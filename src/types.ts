export type MaybePromise<T> = T | Promise<T>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> {}

export type MessageScope = 'private' | 'group';

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

export type PluginPermission =
  | 'message:observe'
  | 'admin:observe'
  | 'summary:observe'
  | 'bot:send'
  | 'model:use'
  | 'storage:read'
  | 'storage:write'
  | 'command:register'
  | 'knowledge:read'
  | 'knowledge:write'
  | 'summary:control'
  | 'reply:control'
  | 'knowledge:control'
  | 'webui:route';

export interface OneBotMessageSegment {
  type: string;
  data: Record<string, string>;
}

export interface OneBotSender {
  user_id?: number;
  nickname?: string;
  card?: string;
  role?: string;
  sex?: string;
  age?: number;
}

export interface OneBotIncomingEvent {
  time?: number;
  self_id?: number | string;
  post_type: string;
  message_type?: 'private' | 'group';
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  message?: OneBotMessageSegment[] | string;
  raw_message?: string;
  sender?: OneBotSender;
  [key: string]: unknown;
}

export type OutgoingMessage = string | OneBotMessageSegment[];

export interface SendTarget {
  type: MessageScope;
  id: string;
}

export interface SendResult {
  raw: unknown;
  messageId: number | undefined;
}

export interface NormalizedMessageContent {
  text: string;
  segments: OneBotMessageSegment[];
  rawText: string | undefined;
}

export interface NormalizedMessageEvent {
  id: string;
  source: 'onebot-v11';
  receivedAt: string;
  botSelfId: string | undefined;
  scope: MessageScope;
  conversationId: string;
  messageId: number | undefined;
  sender: {
    userId: string;
    nickname: string | undefined;
    card: string | undefined;
    role: string | undefined;
    isAdmin: boolean;
    isBot: boolean;
  };
  content: NormalizedMessageContent;
  raw: OneBotIncomingEvent;
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
  cursorEventId: string | undefined;
  sourceEventIds: string[];
  excludedEventIds: string[];
  recipientIds: string[];
  modelId: string | undefined;
  summaryText: string;
  suggestionsText: string;
  metadata: JsonObject;
}

export interface AdviceRecord {
  id: string;
  createdAt: string;
  adminId: string;
  sourceEventId: string;
  modelId: string | undefined;
  adviceText: string;
  metadata: JsonObject;
}

