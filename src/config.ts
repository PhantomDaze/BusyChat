import type {
  AppConfigFile,
  AppSettings,
  ModelConfig,
  ModelFamily,
  ModelTask,
  OneBotClientConfig,
  OneBotWebSocketConfig,
  OneBotWebSocketMode,
  PluginRuntimeState,
  RuntimeState,
  UiSettings,
} from './types';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

/** 允许 0 的非负整数（心跳间隔 0 表示关闭）。 */
function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function toWebSocketMode(value: unknown): OneBotWebSocketMode | undefined {
  return value === 'off' || value === 'forward' || value === 'reverse' || value === 'both' ? value : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : String(item).trim()))
    .filter((item) => item.length > 0);

  return items;
}

function normalizeRoutePath(value: unknown, fallback: string): string {
  const trimmed = toTrimmedString(value);
  if (!trimmed) {
    return fallback;
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizePluginDirs(value: unknown, fallback: string[]): string[] {
  const dirs = toStringArray(value);
  return dirs && dirs.length > 0 ? dirs : [...fallback];
}

function createDefaultModels(): Record<ModelFamily, ModelConfig[]> {
  return {
    language: [
      {
        id: 'language-fallback',
        label: 'Language Fallback',
        family: 'language',
        provider: 'rule-based',
        enabled: true,
        taskBindings: ['summary', 'advice', 'chat', 'classifier', 'moderation', 'memory-summary'],
        parameters: {
          note: 'Deterministic fallback language model used until a real provider is configured.',
        },
      },
    ],
    'speech-to-text': [
      {
        id: 'stt-fallback',
        label: 'Speech To Text Fallback',
        family: 'speech-to-text',
        provider: 'rule-based',
        enabled: true,
        taskBindings: ['transcription'],
        parameters: {
          note: 'Fallback transcription provider. Returns a stub response until a real STT model is configured.',
        },
      },
    ],
    embedding: [
      {
        id: 'embedding-fallback',
        label: 'Embedding Fallback',
        family: 'embedding',
        provider: 'rule-based',
        enabled: true,
        taskBindings: ['embedding'],
        parameters: {
          dimension: 8,
          note: 'Deterministic hash-based embedding fallback.',
        },
      },
    ],
    rerank: [
      {
        id: 'rerank-fallback',
        label: 'Rerank Fallback',
        family: 'rerank',
        provider: 'rule-based',
        enabled: true,
        taskBindings: ['rerank'],
        parameters: {
          note: 'Deterministic keyword-overlap reranker fallback.',
        },
      },
    ],
  };
}

function createDefaultActiveModels(): Partial<Record<ModelTask, string>> {
  return {
    summary: 'language-fallback',
    advice: 'language-fallback',
    chat: 'language-fallback',
    classifier: 'language-fallback',
    moderation: 'language-fallback',
    'memory-summary': 'language-fallback',
    transcription: 'stt-fallback',
    embedding: 'embedding-fallback',
    rerank: 'rerank-fallback',
  };
}

export function createDefaultUiSettings(): UiSettings {
  return {
    enabled: true,
    title: 'F261Agent',
    password: '',
  };
}

export function createDefaultOneBotSettings(): OneBotClientConfig {
  return {
    baseUrl: 'http://127.0.0.1:5700',
    apiPrefix: '/api',
    timeoutMs: 10_000,
    webSocket: {
      mode: 'off',
      reversePath: '/onebot/ws',
      reconnectIntervalMs: 5_000,
      actionTimeoutMs: 10_000,
      heartbeatIntervalMs: 30_000,
    },
  };
}

export function createDefaultRuntimeState(): RuntimeState {
  return {
    admins: [],
    onebot: createDefaultOneBotSettings(),
    activeModels: createDefaultActiveModels(),
    models: createDefaultModels(),
    plugins: {},
    ui: createDefaultUiSettings(),
  };
}

export function createDefaultAppSettings(): AppSettings {
  return {
    dataDir: 'data',
    host: '127.0.0.1',
    port: 3000,
    trustProxy: false,
    pluginSearchDirs: ['dist/plugins', 'src/plugins'],
    uiPath: '/ui',
    eventPath: '/onebot/event',
  };
}

export function createDefaultAppConfig(): AppConfigFile {
  return {
    settings: createDefaultAppSettings(),
    runtime: createDefaultRuntimeState(),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergePluginStates(
  base: Record<string, PluginRuntimeState>,
  patch: Record<string, PluginRuntimeState>,
): Record<string, PluginRuntimeState> {
  const merged: Record<string, PluginRuntimeState> = { ...base };
  for (const [name, state] of Object.entries(patch)) {
    // Skip documentation keys ("_comment") and anything that isn't an object —
    // otherwise the template's comment string becomes a phantom plugin entry.
    if (name.startsWith('_') || !isPlainObject(state)) continue;
    merged[name] = {
      // Absent `enabled` means enabled — an operator hand-adding a plugin's
      // entry should not silently disable the plugin.
      enabled: state.enabled !== false,
    };
  }
  return merged;
}

function mergeModelState(
  base: Record<ModelFamily, ModelConfig[]>,
  patch: Partial<Record<ModelFamily, ModelConfig[]>>,
): Record<ModelFamily, ModelConfig[]> {
  const merged = clone(base);
  for (const family of Object.keys(patch) as ModelFamily[]) {
    const models = patch[family];
    if (!Array.isArray(models)) {
      continue;
    }

    merged[family] = models.map((model) => ({
      ...model,
      taskBindings: [...(Array.isArray(model.taskBindings) ? model.taskBindings : [])],
      parameters: { ...(model.parameters ?? {}) },
    }));
  }
  return merged;
}

export function normalizeAppSettings(persisted?: Partial<AppSettings>): AppSettings {
  const defaults = createDefaultAppSettings();
  if (!persisted) {
    return defaults;
  }

  return {
    dataDir: toTrimmedString(persisted.dataDir) ?? defaults.dataDir,
    host: toTrimmedString(persisted.host) ?? defaults.host,
    port: toPositiveInteger(persisted.port) ?? defaults.port,
    trustProxy: toBoolean(persisted.trustProxy) ?? defaults.trustProxy ?? false,
    pluginSearchDirs: normalizePluginDirs(persisted.pluginSearchDirs, defaults.pluginSearchDirs),
    uiPath: normalizeRoutePath(persisted.uiPath, defaults.uiPath),
    eventPath: normalizeRoutePath(persisted.eventPath, defaults.eventPath),
  };
}

export function normalizeRuntimeState(persisted?: Partial<RuntimeState>): RuntimeState {
  const defaults = createDefaultRuntimeState();

  if (!persisted) {
    return defaults;
  }

  const onebot: OneBotClientConfig = {
    ...defaults.onebot,
  };
  const persistedOneBot = persisted.onebot;
  const persistedBaseUrl = toTrimmedString(persistedOneBot?.baseUrl);
  if (persistedBaseUrl) {
    onebot.baseUrl = persistedBaseUrl;
  }
  const persistedApiPrefix = toTrimmedString(persistedOneBot?.apiPrefix);
  if (persistedApiPrefix) {
    onebot.apiPrefix = persistedApiPrefix.startsWith('/') ? persistedApiPrefix : `/${persistedApiPrefix}`;
  }
  const persistedTimeout = toPositiveInteger(persistedOneBot?.timeoutMs);
  if (persistedTimeout) {
    onebot.timeoutMs = persistedTimeout;
  }
  const persistedWebSocket = persistedOneBot?.webSocket;
  const webSocket: OneBotWebSocketConfig = {
    ...defaults.onebot.webSocket,
  };
  const webSocketMode = toWebSocketMode(persistedWebSocket?.mode);
  if (webSocketMode) {
    webSocket.mode = webSocketMode;
  }
  const forwardUrl = toTrimmedString(persistedWebSocket?.forwardUrl);
  if (forwardUrl) {
    webSocket.forwardUrl = forwardUrl;
  }
  webSocket.reversePath = normalizeRoutePath(persistedWebSocket?.reversePath, defaults.onebot.webSocket.reversePath);
  const reconnectIntervalMs = toPositiveInteger(persistedWebSocket?.reconnectIntervalMs);
  if (reconnectIntervalMs) {
    webSocket.reconnectIntervalMs = reconnectIntervalMs;
  }
  const actionTimeoutMs = toPositiveInteger(persistedWebSocket?.actionTimeoutMs);
  if (actionTimeoutMs) {
    webSocket.actionTimeoutMs = actionTimeoutMs;
  }
  const heartbeatIntervalMs = toNonNegativeInteger(persistedWebSocket?.heartbeatIntervalMs);
  if (heartbeatIntervalMs !== undefined) {
    webSocket.heartbeatIntervalMs = heartbeatIntervalMs;
  }
  onebot.webSocket = webSocket;
  const accessToken = toTrimmedString(persistedOneBot?.accessToken);
  if (accessToken) {
    onebot.accessToken = accessToken;
  }
  const selfId = toTrimmedString(persistedOneBot?.selfId);
  if (selfId) {
    onebot.selfId = selfId;
  }

  const ui: UiSettings = {
    ...defaults.ui,
  };
  const persistedUi = persisted.ui;
  const uiEnabled = toBoolean(persistedUi?.enabled);
  if (typeof uiEnabled === 'boolean') {
    ui.enabled = uiEnabled;
  }
  const uiTitle = toTrimmedString(persistedUi?.title);
  if (uiTitle) {
    ui.title = uiTitle;
  }
  const authToken = toTrimmedString(persistedUi?.authToken);
  if (authToken) {
    ui.authToken = authToken;
  }
  const passwordHash = toTrimmedString(persistedUi?.passwordHash);
  if (passwordHash) {
    ui.passwordHash = passwordHash;
  }
  const password = toTrimmedString(persistedUi?.password);
  if (password) {
    ui.password = password;
  }

  const activeModels: Partial<Record<ModelTask, string>> = {
    ...defaults.activeModels,
  };
  const persistedActiveModels = persisted.activeModels;
  if (persistedActiveModels) {
    for (const [task, modelId] of Object.entries(persistedActiveModels) as Array<[ModelTask, string | undefined]>) {
      // Skip documentation keys so "_comment" never becomes a task binding.
      if (task.startsWith('_')) continue;
      const normalizedModelId = toTrimmedString(modelId);
      if (normalizedModelId) {
        activeModels[task] = normalizedModelId;
      }
    }
  }

  const models = mergeModelState(defaults.models, persisted.models ?? {});
  const plugins = mergePluginStates(defaults.plugins, persisted.plugins ?? {});
  const admins = Array.isArray(persisted.admins)
    ? persisted.admins.map((id) => String(id).trim()).filter(Boolean)
    : [...defaults.admins];

  return {
    admins,
    onebot,
    activeModels,
    models,
    plugins,
    ui,
  };
}

/**
 * Copy `_`-prefixed keys (documentation/comments, e.g. "_comment") from the
 * user's file back into the normalized output, recursing into matching nested
 * objects. The app rewrites config.json on every runtime update, and without
 * this every annotation the operator wrote would be silently destroyed within
 * minutes of startup.
 */
function preserveCommentKeys(source: unknown, target: unknown): void {
  if (!isPlainObject(source) || !isPlainObject(target)) return;
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('_')) {
      (target as Record<string, unknown>)[key] = value;
    } else if (isPlainObject(value) && isPlainObject(target[key])) {
      preserveCommentKeys(value, target[key]);
    }
  }
}

export function normalizeAppConfig(persisted?: Partial<AppConfigFile>): AppConfigFile {
  const defaults = createDefaultAppConfig();
  if (!persisted) {
    return defaults;
  }

  const normalized: AppConfigFile = {
    settings: normalizeAppSettings(persisted.settings),
    runtime: normalizeRuntimeState(persisted.runtime),
  };
  preserveCommentKeys(persisted, normalized);
  return normalized;
}
