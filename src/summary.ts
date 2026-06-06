import { randomUUID } from 'node:crypto';

import { splitLongText } from './onebot';
import type { ReplyManager } from './reply';
import type {
  AdviceGenerationContext,
  AdviceRecord,
  AppServices,
  Logger,
  ModelTask,
  NormalizedMessageEvent,
  SummaryGenerationContext,
  SummaryRecord,
} from './types';

interface SummaryWorkerDependencies {
  runtime: AppServices['runtime'];
  storage: AppServices['storage'];
  bot: AppServices['bot'];
  models: AppServices['models'];
  plugins: AppServices['plugins'];
  replies: ReplyManager;
  appLogger: Logger;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/** Merge same-sender messages within 5 min and collapse noise. */
function compactEvents(events: NormalizedMessageEvent[]): NormalizedMessageEvent[] {
  const result: NormalizedMessageEvent[] = [];
  for (const event of events) {
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.sender.userId === event.sender.userId &&
      prev.scope === event.scope &&
      prev.conversationId === event.conversationId
    ) {
      const prevTime = new Date(prev.receivedAt).getTime();
      const thisTime = new Date(event.receivedAt).getTime();
      if (thisTime - prevTime < 300_000) {
        // Merge into previous — concatenate text
        prev.content.text = `${prev.content.text} | ${event.content.text}`;
        prev.content.rawText = `${prev.content.rawText ?? ''} | ${event.content.rawText ?? ''}`;
        continue;
      }
    }
    // Skip pure emoji / single-char messages unless from admin
    const t = event.content.text.trim();
    if (!event.sender.isAdmin && t.length <= 1 && !/[a-zA-Z0-9]/.test(t)) continue;
    result.push({ ...event, content: { ...event.content } });
  }
  return result;
}

async function scoreMessages(
  events: NormalizedMessageEvent[],
  models: { generateText: SummaryWorkerDependencies['models']['generateText'] },
): Promise<Record<string, number>> {
  // Only score non-admin, non-bot messages
  const toScore = events.filter((e) => !e.sender.isAdmin && !e.sender.isBot);
  if (toScore.length === 0) return {};

  const lines = toScore.map((e, i) => {
    const sender = e.sender.nickname || e.sender.card || e.sender.userId;
    return `${i + 1}. [${e.scope === 'group' ? '群' : '私'}] ${sender}: ${e.content.text.slice(0, 100)}`;
  });

  try {
    const result = await models.generateText(
      'classifier',
      [
        '评估以下每条消息的重要度，只输出编号和分数（1-5）：',
        '1=纯闲聊/表情 2=日常对话 3=有点内容 4=需要关注 5=紧急/重要',
        '',
        ...lines,
        '',
        '输出格式（每条一行，无其他文字）：',
        '1:2',
        '2:4',
      ].join('\n'),
      { source: 'importance-scoring' },
    );

    const scores: Record<string, number> = {};
    for (const line of result.text.split('\n')) {
      const m = line.trim().match(/^(\d+)\s*[:：]\s*(\d)/);
      if (m) {
        const idx = parseInt(m[1]!, 10) - 1;
        const score = parseInt(m[2]!, 10);
        if (idx >= 0 && idx < toScore.length) {
          scores[toScore[idx]!.id] = Math.min(5, Math.max(1, score));
        }
      }
    }
    return scores;
  } catch {
    // AI unavailable — treat all as medium importance
    const scores: Record<string, number> = {};
    for (const e of toScore) scores[e.id] = 3;
    return scores;
  }
}

function buildSummaryPrompt(context: SummaryGenerationContext, scores?: Record<string, number>): string {
  const scoreMap = scores ?? {};
  const detailLines: string[] = [];
  let noisyCount = 0;

  for (const event of context.events) {
    const senderLabel = event.sender.nickname || event.sender.card || event.sender.userId;
    const scopeLabel = event.scope === 'group' ? `群 ${event.conversationId.replace(/^group:/, '')}` : '私聊';
    const adminMarker = event.sender.isAdmin ? ' [管理员]' : '';
    const botMarker = event.sender.isBot ? ' [Bot]' : '';
    const marker = adminMarker || botMarker;
    const s = scoreMap[event.id] ?? 3;

    if (event.sender.isAdmin || event.sender.isBot) {
      // Always include admin/bot messages for context
      detailLines.push(`${detailLines.length + 1}. [${scopeLabel}] ${senderLabel}${marker}: ${event.content.text}`);
    } else if (s >= 3) {
      const stars = s >= 5 ? '★★★' : s === 4 ? '★★' : '★';
      detailLines.push(`${detailLines.length + 1}. ${stars} [${scopeLabel}] ${senderLabel}: ${event.content.text}`);
    } else {
      noisyCount += 1;
    }
  }

  const parts = [
    '你是一个 QQ 消息汇报助手。',
    '规则：',
    '- 标有 [管理员] 的消息用于理解对话上下文，不作为报告主体。',
    '- ★★★ 为紧急/重要消息，需重点关注；★★ 值得留意；★ 一般内容。',
    noisyCount > 0 ? `- 另有 ${noisyCount} 条闲聊消息未列出，可忽略。` : '',
    '- 输出必须包含两个部分：摘要和建议。',
    '- 建议要面向管理员，尽量可执行。',
    '',
    `汇报对象: ${context.recipients.join(', ') || '未配置'}`,
    `消息数量: ${context.events.length}`,
    '消息列表:',
    ...detailLines,
  ].filter(Boolean);

  return parts.join('\n');
}

