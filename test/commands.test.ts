/**
 * Command Bus Tests
 *
 * Verifies builtin command registration and admin-only enforcement.
 *
 * Run: npx tsx test/commands.test.ts
 */

import { registerBuiltinCommands, CommandBus } from '../src/commands';
import type {
  AppServices,
  CommandDispatchResult,
  JsonObject,
  Logger,
  ModelAdminGateway,
  NormalizedMessageEvent,
  NamespacedStorage,
  RuntimeStore,
  RuntimeState,
  SendResult,
  SendTarget,
  OutgoingMessage,
  SummaryRecord,
  AdviceRecord,
} from '../src/types';

let testsPassed = 0;
let testsFailed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    testsPassed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    testsFailed += 1;
    console.log(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createMockLogger(name: string): Logger {
  return {
    scope: name,
    child: (scope: string) => createMockLogger(`${name}:${scope}`),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createMockRuntimeStore(overrides: Partial<RuntimeState> = {}): RuntimeStore {
  const state: RuntimeState = {
    admins: ['10001'],
    onebot: {
      baseUrl: 'http://127.0.0.1:5700',
      apiPrefix: '/api',
      timeoutMs: 5000,
      webSocket: {
        mode: 'off',
        reversePath: '/onebot/ws',
        reconnectIntervalMs: 5000,
        actionTimeoutMs: 3000,
      },
    },
    summary: {
      enabled: false,
      intervalMs: 120000,
      batchSize: 20,
      maxEventsPerPrompt: 40,
    },
    knowledgeBase: {
      enabled: true,
      maxResults: 10,
      vectorDimension: 8,
    },
    activeModels: {},
    models: { language: [], 'speech-to-text': [], embedding: [], rerank: [] },
    plugins: {},
    ui: { enabled: false, title: 'Test' },
    notifyKeywords: [],
    ...overrides,
  };

  return {
    async snapshot(): Promise<RuntimeState> {
      return JSON.parse(JSON.stringify(state)) as RuntimeState;
    },
    async update(mutator): Promise<RuntimeState> {
      await mutator(state);
      return JSON.parse(JSON.stringify(state)) as RuntimeState;
    },
    async replace(next: RuntimeState): Promise<RuntimeState> {
      Object.assign(state, next);
      return JSON.parse(JSON.stringify(state)) as RuntimeState;
    },
  };
}

function createMockStorage(): AppServices['storage'] {
  const namespaces = new Map<string, Map<string, unknown>>();
  const namespace = (name: string): NamespacedStorage => {
    if (!namespaces.has(name)) {
      namespaces.set(name, new Map<string, unknown>());
    }
    const bucket = namespaces.get(name)!;
    return {
      async get<T>(key: string): Promise<T | undefined> {
        return bucket.get(key) as T | undefined;
      },
      async set<T>(key: string, value: T): Promise<void> {
        bucket.set(key, value);
      },
      async delete(key: string): Promise<void> {
        bucket.delete(key);
      },
      async listKeys(): Promise<string[]> {
        return [...bucket.keys()];
      },
    };
  };

  return {
    async appendEvent(): Promise<boolean> {
      return true;
    },
    async listEventsAfter(): Promise<never[]> {
      return [];
    },
    async appendSummary(): Promise<void> {},
    async listSummaries(): Promise<SummaryRecord[]> {
      return [];
    },
    async appendAdvice(): Promise<void> {},
    async listAdvice(): Promise<AdviceRecord[]> {
      return [];
    },
    async appendCommand(): Promise<void> {},
    async listCommands(): Promise<never[]> {
      return [];
    },
    async appendKnowledgeEntry(): Promise<void> {},
    async listKnowledgeEntries(): Promise<never[]> {
      return [];
    },
    async listKnowledgeEntriesAfter(): Promise<never[]> {
      return [];
    },
    async deleteKnowledgeEntry(): Promise<boolean> {
      return false;
    },
    namespace,
  };
}

function createMockModels(): ModelAdminGateway {
  return {
    async generateText() {
      return { text: 'mock' };
    },
    async transcribe() {
      return { text: 'mock' };
    },
    async embed() {
      return { vectors: [] };
    },
    async rerank() {
      return { ranking: [] };
    },
    listFamilies() {
      return ['language', 'speech-to-text', 'embedding', 'rerank'];
    },
    listTasks() {
      return ['summary', 'advice', 'chat', 'classifier', 'moderation', 'memory-summary', 'transcription', 'embedding', 'rerank'];
    },
    async listModels() {
      return [];
    },
    async listModelsByFamily() {
      return [];
    },
    async upsertModel() {},
    async setModelEnabled() {},
    async setActiveModel() {},
    async removeModel() {},
    async hasOnlyFallbackModels() {
      return true;
    },
  };
}

function createServices(botSendLog: Array<{ target: SendTarget; message: OutgoingMessage }>): AppServices {
  return {
    runtime: createMockRuntimeStore(),
    bot: {
      selfId: undefined,
      async send(target: SendTarget, message: OutgoingMessage): Promise<SendResult> {
        botSendLog.push({ target, message });
        return { raw: {}, messageId: 1 };
      },
      async sendPrivateMessage(userId: string, message: OutgoingMessage): Promise<SendResult> {
        botSendLog.push({ target: { type: 'private', id: userId }, message });
        return { raw: {}, messageId: 1 };
      },
      async sendGroupMessage(groupId: string, message: OutgoingMessage): Promise<SendResult> {
        botSendLog.push({ target: { type: 'group', id: groupId }, message });
        return { raw: {}, messageId: 1 };
      },
    },
    models: createMockModels(),
    storage: createMockStorage(),
    commands: {
      register: () => {},
      async dispatch(): Promise<CommandDispatchResult> {
        return { handled: false, reply: undefined };
      },
      list: () => [],
      unregisterOwner: () => {},
    },
    plugins: {
      async load() {},
      async dispatchMessage() {},
      async dispatchSummary() {},
      async dispatchAdvice() {},
      async shutdown() {},
      async list() {
        return [];
      },
      async setEnabled() {},
      async reload() {},
    },
    summaries: {
      async flush() {
        return null;
      },
      async start() {},
      async stop() {},
      async status() {
        return {
          enabled: false,
          intervalMs: 120000,
          batchSize: 20,
          cursorEventId: undefined,
          lastGeneratedAt: undefined,
        };
      },
    },
    knowledge: {
      async add() {
        throw new Error('not implemented');
      },
      async search() {
        return [];
      },
      async delete() {
        return false;
      },
      async list() {
        return [];
      },
      async summarize() {
        return null;
      },
      async listAfter() {
        return [];
      },
      async start() {},
      async stop() {},
      async status() {
        return {
          enabled: true,
          maxResults: 10,
          vectorDimension: 8,
        };
      },
    },
    appLogger: createMockLogger('test'),
  };
}

function createEvent(overrides: Partial<NormalizedMessageEvent> = {}): NormalizedMessageEvent {
  return {
    id: 'event-1',
    source: 'onebot-v11',
    receivedAt: new Date().toISOString(),
    botSelfId: undefined,
    scope: 'private',
    conversationId: 'private:10002',
    messageId: 1,
    sender: {
      userId: '10002',
      nickname: 'user',
      card: undefined,
      role: undefined,
      isAdmin: false,
      isBot: false,
    },
    content: {
      text: '/help',
      segments: [],
      rawText: '/help',
    },
    raw: {
      post_type: 'message',
      message_type: 'private',
      user_id: 10002,
      message: '/help',
    } as JsonObject as NormalizedMessageEvent['raw'],
    visibility: {
      fromAdmin: false,
      fromBot: false,
      includeInReports: true,
      eligibleForAdvice: false,
    },
    ...overrides,
  };
}

async function main(): Promise<void> {
  const botSendLog: Array<{ target: SendTarget; message: OutgoingMessage }> = [];
  const services = createServices(botSendLog);
  const commands = new CommandBus({
    bot: services.bot,
    models: services.models,
    storage: services.storage,
    runtime: services.runtime,
    appLogger: services.appLogger,
  });

  registerBuiltinCommands({
    ...services,
    commands,
  });

  await test('/help is registered as admin-only', async () => {
    const help = commands.list().find((command) => command.name === 'help');
    assert(help !== undefined, 'help command should exist');
    assert(help!.adminOnly === true, 'help should require admin permission');
  });

  await test('non-admin users cannot use admin commands', async () => {
    const adminCommands = commands.list().filter((command) => command.adminOnly);
    assert(adminCommands.length > 0, 'should have admin commands registered');

    for (const command of adminCommands) {
      const before = botSendLog.length;
      const result = await commands.dispatch(
        createEvent({ content: { text: `/${command.name}`, segments: [], rawText: `/${command.name}` } }),
      );
      assert(result.handled, `/${command.name} should be handled`);
      assert(result.reply === undefined, `/${command.name} should be rejected silently`);
      assert(botSendLog.length === before, `/${command.name} should not send any reply message`);
    }
  });

  await test('admins can use /help', async () => {
    const result = await commands.dispatch(
      createEvent({
        sender: {
          userId: '10001',
          nickname: 'admin',
          card: undefined,
          role: undefined,
          isAdmin: true,
          isBot: false,
        },
        visibility: {
          fromAdmin: true,
          fromBot: false,
          includeInReports: false,
          eligibleForAdvice: true,
        },
        conversationId: 'private:10001',
        content: { text: '/help', segments: [], rawText: '/help' },
        raw: {
          post_type: 'message',
          message_type: 'private',
          user_id: 10001,
          message: '/help',
        } as JsonObject as NormalizedMessageEvent['raw'],
      }),
    );
    assert(result.handled, 'admin command should be handled');
    assert(typeof result.reply === 'string' && result.reply.includes('所有可用命令'), 'should return help text');
    assert(botSendLog.length === 1, 'should send help reply once');
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Total: ${testsPassed + testsFailed}  |  Passed: ${testsPassed}  |  Failed: ${testsFailed}`);
  console.log(`${'='.repeat(50)}`);

  if (testsFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
