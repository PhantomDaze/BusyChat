import { access, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  AdviceRecord,
  AppServices,
  BotPlugin,
  CommandDefinition,
  JsonObject,
  KnowledgeControl,
  KnowledgeGateway,
  Logger,
  JsonValue,
  ModelAdminGateway,
  ModelGateway,
  ModelTask,
  NamespacedStorage,
  NormalizedMessageEvent,
  PluginContext,
  PluginManifest,
  PluginModule,
  PluginPermission,
  PluginRuntimeReader,
  ReplyControl,
  RuntimeStore,
  SummaryControl,
  SummaryRecord,
  WebUiRouteHandler,
  WebUiRouteRegistrar,
} from './types';
import { createPluginConfigStore } from './plugin-config';
import { redactRuntime } from './security';

interface PluginManagerDependencies {
  runtime: RuntimeStore;
  bot: AppServices['bot'];
  models: ModelAdminGateway;
  storage: AppServices['storage'];
  commands: AppServices['commands'];
  knowledge: AppServices['knowledge'];
  summaryControl?: SummaryControl;
  replyControl?: ReplyControl;
  knowledgeControl?: KnowledgeControl;
  appLogger: Logger;
  pluginSearchDirs: string[];
}

interface WebUiRouteEntry extends WebUiRouteHandler {
  owner: string;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  plugin: BotPlugin;
  context: PluginContext;
  filePath: string;
  enabled: boolean;
  /** 最近一次热重载失败的原因（旧版本仍在服务） */
  lastError?: string;
}

/** 加载失败、未进入 loaded 的插件，供 list()/status 展示错误。 */
interface PluginFailure {
  manifest: PluginManifest;
  filePath: string;
  error: string;
}

/**
 * setup 期间注册项先写入暂存区，setup 成功后再原子提交；
 * 失败时旧版本的路由/命令保持不动。
 */
interface RegistrarStage {
  live: boolean;
  routes: WebUiRouteEntry[];
  commands: CommandDefinition[];
}

function createRegistrarStage(): RegistrarStage {
  return { live: false, routes: [], commands: [] };
}

/** 插件名规则：小写字母/数字开头，仅允许小写字母、数字、点、下划线、连字符，最长 64。 */
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface PluginEntrypointCandidate {
  filePath: string;
  extensionRank: number;
  directoryRank: number;
}