function buildAdvicePrompt(event: NormalizedMessageEvent, recentSummaries: SummaryRecord[]): string {
  const summaryLines = recentSummaries.slice(0, 5).map((summary, index) => {
    return `${index + 1}. ${summary.createdAt}\n${summary.summaryText}\n建议:\n${summary.suggestionsText}`;
  });

  return [
    '你是管理员专属助手。',
    '规则：',
    '- 只给建议，不要把管理员自己的消息当成报告内容。',
    '- 给出可执行、简短、明确的建议。',
    '- 如果管理员是在询问如何发送消息，请直接给出命令格式。',
    '',
    `管理员消息: ${event.content.text}`,
    event.scope === 'private'
      ? `会话: 私聊 ${event.conversationId.replace(/^private:/, '')}`
      : `会话: 群 ${event.conversationId.replace(/^group:/, '')}`,
    '',
    '最近摘要:',
    ...summaryLines,
  ].join('\n');
}

function parseSummaryOutput(text: string): { summaryText: string; suggestionsText: string } {
  const summaryMatch = text.match(/摘要[：:]\s*([\s\S]*?)(?:\n+建议[：:]\s*|$)/);
  const suggestionsMatch = text.match(/建议[：:]\s*([\s\S]*)$/);

  if (!summaryMatch && !suggestionsMatch) {
    return {
      summaryText: text.trim(),
      suggestionsText: '',
    };
  }

  return {
    summaryText: summaryMatch?.[1]?.trim() || text.trim(),
    suggestionsText: suggestionsMatch?.[1]?.trim() || '',
  };
}

function parseAdviceText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '暂无建议。';
  }
  return trimmed;
}

async function getActiveModelId(services: SummaryWorkerDependencies, task: ModelTask): Promise<string | undefined> {
  const models = await services.models.listModels();
  const active = models.find((model) => model.activeTasks.includes(task));
  return active?.id;
}

