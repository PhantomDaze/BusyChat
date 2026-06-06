import type Hapi from '@hapi/hapi';

import { createDefaultAppSettings, createDefaultRuntimeState } from './config';
import { DEFAULT_CONFIG_PATH, JsonConfigStore } from './config-store';
import { registerBuiltinCommands, CommandBus } from './commands';
import { KnowledgeService } from './knowledge';
import { createLogger } from './logger';
import { ModelRegistry } from './models';
import { normalizeOneBotMessageEvent, OneBotClient } from './onebot';
import { OneBotWebSocketTransport } from './onebot-ws';
import { AdminPolicy } from './policies';
import { PluginManager } from './plugins';
import { ReplyManager } from './reply';
import { SummaryWorker } from './summary';
import { FileStore } from './storage';
import type {
  AppServices,
  AppSettings,
  CommandRecord,
  JsonObject,
  NormalizedMessageEvent,
  OneBotIncomingEvent,
} from './types';
import { createWebServer } from './webui';

export class BotApplication {
  readonly settings: AppSettings;
  readonly logger = createLogger('f261agent');
  readonly store: FileStore;
  readonly config: JsonConfigStore;
  readonly runtime: JsonConfigStore;
  readonly bot: OneBotClient;
  readonly oneBotWebSocket: OneBotWebSocketTransport;
  readonly models: ModelRegistry;
  readonly commands: CommandBus;
  readonly plugins: PluginManager;
  readonly summaries: SummaryWorker;
  readonly knowledge: KnowledgeService;
  readonly policy: AdminPolicy;
  readonly replies: ReplyManager;
  readonly services: AppServices;
  private server: Hapi.Server | null = null;

  constructor(settings = createDefaultAppSettings(), configPath = DEFAULT_CONFIG_PATH) {
    this.settings = settings;
    this.store = new FileStore(settings.dataDir);
    this.config = new JsonConfigStore(configPath);
    this.runtime = this.config;
    this.bot = new OneBotClient(this.runtime);
    this.oneBotWebSocket = new OneBotWebSocketTransport({
      runtime: this.runtime,
      appLogger: this.logger.child('onebot-ws'),
      handleIncomingEvent: this.handleIncomingEvent.bind(this),
    });
    this.bot.setActionTransport(this.oneBotWebSocket);
    this.models = new ModelRegistry(this.runtime, this.logger.child('models'));
    this.replies = new ReplyManager({
      models: this.models,
      appLogger: this.logger.child('replies'),
    });
    this.commands = new CommandBus({
      bot: this.bot,
      models: this.models,
      storage: this.store,
      runtime: this.runtime,
      appLogger: this.logger.child('commands'),
    });

    this.knowledge = new KnowledgeService({
      runtime: this.runtime,
      storage: this.store,
      models: this.models,
      appLogger: this.logger.child('knowledge'),
    });

    this.plugins = new PluginManager({
      runtime: this.runtime,
      bot: this.bot,
      models: this.models,
      storage: this.store,
      commands: this.commands,
      knowledge: this.knowledge,
      appLogger: this.logger.child('plugins'),
      pluginSearchDirs: this.settings.pluginSearchDirs,
    });
    this.summaries = new SummaryWorker({
      runtime: this.runtime,
      storage: this.store,
      bot: this.bot,
      models: this.models,
      plugins: this.plugins,
      replies: this.replies,
      appLogger: this.logger.child('summaries'),
    });

    this.policy = new AdminPolicy(createDefaultRuntimeState());

    this.services = {
      runtime: this.runtime,
      bot: this.bot,
      models: this.models,
      storage: this.store,
      commands: this.commands,
      plugins: this.plugins,
      summaries: this.summaries,
      knowledge: this.knowledge,
      appLogger: this.logger,
    };
  }