interface PluginManagerApi {
  load(): Promise<void>;
  reload(): Promise<void>;
  reloadOne(name: string): Promise<void>;
  shutdown(): Promise<void>;
  dispatchMessage(event: NormalizedMessageEvent): Promise<void>;
  dispatchSummary(summary: SummaryRecord): Promise<void>;
  dispatchAdvice(advice: AdviceRecord): Promise<void>;
  list(): Promise<
    Array<{
      name: string;
      version: string;
      enabled: boolean;
      description: string | undefined;
      permissions: PluginPermission[];
      filePath?: string;
      error?: string;
    }>
  >;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  listLoadedManifestNames(): Promise<string[]>;
  /** 插件注册的 WebUI 路由（供 WebUI 服务器挂载） */
  collectWebUiRoutes(): Array<{ owner: string; route: WebUiRouteHandler }>;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function supportsTypeScriptEntrypoints(): boolean {
  const entrypoint = process.argv[1] ?? '';
  return entrypoint.endsWith('.ts') || entrypoint.endsWith('.tsx');
}

function comparePluginEntrypoints(
  left: PluginEntrypointCandidate,
  right: PluginEntrypointCandidate,
): number {
  if (left.extensionRank !== right.extensionRank) {
    return left.extensionRank - right.extensionRank;
  }
  if (left.directoryRank !== right.directoryRank) {
    return left.directoryRank - right.directoryRank;
  }
  return left.filePath.localeCompare(right.filePath);
}

function isBotPlugin(value: unknown): value is BotPlugin {
  return (
    value !== null &&
    typeof value === 'object' &&
    'manifest' in value &&
    typeof (value as { setup?: unknown }).setup === 'function'
  );
}

function unwrapPluginCandidate(value: unknown, depth = 0): BotPlugin | null {
  if (!value || typeof value !== 'object' || depth > 3) {
    return null;
  }

  if (isBotPlugin(value)) {
    return value;
  }

  const namespace = value as { default?: unknown; plugin?: unknown };
  return unwrapPluginCandidate(namespace.default, depth + 1) ?? unwrapPluginCandidate(namespace.plugin, depth + 1);
}

async function discoverPluginEntrypoints(directories: string[]): Promise<string[]> {
  const entries = new Map<string, PluginEntrypointCandidate>();
  // Prefer source plugins when the app is started from TypeScript, otherwise prefer built JavaScript.
  const extensions = supportsTypeScriptEntrypoints()
    ? ['ts', 'tsx', 'js', 'cjs', 'mjs']
    : ['js', 'cjs', 'mjs'];

  for (const [directoryRank, directory] of directories.entries()) {
    const resolvedDir = path.resolve(process.cwd(), directory);
    let subdirs: string[] = [];
    try {
      const children = await readdir(resolvedDir, { withFileTypes: true });
      subdirs = children.filter((entry) => entry.isDirectory()).map((entry) => path.join(resolvedDir, entry.name));
    } catch {
      continue;
    }

    for (const subdir of subdirs) {
      const pluginKey = path.relative(resolvedDir, subdir) || path.basename(subdir);
      for (const ext of extensions) {
        const candidate = path.join(subdir, `index.${ext}`);
        if (await pathExists(candidate)) {
          const candidateRank = {
            filePath: candidate,
            extensionRank: extensions.indexOf(ext),
            directoryRank,
          };
          const current = entries.get(pluginKey);
          if (!current || comparePluginEntrypoints(candidateRank, current) < 0) {
            entries.set(pluginKey, candidateRank);
          }
          break;
        }
      }
    }
  }

  return [...entries.values()].sort(comparePluginEntrypoints).map((entry) => entry.filePath);
}

// Keep native import() so the CommonJS build does not rewrite it into require().
const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<unknown>;

function resolvePluginModule(mod: PluginModule): BotPlugin | null {
  return unwrapPluginCandidate(mod as unknown);
}

function permissionSet(manifest: PluginManifest): Set<PluginPermission> {
  return new Set(manifest.permissions);
}

function createNamespacedStorage(storage: NamespacedStorage, permissions: Set<PluginPermission>): NamespacedStorage {
  return {
    async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
      if (!permissions.has('storage:read')) {
        throw new Error('plugin lacks storage:read permission');
      }
      return storage.get<T>(key);
    },
    async set<T extends JsonValue = JsonValue>(key: string, value: T): Promise<void> {
      if (!permissions.has('storage:write')) {
        throw new Error('plugin lacks storage:write permission');
      }
      await storage.set<T>(key, value);
    },
    async delete(key: string): Promise<void> {
      if (!permissions.has('storage:write')) {
        throw new Error('plugin lacks storage:write permission');
      }
      await storage.delete(key);
    },
    async listKeys(): Promise<string[]> {
      if (!permissions.has('storage:read')) {
        throw new Error('plugin lacks storage:read permission');
      }
      return storage.listKeys();
    },
  };
}

function createReadOnlyRuntime(runtime: RuntimeStore): PluginRuntimeReader {
  return {
    // 插件只应看到脱敏后的运行时快照：凭据（密码/令牌/API Key）一律替换为标记。
    snapshot: async () => redactRuntime(await runtime.snapshot()),
  };
}

function wrapBot(bot: AppServices['bot'], permissions: Set<PluginPermission>): AppServices['bot'] {
  return {
    get selfId() {
      return bot.selfId;
    },
    async send(target, message) {
      if (!permissions.has('bot:send')) {
        throw new Error('plugin lacks bot:send permission');
      }
      return bot.send(target, message);
    },
    async sendPrivateMessage(userId, message) {
      if (!permissions.has('bot:send')) {
        throw new Error('plugin lacks bot:send permission');
      }
      return bot.sendPrivateMessage(userId, message);
    },
    async sendGroupMessage(groupId, message) {
      if (!permissions.has('bot:send')) {
        throw new Error('plugin lacks bot:send permission');
      }
      return bot.sendGroupMessage(groupId, message);
    },
  };
}

