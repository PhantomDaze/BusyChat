/**
 * 内置插件注册中心
 *
 * 把摘要、知识库、回复、命令、告警等原硬编码功能注册为内置插件。
 * 内核只保留传输、存储、配置、模型注册表和事件入口。
 */

import type {
  AppServices,
  JsonObject,
  KnowledgeBaseSettings,
  SummarySettings,
} from './types';
import type { BotApplication } from './app';
import type { PluginManager } from './plugins';
import type { BotPlugin, PluginContext, PluginManifest } from './types';
import type { Logger } from './types';
import { KnowledgeService } from './knowledge';
import { ReplyManager } from './reply';
import { SummaryWorker } from './summary';
import { createPluginConfigStore } from './plugin-config';
import { registerCoreCommands } from './plugins/builtin/commands-core';
import { registerKnowledgeCommands } from './plugins/builtin/commands-knowledge';
import { registerReplyCommands } from './plugins/builtin/commands-reply';
import { createNotifyPlugin } from './plugins/builtin/notify';

/**
 * 内置插件默认配置。这些配置存进插件各自的 storage 命名空间
 * （data/plugins/<name>.json 的 config 键），config.json 不保存。
 * 迁移：旧版 runtime.summary / runtime.knowledgeBase 中的字段会在
 * 启动时自动搬入（见 app.ts migrateLegacyPluginConfigs）。
 */
const DEFAULT_SUMMARY_CONFIG: SummarySettings = {
  enabled: true,
  intervalMs: 120_000,
  batchSize: 5,
  maxEventsPerPrompt: 40,
};

// enabled 是冗余字段（真正的开关 = 插件启用状态），status() 会用插件状态覆盖
const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeBaseSettings = {
  enabled: true,
  maxResults: 10,
};

function manifest(
  name: string,
  version: string,
  description: string,
  permissions: PluginManifest['permissions'],
  author = 'F261Agent',
): PluginManifest {
  return { name, version, description, author, permissions };
}

/**
 * 把所有内置功能注册为插件。在 PluginManager.load() 之前调用。
 */
