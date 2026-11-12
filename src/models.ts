import { createHash } from 'node:crypto';

import type {
  EmbeddingRequest,
  EmbeddingResponse,
  JsonObject,
  Logger,
  ModelAdminGateway,
  ModelCatalogEntry,
  ModelConfig,
  ModelFamily,
  ModelProvider,
  ModelTask,
  RerankRequest,
  RerankResponse,
  RuntimeState,
  SpeechToTextRequest,
  SpeechToTextResponse,
  TextModelRequest,
  TextModelResponse,
  RuntimeStore,
} from './types';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Coerce a config value to a positive timeout, guarding against NaN/garbage. */
function resolveTimeoutMs(value: unknown, fallback = 30_000): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Strip anything resembling a bearer token / api key out of an upstream error
 * body before it reaches the logs. Providers occasionally echo the request
 * (including the Authorization header) in their 4xx bodies.
 */
function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, 'sk-[redacted]')
    .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[redacted]');
}

/** 可重试的上游状态码：请求超时、限流、上游暂时不可用。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** undici/fetch 在网络层失败时抛出的常见错误码。 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  const code =
    cause && typeof cause === 'object'
      ? (cause as { code?: unknown }).code
      : undefined;
  if (typeof code === 'string') {
    return NETWORK_ERROR_CODES.has(code);
  }
  return error.name === 'TypeError' && /fetch failed|network/i.test(error.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 解析 Retry-After（秒数或 HTTP 日期），统一封顶 10 秒。 */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 10_000);
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.min(date - Date.now(), 10_000));
  }
  return null;
}

/** 指数退避：500ms * 2^attempt，附加 0..249ms 抖动；上游给了 Retry-After 时优先遵从。 */
function computeRetryDelayMs(attempt: number, response: Response | null): number {
  const hinted = response ? retryAfterMs(response.headers.get('retry-after')) : null;
  if (hinted !== null) return hinted;
  const base = 500 * 2 ** attempt;
  return base + Math.floor(Math.random() * 250);
}

/** 释放响应体，避免重试前占着连接。 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 忽略：body 可能已经被读取或不存在
  }
}

/** 读取 parameters.maxRetries，非法值回落到 2，范围 0..5。 */
function resolveMaxRetries(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 2;
  return Math.min(5, Math.max(0, n));
}

export interface FetchWithRetryOptions {
  timeoutMs?: number;
  /** 最大重试次数（不含首次请求），0..5，默认 2 */
  maxRetries?: number;
}

/**
 * 所有 OpenAI 兼容上游请求共用的重试封装。
 *
 * - 只重试网络错误、408、429、5xx；
 * - 超时最多重试 1 次（POST 可能已到达上游，避免放大副作用）；
 * - 其余可重试错误最多 maxRetries 次；
 * - 每次尝试都使用独立的 AbortSignal.timeout；
 * - 不记录请求头/请求体，因此不会把 apiKey 写进日志。
 */
