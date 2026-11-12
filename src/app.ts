import type Hapi from '@hapi/hapi';

import { createDefaultAppSettings, createDefaultRuntimeState } from './config';
import { DEFAULT_CONFIG_PATH, JsonConfigStore } from './config-store';
import { CommandBus } from './commands';
import { registerBuiltinPlugins } from './builtin';
import { createLogger } from './logger';
import { ModelRegistry } from './models';
import { normalizeOneBotMessageEvent, OneBotClient } from './onebot';
import { OneBotWebSocketTransport } from './onebot-ws';
import { AdminPolicy } from './policies';
import { PluginManager } from './plugins';
import { hashPassword, isLoopbackAddress } from './security';
import { FileStore } from './storage';
import type {
  AppServices,
  AppSettings,
  CommandDispatchResult,
  CommandRecord,
  JsonObject,
  JsonValue,
  NormalizedMessageEvent,
  OneBotIncomingEvent,
} from './types';
import { createWebServer } from './webui';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
  readonly policy: AdminPolicy;
  readonly services: AppServices;
  private server: Hapi.Server | null = null;
  /** 内置服务句柄，由内置插件在 setup 时填充，用于优雅关闭 */
  private builtinStoppers: Array<() => Promise<void>> = [];

  constructor(settings = createDefaultAppSettings(), configPath = DEFAULT_CONFIG_PATH) {
    this.settings = settings;
    this.store = new FileStore(settings.dataDir);
    this.config = new JsonConfigStore(configPath);
    this.runtime = this.config;
    this.bot = new OneBotClient(this.runtime);
    this.oneBotWebSocket = new OneBotWebSocketTransport({
      runtime: this.runtime,
      appLogger: this.logger.child('onebot-ws'),
      trustProxy: settings.trustProxy === true,
      handleIncomingEvent: this.handleIncomingEvent.bind(this),
    });
    this.bot.setActionTransport(this.oneBotWebSocket);
    this.models = new ModelRegistry(this.runtime, this.logger.child('models'));

    // CommandBus 是内核基础设施（插件需要注册命令），在内核构造
    this.commands = new CommandBus({
      bot: this.bot,
      models: this.models,
      storage: this.store,
      runtime: this.runtime,
      appLogger: this.logger.child('commands'),
    });

    // KnowledgeService 引用：由内置 knowledge 插件在 setup 时填充
    // PluginManager 通过 services.knowledge 向其他插件暴露知识库网关
    this.plugins = new PluginManager({
      runtime: this.runtime,
      bot: this.bot,
      models: this.models,
      storage: this.store,
      commands: this.commands,
      knowledge: undefined,
      appLogger: this.logger.child('plugins'),
      pluginSearchDirs: this.settings.pluginSearchDirs,
    });

    this.policy = new AdminPolicy(createDefaultRuntimeState());

    this.services = {
      runtime: this.runtime,
      bot: this.bot,
      models: this.models,
      storage: this.store,
      commands: this.commands,
      plugins: this.plugins,
      appLogger: this.logger,
    } as AppServices;
  }

  /** 内置插件在 setup 时调用，注入 knowledge 服务引用（供其他插件使用） */
  setKnowledgeService(knowledge: AppServices['knowledge']): void {
    (this.plugins as unknown as { deps: { knowledge: AppServices['knowledge'] } }).deps.knowledge = knowledge;
    (this.services as { knowledge: AppServices['knowledge'] | undefined }).knowledge = knowledge;
  }

  /** 内置插件在 setup 时调用，注入 summary 服务引用 */
  setSummaryService(summaries: AppServices['summaries']): void {
    (this.services as { summaries: AppServices['summaries'] | undefined }).summaries = summaries;
  }

  /**
   * 一次性迁移：把旧版 config.json runtime 里的业务配置（summary /
   * knowledgeBase / notifyKeywords / quietHours，以及 plugins.*.config 残留）
   * 搬进各内置插件的 storage 命名空间（config 键），随后写回干净的 config.json。
   * 幂等：迁移完成即重写 config.json，下次启动旧字段已不存在，直接跳过。
   * 注意必须读原始文件——normalize 在加载时已经把这些字段丢弃了。
   */
  private async migrateLegacyPluginConfigs(): Promise<void> {
    const raw = await this.config.readRawConfig();
    const legacy = raw?.runtime;
    if (!legacy || typeof legacy !== 'object') return;

    const legacyRuntime = legacy as unknown as Record<string, unknown>;
    let migrated = 0;
    let disableKnowledge = false;

    if (isPlainObject(legacyRuntime.summary)) {
      await this.store.namespace('builtin-summary').set('config', legacyRuntime.summary as JsonValue);
      migrated += 1;
    }
    if (isPlainObject(legacyRuntime.knowledgeBase)) {
      // 知识库开关迁移到插件启用状态：旧 enabled=false → 禁用 builtin-knowledge。
      // 存储的 config 不带冗余的 enabled（status() 会用插件状态覆盖）。
      const kb = legacyRuntime.knowledgeBase as Record<string, unknown>;
      const { enabled: legacyEnabled, ...rest } = kb;
      await this.store.namespace('builtin-knowledge').set('config', rest as unknown as JsonValue);
      if (legacyEnabled === false) disableKnowledge = true;
      migrated += 1;
    }
    if (Array.isArray(legacyRuntime.notifyKeywords) || legacyRuntime.quietHours !== undefined) {
      await this.store.namespace('builtin-notify').set('config', {
        notifyKeywords: Array.isArray(legacyRuntime.notifyKeywords)
          ? legacyRuntime.notifyKeywords.filter((k): k is string => typeof k === 'string')
          : [],
        quietHours: legacyRuntime.quietHours ?? null,
      } as unknown as JsonValue);
      migrated += 1;
    }

    // 插件条目里残留的 config（旧 PluginRuntimeState 曾携带 config 对象）
    const plugins = legacyRuntime.plugins;
    const pluginConfigResidue =
      isPlainObject(plugins) &&
      Object.values(plugins as Record<string, unknown>).some(
        (p) => isPlainObject(p) && (p as Record<string, unknown>).config !== undefined,
      );

    if (migrated === 0 && !pluginConfigResidue) return;

    this.logger.info('legacy plugin configs migrated into plugin storage', {
      namespaces: migrated,
      pluginConfigResidue,
    });

    // 先强制把插件命名空间的写入落盘，再清理 config.json——若中途崩溃，
    // config.json 仍保留旧字段，下次启动会重新迁移（幂等），不会丢数据。
    await this.store.flush();

    // 用规范化后的 runtime 整体写回：旧业务字段与 plugins.*.config 残留一并消失，
    // `_comment` 文档键（preserveCommentKeys）会保留。
    const nextRuntime = await this.runtime.snapshot();
    if (disableKnowledge) {
      nextRuntime.plugins['builtin-knowledge'] = { enabled: false };
    }
    await this.runtime.replace(nextRuntime);
  }

  /**
   * 把旧版明文 runtime.ui.password 迁移为 scrypt 摘要。幂等：迁移后明文被删除，
   * 下次启动直接跳过。
   */
  private async migrateLegacyUiPassword(): Promise<void> {
    const runtime = await this.runtime.snapshot();
    const plaintext = runtime.ui.password;
    if (!plaintext || runtime.ui.passwordHash) return;

    // 少于 6 位的旧密码不迁移成摘要：否则弱密码会以「有效凭据」的身份
    // 继续允许远程登录。直接删除明文，退回「仅本机可设置新密码」的安全状态。
    if (plaintext.length < 6) {
      await this.runtime.update((state) => {
        if (!state.ui.password || state.ui.passwordHash) return;
        delete state.ui.password;
      });
      this.logger.warn(
        'legacy WebUI password was shorter than 6 characters and has been removed; ' +
          'set a new password from a browser on the local machine',
      );
      return;
    }

    const passwordHash = await hashPassword(plaintext);
    await this.runtime.update((state) => {
      if (!state.ui.password || state.ui.passwordHash) return;
      state.ui.passwordHash = passwordHash;
      delete state.ui.password;
    });
    this.logger.info('legacy WebUI plaintext password migrated to passwordHash');
  }

  async initialize(): Promise<void> {
    await this.config.ensureReady();
    await this.migrateLegacyUiPassword();
    await this.store.ensureReady();
    await this.migrateLegacyPluginConfigs();

    if (await this.models.hasOnlyFallbackModels()) {
      this.logger.warn('============================================================');
      this.logger.warn('NO REAL AI MODELS CONFIGURED — only rule-based fallbacks.');
      this.logger.warn('Summaries, advice, and replies will produce placeholder text.');
      this.logger.warn('Add a real model in config.json or WebUI. Example providers:');
      this.logger.warn('  DeepSeek: https://api.deepseek.com/v1');
      this.logger.warn('  OpenAI-compatible endpoints at /v1/chat/completions');
      this.logger.warn('============================================================');
    }

    // 注册内置插件（summary/knowledge/reply/commands/notify）
    await registerBuiltinPlugins(this.plugins, this.services, this);

    const runtime = await this.runtime.snapshot();
    this.policy.updateRuntime(runtime);
    await this.plugins.load();
    this.server = await createWebServer({
      settings: this.settings,
      config: this.config,
      runtime: this.runtime,
      models: this.models,
      plugins: this.plugins,
      knowledge: this.services.knowledge,
      summaries: this.services.summaries,
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
      const hostIsLoopback = isLoopbackAddress(this.settings.host);
      const hasAccessToken = Boolean(runtime.onebot.accessToken);
      const wsRemoteExposed = ws.mode === 'reverse' || ws.mode === 'both';
      const uiAuthMode = runtime.ui.passwordHash
        ? '已设置密码（scrypt 摘要）'
        : runtime.ui.password
          ? '旧版明文密码（启动时已迁移为摘要）'
          : runtime.ui.authToken
            ? '仅旧版 authToken'
            : '未设密码 — 仅允许本机直连，远程请求会被拒绝';

      const lines: string[] = ['── 启动自检 ──'];
      lines.push(`WebUI:   ${uiUrl}`);
      lines.push(`WebUI鉴权: ${uiAuthMode}`);
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
          ? `OneBot入口: token=${hasAccessToken ? '已设置' : '未设置'} | WS 已关闭 | host=${this.settings.host}`
          : `OneBot入口: token=${hasAccessToken ? '已设置' : '未设置'} | mode=${ws.mode}${ws.mode !== 'reverse' ? ` → ${ws.forwardUrl || '(未填地址)'}` : ''}${ws.mode !== 'forward' ? ` | 反向路径 ${ws.reversePath}` : ''} | host=${this.settings.host}`,
      );
      lines.push(
        `代理设置: trustProxy=${this.settings.trustProxy === true ? 'true（信任 X-Forwarded-*）' : 'false（忽略代理头）'}`,
      );

      for (const line of lines) {
        this.logger.info(line);
      }

      // accessToken 缺失时，任何远程 OneBot 入口都会被 fail-closed 拒绝。
      if (!hasAccessToken && (!hostIsLoopback || wsRemoteExposed)) {
        this.logger.error(
          [
            'OneBot 远程入口未配置 accessToken —— 远程 HTTP 事件上报与反向 WebSocket 将被拒绝。',
            `  host=${this.settings.host}（${hostIsLoopback ? '回环' : '非回环'}） mode=${ws.mode}`,
            '  请在 config.json 的 runtime.onebot.accessToken 或 WebUI「OneBot」页设置 token，',
            '  否则只有本机直连（无代理头）的上报会被接受。',
          ].join('\n'),
        );
      }
    } catch (error) {
      this.logger.warn('startup checklist failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop(): Promise<void> {
    try {
      await this.oneBotWebSocket.dispose();
      for (const stop of this.builtinStoppers) {
        try {
          await stop();
        } catch (error) {
          this.logger.warn('builtin service stop failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.builtinStoppers = [];
      await this.plugins.shutdown();
      if (this.server) {
        await this.server.stop();
        this.server = null;
      }
    } finally {
      await this.store.close();
    }
  }

  /** 内置插件注册的关闭钩子 */
  registerBuiltinStopper(stop: () => Promise<void>): void {
    this.builtinStoppers.push(stop);
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

    if (event.visibility.fromAdmin) {
      const isCommand = event.content.text.trim().startsWith('/');
      if (isCommand) {
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

      return { accepted: true };
    }

    return { accepted: true };
  }
}