function wrapModels(models: ModelAdminGateway, permissions: Set<PluginPermission>): ModelGateway {
  const ensure = (): void => {
    if (!permissions.has('model:use')) {
      throw new Error('plugin lacks model:use permission');
    }
  };

  return {
    async generateText(task, input, context = {}) {
      ensure();
      return models.generateText(task, input, context);
    },
    async transcribe(input, context = {}) {
      ensure();
      return models.transcribe(input, context);
    },
    async embed(inputs, context = {}) {
      ensure();
      return models.embed(inputs, context);
    },
    async rerank(query, candidates, context = {}) {
      ensure();
      return models.rerank(query, candidates, context);
    },
  };
}

function wrapKnowledge(
  knowledge: NonNullable<AppServices['knowledge']>,
  permissions: Set<PluginPermission>,
): KnowledgeGateway {
  return {
    async add(text, metadata) {
      if (!permissions.has('knowledge:write')) {
        throw new Error('plugin lacks knowledge:write permission');
      }
      return knowledge.add(text, {
        ...metadata,
        plugin: metadata.plugin ?? 'plugin',
      });
    },
    async search(query, limit) {
      if (!permissions.has('knowledge:read')) {
        throw new Error('plugin lacks knowledge:read permission');
      }
      return knowledge.search(query, limit);
    },
    async delete(id) {
      if (!permissions.has('knowledge:write')) {
        throw new Error('plugin lacks knowledge:write permission');
      }
      return knowledge.delete(id);
    },
    async list(limit) {
      if (!permissions.has('knowledge:read')) {
        throw new Error('plugin lacks knowledge:read permission');
      }
      return knowledge.list(limit);
    },
    async summarize(entryIds, timeRange) {
      if (!permissions.has('knowledge:read')) {
        throw new Error('plugin lacks knowledge:read permission');
      }
      return knowledge.summarize(entryIds, timeRange);
    },
  };
}

function createPluginContext(
  plugin: BotPlugin,
  base: PluginManagerDependencies,
  logger: Logger,
  stage: RegistrarStage,
  addRoute: (entry: WebUiRouteEntry) => void,
): PluginContext {
  const permissions = permissionSet(plugin.manifest);
  const storage = createNamespacedStorage(base.storage.namespace(plugin.manifest.name), permissions);
  const bot = wrapBot(base.bot, permissions);
  const models = wrapModels(base.models, permissions);
  const runtime = createReadOnlyRuntime(base.runtime);
  // 插件自己的配置访问器：配置是插件元数据，不依赖 storage 权限声明
  const config = createPluginConfigStore<JsonObject>(
    base.storage.namespace(plugin.manifest.name),
    {},
  );

  const commands = {
    register(command: CommandDefinition): void {
      if (!permissions.has('command:register')) {
        throw new Error('plugin lacks command:register permission');
      }
      const entry: CommandDefinition = {
        ...command,
        owner: plugin.manifest.name,
      };
      // setup 阶段先暂存；提交后（live）再直接注册。
      if (stage.live) base.commands.register(entry);
      else stage.commands.push(entry);
    },
  };

  const hasKnowledgeRead = permissions.has('knowledge:read');
  const hasKnowledgeWrite = permissions.has('knowledge:write');
  const knowledge = (hasKnowledgeRead || hasKnowledgeWrite) && base.knowledge
    ? wrapKnowledge(base.knowledge, permissions)
    : undefined;

  const summaryControl = permissions.has('summary:control') ? base.summaryControl : undefined;
  const replyControl = permissions.has('reply:control') ? base.replyControl : undefined;
  const knowledgeControl = permissions.has('knowledge:control') ? base.knowledgeControl : undefined;

  const webui: WebUiRouteRegistrar | undefined = permissions.has('webui:route')
    ? {
        register(route: WebUiRouteHandler): void {
          const entry: WebUiRouteEntry = { ...route, owner: plugin.manifest.name };
          if (stage.live) addRoute(entry);
          else stage.routes.push(entry);
        },
      }
    : undefined;

  return {
    manifest: plugin.manifest,
    bot,
    models,
    storage,
    config,
    commands,
    runtime,
    knowledge,
    summaryControl,
    replyControl,
    knowledgeControl,
    webui,
    logger,
  };
}