export async function fetchWithRetry(
  url: URL | string,
  init: Omit<RequestInit, 'signal'>,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const maxRetries = resolveMaxRetries(options.maxRetries);
  let attempt = 0;
  let timeoutRetried = false;

  for (;;) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok && isRetryableStatus(response.status) && attempt < maxRetries) {
        const delay = computeRetryDelayMs(attempt, response);
        await discardBody(response);
        await sleep(delay);
        attempt += 1;
        continue;
      }
      return response;
    } catch (error) {
      if (isAbortError(error)) {
        // 超时只重试一次：请求可能已经被上游接收，无限重试会重复执行。
        if (!timeoutRetried && attempt < maxRetries) {
          timeoutRetried = true;
          await sleep(computeRetryDelayMs(attempt, null));
          attempt += 1;
          continue;
        }
        throw error;
      }
      if (isNetworkError(error) && attempt < maxRetries) {
        await sleep(computeRetryDelayMs(attempt, null));
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hashToVector(text: string, dimension: number): number[] {
  const digest = createHash('sha256').update(text).digest();
  const vector: number[] = [];
  for (let index = 0; index < dimension; index += 1) {
    const byte = digest[index % digest.length] ?? 0;
    vector.push(Number((byte / 255).toFixed(6)));
  }
  return vector;
}

function nowIso(): string {
  return new Date().toISOString();
}

function taskFamily(task: ModelTask): ModelFamily {
  if (task === 'transcription') {
    return 'speech-to-text';
  }
  if (task === 'embedding') {
    return 'embedding';
  }
  if (task === 'rerank') {
    return 'rerank';
  }
  return 'language';
}

function activeTasksForModel(state: RuntimeState, modelId: string): ModelTask[] {
  return (Object.keys(state.activeModels) as ModelTask[]).filter(
    (task) => state.activeModels[task] === modelId,
  );
}

function normalizeConfig(model: ModelConfig): ModelConfig {
  return {
    ...model,
    taskBindings: [...model.taskBindings],
    parameters: { ...model.parameters },
  };
}

function assertModelCompatibility(model: ModelConfig): void {
  const allowedTasksByFamily: Record<ModelFamily, ModelTask[]> = {
    language: ['summary', 'advice', 'chat', 'classifier', 'moderation', 'memory-summary'],
    'speech-to-text': ['transcription'],
    embedding: ['embedding'],
    rerank: ['rerank'],
  };

  const allowed = new Set(allowedTasksByFamily[model.family]);
  for (const task of model.taskBindings) {
    if (!allowed.has(task)) {
      throw new Error(`model ${model.id} with family ${model.family} cannot serve task ${task}`);
    }
  }
}

class RuleBasedModelProvider implements ModelProvider {
  name = 'rule-based';

  async generateText(request: TextModelRequest): Promise<TextModelResponse> {
    const lines = request.input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12);

    const header = {
      summary: '摘要',
      advice: '建议',
      chat: '回复',
      classifier: '分类',
      moderation: '审核',
      'memory-summary': '记忆总结',
    }[request.task];

    const body = lines.length > 0 ? lines.map((line) => `- ${line}`).join('\n') : '- 暂无可用内容';

    let text = `${header}（fallback）\n${body}`;

    if (request.task === 'summary') {
      text += '\n\n建议：\n- 先关注高频话题\n- 对重要事项单独跟进\n- 必要时手动复核';
    }

    if (request.task === 'advice') {
      text = `建议（fallback）\n- 先确认目标账号和上下文\n- 如需发送消息，可使用 /send private <qq> <内容>\n- 如果要改变模型或插件配置，可在 WebUI 中操作\n\n上下文：\n${body}`;
    }

    if (request.task === 'chat') {
      text = `回复（fallback）\n- 我已经收到你的消息。\n- 当前是规则降级模式，建议在 WebUI 中配置真实语言模型。`;
    }

    if (request.task === 'classifier') {
      text = `分类（fallback）\n- 该消息属于：未配置真实分类模型\n- 可信度：0.1`;
    }

    if (request.task === 'moderation') {
      text = `审核（fallback）\n- 该消息未命中规则，建议人工复核`;
    }

    return {
      text,
      raw: {
        fallback: true,
        task: request.task,
      },
    };
  }

  async transcribe(request: SpeechToTextRequest): Promise<SpeechToTextResponse> {
    const label = request.input.audioUrl ?? request.input.audioBase64 ?? '<audio>';
    return {
      text: `[fallback transcription unavailable for ${label}]`,
      language: 'unknown',
      raw: { fallback: true },
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const dimension = Number(request.config.parameters.dimension ?? 8);
    return {
      vectors: request.inputs.map((input) => hashToVector(input, dimension)),
      raw: { fallback: true },
    };
  }

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const queryTokens = new Set(tokenize(request.query));
    const ranking = request.candidates.map((candidate, index) => {
      const candidateTokens = tokenize(candidate);
      let overlap = 0;
      for (const token of candidateTokens) {
        if (queryTokens.has(token)) {
          overlap += 1;
        }
      }
      const score = candidateTokens.length > 0 ? overlap / candidateTokens.length : 0;
      return { index, score: Number(score.toFixed(4)) };
    });

    ranking.sort((left, right) => right.score - left.score);

    return {
      ranking,
      raw: { fallback: true },
    };
  }
}

class OpenAICompatibleProvider implements ModelProvider {
  name = 'openai-compatible';

  async generateText(request: TextModelRequest): Promise<TextModelResponse> {
    const baseUrl = String(request.config.parameters.baseUrl ?? '').trim();
    const model = String(request.config.parameters.model ?? '').trim();
    if (!baseUrl || !model) {
      throw new Error('openai-compatible model requires baseUrl and model parameters');
    }

    const apiKey = String(request.config.parameters.apiKey ?? '').trim();
    const timeoutMs = resolveTimeoutMs(request.config.parameters.timeoutMs);
    const systemPrompt = String(request.config.parameters.systemPrompt ?? '').trim();
    const temperature = request.config.parameters.temperature;
    const maxTokens = request.config.parameters.maxTokens;

    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const response = await fetchWithRetry(
      new URL('chat/completions', normalizedBase),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            {
              role: 'user',
              content: request.input,
            },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
      },
      { timeoutMs, maxRetries: resolveMaxRetries(request.config.parameters.maxRetries) },
    );

    if (!response.ok) {
      throw new Error(`openai-compatible request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const text = payload.choices?.[0]?.message?.content?.trim() || '';
    if (!text) {
      throw new Error('openai-compatible response did not include content');
    }

    const usage: TextModelResponse['usage'] = payload.usage
      ? {
          ...(typeof payload.usage.prompt_tokens === 'number'
            ? { promptTokens: payload.usage.prompt_tokens }
            : {}),
          ...(typeof payload.usage.completion_tokens === 'number'
            ? { completionTokens: payload.usage.completion_tokens }
            : {}),
          ...(typeof payload.usage.total_tokens === 'number'
            ? { totalTokens: payload.usage.total_tokens }
            : {}),
        }
      : undefined;

    return {
      text,
      raw: payload,
      ...(usage ? { usage } : {}),
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const baseUrl = String(request.config.parameters.baseUrl ?? '').trim();
    const model = String(request.config.parameters.model ?? '').trim();
    if (!baseUrl || !model) {
      throw new Error('openai-compatible embedding requires baseUrl and model parameters');
    }

    const apiKey = String(request.config.parameters.apiKey ?? '').trim();
    const timeoutMs = resolveTimeoutMs(request.config.parameters.timeoutMs);

    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const response = await fetchWithRetry(
      new URL('embeddings', normalizedBase),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          input: request.inputs,
        }),
      },
      { timeoutMs, maxRetries: resolveMaxRetries(request.config.parameters.maxRetries) },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `openai-compatible embedding failed: ${response.status}${body ? ` - ${redactSecrets(body).slice(0, 200)}` : ''}`,
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };

    const items = payload.data ?? [];
    items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = items.map((item) => item.embedding ?? []);

    if (vectors.length === 0 || vectors.some((v) => v.length === 0)) {
      throw new Error('openai-compatible embedding returned empty vectors');
    }

    return { vectors, raw: payload };
  }

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const baseUrl = String(request.config.parameters.baseUrl ?? '').trim();
    const model = String(request.config.parameters.model ?? '').trim();
    if (!baseUrl || !model) {
      throw new Error('openai-compatible rerank requires baseUrl and model parameters');
    }

    const apiKey = String(request.config.parameters.apiKey ?? '').trim();
    const timeoutMs = resolveTimeoutMs(request.config.parameters.timeoutMs);

    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const response = await fetchWithRetry(
      new URL('rerank', normalizedBase),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          query: request.query,
          documents: request.candidates,
        }),
      },
      { timeoutMs, maxRetries: resolveMaxRetries(request.config.parameters.maxRetries) },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `openai-compatible rerank failed: ${response.status}${body ? ` - ${redactSecrets(body).slice(0, 200)}` : ''}`,
      );
    }

    const payload = (await response.json()) as {
      results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
      data?: Array<{ index?: number; relevance_score?: number; score?: number }>;
    };

    // Support both `results` (Cohere/Jina style) and `data` (智谱 style) response fields
    const rawRanking = payload.results ?? payload.data ?? [];
    const ranking = rawRanking.map((item) => ({
      index: item.index ?? 0,
      score: item.relevance_score ?? item.score ?? 0,
    }));

    if (ranking.length === 0) {
      throw new Error('openai-compatible rerank returned empty results');
    }

    return { ranking, raw: payload };
  }

  /** GET {base}/models 拉取上游可用模型 id 列表。 */
  async listRemoteModels(config: ModelConfig): Promise<string[]> {
    const baseUrl = String(config.parameters.baseUrl ?? '').trim();
    if (!baseUrl) {
      throw new Error('拉取模型列表需要 baseUrl 参数');
    }
    const apiKey = String(config.parameters.apiKey ?? '').trim();
    const timeoutMs = resolveTimeoutMs(config.parameters.timeoutMs);

    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const response = await fetchWithRetry(
      new URL('models', normalizedBase),
      {
        method: 'GET',
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      },
      { timeoutMs, maxRetries: resolveMaxRetries(config.parameters.maxRetries) },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `拉取模型列表失败: ${response.status}${body ? ` - ${redactSecrets(body).slice(0, 200)}` : ''}`,
      );
    }

    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = (payload.data ?? []).map((item) => item.id ?? '').filter(Boolean);
    if (ids.length === 0) {
      throw new Error('上游返回了空的模型列表');
    }
    return ids;
  }

  /** 连通性测试：拉取模型列表，并校验配置的 model 是否可用。 */
  async testConnection(config: ModelConfig): Promise<string> {
    const model = String(config.parameters.model ?? '').trim();
    const ids = await this.listRemoteModels(config);
    const preview = ids.slice(0, 5).join(', ');

    if (!model) {
      return `连接成功，上游共 ${ids.length} 个模型（例如: ${preview}）`;
    }
    if (ids.includes(model)) {
      return `连接成功，模型 ${model} 可用（共 ${ids.length} 个模型）`;
    }
    const fuzzy = ids.filter((id) => id.includes(model)).slice(0, 3);
    if (fuzzy.length > 0) {
      return `连接成功，但 ${model} 未精确匹配；发现相近: ${fuzzy.join(', ')}（共 ${ids.length} 个模型）`;
    }
    return `连接成功，但 ${model} 不在上游模型列表中（共 ${ids.length} 个模型，例如: ${preview}）`;
  }
}

export class ModelRegistry implements ModelAdminGateway {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(
    private readonly runtime: RuntimeStore,
    private readonly logger: Logger,
  ) {
    this.registerProvider(new RuleBasedModelProvider());
    this.registerProvider(new OpenAICompatibleProvider());
  }

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** 返回已注册的 provider 名称，供 WebUI/诊断展示。 */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  listFamilies(): ModelFamily[] {
    return ['language', 'speech-to-text', 'embedding', 'rerank'];
  }

  listTasks(): ModelTask[] {
    return [
      'summary',
      'advice',
      'chat',
      'classifier',
      'moderation',
      'memory-summary',
      'transcription',
      'embedding',
      'rerank',
    ];
  }

  async listModels(): Promise<ModelCatalogEntry[]> {
    const state = await this.runtime.snapshot();
    const entries: ModelCatalogEntry[] = [];
    for (const family of this.listFamilies()) {
      const models = state.models[family] ?? [];
      for (const model of models) {
        entries.push({
          ...normalizeConfig(model),
          activeTasks: activeTasksForModel(state, model.id),
        });
      }
    }
    return entries;
  }

  async listModelsByFamily(family: ModelFamily): Promise<ModelCatalogEntry[]> {
    const state = await this.runtime.snapshot();
    return (state.models[family] ?? []).map((model) => ({
      ...normalizeConfig(model),
      activeTasks: activeTasksForModel(state, model.id),
    }));
  }

  async upsertModel(model: ModelConfig): Promise<void> {
    assertModelCompatibility(model);
    await this.runtime.update((state) => {
      const familyModels = state.models[model.family] ?? [];
      const index = familyModels.findIndex((item) => item.id === model.id);
      const next = normalizeConfig(model);
      if (index >= 0) {
        familyModels[index] = next;
      } else {
        familyModels.push(next);
      }
      state.models[model.family] = familyModels;
      if (!Object.values(state.activeModels).includes(model.id) && model.taskBindings.length > 0) {
        for (const task of model.taskBindings) {
          if (!state.activeModels[task]) {
            state.activeModels[task] = model.id;
          }
        }
      }
    });
  }

  async setModelEnabled(modelId: string, enabled: boolean): Promise<void> {
    const updated = await this.runtime.update((state) => {
      let found = false;
      for (const family of this.listFamilies()) {
        const model = (state.models[family] ?? []).find((item) => item.id === modelId);
        if (model) {
          model.enabled = enabled;
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error(`model ${modelId} not found`);
      }
    });
    void updated;
  }

  async setActiveModel(task: ModelTask, modelId: string): Promise<void> {
    await this.runtime.update((state) => {
      const family = taskFamily(task);
      const model = (state.models[family] ?? []).find((item) => item.id === modelId);
      if (!model) {
        throw new Error(`model ${modelId} not found in family ${family}`);
      }
      if (!model.enabled) {
        throw new Error(`model ${modelId} is disabled`);
      }
      if (!model.taskBindings.includes(task)) {
        throw new Error(`model ${modelId} cannot serve task ${task}`);
      }
      state.activeModels[task] = modelId;
    });
  }

  async removeModel(modelId: string): Promise<void> {
    await this.runtime.update((state) => {
      for (const family of this.listFamilies()) {
        state.models[family] = (state.models[family] ?? []).filter((item) => item.id !== modelId);
      }
      for (const task of this.listTasks()) {
        if (state.activeModels[task] === modelId) {
          delete state.activeModels[task];
        }
      }
    });
  }

  async hasOnlyFallbackModels(): Promise<boolean> {
    const state = await this.runtime.snapshot();
    for (const family of this.listFamilies()) {
      const models = state.models[family] ?? [];
      if (models.some((m) => m.provider !== 'rule-based' && m.enabled)) return false;
    }
    return true;
  }

  /** 透传到 provider：拉取该模型配置对应上游的可用模型 id 列表。 */
  async listRemoteModels(model: ModelConfig): Promise<string[]> {
    const provider = this.providers.get(model.provider);
    if (!provider?.listRemoteModels) {
      throw new Error(`provider ${model.provider} 不支持拉取模型列表`);
    }
    return provider.listRemoteModels(model);
  }

  /** 透传到 provider：测试该模型配置与上游的连接。 */
  async testConnection(model: ModelConfig): Promise<string> {
    const provider = this.providers.get(model.provider);
    if (!provider?.testConnection) {
      throw new Error(`provider ${model.provider} 不支持连接测试`);
    }
    return provider.testConnection(model);
  }

  async generateText(
    task: TextModelRequest['task'],
    input: string,
    context: JsonObject = {},
  ): Promise<TextModelResponse> {
    return this.runTextTask(task, input, context);
  }

  async transcribe(
    input: SpeechToTextRequest['input'],
    context: JsonObject = {},
  ): Promise<SpeechToTextResponse> {
    return this.runSpeechTask('transcription', input, context);
  }

  async embed(inputs: string[], context: JsonObject = {}): Promise<EmbeddingResponse> {
    return this.runEmbeddingTask(inputs, context);
  }

  async rerank(query: string, candidates: string[], context: JsonObject = {}): Promise<RerankResponse> {
    return this.runRerankTask(query, candidates, context);
  }

  private async selectModelForTask(task: ModelTask): Promise<ModelConfig> {
    const state = await this.runtime.snapshot();
    const family = taskFamily(task);
    const models = state.models[family] ?? [];

    const activeId = state.activeModels[task];
    if (activeId) {
      const active = models.find((item) => item.id === activeId);
      if (active && active.enabled && active.taskBindings.includes(task)) {
        return active;
      }
    }

    const preferred = models.find((item) => item.enabled && item.taskBindings.includes(task));
    if (preferred) {
      return preferred;
    }

    const fallback = models.find((item) => item.provider === 'rule-based' && item.taskBindings.includes(task));
    if (fallback) {
      return fallback;
    }

    throw new Error(`no model configured for task ${task}`);
  }

  private async runTextTask(
    task: TextModelRequest['task'],
    input: string,
    context: JsonObject,
  ): Promise<TextModelResponse> {
    const model = await this.selectModelForTask(task);
    const provider = this.providers.get(model.provider);
    const request: TextModelRequest = {
      task,
      input,
      context,
      config: model,
    };

    if (provider?.generateText) {
      try {
        const response = await provider.generateText(request);
        // 标注实际响应来源，便于摘要等上层识别“真实模型 / 规则兜底”。
        return {
          ...response,
          modelId: response.modelId ?? model.id,
          provider: response.provider ?? model.provider,
        };
      } catch (error) {
        this.logger.warn('text model provider failed, falling back', {
          task,
          modelId: model.id,
          provider: model.provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const fallbackProvider = this.providers.get('rule-based');
    if (!fallbackProvider?.generateText) {
      throw new Error('rule-based provider is unavailable');
    }

    const fallbackResponse = await fallbackProvider.generateText(request);
    if (model.provider !== 'rule-based') {
      // 配置的是真实模型但本次失败：显式标记降级，并把失败模型的来源带回去。
      return {
        ...fallbackResponse,
        degraded: true,
        modelId: model.id,
        provider: model.provider,
      };
    }
    return {
      ...fallbackResponse,
      modelId: fallbackResponse.modelId ?? model.id,
      provider: fallbackResponse.provider ?? model.provider,
    };
  }

  private async runSpeechTask(
    task: Extract<ModelTask, 'transcription'>,
    input: SpeechToTextRequest['input'],
    context: JsonObject,
  ): Promise<SpeechToTextResponse> {
    const model = await this.selectModelForTask(task);
    const provider = this.providers.get(model.provider);
    const request: SpeechToTextRequest = {
      input,
      context,
      config: model,
    };

    if (provider?.transcribe) {
      try {
        const response = await provider.transcribe(request);
        return {
          ...response,
          modelId: model.id,
          provider: model.provider,
        } as SpeechToTextResponse & { modelId: string; provider: string };
      } catch (error) {
        this.logger.warn('speech-to-text provider failed, falling back', {
          modelId: model.id,
          provider: model.provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const fallbackProvider = this.providers.get('rule-based');
    if (!fallbackProvider?.transcribe) {
      throw new Error('rule-based provider is unavailable');
    }
    const fallbackResponse = await fallbackProvider.transcribe(request);
    if (model.provider !== 'rule-based') {
      return {
        ...fallbackResponse,
        degraded: true,
        modelId: model.id,
        provider: model.provider,
      } as SpeechToTextResponse & {
        degraded: true;
        modelId: string;
        provider: string;
      };
    }
    return fallbackResponse;
  }

  private async runEmbeddingTask(inputs: string[], context: JsonObject): Promise<EmbeddingResponse> {
    const model = await this.selectModelForTask('embedding');
    const provider = this.providers.get(model.provider);
    const request: EmbeddingRequest = {
      inputs,
      context,
      config: model,
    };

    if (provider?.embed) {
      try {
        return await provider.embed(request);
      } catch (error) {
        // Do NOT silently fall back to the rule-based embedder here: it emits a
        // vector of a different dimension, which would be persisted next to the
        // real ones and permanently pollute the knowledge base. Surface the
        // failure so the caller can retry rather than store garbage.
        if (model.provider !== 'rule-based') {
          this.logger.warn('embedding provider failed', {
            modelId: model.id,
            provider: model.provider,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
    } else if (model.provider !== 'rule-based') {
      // 配置的真实 provider 不存在/未实现 embed：同样不能静默降级。
      throw new Error(`embedding provider ${model.provider} is unavailable`);
    }

    const fallbackProvider = this.providers.get('rule-based');
    if (!fallbackProvider?.embed) {
      throw new Error('rule-based provider is unavailable');
    }
    return fallbackProvider.embed(request);
  }

  private async runRerankTask(
    query: string,
    candidates: string[],
    context: JsonObject,
  ): Promise<RerankResponse> {
    const model = await this.selectModelForTask('rerank');
    const provider = this.providers.get(model.provider);
    const request: RerankRequest = {
      query,
      candidates,
      context,
      config: model,
    };

    if (provider?.rerank) {
      try {
        const response = await provider.rerank(request);
        return {
          ...response,
          modelId: model.id,
          provider: model.provider,
        } as RerankResponse & { modelId: string; provider: string };
      } catch (error) {
        this.logger.warn('rerank provider failed, falling back', {
          modelId: model.id,
          provider: model.provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const fallbackProvider = this.providers.get('rule-based');
    if (!fallbackProvider?.rerank) {
      throw new Error('rule-based provider is unavailable');
    }
    const fallbackResponse = await fallbackProvider.rerank(request);
    if (model.provider !== 'rule-based') {
      return {
        ...fallbackResponse,
        degraded: true,
        modelId: model.id,
        provider: model.provider,
      } as RerankResponse & {
        degraded: true;
        modelId: string;
        provider: string;
      };
    }
    return fallbackResponse;
  }
}
