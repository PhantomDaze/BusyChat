import type { ReplyManager } from './reply';
import type {
  AppServices,
  CommandContext,
  CommandDefinition,
  CommandDispatchResult,
  KnowledgeEntry,
  ModelTask,
  NormalizedMessageEvent,
  OutgoingMessage,
} from './types';

interface CommandBusDependencies {
  bot: AppServices['bot'];
  models: AppServices['models'];
  storage: AppServices['storage'];
  runtime: AppServices['runtime'];
  appLogger: AppServices['appLogger'];
}

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function toText(message: OutgoingMessage): string {
  if (typeof message === 'string') {
    return message;
  }
  return message
    .map((segment) => {
      if (segment.type === 'text') {
        return segment.data.text ?? '';
      }
      return `[${segment.type}]`;
    })
    .join('');
}

export class CommandBus {
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly owners = new Map<string, string>();

  constructor(private readonly services: CommandBusDependencies) {}

  register(definition: CommandDefinition): void {
    if (!definition.description || !definition.description.trim()) {
      throw new Error(`command /${definition.name} must have a non-empty description`);
    }
    const currentOwner = this.owners.get(definition.name);
    if (this.commands.has(definition.name) && currentOwner !== definition.owner) {
      throw new Error(`command ${definition.name} already exists`);
    }
    this.commands.set(definition.name, definition);
    this.owners.set(definition.name, definition.owner ?? 'builtin');
  }

  unregisterOwner(owner: string): void {
    for (const [name, currentOwner] of this.owners.entries()) {
      if (currentOwner === owner) {
        this.owners.delete(name);
        this.commands.delete(name);
      }
    }
  }

  list(): CommandDefinition[] {
    return [...this.commands.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async dispatch(event: NormalizedMessageEvent): Promise<CommandDispatchResult> {
    const text = event.content.text.trim();
    if (!text.startsWith('/')) {
      return { handled: false, reply: undefined };
    }

    const tokens = tokenizeCommand(text.slice(1));
    if (tokens.length === 0) {
      return { handled: false, reply: undefined };
    }

    const commandName = tokens[0]?.toLowerCase();
    if (!commandName) {
      return { handled: false, reply: undefined };
    }
    const args = tokens.slice(1);
    const definition = this.commands.get(commandName);

    if (!definition) {
      return { handled: false, command: commandName, args, reply: undefined };
    }

    if (definition.adminOnly && !event.visibility.fromAdmin) {
      return {
        handled: true,
        command: commandName,
        args,
        reply: '该命令仅限管理员使用。',
      };
    }

    const logger = this.services.appLogger.child(`command:${definition.name}`);
    const reply = async (message: OutgoingMessage): Promise<void> => {
      await this.services.bot.send(
        {
          type: event.scope,
          id: event.scope === 'group' ? event.conversationId.replace(/^group:/, '') : event.sender.userId,
        },
        message,
      );
    };

    const context: CommandContext = {
      event,
      args,
      bot: this.services.bot,
      models: this.services.models,
      storage: this.services.storage.namespace(`command-${definition.name}`),
      runtime: this.services.runtime,
      logger,
      reply,
    };

    const result = await definition.execute(context);
    const replyText = typeof result === 'string' ? result : undefined;

    if (replyText) {
      await reply(replyText);
    }

    return {
      handled: true,
      command: commandName,
      args,
      reply: replyText,
    };
  }
}

function formatCommandHelp(commands: CommandDefinition[]): string {
  const publicCmds = commands.filter((c) => !c.adminOnly);
  const adminCmds = commands.filter((c) => c.adminOnly);

  const fmt = (list: CommandDefinition[]) =>
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
      if (model.activeTasks.length === 0) {
        return [];
      }
      return model.activeTasks.map((task) => `- ${task}: ${model.label} (${model.id}, ${model.family}, ${model.provider})`);
    })
    .join('\n');
}

