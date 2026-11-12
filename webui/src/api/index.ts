import { LONG_REQUEST_TIMEOUT_MS, request } from './client';
import type {
  AppConfigFile,
  AppState,
  KnowledgeBaseSettings,
  KnowledgeEntry,
  KnowledgeSearchResult,
  ModelCatalogEntry,
  ModelConfig,
  ModelFetchResult,
  ModelProbePayload,
  ModelProbeResult,
  ModelTask,
  NormalizedEvent,
  NotifySettings,
  OneBotClientConfig,
  PendingReply,
  PluginInfo,
  ReplyGenerateResult,
  SaveConfigResult,
  SummaryRecord,
  SummaryStatus,
  WebSocketStatus,
} from './types';

const enc = encodeURIComponent;

/** 所有 WebUI HTTP 接口的集中封装 */
export const api = {
  // ---- 鉴权 ----
  login(password: string) {
    return request<{ ok: boolean; token: string }>('/api/login', {
      method: 'POST',
      body: { password },
      skipUnauthorizedHandler: true,
    });
  },
  logout() {
    return request<{ ok: boolean }>('/api/logout', { method: 'POST' });
  },
  setPassword(password: string) {
    return request<{ ok: boolean; token: string }>('/api/ui-password', {
      method: 'POST',
      body: { password },
      skipUnauthorizedHandler: true,
    });
  },

  // ---- 全局状态 / 配置 ----
  state() {
    return request<AppState>('/api/state');
  },
  config() {
    return request<AppConfigFile>('/api/config');
  },
  saveConfig(config: AppConfigFile) {
    return request<SaveConfigResult>('/api/config', { method: 'POST', body: config });
  },

  // ---- 管理员 ----
  addAdmin(userId: string) {
    return request<{ ok: boolean }>('/api/admins', { method: 'POST', body: { userId } });
  },
  removeAdmin(id: string) {
    return request<{ ok: boolean }>(`/api/admins/${enc(id)}`, { method: 'DELETE' });
  },

  // ---- 模型 ----
  models() {
    return request<ModelCatalogEntry[]>('/api/models');
  },
  saveModel(model: ModelConfig) {
    return request<{ ok: boolean }>('/api/models', { method: 'POST', body: model });
  },
  setModelEnabled(id: string, enabled: boolean) {
    return request<{ ok: boolean }>(`/api/models/${enc(id)}/enabled`, {
      method: 'POST',
      body: { enabled },
    });
  },
  deleteModel(id: string) {
    return request<{ ok: boolean }>(`/api/models/${enc(id)}`, { method: 'DELETE' });
  },
  activateModel(task: ModelTask, modelId: string) {
    return request<{ ok: boolean }>(`/api/models/${enc(task)}/activate`, {
      method: 'POST',
      body: { modelId },
    });
  },
  testModel(payload: ModelProbePayload) {
    return request<ModelProbeResult>('/api/models/test', {
      method: 'POST',
      body: payload,
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    });
  },
  fetchRemoteModels(payload: ModelProbePayload) {
    return request<ModelFetchResult>('/api/models/fetch', {
      method: 'POST',
      body: payload,
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    });
  },

  // ---- 插件 ----
  plugins() {
    return request<PluginInfo[]>('/api/plugins');
  },
  setPluginEnabled(name: string, enabled: boolean) {
    return request<{ ok: boolean }>(`/api/plugins/${enc(name)}/enabled`, {
      method: 'POST',
      body: { enabled },
    });
  },
  reloadPlugins() {
    return request<{ ok: boolean }>('/api/plugins/reload', { method: 'POST' });
  },

  // ---- OneBot / WebSocket ----
  saveOneBotConfig(config: Partial<OneBotClientConfig> & { accessToken?: string }) {
    return request<{ ok: boolean }>('/api/onebot-config', { method: 'POST', body: config });
  },
  saveWsConfig(config: {
    mode: string;
    forwardUrl: string;
    reversePath: string;
    reconnectIntervalMs: number;
    actionTimeoutMs: number;
  }) {
    return request<{ ok: boolean }>('/api/ws-config', { method: 'POST', body: config });
  },
  wsStatus() {
    return request<WebSocketStatus>('/api/ws-status');
  },
  events(limit = 64, signal?: AbortSignal) {
    return request<NormalizedEvent[]>(`/api/events?limit=${limit}`, { signal });
  },

  // ---- 知识库（builtin-knowledge 插件路由） ----
  knowledge: {
    list(limit = 50) {
      return request<{ items: KnowledgeEntry[] }>(`/api/knowledge?limit=${limit}`);
    },
    add(text: string) {
      return request<KnowledgeEntry>('/api/knowledge', { method: 'POST', body: { text } });
    },
    remove(id: string) {
      return request<{ deleted: boolean }>(`/api/knowledge/${enc(id)}`, { method: 'DELETE' });
    },
    search(query: string, limit?: number) {
      return request<{ results: KnowledgeSearchResult[] }>('/api/knowledge/search', {
        method: 'POST',
        body: { query, limit },
      });
    },
    summarize(entryIds?: string[]) {
      return request<KnowledgeEntry>('/api/knowledge/summarize', {
        method: 'POST',
        body: { entryIds },
      });
    },
    settings() {
      return request<KnowledgeBaseSettings>('/api/knowledge/settings');
    },
    saveSettings(settings: {
      enabled: boolean;
      maxResults: number;
      vectorDimension: number | null;
    }) {
      return request<{ ok: boolean }>('/api/knowledge/settings', {
        method: 'POST',
        body: settings,
      });
    },
  },

  // ---- 摘要（builtin-summary 插件路由） ----
  summary: {
    saveSettings(settings: {
      enabled: boolean;
      intervalMs: number;
      batchSize: number;
      maxEventsPerPrompt: number;
    }) {
      return request<{ ok: boolean }>('/api/summary/settings', {
        method: 'POST',
        body: settings,
      });
    },
    flush() {
      return request<SummaryRecord & { empty?: boolean; ok?: boolean }>('/api/summary/flush', {
        method: 'POST',
        timeoutMs: LONG_REQUEST_TIMEOUT_MS,
      });
    },
    status() {
      return request<SummaryStatus>('/api/summary/status').catch(() => null);
    },
  },

  // ---- 关键词告警（builtin-notify 插件路由） ----
  notify: {
    settings() {
      return request<NotifySettings>('/api/notify/settings');
    },
    saveSettings(settings: Partial<NotifySettings>) {
      return request<NotifySettings>('/api/notify/settings', {
        method: 'POST',
        body: settings,
      });
    },
  },

  // ---- 待回复（builtin-reply 插件路由） ----
  reply: {
    pending() {
      return request<{ items: PendingReply[] }>('/api/reply/pending');
    },
    generate(id: string, instruction: string) {
      return request<ReplyGenerateResult>('/api/reply/generate', {
        method: 'POST',
        body: { id, instruction },
      });
    },
    dismiss(id: string) {
      return request<{ ok: boolean }>(`/api/reply/${enc(id)}/dismiss`, { method: 'POST' });
    },
  },
};