export class SummaryWorker {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SummaryWorkerDependencies) {}

  async start(): Promise<void> {
    await this.stop();
    const runtime = await this.deps.runtime.snapshot();
    if (!runtime.summary.enabled) {
      this.deps.appLogger.info('summary worker disabled');
      return;
    }

    if (runtime.admins.length === 0) {
      this.deps.appLogger.warn('summary worker started but NO ADMINS configured — summaries will not be delivered. Use /admin add <QQ> to add recipients.');
    }

    const intervalMs = runtime.summary.intervalMs;
    this.timer = setInterval(() => {
      void this.flush('interval').catch((error) => {
        this.deps.appLogger.error('summary flush failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);

    this.deps.appLogger.info('summary worker started', {
      intervalMs,
      batchSize: runtime.summary.batchSize,
      admins: runtime.admins.length,
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async status(): Promise<{
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    cursorEventId: string | undefined;
    lastGeneratedAt: string | undefined;
  }> {
    const runtime = await this.deps.runtime.snapshot();
    return {
      enabled: runtime.summary.enabled,
      intervalMs: runtime.summary.intervalMs,
      batchSize: runtime.summary.batchSize,
      cursorEventId: runtime.summary.cursorEventId,
      lastGeneratedAt: runtime.summary.lastGeneratedAt,
    };
  }

  async flush(reason: string): Promise<SummaryRecord | null> {
    const runtime = await this.deps.runtime.snapshot();
    if (!runtime.summary.enabled) {
      this.deps.appLogger.info('summary flush skipped: disabled');
      return null;
    }

    const recipients = [...runtime.admins];
    if (recipients.length === 0) {
      this.deps.appLogger.warn('summary flush skipped: no admins configured — use /admin add <QQ> to add recipients');
      return null;
    }
    const allEvents = await this.deps.storage.listEventsAfter(runtime.summary.cursorEventId);
    if (allEvents.length === 0) {
      this.deps.appLogger.debug('summary flush skipped: no new events since cursor', {
        cursorEventId: runtime.summary.cursorEventId ?? '(none)',
      });
      return null;
    }

    const limitedEvents = allEvents.slice(-runtime.summary.maxEventsPerPrompt);
    // Context events: include admin messages so AI sees the full conversation
    const contextEvents = limitedEvents.filter((event) => !event.visibility.fromBot);
    // Reportable events: only non-admin non-bot messages for the batch threshold
    const reportableEvents = limitedEvents.filter((event) => event.visibility.includeInReports);
    const excludedEvents = limitedEvents.filter((event) => event.visibility.fromBot);
    const lastEvent = limitedEvents[limitedEvents.length - 1];

    if (!lastEvent) {
      return null;
    }

    if (contextEvents.length === 0) {
      await this.deps.runtime.update((state) => {
        state.summary.cursorEventId = lastEvent.id;
        state.summary.lastGeneratedAt = nowIso();
      });
      return null;
    }

    if (reason === 'interval' && reportableEvents.length < runtime.summary.batchSize) {
      return null;
    }

    // Dedup & collapse noise before scoring
    const compacted = compactEvents(contextEvents);
    const scores = await scoreMessages(compacted, this.deps.models);

    const generationContext: SummaryGenerationContext = {
      events: compacted,
      recipients,
      cursorEventId: lastEvent.id,
    };

    const prompt = buildSummaryPrompt(generationContext, scores);
    const textResult = await this.deps.models.generateText('summary', prompt, {
      reason,
      recipients,
      eventCount: generationContext.events.length,
    });
    const parsed = parseSummaryOutput(textResult.text);
    const summaryRecord: SummaryRecord = {
      id: makeId('summary'),
      createdAt: nowIso(),
      cursorEventId: lastEvent.id,
      sourceEventIds: limitedEvents.map((event) => event.id),
      excludedEventIds: excludedEvents.map((event) => event.id),
      recipientIds: recipients,
      modelId: await getActiveModelId(this.deps, 'summary'),
      summaryText: parsed.summaryText,
      suggestionsText: parsed.suggestionsText || '暂无建议。',
      metadata: {
        reason,
        eventCount: limitedEvents.length,
        reportableCount: reportableEvents.length,
      },
    };

    await this.deps.storage.appendSummary(summaryRecord);
    await this.deps.runtime.update((state) => {
      state.summary.cursorEventId = lastEvent.id;
      state.summary.lastGeneratedAt = summaryRecord.createdAt;
    });

    const pendingSection = this.deps.replies.formatPendingForSummary();
    const fullText = `摘要：\n${summaryRecord.summaryText}\n\n建议：\n${summaryRecord.suggestionsText}${pendingSection}`;
    const chunks = splitLongText(fullText, 3800);
    for (const recipientId of recipients) {
      for (let i = 0; i < chunks.length; i += 1) {
        const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
        await this.deps.bot.sendPrivateMessage(recipientId, prefix + chunks[i]!);
      }
    }

    await this.deps.plugins.dispatchSummary(summaryRecord);
    this.deps.appLogger.info('summary sent', {
      reason,
      recipients,
      eventCount: limitedEvents.length,
    });

    // 手动触发后重置定时器，下次自动摘要在 intervalMs 之后
    if (reason !== 'interval') {
      await this.start();
    }

    return summaryRecord;
  }

  async advise(event: NormalizedMessageEvent): Promise<AdviceRecord> {
    const recentSummaries = await this.deps.storage.listSummaries(5);
    const prompt = buildAdvicePrompt(event, recentSummaries);
    const textResult = await this.deps.models.generateText('advice', prompt, {
      eventId: event.id,
      adminId: event.sender.userId,
    });
    const adviceText = parseAdviceText(textResult.text);
    const adviceRecord: AdviceRecord = {
      id: makeId('advice'),
      createdAt: nowIso(),
      adminId: event.sender.userId,
      sourceEventId: event.id,
      modelId: await getActiveModelId(this.deps, 'advice'),
      adviceText,
      metadata: {
        conversationId: event.conversationId,
      },
    };

    await this.deps.storage.appendAdvice(adviceRecord);
    await this.deps.bot.sendPrivateMessage(event.sender.userId, adviceText);
    await this.deps.plugins.dispatchAdvice(adviceRecord);
    return adviceRecord;
  }
}
