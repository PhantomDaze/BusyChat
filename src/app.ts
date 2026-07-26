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
  CommandDispatchResult,
  CommandRecord,
  JsonObject,
  NormalizedMessageEvent,
  OneBotIncomingEvent,
} from './types';
import { createWebServer } from './webui';

/** Parse an HH:MM string to minutes-since-midnight, or null if malformed. */
function parseHhmm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** Robust quiet-hours check that handles overnight windows and un-padded times. */
function isWithinQuietHours(nowMinutes: number, start: string, end: string): boolean {
  const s = parseHhmm(start);
  const e = parseHhmm(end);
  if (s === null || e === null || s === e) return false;
  return s < e
    ? nowMinutes >= s && nowMinutes < e
    : nowMinutes >= s || nowMinutes < e;
}

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
    await this.logStartupChecklist();
  }

  /**
   * One-glance startup summary with actionable hints for anything missing.
   * New deployments otherwise hit a chicken-and-egg: with no admins configured
   * nobody can run commands, and nothing tells the operator what to do next.
   */
  private async logStartupChecklist(): Promise<void> {
    try {
      const runtime = await this.runtime.snapshot();
      const fallbackOnly = await this.models.hasOnlyFallbackModels();
      const displayHost =
        this.settings.host === '0.0.0.0' || this.settings.host === '::'
          ? '127.0.0.1'
          : this.settings.host;
      const uiUrl = `http://${displayHost}:${this.settings.port}${this.settings.uiPath}`;
      const ws = runtime.onebot.webSocket;

      const lines: string[] = ['── 启动自检 ──'];
      lines.push(`WebUI:   ${uiUrl}${runtime.ui.password ? '' : '（未设密码，任何人可访问 — 请在 WebUI「管理员」页设置）'}`);
      lines.push(
        runtime.admins.length > 0
          ? `管理员:  ${runtime.admins.length} 个（${runtime.admins.join(', ')}）`
          : '管理员:  未配置 — 摘要无法送达，且没人能使用命令。请在 WebUI「管理员」页添加你的 QQ 号',
      );
      lines.push(
        fallbackOnly
          ? 'AI模型:  仅规则回退 — 摘要/回复将输出占位文本。请在 WebUI「模型」页配置真实模型'
          : 'AI模型:  已配置真实模型',
      );
      lines.push(
        ws.mode === 'off'
          ? 'OneBot:  WebSocket 已关闭 — 请在 WebUI「WS」页选择 forward 或 reverse 模式'
          : `OneBot:  ${ws.mode}${ws.mode !== 'reverse' ? ` → ${ws.forwardUrl || '(未填地址)'}` : ''}${ws.mode !== 'forward' ? ` | 反向路径 ${ws.reversePath}` : ''}`,
      );

      for (const line of lines) {
        this.logger.info(line);
      }
    } catch (error) {
      this.logger.warn('startup checklist failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop(): Promise<void> {
    // The store flush is the one step that loses data if skipped, so it runs
    // in a finally: a throw from any teardown step above must not bypass it.
    try {
      await this.oneBotWebSocket.dispose();
      await this.summaries.stop();
      await this.knowledge.stop();
      await this.plugins.shutdown();
      if (this.server) {
        await this.server.stop();
        this.server = null;
      }
    } finally {
      await this.store.close();
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

    void this.plugins.dispatchMessage(event).catch((error) => {
      this.logger.warn('plugin dispatch failed', {
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Classify non-admin non-bot messages for potential reply requests
    if (!event.visibility.fromAdmin && !event.visibility.fromBot) {
      void this.replies
        .classifyMessage(event)
        .then((needsReply) => {
          if (needsReply) this.replies.addPending(event);
        })
        .catch((error) => {
          this.logger.warn('reply classification failed', {
            eventId: event.id,
            error: error instanceof Error ? error.message : String(error),
          });
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
            inQuiet = isWithinQuietHours(now.getHours() * 60 + now.getMinutes(), qh.start, qh.end);
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
        // A throwing command handler must still produce an audit record and a
        // reply — otherwise the admin gets complete silence and the only trace
        // is a transport-level log line.
        let result: CommandDispatchResult;
        let failure: string | undefined;
        try {
          result = await this.commands.dispatch(event);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          this.logger.error('command execution failed', {
            eventId: event.id,
            text: event.content.text.slice(0, 120),
            error: failure,
          });
          result = { handled: false, reply: `命令执行失败: ${failure}` };
        }

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

        if (failure) {
          await this.bot
            .sendPrivateMessage(event.sender.userId, result.reply ?? `命令执行失败: ${failure}`)
            .catch(() => {});
        } else if (!result.handled || !result.reply) {
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