export async function registerBuiltinPlugins(
  manager: PluginManager,
  services: AppServices,
  app: BotApplication,
): Promise<void> {
  // ---- KnowledgeService（内置 knowledge 插件） ----
  const knowledgeConfig = createPluginConfigStore(
    services.storage.namespace('builtin-knowledge'),
    DEFAULT_KNOWLEDGE_CONFIG,
  );
  const knowledge = new KnowledgeService({
    runtime: services.runtime,
    storage: services.storage,
    models: services.models,
    config: knowledgeConfig,
    pluginName: 'builtin-knowledge',
    appLogger: services.appLogger.child('knowledge'),
  });
  app.setKnowledgeService(knowledge);

  const knowledgePlugin: BotPlugin = {
    manifest: manifest(
      'builtin-knowledge',
      '1.0.0',
      '知识库服务 — 语义搜索、长期记忆、记忆总结',
      ['knowledge:read', 'knowledge:write', 'knowledge:control', 'command:register', 'webui:route'],
    ),
    async setup(ctx: PluginContext) {
      await ctx.knowledgeControl?.start();
      // 注册知识库命令
      registerKnowledgeCommands(ctx, services);
      // 注册 WebUI 知识库 API 路由
      if (ctx.webui) {
        ctx.webui.register({
          method: 'GET',
          path: '/api/knowledge/settings',
          handler: async () => {
            const runtime = await services.runtime.snapshot();
            const config = await knowledgeConfig.get();
            return {
              enabled: runtime.plugins['builtin-knowledge']?.enabled !== false,
              maxResults: config.maxResults,
              vectorDimension: config.vectorDimension ?? null,
            } as unknown as JsonObject;
          },
        });
        ctx.webui.register({
          method: 'POST',
          path: '/api/knowledge/settings',
          handler: async (payload) => {
            const p = payload as { enabled?: unknown; maxResults?: unknown; vectorDimension?: unknown };
            await knowledgeConfig.update((config) => {
              const next = { ...config };
              if (typeof p.maxResults === 'number' && Number.isFinite(p.maxResults)) {
                next.maxResults = Math.min(Math.max(Math.round(p.maxResults), 1), 5000);
              }
              if (p.vectorDimension === null) {
                delete next.vectorDimension;
              } else if (typeof p.vectorDimension === 'number' && Number.isFinite(p.vectorDimension)) {
                next.vectorDimension = Math.max(Math.round(p.vectorDimension), 1);
              }
              return next;
            });
            if (typeof p.enabled === 'boolean') {
              // 知识库开关 = 插件启用状态，变更会触发插件热重载
              await services.plugins.setEnabled('builtin-knowledge', p.enabled);
            }
            return { ok: true } as unknown as JsonObject;
          },
        });
        ctx.webui.register({
          method: 'GET',
          path: '/api/knowledge',
          handler: async (_payload, query) => {
            const limit = typeof query.limit === 'string' ? parseInt(query.limit, 10) || undefined : undefined;
            return { items: await knowledge.list(limit) } as unknown as JsonObject;
          },
        });
        ctx.webui.register({
          method: 'POST',
          path: '/api/knowledge',
          handler: async (payload) => {
            const text = typeof (payload as { text?: string })?.text === 'string' ? (payload as { text: string }).text.trim() : '';
            if (!text) throw new Error('text is required');
            const entry = await knowledge.add(text, { source: 'webui', type: 'user' });
            return entry as unknown as JsonObject;
          },
        });
        ctx.webui.register({
          method: 'DELETE',
          path: '/api/knowledge/{id}',
          handler: async (payload) => {
            // id 从路径参数取，这里 fallback payload
            const id = typeof (payload as { id?: string })?.id === 'string' ? (payload as { id: string }).id : '';
            const deleted = await knowledge.delete(id);
            return { deleted } as unknown as JsonObject;
          },
        });
        ctx.webui.register({
          method: 'POST',
          path: '/api/knowledge/search',
          handler: async (payload) => {
            const query = typeof (payload as { query?: string })?.query === 'string' ? (payload as { query: string }).query.trim() : '';
            if (!query) throw new Error('query is required');
            const limit = typeof (payload as { limit?: number })?.limit === 'number' ? (payload as { limit: number }).limit : undefined;
            return { results: await knowledge.search(query, limit) } as unknown as JsonObject;
          },
        });
        ctx.webui.register({
          method: 'POST',
          path: '/api/knowledge/summarize',
          handler: async (payload) => {
            const entryIds = Array.isArray((payload as { entryIds?: unknown[] })?.entryIds)
              ? ((payload as { entryIds: unknown[] }).entryIds).map(String)
              : undefined;
            const result = await knowledge.summarize(entryIds);
            if (!result) throw new Error('no entries to summarize');
            return result as unknown as JsonObject;
          },
        });
      }
    },
    async teardown() {
      await knowledge.stop();
    },
  };

  // ---- SummaryWorker（内置 summary 插件） ----
  const summaryConfig = createPluginConfigStore(
    services.storage.namespace('builtin-summary'),
    DEFAULT_SUMMARY_CONFIG,
  );
  const summaries = new SummaryWorker({
    runtime: services.runtime,
    storage: services.storage,
    bot: services.bot,
    models: services.models,
    plugins: services.plugins,
    config: summaryConfig,
    replyFormatter: null, // reply 插件 setup 后注入
    appLogger: services.appLogger.child('summaries'),
  });
  app.setSummaryService(summaries);

  // ---- ReplyManager（内置 reply 插件） ----
  const replies = new ReplyManager({
    models: services.models,
    appLogger: services.appLogger.child('replies'),
  });
  // 把 reply 的待回复摘要注入 summary worker
  summaries['deps'].replyFormatter = () => replies.formatPendingForSummary();

  const replyPlugin: BotPlugin = {
    manifest: manifest(
      'builtin-reply',
      '1.0.0',
      '待回复消息管理 — 分类、暂存、AI 生成回复',
      ['reply:control', 'command:register', 'model:use', 'webui:route'],
    ),
    async setup(ctx: PluginContext) {
      registerReplyCommands(ctx, replies);
      // WebUI 路由：待回复列表 / 生成回复 / 忽略
      if (ctx.webui) {
        ctx.webui.register({
          method: 'GET',
          path: '/api/reply/pending',
          handler: async () => {
            const items = replies.listPending().map((p) => ({
              id: p.id,
              idShort: p.id.slice(0, 8),
              createdAt: p.createdAt,
              status: p.status,
              scope: p.sourceEvent.scope,
              senderId: p.sourceEvent.sender.userId,
              senderName: p.sourceEvent.sender.nickname ?? p.sourceEvent.sender.userId,
              text: p.sourceEvent.content.text.slice(0, 200),
            }));
            return { items } as unknown as JsonObject;
          },
        });
        ctx.webui.register({
          method: 'POST',
          path: '/api/reply/generate',
          handler: async (payload) => {
            const p = payload as { id?: unknown; instruction?: unknown };
            const pending = replies.getPending(String(p.id ?? ''));
            if (!pending) throw new Error('未找到待回复消息');
            if (pending.status !== 'pending') throw new Error('该消息已处理，无法重复生成');
            const instruction = String(p.instruction ?? '').trim();
            if (!instruction) throw new Error('请输入回复指示');
            const result = await replies.generateReply(pending, instruction);
            await ctx.bot.send(result.target, result.message);
            replies.markResolved(pending, result);
            return {
              ok: true,
              target: `${result.target.type}:${result.target.id}`,
              message: typeof result.message === 'string' ? result.message.slice(0, 120) : '[非文本消息]',
            } as unknown as JsonObject;
          },
        });
        ctx.webui.register({
          method: 'POST',
          path: '/api/reply/{id}/dismiss',
          handler: async (payload, query) => {
            const id = String((payload as { id?: unknown } | undefined)?.id ?? query.id ?? '');
            const ok = replies.dismiss(id);
            return { ok } as unknown as JsonObject;
          },
        });
      }
    },
    hooks: {
      async onMessage(event) {
        if (event.visibility.fromBot || event.visibility.fromAdmin) return;
        const needsReply = await replies.classifyMessage(event);
        if (needsReply) replies.addPending(event);
      },
    },
  };

  const summaryPlugin: BotPlugin = {
    manifest: manifest(
      'builtin-summary',
      '1.0.0',
      '定时摘要工作器 — 收集消息、调用模型生成摘要、发送给管理员',
      ['summary:control', 'command:register', 'webui:route', 'admin:observe'],
    ),
    async setup(ctx: PluginContext) {
      await summaries.start();
      registerCoreCommands(ctx, services, summaries);
      if (ctx.webui) {
        ctx.webui.register({
          method: 'POST',
          path: '/api/summary/settings',
          handler: async (payload) => {
            const p = payload as { enabled?: boolean; intervalMs?: number; batchSize?: number; maxEventsPerPrompt?: number };
            await summaryConfig.update((config) => {
              const enabled = typeof p.enabled === 'boolean' ? p.enabled : config.enabled;
              const intervalMs = typeof p.intervalMs === 'number' ? Math.min(Math.max(Math.round(p.intervalMs), 5000), 86400000) : config.intervalMs;
              const batchSize = typeof p.batchSize === 'number' ? Math.min(Math.max(Math.round(p.batchSize), 1), 1000) : config.batchSize;
              const maxEventsPerPrompt = typeof p.maxEventsPerPrompt === 'number' ? Math.min(Math.max(Math.round(p.maxEventsPerPrompt), 1), 500) : config.maxEventsPerPrompt;
              return { ...config, enabled, intervalMs, batchSize, maxEventsPerPrompt };
            });
            await summaries.start();
            return { ok: true } as unknown as JsonObject;
          },
        });
        ctx.webui.register({
          method: 'POST',
          path: '/api/summary/flush',
          handler: async () => {
            const record = await summaries.flush('manual-webui');
            return (record ?? { ok: true, empty: true }) as unknown as JsonObject;
          },
        });
      }
    },
    async teardown() {
      await summaries.stop();
    },
  };

  // ---- Notify 插件（关键词告警 + 免打扰） ----
  const notifyPlugin = createNotifyPlugin(services);

  manager.registerBuiltin(knowledgePlugin);
  manager.registerBuiltin(replyPlugin);
  manager.registerBuiltin(summaryPlugin);
  manager.registerBuiltin(notifyPlugin);
}
