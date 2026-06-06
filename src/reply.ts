import { randomUUID } from 'node:crypto';

import type {
  JsonObject,
  Logger,
  ModelAdminGateway,
  NormalizedMessageEvent,
  OutgoingMessage,
  SendTarget,
} from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingReply {
  id: string;
  createdAt: string;
  sourceEvent: NormalizedMessageEvent;
  status: 'pending' | 'replied' | 'dismissed';
  adminInstruction?: string;
  aiReply?: {
    target: SendTarget;
    message: OutgoingMessage;
    reasoning: string;
  };
  resolvedAt?: string;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

interface ReplyManagerDependencies {
  models: ModelAdminGateway;
  appLogger: Logger;
  selfId?: string;
}

// ---------------------------------------------------------------------------
// ReplyManager
// ---------------------------------------------------------------------------

export class ReplyManager {
  private pending = new Map<string, PendingReply>();

  constructor(private readonly deps: ReplyManagerDependencies) {}

  // -----------------------------------------------------------------------
  // Classification
  // -----------------------------------------------------------------------

  /** Determine whether an incoming message explicitly targets the bot / admin. */
  async classifyMessage(event: NormalizedMessageEvent): Promise<boolean> {
    // Skip bot's own messages and admin messages
    if (event.visibility.fromBot || event.visibility.fromAdmin) return false;

    const text = event.content.text;
    if (!text) return false;

    const isPrivate = event.scope === 'private';

    // Private messages to the bot always warrant admin attention
    if (isPrivate) return true;

    // In groups, only flag if the bot itself was @mentioned
    const selfId = event.botSelfId ?? this.deps.selfId;
    if (selfId) {
      const mentionedBot = event.content.segments.some(
        (s) => s.type === 'at' && (s.data.qq === selfId || s.data.user_id === selfId),
      );
      if (mentionedBot) return true;
      // Fallback: bot QQ appears as text mention
      if (text.includes(`@${selfId}`)) return true;
    }

    // Do NOT flag random group chat — that's the summary worker's job
    return false;
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  addPending(event: NormalizedMessageEvent): PendingReply {
    const entry: PendingReply = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      sourceEvent: event,
      status: 'pending',
    };
    this.pending.set(entry.id, entry);
    this.deps.appLogger.info('reply request added', {
      id: entry.id.slice(0, 8),
      sender: event.sender.userId,
      scope: event.scope,
    });
    return entry;
  }

  listPending(): PendingReply[] {
    return [...this.pending.values()]
      .filter((p) => p.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getPending(idPrefix: string): PendingReply | undefined {
    if (this.pending.has(idPrefix)) return this.pending.get(idPrefix);
    for (const [id, p] of this.pending) {
      if (id.startsWith(idPrefix)) return p;
    }
    return undefined;
  }

  dismiss(id: string): boolean {
    const p = this.getPending(id);
    if (!p || p.status !== 'pending') return false;
    p.status = 'dismissed';
    p.resolvedAt = new Date().toISOString();
    this.deps.appLogger.info('reply request dismissed', { id: p.id.slice(0, 8) });
    return true;
  }

  // -----------------------------------------------------------------------
  // AI reply generation
  // -----------------------------------------------------------------------

  async generateReply(
    pending: PendingReply,
    adminInstruction: string,
  ): Promise<{ target: SendTarget; message: OutgoingMessage; reasoning: string }> {
    const event = pending.sourceEvent;
    const scopeLabel = event.scope === 'group' ? '群聊' : '私聊';

    const prompt = [
      '你是一个消息回复助手。请根据管理员指示生成回复。',
      '',
      '原始消息：',
      `  发送者: ${event.sender.nickname ?? event.sender.userId} (QQ ${event.sender.userId})`,
      `  类型: ${scopeLabel}`,
      `  内容: ${event.content.text.slice(0, 500)}`,
      '',
      `管理员指示: ${adminInstruction}`,
      '',
      '请按以下格式输出：',
      '回复方式: [private/group]',
      '回复对象ID: [QQ号或群号]',
      '回复内容: [具体措辞]',
      '',
      '规则：',
      '- 如果原始消息是群聊，除非管理员明确要求私聊，否则在群里回复',
      '- 如果原始消息是私聊，直接私聊回复',
      '- 回复用语自然友好，以管理员名义而非机器人名义',
    ].join('\n');

    const result = await this.deps.models.generateText('chat', prompt, {
      pendingReplyId: pending.id,
      adminInstruction: adminInstruction.slice(0, 100),
      sourceEventScope: event.scope,
    });

    const text = result.text;

    // Parse the AI output
    const targetTypeMatch = text.match(/回复方式:\s*(private|group)/i);
    const targetType = (targetTypeMatch?.[1]?.toLowerCase() ?? event.scope) as 'private' | 'group';

    const targetIdMatch = text.match(/回复对象ID:\s*(\S+)/);
    let targetId = targetIdMatch?.[1]?.trim() ?? '';

    // Fallback: reply in the original conversation
    if (!targetId) {
      if (event.scope === 'group') {
        targetId = event.conversationId.replace(/^group:/, '');
      } else {
        targetId = event.sender.userId;
      }
    }

    const replyContentMatch = text.match(/回复内容:\s*([\s\S]+)$/);
    const replyContent = replyContentMatch?.[1]?.trim() || adminInstruction;

    const target: SendTarget = { type: targetType, id: targetId };

    pending.adminInstruction = adminInstruction;

    return { target, message: replyContent, reasoning: text.slice(0, 200) };
  }

  markResolved(
    pending: PendingReply,
    result: { target: SendTarget; message: OutgoingMessage; reasoning: string },
  ): void {
    pending.status = 'replied';
    pending.aiReply = result;
    pending.resolvedAt = new Date().toISOString();
    this.deps.appLogger.info('reply request resolved', {
      id: pending.id.slice(0, 8),
      target: `${result.target.type}:${result.target.id}`,
    });
  }

  // -----------------------------------------------------------------------
  // Summary integration
  // -----------------------------------------------------------------------

  formatPendingForSummary(): string {
    const pending = this.listPending();
    if (pending.length === 0) return '';

    const items = pending.map((p, i) => {
      const event = p.sourceEvent;
      const scopeLabel = event.scope === 'group' ? '群聊' : '私聊';
      const sender = event.sender.nickname ?? event.sender.userId;
      const time = event.receivedAt.slice(11, 19);
      return [
        `[待回复 #${i + 1}] ${p.id.slice(0, 8)}`,
        `  发送者: ${sender} (${event.sender.userId})`,
        `  来源: ${scopeLabel} | 时间: ${time}`,
        `  内容: ${event.content.text.slice(0, 200)}`,
      ].join('\n');
    });

    return [
      '',
      '--- 待回复消息 ---',
      '以下消息可能需要回复：',
      ...items,
      '',
      '回复: /reply <ID前8位> <指示>  (如 /reply a1b2c3d4 告诉他稍后处理)',
      '忽略: /reply dismiss <ID前8位>',
      '/reply list 查看全部',
    ].join('\n');
  }
}
