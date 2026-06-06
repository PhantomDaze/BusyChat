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
  | 'knowledge:write';

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
  vectorDimension: number;
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

export interface RuntimeState {
  admins: string[];
  onebot: OneBotClientConfig;
  summary: SummarySettings;
  knowledgeBase: KnowledgeBaseSettings;
  activeModels: Partial<Record<ModelTask, string>>;
  models: Record<ModelFamily, ModelConfig[]>;
  plugins: Record<string, PluginRuntimeState>;
  ui: UiSettings;
  notifyKeywords: string[];
  quietHours?: { start: string; end: string };
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

export interface PluginRuntimeState {
  enabled: boolean;
  config: JsonObject;
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

export interface PluginRuntimeReader {
  snapshot(): Promise<RuntimeState>;
}

export interface PluginContext {
  manifest: PluginManifest;
  bot: BotGateway;
  models: ModelGateway;
  storage: NamespacedStorage;
  commands: CommandRegistrar;
  runtime: PluginRuntimeReader;
  knowledge: KnowledgeGateway | undefined;
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
    deleteKnowledgeEntry(id: string): Promise<boolean>;
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
    list(): Promise<Array<{ name: string; version: string; enabled: boolean; description: string | undefined }>>;
    setEnabled(name: string, enabled: boolean): Promise<void>;
    reload(): Promise<void>;
  };
  summaries: {
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
  knowledge: KnowledgeServiceApi;
  appLogger: Logger;
}