export interface CommandRecord {
  id: string;
  createdAt: string;
  eventId: string;
  command: string;
  args: string[];
  handled: boolean;
  reply: string | undefined;
  error?: string;
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

export interface KnowledgeBaseSettings {
  enabled: boolean;
  maxResults: number;
  /**
   * Expected embedding width. Optional: when set, KnowledgeService.add rejects
   * vectors of any other length (guarding against a misconfigured provider);
   * when absent, no dimension check is performed.
   */
  vectorDimension?: number;
}

export interface KnowledgeQueryResult {
  entry: KnowledgeEntry;
  similarityScore: number;
  rerankScore?: number;
}

export interface KnowledgeGateway {
  add(text: string, metadata: KnowledgeEntry['metadata']): Promise<KnowledgeEntry>;
  search(query: string, limit?: number): Promise<KnowledgeQueryResult[]>;
  delete(id: string): Promise<boolean>;
  list(limit?: number): Promise<KnowledgeEntry[]>;
  summarize(entryIds?: string[], timeRange?: { after: string; before: string }): Promise<KnowledgeEntry | null>;
}

export interface KnowledgeServiceApi extends KnowledgeGateway {
  listAfter(cursorId?: string, limit?: number): Promise<KnowledgeEntry[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<KnowledgeBaseSettings>;
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

export interface TextModelRequest {
  task: Exclude<ModelTask, 'transcription' | 'embedding' | 'rerank'>;
  input: string;
  context: JsonObject;
  config: ModelConfig;
}

export interface TextModelResponse {
  text: string;
  raw?: unknown;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface SpeechToTextRequest {
  input: {
    audioUrl?: string;
    audioBase64?: string;
    mimeType?: string;
  };
  context: JsonObject;
  config: ModelConfig;
}

export interface SpeechToTextResponse {
  text: string;
  language?: string;
  segments?: Array<{
    startMs?: number;
    endMs?: number;
    text: string;
  }>;
  raw?: unknown;
}

export interface EmbeddingRequest {
  inputs: string[];
  context: JsonObject;
  config: ModelConfig;
}

export interface EmbeddingResponse {
  vectors: number[][];
  raw?: unknown;
}

export interface RerankRequest {
  query: string;
  candidates: string[];
  context: JsonObject;
  config: ModelConfig;
}

export interface RerankResponse {
  ranking: Array<{
    index: number;
    score: number;
  }>;
  raw?: unknown;
}

export interface ModelProvider {
  name: string;
  generateText?(request: TextModelRequest): Promise<TextModelResponse>;
  transcribe?(request: SpeechToTextRequest): Promise<SpeechToTextResponse>;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  rerank?(request: RerankRequest): Promise<RerankResponse>;
  /** 从上游 API 拉取可用模型 id 列表（如 GET /v1/models），供 WebUI 展示 */
  listRemoteModels?(config: ModelConfig): Promise<string[]>;
  /** 测试与上游的连接，返回人类可读的结果（WebUI 测试连接按钮） */
  testConnection?(config: ModelConfig): Promise<string>;
}

export interface ModelGateway {
  generateText(task: TextModelRequest['task'], input: string, context?: JsonObject): Promise<TextModelResponse>;
  transcribe(input: SpeechToTextRequest['input'], context?: JsonObject): Promise<SpeechToTextResponse>;
  embed(inputs: string[], context?: JsonObject): Promise<EmbeddingResponse>;
  rerank(query: string, candidates: string[], context?: JsonObject): Promise<RerankResponse>;
}

export interface ModelAdminGateway extends ModelGateway {
  listFamilies(): ModelFamily[];
  listTasks(): ModelTask[];
  listModels(): Promise<ModelCatalogEntry[]>;
  listModelsByFamily(family: ModelFamily): Promise<ModelCatalogEntry[]>;
  upsertModel(model: ModelConfig): Promise<void>;
  setModelEnabled(modelId: string, enabled: boolean): Promise<void>;
  setActiveModel(task: ModelTask, modelId: string): Promise<void>;
  removeModel(modelId: string): Promise<void>;
  hasOnlyFallbackModels(): Promise<boolean>;
  /** 拉取指定模型配置对应上游的可用模型 id 列表 */
  listRemoteModels(model: ModelConfig): Promise<string[]>;
  /** 测试指定模型配置与上游的连接，返回人类可读结果 */
  testConnection(model: ModelConfig): Promise<string>;
}

export interface BotGateway {
  selfId: string | undefined;
  send(target: SendTarget, message: OutgoingMessage): Promise<SendResult>;
  sendPrivateMessage(userId: string, message: OutgoingMessage): Promise<SendResult>;
  sendGroupMessage(groupId: string, message: OutgoingMessage): Promise<SendResult>;
}

export interface NamespacedStorage {
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>;
  set<T extends JsonValue = JsonValue>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(): Promise<string[]>;
}

/**
 * 内核运行时状态。只含内核组件（策略、传输、模型注册表、插件管理器、WebUI）
 * 自己的数据；插件的业务配置不在此处，每个插件通过 PluginContext.config 访问
 * 自己的配置（存储在插件 storage 命名空间的 `config` 键）。
 */
export interface RuntimeState {
  admins: string[];
  onebot: OneBotClientConfig;
  activeModels: Partial<Record<ModelTask, string>>;
  models: Record<ModelFamily, ModelConfig[]>;
  plugins: Record<string, PluginRuntimeState>;
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

export interface OneBotClientConfig {
  baseUrl: string;
  apiPrefix: string;
  accessToken?: string;
  selfId?: string;
  timeoutMs: number;
  webSocket: OneBotWebSocketConfig;
}

export type OneBotWebSocketMode = 'off' | 'forward' | 'reverse' | 'both';

export interface OneBotWebSocketConfig {
  mode: OneBotWebSocketMode;
  forwardUrl?: string;
  reversePath: string;
  reconnectIntervalMs: number;
  actionTimeoutMs: number;
}

export interface SummarySettings {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  maxEventsPerPrompt: number;
  cursorEventId?: string;
  lastGeneratedAt?: string;
}

export interface UiSettings {
  enabled: boolean;
  title: string;
  authToken?: string;
  password?: string;
}

/**
 * 插件运行时状态。只记录启停；插件自身的配置通过
 * PluginContext.config 存进插件 storage 命名空间，不放在 config.json。
 */
export interface PluginRuntimeState {
  enabled: boolean;
}

/**
 * 插件配置访问器：每个插件用它读写自己的配置。
 * 配置保存在插件 storage 命名空间的 `config` 键下。
 * 用 object（而非 JsonValue）约束：插件的配置接口（SummarySettings 等）
 * 是普通对象类型，没有 JsonObject 的索引签名。
 */
export interface PluginConfigStore<T extends object = JsonObject> {
  /** 读取当前配置；未设置过时返回传入的默认值 */
  get(): Promise<T>;
  /** 基于当前配置调用 mutator 并写回，返回新配置 */
  update(mutator: (config: T) => T): Promise<T>;
  /** 重置为显式传入的配置 */
  reset(config: T): Promise<T>;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  permissions: PluginPermission[];
}

export interface RuntimeReader {
  snapshot(): Promise<RuntimeState>;
}

export interface RuntimeStore extends RuntimeReader {
  update(mutator: (state: RuntimeState) => MaybePromise<void>): Promise<RuntimeState>;
  replace(next: RuntimeState): Promise<RuntimeState>;
}

export interface AppConfigStore extends RuntimeStore {
  snapshotConfig(): Promise<AppConfigFile>;
  snapshotSettings(): Promise<AppSettings>;
  updateSettings(mutator: (settings: AppSettings) => MaybePromise<void>): Promise<AppSettings>;
  replaceSettings(next: AppSettings): Promise<AppSettings>;
  replaceConfig(next: AppConfigFile): Promise<AppConfigFile>;
}

export interface Logger {
  scope: string;
  child(scope: string): Logger;
  debug(message: string, meta?: JsonObject): void;
  info(message: string, meta?: JsonObject): void;
  warn(message: string, meta?: JsonObject): void;
  error(message: string, meta?: JsonObject): void;
}

export interface CommandContext {
  event: NormalizedMessageEvent;
  args: string[];
  bot: BotGateway;
  models: ModelGateway;
  storage: NamespacedStorage;
  config: PluginConfigStore<JsonObject>;
  runtime: RuntimeReader;
  logger: Logger;
  reply(message: OutgoingMessage): Promise<void>;
}

export interface CommandDefinition {
  name: string;
  description: string;
  usage?: string;
  adminOnly?: boolean;
  owner?: string;
  execute(ctx: CommandContext): MaybePromise<string | void>;
}

export interface CommandDispatchResult {
  handled: boolean;
  reply: string | undefined;
  command?: string;
  args?: string[];
}

export interface CommandRegistrar {
  register(command: CommandDefinition): void;
}

export interface SummaryControl {
  flush(reason: string): Promise<SummaryRecord | null>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    maxEventsPerPrompt: number;
    cursorEventId: string | undefined;
    lastGeneratedAt: string | undefined;
  }>;
}

export interface ReplyControl {
  listPending(): Array<{
    id: string;
    createdAt: string;
    sourceEvent: NormalizedMessageEvent;
    status: 'pending' | 'replied' | 'dismissed';
  }>;
  generateReply(
    pending: { id: string; sourceEvent: NormalizedMessageEvent },
    instruction: string,
  ): Promise<{ target: SendTarget; message: OutgoingMessage; reasoning: string }>;
  dismiss(id: string): boolean;
  formatPendingForSummary(): string;
}

export interface KnowledgeControl {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<KnowledgeBaseSettings>;
}

export interface WebUiRouteHandler {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  handler: (payload: JsonObject | undefined, query: Record<string, unknown>) => MaybePromise<JsonObject>;
  label?: string;
  requireAuth?: boolean;
}

export interface WebUiRouteRegistrar {
  register(route: WebUiRouteHandler): void;
}

export interface PluginRuntimeReader {
  snapshot(): Promise<RuntimeState>;
}

export interface PluginContext {
  manifest: PluginManifest;
  bot: BotGateway;
  models: ModelGateway;
  storage: NamespacedStorage;
  /** 插件自己的配置访问器（读写插件 storage 命名空间的 `config` 键） */
  config: PluginConfigStore<JsonObject>;
  commands: CommandRegistrar;
  runtime: PluginRuntimeReader;
  knowledge: KnowledgeGateway | undefined;
  summaryControl: SummaryControl | undefined;
  replyControl: ReplyControl | undefined;
  knowledgeControl: KnowledgeControl | undefined;
  webui: WebUiRouteRegistrar | undefined;
  logger: Logger;
}

export interface PluginHooks {
  onMessage?(event: NormalizedMessageEvent, ctx: PluginContext): MaybePromise<void>;
  onAdminMessage?(event: NormalizedMessageEvent, ctx: PluginContext): MaybePromise<void>;
  onSummaryReady?(summary: SummaryRecord, ctx: PluginContext): MaybePromise<void>;
  onAdviceReady?(advice: AdviceRecord, ctx: PluginContext): MaybePromise<void>;
  onShutdown?(ctx: PluginContext): MaybePromise<void>;
}

export interface BotPlugin {
  manifest: PluginManifest;
  setup(ctx: PluginContext): MaybePromise<void>;
  hooks?: PluginHooks;
  teardown?(ctx: PluginContext): MaybePromise<void>;
}

export interface PluginModule {
  default?: BotPlugin;
  plugin?: BotPlugin;
  createPlugin?: () => MaybePromise<BotPlugin>;
}

export interface OneBotActionResponse<T = unknown> {
  status: string;
  retcode?: number;
  data?: T;
  echo?: string;
  message?: string;
}

export interface SummaryGenerationContext {
  events: NormalizedMessageEvent[];
  recipients: string[];
  cursorEventId?: string;
}

export interface AdviceGenerationContext {
  event: NormalizedMessageEvent;
  recentSummaries: SummaryRecord[];
}

export interface AppServices {
  runtime: RuntimeStore;
  bot: BotGateway;
  models: ModelAdminGateway;
  storage: {
    appendEvent(event: NormalizedMessageEvent): Promise<boolean>;
    listEventsAfter(cursorEventId?: string, limit?: number): Promise<NormalizedMessageEvent[]>;
    appendSummary(summary: SummaryRecord): Promise<void>;
    listSummaries(limit?: number): Promise<SummaryRecord[]>;
    appendAdvice(advice: AdviceRecord): Promise<void>;
    listAdvice(limit?: number): Promise<AdviceRecord[]>;
    appendCommand(record: CommandRecord): Promise<void>;
    listCommands(limit?: number): Promise<CommandRecord[]>;
    appendKnowledgeEntry(entry: KnowledgeEntry): Promise<void>;
    listKnowledgeEntries(limit?: number): Promise<KnowledgeEntry[]>;
    listKnowledgeEntriesAfter(cursorId?: string, limit?: number): Promise<KnowledgeEntry[]>;
    countKnowledgeEntries(): Promise<number>;
    deleteKnowledgeEntry(id: string): Promise<string | false>;
    namespace(name: string): NamespacedStorage;
  };
  commands: {
    register(definition: CommandDefinition): void;
    dispatch(event: NormalizedMessageEvent): Promise<CommandDispatchResult>;
    list(): CommandDefinition[];
    unregisterOwner(owner: string): void;
  };
  plugins: {
    load(): Promise<void>;
    dispatchMessage(event: NormalizedMessageEvent): Promise<void>;
    dispatchSummary(summary: SummaryRecord): Promise<void>;
    dispatchAdvice(advice: AdviceRecord): Promise<void>;
    shutdown(): Promise<void>;
    list(): Promise<Array<{ name: string; version: string; enabled: boolean; description: string | undefined; filePath?: string }>>;
    setEnabled(name: string, enabled: boolean): Promise<void>;
    reload(): Promise<void>;
    reloadOne(name: string): Promise<void>;
    collectWebUiRoutes(): Array<{ owner: string; route: WebUiRouteHandler }>;
  };
  summaries?: {
    flush(reason: string): Promise<SummaryRecord | null>;
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): Promise<{
      enabled: boolean;
      intervalMs: number;
      batchSize: number;
      cursorEventId: string | undefined;
      lastGeneratedAt: string | undefined;
    }>;
  };
  knowledge?: KnowledgeServiceApi;
  appLogger: Logger;
}