export class PluginManager implements PluginManagerApi {
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly failures = new Map<string, PluginFailure>();
  private readonly webUiRoutes: WebUiRouteEntry[] = [];
  private readonly manifestToRoutes = new Map<string, WebUiRouteEntry[]>();
  private readonly builtins: BotPlugin[] = [];
  private watcher: import('node:fs').FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  /** 串行化 reload/reloadOne/setEnabled，避免文件监听与 API 触发的重载交错。 */
  private operationChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PluginManagerDependencies) {}

  /** 注册内置插件（不经过文件发现，在 load 之前调用） */
  registerBuiltin(plugin: BotPlugin): void {
    this.builtins.push(plugin);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation, operation);
    // 队列本身吞掉错误，保证后续操作不会被前一次的失败卡住。
    this.operationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async load(): Promise<void> {
    await this.enqueue(async () => {
      await this.reloadInternal();
      this.startWatching();
    });
  }

  async reload(): Promise<void> {
    await this.enqueue(() => this.reloadInternal());
  }

  async reloadOne(name: string): Promise<void> {
    await this.enqueue(() => this.reloadOneInternal(name));
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.enqueue(async () => {
      await this.deps.runtime.update((state) => {
        if (!state.plugins[name]) {
          state.plugins[name] = { enabled };
        } else {
          state.plugins[name].enabled = enabled;
        }
      });
      await this.reloadInternal();
    });
  }

  async shutdown(): Promise<void> {
    await this.enqueue(() => this.shutdownInternal());
  }

  // -----------------------------------------------------------------------
  // 注册项提交 / 回滚
  // -----------------------------------------------------------------------

  private addRoute(entry: WebUiRouteEntry): void {
    this.webUiRoutes.push(entry);
    let list = this.manifestToRoutes.get(entry.owner);
    if (!list) {
      list = [];
      this.manifestToRoutes.set(entry.owner, list);
    }
    list.push(entry);
  }

  /**
   * setup 成功后原子提交暂存注册：先移除旧版本的同名命令/路由，再安装新版本，
   * 之后插件运行期再注册的项会直接进入 live 状态。
   */
  private commitRegistrations(name: string, stage: RegistrarStage): void {
    this.deps.commands.unregisterOwner(name);
    for (const command of stage.commands) {
      this.deps.commands.register(command);
    }
    this.removeRoutesForOwner(name);
    for (const route of stage.routes) {
      this.addRoute(route);
    }
    stage.commands.length = 0;
    stage.routes.length = 0;
    stage.live = true;
  }

  private removeRoutesForOwner(name: string): void {
    const routes = this.manifestToRoutes.get(name);
    if (!routes) return;
    for (const r of routes) {
      const idx = this.webUiRoutes.indexOf(r);
      if (idx >= 0) this.webUiRoutes.splice(idx, 1);
    }
    this.manifestToRoutes.delete(name);
  }

  /** 校验插件名格式，并阻止文件插件冒充已注册的内置插件。 */
  private assertManifestName(
    manifest: PluginManifest,
    builtinNames: Set<string>,
    isBuiltin: boolean,
  ): void {
    if (typeof manifest.name !== 'string' || !PLUGIN_NAME_PATTERN.test(manifest.name)) {
      throw new Error(
        `invalid plugin name ${JSON.stringify(manifest.name ?? '')}: must match ${PLUGIN_NAME_PATTERN}`,
      );
    }
    if (!isBuiltin && builtinNames.has(manifest.name)) {
      throw new Error(`plugin "${manifest.name}" collides with a registered builtin plugin`);
    }
  }

  private recordFailure(manifest: PluginManifest, filePath: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    this.failures.set(manifest.name, { manifest, filePath, error: message });
    return message;
  }

  private async runTeardown(name: string, record: LoadedPlugin): Promise<void> {
    const teardowns: Array<() => unknown> = [];
    if (record.plugin.hooks?.onShutdown) {
      teardowns.push(() => record.plugin.hooks!.onShutdown!(record.context));
    }
    if (record.plugin.teardown) {
      teardowns.push(() => record.plugin.teardown!(record.context));
    }
    for (const run of teardowns) {
      try {
        await run();
      } catch (error) {
        this.deps.appLogger.warn('plugin teardown failed', {
          plugin: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // 加载 / 重载
  // -----------------------------------------------------------------------

  private async reloadInternal(): Promise<void> {
    await this.teardownAll();

    const runtime = await this.deps.runtime.snapshot();
    const nextPlugins = { ...runtime.plugins };
    const builtinNames = new Set(this.builtins.map((plugin) => plugin.manifest.name));

    // 先加载内置插件
    for (const plugin of this.builtins) {
      const name = plugin.manifest.name;
      try {
        this.assertManifestName(plugin.manifest, builtinNames, true);
      } catch (error) {
        const message = this.recordFailure(plugin.manifest, '(builtin)', error);
        this.deps.appLogger.error('failed to load builtin plugin', { name, error: message });
        continue;
      }

      const pluginState = nextPlugins[name] ?? (nextPlugins[name] = { enabled: true });
      const enabled = pluginState.enabled !== false;
      const logger = this.deps.appLogger.child(`plugin:${name}`);
      const stage = createRegistrarStage();
      const context = createPluginContext(plugin, this.deps, logger, stage, (entry) =>
        this.addRoute(entry),
      );

      if (enabled) {
        try {
          await plugin.setup(context);
          // setup 成功后才提交注册并标记为已加载。
          this.commitRegistrations(name, stage);
          logger.info('builtin plugin loaded', { version: plugin.manifest.version });
        } catch (error) {
          const message = this.recordFailure(plugin.manifest, '(builtin)', error);
          this.deps.appLogger.error('failed to load builtin plugin', { name, error: message });
          continue;
        }
      }

      this.loaded.set(name, {
        manifest: plugin.manifest,
        plugin,
        context,
        filePath: '(builtin)',
        enabled,
      });
    }

    // 再加载文件系统发现的插件
    const entrypoints = await discoverPluginEntrypoints(this.deps.pluginSearchDirs);

    for (const filePath of entrypoints) {
      let plugin: BotPlugin | null = null;
      let stage: RegistrarStage | undefined;
      try {
        const importUrl = `${pathToFileURL(filePath).href}?v=${Date.now()}`;
        const mod = (await dynamicImport(importUrl)) as PluginModule;
        plugin = mod.createPlugin ? unwrapPluginCandidate(await mod.createPlugin()) : resolvePluginModule(mod);
        if (!plugin) {
          this.deps.appLogger.warn('plugin module did not export a plugin', { filePath });
          continue;
        }

        if (!plugin.manifest?.name) {
          throw new Error('plugin manifest.name is required');
        }
        this.assertManifestName(plugin.manifest, builtinNames, false);

        const name = plugin.manifest.name;
        const pluginState =
          nextPlugins[name] ??
          (nextPlugins[name] = {
            enabled: true,
          });
        const logger = this.deps.appLogger.child(`plugin:${name}`);
        stage = createRegistrarStage();
        const context = createPluginContext(plugin, this.deps, logger, stage, (entry) =>
          this.addRoute(entry),
        );
        const enabled = pluginState.enabled !== false;

        if (enabled) {
          await plugin.setup(context);
          this.commitRegistrations(name, stage);
          logger.info('plugin loaded', { version: plugin.manifest.version, filePath });
        } else {
          logger.info('plugin discovered but disabled', { version: plugin.manifest.version, filePath });
        }

        this.loaded.set(name, {
          manifest: plugin.manifest,
          plugin,
          context,
          filePath,
          enabled,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.appLogger.error('failed to load plugin', { filePath, error: message });
        // setup 抛错或清单非法：不进入 loaded，但把错误暴露给 list()/status。
        if (stage) {
          stage.commands.length = 0;
          stage.routes.length = 0;
        }
        if (plugin?.manifest && typeof plugin.manifest.name === 'string') {
          this.failures.set(plugin.manifest.name, {
            manifest: plugin.manifest,
            filePath,
            error: message,
          });
        }
      }
    }

    await this.deps.runtime.update((state) => {
      state.plugins = nextPlugins;
    });
  }

  private async reloadOneInternal(name: string): Promise<void> {
    const entrypoints = await discoverPluginEntrypoints(this.deps.pluginSearchDirs);
    const targetEntry = entrypoints.find((filePath) => {
      const segments = filePath.split(path.sep);
      const dir = segments[segments.length - 2] ?? '';
      return dir === name || filePath.includes(`${path.sep}${name}${path.sep}index.`);
    });
    if (!targetEntry) {
      throw new Error(`plugin "${name}" not found in plugin search directories`);
    }

    const runtime = await this.deps.runtime.snapshot();
    const importUrl = `${pathToFileURL(targetEntry).href}?v=${Date.now()}`;
    const mod = (await dynamicImport(importUrl)) as PluginModule;
    const plugin = mod.createPlugin ? unwrapPluginCandidate(await mod.createPlugin()) : resolvePluginModule(mod);
    if (!plugin) {
      throw new Error(`plugin module "${name}" did not export a plugin`);
    }
    if (!plugin.manifest?.name) {
      throw new Error('plugin manifest.name is required');
    }
    const builtinNames = new Set(this.builtins.map((builtin) => builtin.manifest.name));
    this.assertManifestName(plugin.manifest, builtinNames, false);

    const resolvedName = plugin.manifest.name;
    const pluginState = runtime.plugins[resolvedName] ?? runtime.plugins[name] ?? { enabled: true };
    const enabled = pluginState.enabled !== false;
    const logger = this.deps.appLogger.child(`plugin:${resolvedName}`);
    const stage = createRegistrarStage();
    const context = createPluginContext(plugin, this.deps, logger, stage, (entry) =>
      this.addRoute(entry),
    );
    const previous = this.loaded.get(resolvedName);

    if (enabled) {
      try {
        await plugin.setup(context);
      } catch (error) {
        // setup 失败：保留旧版本继续服务，只记录错误。
        const message = error instanceof Error ? error.message : String(error);
        this.deps.appLogger.error('failed to reload plugin', {
          plugin: resolvedName,
          filePath: targetEntry,
          error: message,
        });
        if (previous) previous.lastError = message;
        else {
          this.failures.set(resolvedName, {
            manifest: plugin.manifest,
            filePath: targetEntry,
            error: message,
          });
        }
        throw error;
      }
      this.commitRegistrations(resolvedName, stage);
      logger.info('plugin reloaded', { version: plugin.manifest.version, filePath: targetEntry });
    } else {
      // 已禁用：移除旧版本的命令与路由。
      this.deps.commands.unregisterOwner(resolvedName);
      this.removeRoutesForOwner(resolvedName);
    }

    // 新版本就绪后再销毁旧版本，避免失败时出现空窗。
    if (previous) {
      await this.runTeardown(resolvedName, previous);
    }

    this.loaded.set(resolvedName, {
      manifest: plugin.manifest,
      plugin,
      context,
      filePath: targetEntry,
      enabled,
    });
    this.failures.delete(resolvedName);
  }

  private async teardownAll(): Promise<void> {
    for (const [name, record] of this.loaded.entries()) {
      this.deps.commands.unregisterOwner(name);
      this.removeRoutesForOwner(name);
      await this.runTeardown(name, record);
    }
    this.loaded.clear();
    this.failures.clear();
    this.webUiRoutes.length = 0;
    this.manifestToRoutes.clear();
  }

  private async shutdownInternal(): Promise<void> {
    this.stopWatching();
    await this.teardownAll();
  }

  collectWebUiRoutes(): Array<{ owner: string; route: WebUiRouteHandler }> {
    // 每次调用都返回当前实时路由，禁用/卸载后立即不再出现。
    return this.webUiRoutes.map(({ owner, ...route }) => ({ owner, route }));
  }

  // -----------------------------------------------------------------------
  // 文件监听
  // -----------------------------------------------------------------------

  private startWatching(): void {
    if (this.watcher) return;
    const fs = require('node:fs') as typeof import('node:fs');
    const watchedDirs = new Set<string>();
    for (const dir of this.deps.pluginSearchDirs) {
      watchedDirs.add(path.resolve(process.cwd(), dir));
    }
    const onChange = (): void => {
      if (this.reloadTimer) return;
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        void this.reload().catch((error) => {
          this.deps.appLogger.warn('auto-reload from file watcher failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 300);
    };
    const watchers: import('node:fs').FSWatcher[] = [];
    try {
      for (const dir of watchedDirs) {
        const w = fs.watch(
          dir,
          { recursive: true },
          (event: string, filename: string | Buffer | null) => {
            if (!filename) return;
            const name = typeof filename === 'string' ? filename : filename.toString();
            if (!/\.(ts|tsx|js|cjs|mjs)$/.test(name)) return;
            this.deps.appLogger.info('plugin source changed, reloading', { filename: name });
            onChange();
          },
        );
        watchers.push(w);
      }
      // 用第一个 watcher 作为主引用，其余存入数组统一关闭
      this.watcher = watchers[0] ?? null;
      if (watchers.length > 1) {
        this.extraWatchers = watchers.slice(1);
      }
      for (const w of watchers) {
        w.on('error', () => {
          // 单个 watcher 出错不影响其他
        });
      }
    } catch {
      this.watcher = null;
      this.extraWatchers = [];
    }
  }

  private extraWatchers: import('node:fs').FSWatcher[] = [];

  private stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const w of this.extraWatchers) {
      w.close();
    }
    this.extraWatchers = [];
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // 事件分发
  // -----------------------------------------------------------------------

  async dispatchMessage(event: NormalizedMessageEvent): Promise<void> {
    const tasks: Promise<unknown>[] = [];

    for (const record of this.loaded.values()) {
      if (!record.enabled) {
        continue;
      }
      const plugin = record.plugin;
      if (!plugin.hooks?.onMessage && !plugin.hooks?.onAdminMessage) {
        continue;
      }

      if (event.visibility.fromAdmin) {
        const hook = plugin.hooks?.onAdminMessage;
        if (!record.manifest.permissions.includes('admin:observe') || !hook) {
          continue;
        }
        tasks.push(
          Promise.resolve()
            .then(() => hook(event, record.context))
            .catch((error) => {
              record.context.logger.error('onAdminMessage hook failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            }),
        );
        continue;
      }

      const hook = plugin.hooks?.onMessage;
      if (!record.manifest.permissions.includes('message:observe') || !hook) {
        continue;
      }

      tasks.push(
        Promise.resolve()
          .then(() => hook(event, record.context))
          .catch((error) => {
            record.context.logger.error('onMessage hook failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }),
      );
    }

    await Promise.all(tasks);
  }

  async dispatchSummary(summary: SummaryRecord): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const record of this.loaded.values()) {
      if (!record.enabled || !record.manifest.permissions.includes('summary:observe') || !record.plugin.hooks?.onSummaryReady) {
        continue;
      }
      tasks.push(
        Promise.resolve()
          .then(() => record.plugin.hooks?.onSummaryReady?.(summary, record.context))
          .catch((error) => {
            record.context.logger.error('onSummaryReady hook failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }),
      );
    }
    await Promise.all(tasks);
  }

  async dispatchAdvice(advice: AdviceRecord): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const record of this.loaded.values()) {
      if (!record.enabled || !record.manifest.permissions.includes('admin:observe') || !record.plugin.hooks?.onAdviceReady) {
        continue;
      }
      tasks.push(
        Promise.resolve()
          .then(() => record.plugin.hooks?.onAdviceReady?.(advice, record.context))
          .catch((error) => {
            record.context.logger.error('onAdviceReady hook failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }),
      );
    }
    await Promise.all(tasks);
  }

  async list(): Promise<
    Array<{
      name: string;
      version: string;
      enabled: boolean;
      description: string | undefined;
      permissions: PluginPermission[];
      filePath?: string;
      error?: string;
    }>
  > {
    const runtime = await this.deps.runtime.snapshot();
    const entries: Array<{
      name: string;
      version: string;
      enabled: boolean;
      description: string | undefined;
      permissions: PluginPermission[];
      filePath?: string;
      error?: string;
    }> = [...this.loaded.values()].map((record) => {
      const entry: {
        name: string;
        version: string;
        enabled: boolean;
        description: string | undefined;
        permissions: PluginPermission[];
        filePath?: string;
        error?: string;
      } = {
        name: record.manifest.name,
        version: record.manifest.version,
        enabled: runtime.plugins[record.manifest.name]?.enabled !== false && record.enabled,
        description: record.manifest.description,
        permissions: [...record.manifest.permissions],
        filePath: record.filePath,
      };
      if (record.lastError !== undefined) entry.error = record.lastError;
      return entry;
    });

    // 加载失败、未进入 loaded 的插件也展示出来（enabled=false + error）。
    for (const [name, failure] of this.failures) {
      if (this.loaded.has(name)) continue;
      entries.push({
        name,
        version: failure.manifest.version,
        enabled: false,
        description: failure.manifest.description,
        permissions: [...failure.manifest.permissions],
        filePath: failure.filePath,
        error: failure.error,
      });
    }

    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async listLoadedManifestNames(): Promise<string[]> {
    return [...this.loaded.keys()];
  }
}