  async initialize(): Promise<void> {
    await this.config.ensureReady();
    await this.store.ensureReady();

    // Warn if only fallback models are configured
    if (await this.models.hasOnlyFallbackModels()) {
      this.logger.warn('============================================================');
      this.logger.warn('NO REAL AI MODELS CONFIGURED — only rule-based fallbacks.');
      this.logger.warn('Summaries, advice, and replies will produce placeholder text.');
      this.logger.warn('Add a real model in config.json or WebUI. Example providers:');
      this.logger.warn('  DeepSeek: https://api.deepseek.com/v1');
      this.logger.warn('  OpenAI-compatible endpoints at /v1/chat/completions');
      this.logger.warn('============================================================');
    }

    await this.knowledge.start();
    const runtime = await this.runtime.snapshot();
    this.policy.updateRuntime(runtime);
    registerBuiltinCommands(this.services, this.replies);
    await this.plugins.load();
    await this.summaries.start();
    this.server = await createWebServer({
      settings: this.settings,
      config: this.config,
      runtime: this.runtime,
      models: this.models,
      plugins: this.plugins,
      summaries: this.summaries,
      knowledge: this.knowledge,
      storage: this.store,
      oneBotWebSocket: this.oneBotWebSocket,
      handleIncomingEvent: this.handleIncomingEvent.bind(this),
      appLogger: this.logger.child('webui'),
    });
    this.oneBotWebSocket.attachReverse(this.server.listener);
    await this.oneBotWebSocket.start();
  }

  async start(): Promise<void> {
    if (!this.server) {
      await this.initialize();
    }

    if (!this.server) {
      throw new Error('web server failed to initialize');
    }

    await this.server.start();
    this.logger.info('server started', { uri: this.server.info.uri });
  }

  async stop(): Promise<void> {
    await this.oneBotWebSocket.stop();
    await this.summaries.stop();
    await this.knowledge.stop();
    await this.plugins.shutdown();
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
  }

  async handleIncomingEvent(payload: JsonObject, _headers: Record<string, unknown>): Promise<{
    accepted: boolean;
    duplicate?: boolean;
    ignored?: boolean;
    commandHandled?: boolean;
  }> {
    const runtime = await this.runtime.snapshot();
    this.policy.updateRuntime(runtime);

    const event = normalizeOneBotMessageEvent(payload as OneBotIncomingEvent, runtime);
    if (!event) {
      return { accepted: false, ignored: true };
    }

    const accepted = await this.store.appendEvent(event);
    if (!accepted) {
      return { accepted: false, duplicate: true };
    }

    if (event.visibility.fromBot) {
      this.logger.debug('bot message ignored by pipelines', { eventId: event.id });
      return { accepted: true, ignored: true };
    }

    void this.plugins.dispatchMessage(event);

    // Classify non-admin non-bot messages for potential reply requests
    if (!event.visibility.fromAdmin && !event.visibility.fromBot) {
      void this.replies.classifyMessage(event).then((needsReply) => {
        if (needsReply) this.replies.addPending(event);
      });

      // Keyword notification: instantly notify admins of matching messages
      const keywords = runtime.notifyKeywords;
      if (keywords && keywords.length > 0) {
        const text = event.content.text.toLowerCase();
        const matched = keywords.find((kw) => text.includes(kw.toLowerCase()));
        if (matched) {
          // Check quiet hours
          const qh = runtime.quietHours;
          let inQuiet = false;
          if (qh) {
            const now = new Date();
            const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
            inQuiet = qh.start <= qh.end
              ? hhmm >= qh.start && hhmm < qh.end
              : hhmm >= qh.start || hhmm < qh.end;
          }

          if (!inQuiet) {
            const sender = event.sender.nickname ?? event.sender.userId;
            const scope = event.scope === 'group'
              ? `群 ${event.conversationId.replace(/^group:/, '')}`
              : '私聊';
            const alert = `🔔 关键词告警: "${matched}"\n发送者: ${sender} (${event.sender.userId})\n来源: ${scope}\n内容: ${event.content.text.slice(0, 300)}`;
            for (const adminId of runtime.admins) {
              void this.bot.sendPrivateMessage(adminId, alert).catch(() => {});
            }
          }
        }
      }
    }

    if (event.visibility.fromAdmin) {
      const isCommand = event.content.text.trim().startsWith('/');
      if (isCommand) {
        const result = await this.commands.dispatch(event);
        const record: CommandRecord = {
          id: `${event.id}:cmd`,
          createdAt: new Date().toISOString(),
          eventId: event.id,
          command: result.command ?? 'unknown',
          args: result.args ?? [],
          handled: result.handled,
          reply: result.reply,
        };
        await this.store.appendCommand(record);

        if (!result.handled || !result.reply) {
          await this.bot.sendPrivateMessage(
            event.sender.userId,
            '未识别命令，发送 /help 查看可用命令。',
          );
        }

        return { accepted: true, commandHandled: result.handled };
      }

      if (this.policy.shouldGenerateAdvice(event)) {
        await this.summaries.advise(event);
        return { accepted: true };
      }

      return { accepted: true };
    }

    return { accepted: true };
  }
}
