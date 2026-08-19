/** 内置核心命令：help / status / send / summary / model / plugin / admin / report */

import type { AppServices, PluginContext } from '../../../types';
import type { SummaryWorker } from '../../../summary';

function formatCommandHelp(commands: { name: string; description: string; usage?: string; adminOnly?: boolean }[]): string {
  const publicCmds = commands.filter((c) => !c.adminOnly);
  const adminCmds = commands.filter((c) => c.adminOnly);

  const fmt = (list: typeof commands) =>
    list
      .map((cmd) => {
        const usage = cmd.usage ? `\n  用法: ${cmd.usage}` : '';
        return `  /${cmd.name}  ${cmd.description}${usage}`;
      })
      .join('\n');

  const parts = ['所有可用命令：', ''];
  if (publicCmds.length > 0) {
    parts.push('任何人可用：', fmt(publicCmds), '');
  }
  parts.push('管理员专用：', fmt(adminCmds));
  return parts.join('\n');
}

function formatActiveTaskModels(models: Awaited<ReturnType<AppServices['models']['listModels']>>): string {
  return models
    .flatMap((model) => {
      if (model.activeTasks.length === 0) return [];
      return model.activeTasks.map((task) => `- ${task}: ${model.label} (${model.id}, ${model.family}, ${model.provider})`);
    })
    .join('\n');
}

