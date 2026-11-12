/** BusyChat WebUI 用到的 HTTP 契约类型（与后端 src/types.ts 对齐） */

export type ModelFamily = 'language' | 'speech-to-text' | 'embedding' | 'rerank';

export type ModelTask =
  | 'summary'
  | 'advice'
  | 'chat'
  | 'classifier'
  | 'moderation'
  | 'memory-summary'
  | 'transcription'
  | 'embedding'
  | 'rerank';

export type OneBotWebSocketMode = 'off' | 'forward' | 'reverse' | 'both';

export type JsonObject = Record<string, unknown>;

export interface ModelFieldMeta {
  key: string;
  label: string;
  type: 'string' | 'text' | 'password' | 'int' | 'float' | 'bool';
  hint?: string;
  placeholder?: string;
  default?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  isModelName?: boolean;
  slider?: boolean;
}

export interface ModelProviderSchema {
  provider: string;
  family: ModelFamily;
  fields: ModelFieldMeta[];
}

export interface ModelConfig {
  id: string;
  label: string;
  family: ModelFamily;
  provider: string;
  enabled: boolean;
  taskBindings: ModelTask[];
  priority?: number;
  parameters: JsonObject;
}

export interface ModelCatalogEntry extends ModelConfig {
  activeTasks: ModelTask[];
}

export interface PluginInfo {
  name: string;
  version: string;
  enabled: boolean;
  description?: string;
  filePath?: string;
  permissions?: string[];
}

export interface OneBotWebSocketConfig {
  mode: OneBotWebSocketMode;
  forwardUrl?: string;
  reversePath: string;
  reconnectIntervalMs: number;
  actionTimeoutMs: number;
}

export interface OneBotClientConfig {
  baseUrl: string;
  apiPrefix: string;
  accessToken?: string;
  selfId?: string;
  timeoutMs: number;
  webSocket: OneBotWebSocketConfig;
}

export interface UiSettings {
  enabled: boolean;
  title: string;
  authToken?: string;
  /** 已脱敏：后端返回真实值时通常是 `__redacted__` */
  password?: string;
  /** 后端新增的密码哈希标记：非空即表示已配置密码 */
  passwordHash?: string;
}

export interface RuntimeState {
  admins: string[];
  onebot: OneBotClientConfig;
  activeModels: Partial<Record<ModelTask, string>>;
  models: Record<ModelFamily, ModelConfig[]>;
  plugins: Record<string, { enabled: boolean }>;
  ui: UiSettings;
}

export interface AppSettings {
  dataDir: string;
  host: string;
  port: number;
  pluginSearchDirs: string[];
  uiPath: string;
  eventPath: string;
}

export interface AppConfigFile {
  settings: AppSettings;
  runtime: RuntimeState;
}

export interface NormalizedEvent {
  id: string;
  source: string;
  receivedAt: string;
  botSelfId?: string;
  scope: 'private' | 'group';
  conversationId: string;
  messageId?: number;
  sender: {
    userId: string;
    nickname?: string;
    card?: string;
    role?: string;
    isAdmin: boolean;
    isBot: boolean;
  };
  content: { text: string; segments: unknown[]; rawText?: string };
  visibility: {
    fromAdmin: boolean;
    fromBot: boolean;
    includeInReports: boolean;
    eligibleForAdvice: boolean;
  };
}

export interface SummaryRecord {
  id: string;
  createdAt: string;
  summaryText: string;
  suggestionsText: string;
  recipientIds: string[];
  modelId?: string;
  sourceEventIds: string[];
  metadata: JsonObject;
}

export interface AdviceRecord {
  id: string;
  createdAt: string;
  adminId: string;
  sourceEventId: string;
  adviceText: string;
  modelId?: string;
}

export interface CommandRecord {
  id: string;
  createdAt: string;
  eventId: string;
  command: string;
  args: string[];
  handled: boolean;
  reply?: string;
  error?: string;
}

export interface SummaryStatus {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  maxEventsPerPrompt: number;
  cursorEventId?: string;
  lastGeneratedAt?: string;
}

export interface KnowledgeBaseSettings {
  enabled: boolean;
  maxResults: number;
  vectorDimension?: number | null;
}

export interface AppState {
  config: AppConfigFile;
  settings: AppSettings;
  runtime: RuntimeState;
  models: ModelCatalogEntry[];
  plugins: PluginInfo[];
  summaries: SummaryRecord[];
  advice: AdviceRecord[];
  commands: CommandRecord[];
  events: NormalizedEvent[];
  kbCount: number;
  fallbackOnly: boolean;
  summaryStatus?: SummaryStatus;
  knowledgeStatus?: KnowledgeBaseSettings;
  tasks: ModelTask[];
  families: ModelFamily[];
  modelSchema: ModelProviderSchema[];
  version?: string;
}

export interface KnowledgeEntry {
  id: string;
  createdAt: string;
  updatedAt?: string;
  text: string;
  vector: number[];
  metadata: {
    source: string;
    plugin?: string;
    tags?: string[];
    type: 'user' | 'summary' | 'plugin';
    summaryOfEntryIds?: string[];
    modelId?: string;
  };
}

export interface KnowledgeSearchResult {
  entry: KnowledgeEntry;
  similarityScore: number;
  rerankScore?: number;
}

export interface WebSocketStatus {
  config: {
    mode: OneBotWebSocketMode;
    forwardUrl?: string;
    reversePath: string;
  };
  transport: {
    forwardConnected: boolean;
    reverseConnected: boolean;
    reversePeerCount: number;
    stopped: boolean;
  };
}

export interface PendingReply {
  id: string;
  idShort: string;
  createdAt: string;
  status: 'pending' | 'replied' | 'dismissed';
  scope: 'private' | 'group';
  senderId: string;
  senderName: string;
  text: string;
}

export interface NotifySettings {
  notifyKeywords: string[];
  quietHours: { start: string; end: string } | null;
}

export interface ReplyGenerateResult {
  ok: boolean;
  target: string;
  message: string;
}

export interface ModelProbePayload {
  id?: string;
  family: ModelFamily;
  provider: string;
  parameters: JsonObject;
}

export interface ModelProbeResult {
  ok: boolean;
  message?: string;
}

export interface ModelFetchResult {
  ok: boolean;
  models?: string[];
  message?: string;
}

export interface SaveConfigResult {
  ok: boolean;
  warnings?: string[];
}