export function registerBuiltinCommands(services: AppServices, replies?: ReplyManager): void {
  const bus = services.commands;

  bus.register({
    name: 'help',
    description: '显示所有可用命令',
    usage: '/help',
    adminOnly: false,
    owner: 'builtin',
    execute: async () => formatCommandHelp(bus.list()),
  });

  bus.register({
    name: 'send',
    description: '让机器人向指定账号或群发送消息',
    usage: '/send private <qq> <内容> 或 /send group <群号> <内容>',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      const [targetType, targetId, ...contentParts] = ctx.args;
      if (!targetType || !targetId || contentParts.length === 0) {
        return '用法: /send private <qq> <内容> 或 /send group <群号> <内容>';
      }

      const content = contentParts.join(' ');
      if (targetType === 'private') {
        await ctx.bot.sendPrivateMessage(targetId, content);
        return `已发送给 ${targetId}`;
      }
      if (targetType === 'group') {
        await ctx.bot.sendGroupMessage(targetId, content);
        return `已发送到群 ${targetId}`;
      }
      return 'targetType 只能是 private 或 group';
    },
  });

  bus.register({
    name: 'summary',
    description: '查看或立即生成摘要',
    usage: '/summary now',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      const subCommand = ctx.args[0]?.toLowerCase();
      if (subCommand === 'now') {
        const record = await services.summaries.flush('manual-command');
        if (!record) {
          return '当前没有可生成的摘要（无新消息或没有普通用户消息）。';
        }
        const cfg = await services.runtime.snapshot();
        return `摘要已生成并发送给 ${record.recipientIds.length} 位管理员（${record.sourceEventIds.length} 条消息，${record.excludedEventIds.length} 条跳过）。下次自动摘要延后至 ${Math.round(cfg.summary.intervalMs / 1000)}s 后。`;
      }
      if (subCommand === 'status') {
        const status = await services.summaries.status();
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

  bus.register({
    name: 'model',
    description: '查看和切换模型',
    usage: '/model list | /model activate <task> <modelId> | /model enable <modelId> | /model disable <modelId>',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      const [subCommand, arg1, arg2] = ctx.args;
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
        const task = arg1 as ModelTask | undefined;
        const modelId = arg2;
        if (!task || !modelId) {
          return '用法: /model activate <task> <modelId>';
        }
        await services.models.setActiveModel(task, modelId);
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

  bus.register({
    name: 'plugin',
    description: '查看或切换插件',
    usage: '/plugin list | /plugin enable <name> | /plugin disable <name>',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      const [subCommand, pluginName] = ctx.args;
      if (!subCommand || subCommand === 'list') {
        const plugins = await services.plugins.list();
        const lines = plugins.map((plugin) => {
          return `- ${plugin.name} (${plugin.version}) ${plugin.enabled ? 'enabled' : 'disabled'}${plugin.description ? ` - ${plugin.description}` : ''}`;
        });
        return lines.length > 0 ? lines.join('\n') : '暂无插件。';
      }
      if (!pluginName) {
        return '用法: /plugin list | /plugin enable <name> | /plugin disable <name>';
      }
      if (subCommand === 'enable') {
        await services.plugins.setEnabled(pluginName, true);
        return `已启用插件 ${pluginName}`;
      }
      if (subCommand === 'disable') {
        await services.plugins.setEnabled(pluginName, false);
        return `已禁用插件 ${pluginName}`;
      }
      return '用法: /plugin list | /plugin enable <name> | /plugin disable <name>';
    },
  });

  bus.register({
    name: 'admin',
    description: '查看管理员列表',
    usage: '/admin list | /admin add <qq> | /admin remove <qq>',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      const [subCommand, adminId] = ctx.args;
      if (!subCommand || subCommand === 'list') {
        const snapshot = await ctx.runtime.snapshot();
        return snapshot.admins.length > 0 ? snapshot.admins.map((item) => `- ${item}`).join('\n') : '暂无管理员。';
      }
      if (!adminId) {
        return '用法: /admin list | /admin add <qq> | /admin remove <qq>';
      }
      const next = await ctx.runtime.snapshot();
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

  bus.register({
    name: 'report',
    description: '查看最近摘要或手动触发摘要',
    usage: '/report list | /report flush',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      const [subCommand] = ctx.args;
      if (!subCommand || subCommand === 'list') {
        const summaries = await services.storage.listSummaries(5);
        if (summaries.length === 0) {
          return '暂无摘要记录。';
        }
        return summaries
          .map((summary) => {
            return `- ${summary.createdAt}\n${summary.summaryText}\n建议:\n${summary.suggestionsText}`;
          })
          .join('\n\n');
      }
      if (subCommand === 'flush') {
        const record = await services.summaries.flush('manual-report');
        if (!record) {
          return '当前没有可生成的摘要（无新消息或没有普通用户消息）。';
        }
        return `摘要已刷新并发送给 ${record.recipientIds.length} 位管理员（${record.sourceEventIds.length} 条消息）。`;
      }
      return '用法: /report list | /report flush';
    },
  });

  // -------------------------------------------------------------------
  // Notification keywords & quiet hours
  // -------------------------------------------------------------------

  bus.register({
    name: 'notify',
    description: '管理关键词告警和免打扰时段',
    usage: '/notify keywords [add|remove|list] | /notify quiet <开始> <结束> | /notify quiet off',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      const [sub, ...rest] = ctx.args;

      if (!sub || sub === 'keywords') {
        const [kwAction, ...kwRest] = rest;
        const kw = kwRest.join(' ').trim();

        if (!kwAction || kwAction === 'list') {
          const snapshot = await ctx.runtime.snapshot();
          const kws = snapshot.notifyKeywords ?? [];
          if (kws.length === 0) return '当前未设置通知关键词。用法: /notify keywords add <关键词>';
          return `当前通知关键词:\n${kws.map((k, i) => `${i + 1}. ${k}`).join('\n')}`;
        }

        if (kwAction === 'add' && kw) {
          await services.runtime.update((state) => {
            const kws = state.notifyKeywords ?? [];
            if (!kws.includes(kw)) {
              state.notifyKeywords = [...kws, kw];
            }
          });
          return `已添加通知关键词: ${kw}`;
        }

        if (kwAction === 'remove' && kw) {
          await services.runtime.update((state) => {
            state.notifyKeywords = (state.notifyKeywords ?? []).filter((k) => k !== kw);
          });
          return `已移除通知关键词: ${kw}`;
        }

        return '用法: /notify keywords [add|remove|list]';
      }

      if (sub === 'quiet') {
        const [start, end] = rest;
        if (!start || start === 'off') {
          await services.runtime.update((state) => { delete state.quietHours; });
          return '免打扰已关闭。';
        }
        if (start && end) {
          await services.runtime.update((state) => {
            state.quietHours = { start: start!.trim(), end: end!.trim() };
          });
          return `免打扰时段已设为 ${start!.trim()} - ${end!.trim()}（含关键词的紧急消息仍会在非免打扰时段通知）。`;
        }
        return '用法: /notify quiet <开始时间> <结束时间> (如 /notify quiet 23:00 07:00)';
      }

      return '用法: /notify keywords [add|remove|list] | /notify quiet <开始> <结束> | /notify quiet off';
    },
  });

  // -------------------------------------------------------------------
  // Reply assistant
  // -------------------------------------------------------------------

  bus.register({
    name: 'reply',
    description: '查看或处理待回复消息',
    usage: '/reply list | /reply <ID前8位> <指示> | /reply dismiss <ID前8位>',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      if (!replies) return '回复功能未启用。';

      const [action, ...rest] = ctx.args;

      if (!action || action === 'list') {
        const pending = replies.listPending();
        if (pending.length === 0) return '当前没有待回复的消息。';
        return pending
          .map((p) => {
            const e = p.sourceEvent;
            const scope = e.scope === 'group' ? '群' : '私';
            const sender = e.sender.nickname ?? e.sender.userId;
            const time = e.receivedAt.slice(11, 19);
            return `[${p.id.slice(0, 8)}] [${scope}] ${sender}: ${e.content.text.slice(0, 80)} (${time})`;
          })
          .join('\n');
      }

      if (action === 'dismiss') {
        const id = rest[0];
        if (!id) return '用法: /reply dismiss <ID前8位>';
        const ok = replies.dismiss(id);
        return ok ? `已忽略 ${id}` : `未找到待回复消息: ${id}`;
      }

      // Treat first arg as the reply ID and the rest as admin instruction
      const replyId = action;
      const instruction = rest.join(' ').trim();
      if (!instruction) return '用法: /reply <ID前8位> <回复指示>';

      const pending = replies.getPending(replyId);
      if (!pending) return `未找到待回复消息: ${replyId}（可用 /reply list 查看全部）`;

      try {
        const result = await replies.generateReply(pending, instruction);
        await ctx.bot.send(result.target, result.message);
        replies.markResolved(pending, result);
        return `已回复 [${result.target.type === 'group' ? '群' : '私'}:${result.target.id}]: ${typeof result.message === 'string' ? result.message.slice(0, 100) : '[非文本消息]'}`;
      } catch (err) {
        return `回复失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  // -------------------------------------------------------------------
  // Knowledge base commands
  // -------------------------------------------------------------------

  bus.register({
    name: 'remember',
    description: '将文本添加到知识库',
    usage: '/remember <内容>',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      if (ctx.args.length === 0) return '用法: /remember <要记忆的内容>';
      const text = ctx.args.join(' ');
      try {
        const entry = await services.knowledge.add(text, {
          source: 'command',
          type: 'user',
        });
        return `已记忆 [${entry.id.slice(0, 8)}]: ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`;
      } catch (err) {
        return `记忆失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  bus.register({
    name: 'recall',
    description: '语义搜索知识库',
    usage: '/recall <查询> [数量]',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      const maybeLimit = parseInt(ctx.args[ctx.args.length - 1]!, 10);
      const hasLimit = Number.isFinite(maybeLimit) && maybeLimit > 0;
      const queryEnd = hasLimit ? ctx.args.length - 1 : ctx.args.length;
      const query = ctx.args.slice(0, queryEnd).join(' ');
      if (!query) return '用法: /recall <查询内容> [返回数量]';
      try {
        const results = await services.knowledge.search(
          query,
          hasLimit ? maybeLimit : undefined,
        );
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

  bus.register({
    name: 'forget',
    description: '从知识库中删除一项',
    usage: '/forget <id>',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      if (ctx.args.length === 0) return '用法: /forget <条目ID>';
      const id = ctx.args[0]!;
      try {
        const deleted = await services.knowledge.delete(id);
        return deleted
          ? `已删除知识库条目 ${id}`
          : `未找到匹配 "${id}" 的条目（支持部分 ID 前缀匹配）`;
      } catch (err) {
        return `删除失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  bus.register({
    name: 'kb-summarize',
    description: '对知识库内容进行总结',
    usage: '/kb-summarize [数量] | /kb-summarize <id1> <id2> ...',
    adminOnly: true,
    owner: 'builtin',
    execute: async (ctx) => {
      try {
        let summary: KnowledgeEntry | null = null;

        if (ctx.args.length === 0) {
          // Summarize recent entries
          summary = await services.knowledge.summarize();
        } else {
          const maybeLimit = parseInt(ctx.args[0]!, 10);
          if (Number.isFinite(maybeLimit) && maybeLimit > 0) {
            // Summarize N most recent entries
            const entries = await services.knowledge.list(maybeLimit);
            summary = await services.knowledge.summarize(
              entries.map((e) => e.id),
            );
          } else {
            // Treat args as entry IDs
            summary = await services.knowledge.summarize(ctx.args);
          }
        }

        if (!summary) {
          return '没有可总结的知识库条目。';
        }

        return `记忆总结 [${summary.id.slice(0, 8)}]:\n${summary.text}`;
      } catch (err) {
        return `总结失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
