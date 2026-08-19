/** 内置知识库命令：remember / recall / forget / kb-summarize */

import type { AppServices, KnowledgeEntry, PluginContext } from '../../../types';

export function registerKnowledgeCommands(ctx: PluginContext, services: AppServices): void {
  if (!services.knowledge) return;

  ctx.commands.register({
    name: 'remember',
    description: '将文本添加到知识库',
    usage: '/remember <内容>',
    adminOnly: true,
    execute: async (cmdCtx) => {
      if (cmdCtx.args.length === 0) return '用法: /remember <要记忆的内容>';
      const text = cmdCtx.args.join(' ');
      try {
        const entry = await services.knowledge!.add(text, { source: 'command', type: 'user' });
        return `已记忆 [${entry.id.slice(0, 8)}]: ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`;
      } catch (err) {
        return `记忆失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  ctx.commands.register({
    name: 'recall',
    description: '语义搜索知识库',
    usage: '/recall <查询> [数量]',
    adminOnly: true,
    execute: async (cmdCtx) => {
      const lastArg = cmdCtx.args[cmdCtx.args.length - 1];
      const maybeLimit = /^\d+$/.test(lastArg ?? '') ? parseInt(lastArg!, 10) : NaN;
      const hasLimit = cmdCtx.args.length > 1 && maybeLimit >= 1 && maybeLimit <= 50;
      const queryEnd = hasLimit ? cmdCtx.args.length - 1 : cmdCtx.args.length;
      const query = cmdCtx.args.slice(0, queryEnd).join(' ');
      if (!query) return '用法: /recall <查询内容> [返回数量]';
      try {
        const results = await services.knowledge!.search(query, hasLimit ? maybeLimit : undefined);
        if (results.length === 0) return '未找到相关知识。';
        return results
          .map((r, i) => {
            const score = r.rerankScore ?? r.similarityScore;
            return `${i + 1}. [${r.entry.id.slice(0, 8)}] (相关度: ${score.toFixed(3)})\n   ${r.entry.text.slice(0, 300)}${r.entry.text.length > 300 ? '...' : ''}`;
          })
          .join('\n\n');
      } catch (err) {
        return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  ctx.commands.register({
    name: 'forget',
    description: '从知识库中删除一项',
    usage: '/forget <id>',
    adminOnly: true,
    execute: async (cmdCtx) => {
      if (cmdCtx.args.length === 0) return '用法: /forget <条目ID>';
      const id = cmdCtx.args[0]!;
      try {
        const deleted = await services.knowledge!.delete(id);
        return deleted ? `已删除知识库条目 ${id}` : `未找到匹配 "${id}" 的条目（支持部分 ID 前缀匹配）`;
      } catch (err) {
        return `删除失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  ctx.commands.register({
    name: 'kb-summarize',
    description: '对知识库内容进行总结',
    usage: '/kb-summarize [数量] | /kb-summarize <id1> <id2> ...',
    adminOnly: true,
    execute: async (cmdCtx) => {
      try {
        let summary: KnowledgeEntry | null = null;
        if (cmdCtx.args.length === 0) {
          summary = await services.knowledge!.summarize();
        } else {
          const maybeLimit = parseInt(cmdCtx.args[0]!, 10);
          if (Number.isFinite(maybeLimit) && maybeLimit > 0) {
            const entries = await services.knowledge!.list(maybeLimit);
            summary = await services.knowledge!.summarize(entries.map((e) => e.id));
          } else {
            summary = await services.knowledge!.summarize(cmdCtx.args);
          }
        }
        if (!summary) return '没有可总结的知识库条目。';
        return `记忆总结 [${summary.id.slice(0, 8)}]:\n${summary.text}`;
      } catch (err) {
        return `总结失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
