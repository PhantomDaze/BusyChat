/** 内置回复命令：reply */

import type { PluginContext } from '../../../types';
import type { ReplyManager } from '../../../reply';

export function registerReplyCommands(ctx: PluginContext, replies: ReplyManager): void {
  ctx.commands.register({
    name: 'reply',
    description: '查看或处理待回复消息',
    usage: '/reply list | /reply <ID前8位> <指示> | /reply dismiss <ID前8位>',
    adminOnly: true,
    execute: async (cmdCtx) => {
      const [action, ...rest] = cmdCtx.args;

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

      const replyId = action;
      const instruction = rest.join(' ').trim();
      if (!instruction) return '用法: /reply <ID前8位> <回复指示>';

      const pending = replies.getPending(replyId);
      if (!pending) return `未找到待回复消息: ${replyId}（可用 /reply list 查看全部）`;
      if (pending.status !== 'pending') {
        const label = pending.status === 'replied' ? '已回复' : '已忽略';
        return `该消息${label}，无法重复处理: ${replyId}`;
      }

      try {
        const result = await replies.generateReply(pending, instruction);
        await cmdCtx.bot.send(result.target, result.message);
        replies.markResolved(pending, result);
        return `已回复 [${result.target.type === 'group' ? '群' : '私'}:${result.target.id}]: ${typeof result.message === 'string' ? result.message.slice(0, 100) : '[非文本消息]'}`;
      } catch (err) {
        return `回复失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
