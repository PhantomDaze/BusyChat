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
    const timeoutMs = Number(request.config.parameters.timeoutMs ?? 30_000);
    const systemPrompt = String(request.config.parameters.systemPrompt ?? '').trim();
    const temperature = request.config.parameters.temperature;
    const maxTokens = request.config.parameters.maxTokens;

    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const response = await fetch(new URL('chat/completions', normalizedBase), {
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
      signal: AbortSignal.timeout(timeoutMs),
    });

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
    const timeoutMs = Number(request.config.parameters.timeoutMs ?? 30_000);

    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const response = await fetch(new URL('embeddings', normalizedBase), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        input: request.inputs,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `openai-compatible embedding failed: ${response.status}${body ? ` - ${body.slice(0, 200)}` : ''}`,
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
    const timeoutMs = Number(request.config.parameters.timeoutMs ?? 30_000);

    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const response = await fetch(new URL('rerank', normalizedBase), {
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
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `openai-compatible rerank failed: ${response.status}${body ? ` - ${body.slice(0, 200)}` : ''}`,
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
        return await provider.generateText(request);
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

    return fallbackProvider.generateText(request);
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
        return await provider.transcribe(request);
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
    return fallbackProvider.transcribe(request);
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
        this.logger.warn('embedding provider failed, falling back', {
          modelId: model.id,
          provider: model.provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
        return await provider.rerank(request);
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
    return fallbackProvider.rerank(request);
  }
}
