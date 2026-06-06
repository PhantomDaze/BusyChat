import { access, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  AdviceRecord,
  AppServices,
  BotPlugin,
  CommandDefinition,
  JsonObject,
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
  RuntimeStore,
  SummaryRecord,
} from './types';

interface PluginManagerDependencies {
  runtime: RuntimeStore;
  bot: AppServices['bot'];
  models: ModelAdminGateway;
  storage: AppServices['storage'];
  commands: AppServices['commands'];
  knowledge: AppServices['knowledge'];
  appLogger: Logger;
  pluginSearchDirs: string[];
}

interface LoadedPlugin {
  manifest: PluginManifest;
  plugin: BotPlugin;
  context: PluginContext;
  filePath: string;
  enabled: boolean;
}

interface PluginEntrypointCandidate {
  filePath: string;
  extensionRank: number;
  directoryRank: number;
}

interface PluginManagerApi {
  load(): Promise<void>;
  reload(): Promise<void>;
  shutdown(): Promise<void>;
  dispatchMessage(event: NormalizedMessageEvent): Promise<void>;
  dispatchSummary(summary: SummaryRecord): Promise<void>;
  dispatchAdvice(advice: AdviceRecord): Promise<void>;
  list(): Promise<Array<{ name: string; version: string; enabled: boolean; description: string | undefined }>>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  listLoadedManifestNames(): Promise<string[]>;
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
    snapshot: () => runtime.snapshot(),
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
  knowledge: AppServices['knowledge'],
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
): PluginContext {
  const permissions = permissionSet(plugin.manifest);
  const storage = createNamespacedStorage(base.storage.namespace(plugin.manifest.name), permissions);
  const bot = wrapBot(base.bot, permissions);
  const models = wrapModels(base.models, permissions);
  const runtime = createReadOnlyRuntime(base.runtime);

  const commands = {
    register(command: CommandDefinition): void {
      if (!permissions.has('command:register')) {
        throw new Error('plugin lacks command:register permission');
      }
      base.commands.register({
        ...command,
        owner: command.owner ?? plugin.manifest.name,
      });
    },
  };

  const hasKnowledgeRead = permissions.has('knowledge:read');
  const hasKnowledgeWrite = permissions.has('knowledge:write');
  const knowledge = hasKnowledgeRead || hasKnowledgeWrite
    ? wrapKnowledge(base.knowledge, permissions)
    : undefined;

  return {
    manifest: plugin.manifest,
    bot,
    models,
    storage,
    commands,
    runtime,
    knowledge,
    logger,
  };
}

export class PluginManager implements PluginManagerApi {
  private readonly loaded = new Map<string, LoadedPlugin>();

  constructor(private readonly deps: PluginManagerDependencies) {}

  async load(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    await this.shutdown();

    const entrypoints = await discoverPluginEntrypoints(this.deps.pluginSearchDirs);
    const runtime = await this.deps.runtime.snapshot();
    const nextPlugins = { ...runtime.plugins };

    for (const filePath of entrypoints) {
      try {
        const mod = (await dynamicImport(pathToFileURL(filePath).href)) as PluginModule;
        const plugin = mod.createPlugin ? unwrapPluginCandidate(await mod.createPlugin()) : resolvePluginModule(mod);
        if (!plugin) {
          this.deps.appLogger.warn('plugin module did not export a plugin', { filePath });
          continue;
        }

        if (!plugin.manifest?.name) {
          throw new Error('plugin manifest.name is required');
        }

        const pluginState =
          nextPlugins[plugin.manifest.name] ??
          (nextPlugins[plugin.manifest.name] = {
            enabled: true,
            config: {},
          });
        const logger = this.deps.appLogger.child(`plugin:${plugin.manifest.name}`);
        const context = createPluginContext(plugin, this.deps, logger);
        const enabled = pluginState.enabled !== false;

        this.loaded.set(plugin.manifest.name, {
          manifest: plugin.manifest,
          plugin,
          context,
          filePath,
          enabled,
        });

        if (enabled) {
          await plugin.setup(context);
          logger.info('plugin loaded', { version: plugin.manifest.version, filePath });
        } else {
          logger.info('plugin discovered but disabled', { version: plugin.manifest.version, filePath });
        }
      } catch (error) {
        this.deps.appLogger.error('failed to load plugin', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.deps.runtime.update((state) => {
      state.plugins = nextPlugins;
    });
  }

  async shutdown(): Promise<void> {
    for (const [name, record] of this.loaded.entries()) {
      this.deps.commands.unregisterOwner(name);
      if (record.plugin.teardown) {
        try {
          await record.plugin.teardown(record.context);
        } catch (error) {
          this.deps.appLogger.warn('plugin teardown failed', {
            plugin: name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    this.loaded.clear();
  }

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

  async list(): Promise<Array<{ name: string; version: string; enabled: boolean; description: string | undefined }>> {
    const runtime = await this.deps.runtime.snapshot();
    return [...this.loaded.values()]
      .map((record) => ({
        name: record.manifest.name,
        version: record.manifest.version,
        enabled: runtime.plugins[record.manifest.name]?.enabled !== false && record.enabled,
        description: record.manifest.description,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.deps.runtime.update((state) => {
      if (!state.plugins[name]) {
        state.plugins[name] = {
          enabled,
          config: {},
        };
      } else {
        state.plugins[name].enabled = enabled;
      }
    });
    await this.reload();
  }

  async listLoadedManifestNames(): Promise<string[]> {
    return [...this.loaded.keys()];
  }
}