export function registerCoreCommands(
  ctx: PluginContext,
  services: AppServices,
  summaries: SummaryWorker,
): void {
  ctx.commands.register({
    name: 'help',
    description: '显示所有可用命令',
    usage: '/help',
    adminOnly: true,
    execute: async () => formatCommandHelp(services.commands.list()),
  });

  ctx.commands.register({
    name: 'status',
    description: '查看机器人运行状态',
    usage: '/status',
    adminOnly: true,
    execute: async () => {
      const runtime = await services.runtime.snapshot();
      const models = await services.models.listModels();
      const summaryStatus = await summaries.status();
      const kbCount = await services.storage.countKnowledgeEntries();
      const ws = runtime.onebot.webSocket;

      return [
        '🤖 机器人状态',
        `管理员: ${runtime.admins.length > 0 ? runtime.admins.join(', ') : '未配置'}`,
        `WebSocket: ${ws.mode}${ws.mode === 'forward' || ws.mode === 'both' ? ` → ${ws.forwardUrl || '(未填地址)'}` : ''}`,
        `摘要: ${summaryStatus.enabled ? `每 ${Math.round(summaryStatus.intervalMs / 1000)}s，≥${summaryStatus.batchSize} 条触发` : '已停用'}${summaryStatus.lastGeneratedAt ? `，上次 ${summaryStatus.lastGeneratedAt.slice(0, 19).replace('T', ' ')}` : ''}`,
        `知识库: ${runtime.plugins['builtin-knowledge']?.enabled !== false ? `${kbCount} 条` : '已禁用'}`,
        '',
        '任务模型绑定:',
        formatActiveTaskModels(models) || '- 无（仅规则回退，请配置真实模型）',
      ].join('\n');
    },
  });

  ctx.commands.register({
    name: 'send',
    description: '让机器人向指定账号或群发送消息',
    usage: '/send private <qq> <内容> 或 /send group <群号> <内容>',
    adminOnly: true,
    execute: async (cmdCtx) => {
      const [targetType, targetId, ...contentParts] = cmdCtx.args;
      if (!targetType || !targetId || contentParts.length === 0) {
        return '用法: /send private <qq> <内容> 或 /send group <群号> <内容>';
      }
      const content = contentParts.join(' ');
      if (targetType === 'private') {
        await cmdCtx.bot.sendPrivateMessage(targetId, content);
        return `已发送给 ${targetId}`;
      }
      if (targetType === 'group') {
        await cmdCtx.bot.sendGroupMessage(targetId, content);
        return `已发送到群 ${targetId}`;
      }
      return 'targetType 只能是 private 或 group';
    },
  });

  ctx.commands.register({
    name: 'summary',
    description: '查看或立即生成摘要',
    usage: '/summary now',
    adminOnly: true,
    execute: async (cmdCtx) => {
      const subCommand = cmdCtx.args[0]?.toLowerCase();
      if (subCommand === 'now') {
        const record = await summaries.flush('manual-command');
        if (!record) {
          return '当前没有可生成的摘要（无新消息或没有普通用户消息）。';
        }
        const status = await summaries.status();
        return `摘要已生成并发送给 ${record.recipientIds.length} 位管理员（${record.sourceEventIds.length} 条消息，${record.excludedEventIds.length} 条跳过）。下次自动摘要延后至 ${Math.round(status.intervalMs / 1000)}s 后。`;
      }
      if (subCommand === 'status') {
        const status = await summaries.status();
        return [
          `摘要功能: ${status.enabled ? '开启' : '关闭'}`,
          `间隔: ${status.intervalMs} ms`,
          `批量阈值: ${status.batchSize}`,
          `游标: ${status.cursorEventId ?? '无'}`,
          `上次生成: ${status.lastGeneratedAt ?? '无'}`,
        ].join('\n');
      }
      return '用法: /summary now 或 /summary status';
    },
  });

  ctx.commands.register({
    name: 'model',
    description: '查看和切换模型',
    usage: '/model list | /model activate <task> <modelId> | /model enable <modelId> | /model disable <modelId>',
    adminOnly: true,
    execute: async (cmdCtx) => {
      const [subCommand, arg1, arg2] = cmdCtx.args;
      if (!subCommand || subCommand === 'list') {
        const models = await services.models.listModels();
        const lines = models.map((model) => {
          const active = model.activeTasks.length > 0 ? ` [active:${model.activeTasks.join(',')}]` : '';
          const status = model.enabled ? 'enabled' : 'disabled';
          return `- ${model.family}/${model.id} (${model.provider}, ${status})${active}`;
        });
        return lines.length > 0 ? lines.join('\n') : '暂无模型。';
      }
      if (subCommand === 'activate') {
        const task = arg1;
        const modelId = arg2;
        if (!task || !modelId) return '用法: /model activate <task> <modelId>';
        await services.models.setActiveModel(task as never, modelId);
        return `已将 ${task} 任务切换为 ${modelId}`;
      }
      if (subCommand === 'enable' && arg1) {
        await services.models.setModelEnabled(arg1, true);
        return `已启用 ${arg1}`;
      }
      if (subCommand === 'disable' && arg1) {
        await services.models.setModelEnabled(arg1, false);
        return `已禁用 ${arg1}`;
      }
      return '用法: /model list | /model activate <task> <modelId> | /model enable <modelId> | /model disable <modelId>';
    },
  });

  ctx.commands.register({
    name: 'plugin',
    description: '查看或切换插件',
    usage: '/plugin list | /plugin enable <name> | /plugin disable <name> | /plugin reload <name>',
    adminOnly: true,
    execute: async (cmdCtx) => {
      const [subCommand, pluginName] = cmdCtx.args;
      if (!subCommand || subCommand === 'list') {
        const plugins = await services.plugins.list();
        const lines = plugins.map((plugin) => {
          return `- ${plugin.name} (${plugin.version}) ${plugin.enabled ? 'enabled' : 'disabled'}${plugin.description ? ` - ${plugin.description}` : ''}`;
        });
        return lines.length > 0 ? lines.join('\n') : '暂无插件。';
      }
      if (!pluginName) {
        return '用法: /plugin list | /plugin enable <name> | /plugin disable <name> | /plugin reload <name>';
      }
      if (subCommand === 'enable') {
        await services.plugins.setEnabled(pluginName, true);
        return `已启用插件 ${pluginName}`;
      }
      if (subCommand === 'disable') {
        await services.plugins.setEnabled(pluginName, false);
        return `已禁用插件 ${pluginName}`;
      }
      if (subCommand === 'reload') {
        await services.plugins.reloadOne(pluginName);
        return `已重新加载插件 ${pluginName}`;
      }
      return '用法: /plugin list | /plugin enable <name> | /plugin disable <name> | /plugin reload <name>';
    },
  });

  ctx.commands.register({
    name: 'admin',
    description: '查看管理员列表',
    usage: '/admin list | /admin add <qq> | /admin remove <qq>',
    adminOnly: true,
    execute: async (cmdCtx) => {
      const [subCommand, adminId] = cmdCtx.args;
      if (!subCommand || subCommand === 'list') {
        const snapshot = await cmdCtx.runtime.snapshot();
        return snapshot.admins.length > 0 ? snapshot.admins.map((item) => `- ${item}`).join('\n') : '暂无管理员。';
      }
      if (!adminId) {
        return '用法: /admin list | /admin add <qq> | /admin remove <qq>';
      }
      const next = await cmdCtx.runtime.snapshot();
      const admins = new Set(next.admins);
      if (subCommand === 'add') {
        admins.add(adminId);
        await services.runtime.update((state) => {
          state.admins = [...admins];
        });
        return `已添加管理员 ${adminId}`;
      }
      if (subCommand === 'remove') {
        admins.delete(adminId);
        await services.runtime.update((state) => {
          state.admins = [...admins];
        });
        return `已移除管理员 ${adminId}`;
      }
      return '用法: /admin list | /admin add <qq> | /admin remove <qq>';
    },
  });

  ctx.commands.register({
    name: 'report',
    description: '查看最近摘要或手动触发摘要',
    usage: '/report list | /report flush',
    adminOnly: true,
    execute: async (cmdCtx) => {
      const [subCommand] = cmdCtx.args;
      if (!subCommand || subCommand === 'list') {
        const summaries = await services.storage.listSummaries(5);
        if (summaries.length === 0) return '暂无摘要记录。';
        return summaries
          .map((summary) => `- ${summary.createdAt}\n${summary.summaryText}\n建议:\n${summary.suggestionsText}`)
          .join('\n\n');
      }
      if (subCommand === 'flush') {
        const record = await summaries.flush('manual-report');
        if (!record) return '当前没有可生成的摘要（无新消息或没有普通用户消息）。';
        return `摘要已刷新并发送给 ${record.recipientIds.length} 位管理员（${record.sourceEventIds.length} 条消息）。`;
      }
      return '用法: /report list | /report flush';
    },
  });
}
