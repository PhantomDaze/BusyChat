/**
 * Auto-Memory Plugin
 *
 * 自动记忆总结插件，提供两个核心功能：
 *
 * 1. 每日定时总结（北京时间 21:30）
 *    - 收集当日所有消息，按管理员相关性和偏好筛选
 *    - 调用语言模型生成摘要
 *    - 写入长期记忆知识库
 *    - 向所有管理员发送报告
 *
 * 2. @提及响应
 *    - 当助手账号被 @ 时，不自动回复
 *    - 结合最近几条消息分析上下文
 *    - 向管理员发送询问消息，由管理员决定如何响应
 */

import type {
  BotPlugin,
  JsonObject,
  KnowledgeEntry,
  NormalizedMessageEvent,
  PluginContext,
  PluginManifest,
} from '../../types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface StoredMessage {
  id: string;
  time: string;
  scope: 'private' | 'group';
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  isAdmin: boolean;
  mentionedAdmin: boolean;
  mentionedBot: boolean;
}

interface AdminPreferences {
  keywords: string[];
  maxMessagesPerDay: number;
  includePrivate: boolean;
  includeGroups: boolean;
}

interface AutoMemoryState {
  installedAt: string;
  lastSummaryDate: string;
  messageBuffer: StoredMessage[];
  totalMessagesObserved: number;
  totalSummariesGenerated: number;
  totalMentionHandled: number;
  preferences: AdminPreferences;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_KEY = 'state';
const MAX_BUFFER_SIZE = 1000;
const MENTION_CONTEXT_COUNT = 15;
const SUMMARY_HOUR = 21;
const SUMMARY_MINUTE = 30;
const CHECK_INTERVAL_MS = 60_000; // check every 60 seconds

export const manifest: PluginManifest = {
  name: 'auto-memory',
  version: '1.0.0',
  description:
    '自动记忆总结插件 — 每日21:30自动总结并写入知识库，@提及时向管理员请示。',
  author: 'F261Agent',
  permissions: [
    'message:observe',
    'admin:observe',
    'bot:send',
    'model:use',
    'storage:read',
    'storage:write',
    'knowledge:read',
    'knowledge:write',
    'command:register',
  ],
};

// ---------------------------------------------------------------------------
// Time helpers (Beijing time UTC+8)
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function beijingNow(): Date {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }),
  );
}

function beijingDateString(): string {
  const d = beijingNow();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function beijingHourMinute(): { hour: number; minute: number } {
  const d = beijingNow();
  return { hour: d.getHours(), minute: d.getMinutes() };
}

// ---------------------------------------------------------------------------
// State normalization / serialization
// ---------------------------------------------------------------------------

function createDefaultState(): AutoMemoryState {
  return {
    installedAt: nowIso(),
    lastSummaryDate: '',
    messageBuffer: [],
    totalMessagesObserved: 0,
    totalSummariesGenerated: 0,
    totalMentionHandled: 0,
    preferences: {
      keywords: [],
      maxMessagesPerDay: 200,
      includePrivate: true,
      includeGroups: true,
    },
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => readString(item))
    .filter((item): item is string => typeof item === 'string');
}

function readStoredMessage(obj: unknown): StoredMessage | null {
  if (!obj || typeof obj !== 'object') return null;
  const m = obj as Record<string, unknown>;
  const id = readString(m.id);
  if (!id) return null;
  return {
    id,
    time: readString(m.time) ?? '',
    scope: m.scope === 'group' ? 'group' : 'private',
    conversationId: readString(m.conversationId) ?? '',
    senderId: readString(m.senderId) ?? '',
    senderName: readString(m.senderName) ?? '',
    text: readString(m.text) ?? '',
    isAdmin: Boolean(m.isAdmin),
    mentionedAdmin: Boolean(m.mentionedAdmin),
    mentionedBot: Boolean(m.mentionedBot),
  };
}

function readMessageBuffer(value: unknown): StoredMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => readStoredMessage(item))
    .filter((item): item is StoredMessage => item !== null)
    .slice(-MAX_BUFFER_SIZE);
}

function normalizeState(value: JsonObject | undefined): AutoMemoryState {
  const fallback = createDefaultState();
  if (!value) return fallback;

  const prefs = (typeof value.preferences === 'object' && value.preferences !== null
    ? value.preferences
    : {}) as Record<string, unknown>;

  return {
    installedAt: readString(value.installedAt) ?? fallback.installedAt,
    lastSummaryDate: readString(value.lastSummaryDate) ?? fallback.lastSummaryDate,
    messageBuffer: readMessageBuffer(value.messageBuffer),
    totalMessagesObserved:
      typeof value.totalMessagesObserved === 'number'
        ? value.totalMessagesObserved
        : fallback.totalMessagesObserved,
    totalSummariesGenerated:
      typeof value.totalSummariesGenerated === 'number'
        ? value.totalSummariesGenerated
        : fallback.totalSummariesGenerated,
    totalMentionHandled:
      typeof value.totalMentionHandled === 'number'
        ? value.totalMentionHandled
        : fallback.totalMentionHandled,
    preferences: {
      keywords: readStringArray(prefs.keywords),
      maxMessagesPerDay:
        typeof prefs.maxMessagesPerDay === 'number'
          ? prefs.maxMessagesPerDay
          : fallback.preferences.maxMessagesPerDay,
      includePrivate:
        typeof prefs.includePrivate === 'boolean'
          ? prefs.includePrivate
          : fallback.preferences.includePrivate,
      includeGroups:
        typeof prefs.includeGroups === 'boolean'
          ? prefs.includeGroups
          : fallback.preferences.includeGroups,
    },
  };
}

function serializeState(state: AutoMemoryState): JsonObject {
  return {
    installedAt: state.installedAt,
    lastSummaryDate: state.lastSummaryDate,
    messageBuffer: state.messageBuffer.map((m) => ({
      id: m.id,
      time: m.time,
      scope: m.scope,
      conversationId: m.conversationId,
      senderId: m.senderId,
      senderName: m.senderName,
      text: m.text,
      isAdmin: m.isAdmin,
      mentionedAdmin: m.mentionedAdmin,
      mentionedBot: m.mentionedBot,
    })),
    totalMessagesObserved: state.totalMessagesObserved,
    totalSummariesGenerated: state.totalSummariesGenerated,
    totalMentionHandled: state.totalMentionHandled,
    preferences: {
      keywords: [...state.preferences.keywords],
      maxMessagesPerDay: state.preferences.maxMessagesPerDay,
      includePrivate: state.preferences.includePrivate,
      includeGroups: state.preferences.includeGroups,
    },
  };
}

async function readState(ctx: PluginContext): Promise<AutoMemoryState> {
  const stored = await ctx.storage.get<JsonObject>(STATE_KEY);
  return normalizeState(stored);
}

async function writeState(
  ctx: PluginContext,
  state: AutoMemoryState,
): Promise<void> {
  await ctx.storage.set(STATE_KEY, serializeState(state));
}

// ---------------------------------------------------------------------------
// Message relevance helpers
// ---------------------------------------------------------------------------

function isBotMentioned(event: NormalizedMessageEvent, selfId: string): boolean {
  for (const seg of event.content.segments) {
    if (seg.type === 'at') {
      const qq = seg.data.qq || seg.data.user_id;
      if (qq && qq === selfId) return true;
    }
  }
  if (event.content.text.includes(`@${selfId}`)) return true;
  return false;
}

function doesMessageMentionAdmin(
  event: NormalizedMessageEvent,
  adminIds: string[],
): boolean {
  for (const seg of event.content.segments) {
    if (seg.type === 'at') {
      const qq = seg.data.qq || seg.data.user_id;
      if (qq && adminIds.includes(qq)) return true;
    }
  }
  for (const adminId of adminIds) {
    if (event.content.text.includes(`@${adminId}`)) return true;
  }
  return false;
}

function isRelevantToAdmin(
  msg: StoredMessage,
  adminIds: string[],
  keywords: string[],
): boolean {
  // Direct admin involvement
  if (msg.isAdmin) return true;
  if (msg.mentionedAdmin) return true;

  // Keyword match
  if (keywords.length > 0) {
    const lower = msg.text.toLowerCase();
    if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

async function runDailySummary(ctx: PluginContext): Promise<void> {
  const state = await readState(ctx);
  const runtime = await ctx.runtime.snapshot();

  if (!runtime.knowledgeBase.enabled) {
    ctx.logger.warn('auto-memory: knowledge base disabled, skipping summary');
    return;
  }

  const adminIds = runtime.admins;
  if (adminIds.length === 0) {
    ctx.logger.warn('auto-memory: no admins configured, skipping summary');
    return;
  }

  const prefs = state.preferences;
  const allMessages = state.messageBuffer;

  // Filter by scope preference
  let scopeFiltered = allMessages;
  if (!prefs.includePrivate) {
    scopeFiltered = scopeFiltered.filter((m) => m.scope !== 'private');
  }
  if (!prefs.includeGroups) {
    scopeFiltered = scopeFiltered.filter((m) => m.scope !== 'group');
  }

  // Filter by admin relevance
  const relevant = scopeFiltered.filter((m) =>
    isRelevantToAdmin(m, adminIds, prefs.keywords),
  );

  // Also include a sample of non-relevant messages for context
  const nonRelevant = scopeFiltered.filter(
    (m) => !isRelevantToAdmin(m, adminIds, prefs.keywords),
  );
  const contextSample = nonRelevant.slice(-20);

  // Combine and sort by time
  const reportMessages = [...contextSample, ...relevant]
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(-prefs.maxMessagesPerDay);

  if (reportMessages.length === 0) {
    ctx.logger.info('auto-memory: no messages to summarize today');

    // Still send a quiet-day report
    if (adminIds.length > 0 && state.totalMessagesObserved > 0) {
      const dateStr = beijingDateString();
      const quietReport = `📅 ${dateStr} 每日摘要\n\n今日无需要关注的消息。共收到 ${allMessages.length} 条消息。`;

      // Write to knowledge base
      if (ctx.knowledge) {
        await ctx.knowledge.add(quietReport, {
          source: 'auto-memory',
          type: 'summary',
          tags: ['daily-summary', dateStr],
        });
      }

      const recipients = adminIds;
      for (const uid of recipients) {
        try {
          await ctx.bot.sendPrivateMessage(uid, quietReport);
        } catch (err) {
          ctx.logger.warn('auto-memory: failed to send report', {
            recipient: uid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Clear buffer
    await writeState(ctx, {
      ...state,
      lastSummaryDate: beijingDateString(),
      messageBuffer: [],
    });
    return;
  }

  // Build prompt
  const messagesText = reportMessages
    .map((m) => {
      const scope = m.scope === 'group' ? '群聊' : '私聊';
      const adminMarker = m.isAdmin ? ' [管理员]' : '';
      const mentionedMarker = m.mentionedAdmin ? ' [提及管理员]' : '';
      const time = m.time.slice(11, 19); // HH:MM:SS
      return `[${time}] [${scope}] ${m.senderName}${adminMarker}${mentionedMarker}: ${m.text}`;
    })
    .join('\n');

  const prompt = [
    '你是一个智能记忆总结助手。请根据以下今日消息记录，生成一份日报摘要。',
    '',
    '要求：',
    '1. 提炼今日核心讨论主题和关键事件',
    '2. 突出与管理员相关的消息和需要关注的事项',
    '3. 标注需要管理员跟进或处理的问题',
    '4. 用简洁的中文输出，分点列出',
    '',
    '--- 今日消息 ---',
    messagesText,
    '',
    '请生成日报摘要：',
  ].join('\n');

  let summaryText: string;
  try {
    const result = await ctx.models.generateText('memory-summary', prompt, {
      plugin: manifest.name,
      messageCount: reportMessages.length,
    });
    summaryText = result.text.trim();
  } catch (err) {
    ctx.logger.warn('auto-memory: LLM summary failed, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    summaryText = `[fallback] 今日共 ${reportMessages.length} 条相关消息，涉及 ${adminIds.length} 位管理员。`;
  }

  const dateStr = beijingDateString();
  const reportHeading = `📅 ${dateStr} 每日智能摘要\n\n`;

  // Write to knowledge base
  let kbEntry: KnowledgeEntry | null = null;
  if (ctx.knowledge) {
    try {
      kbEntry = await ctx.knowledge.add(reportHeading + summaryText, {
        source: 'auto-memory',
        type: 'summary',
        tags: ['daily-summary', dateStr],
      });
    } catch (err) {
      ctx.logger.warn('auto-memory: failed to write to knowledge base', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Extract facts / decisions / todos from messages
    try {
      const factPrompt = [
        '从以下今日消息中提取可能需要记住的信息：',
        '- 约定/承诺（时间、地点、事项）',
        '- 决策/结论（最终决定了什么）',
        '- 待办事项（需要谁做什么）',
        '- 其他值得记住的事实',
        '只提取明确的信息，不要推测。每行一条，格式："[类型] 内容"。',
        '如果没有值得记录的信息，回复 "无"。',
        '',
        '--- 今日消息 ---',
        messagesText.slice(0, 3000),
      ].join('\n');

      const factResult = await ctx.models.generateText('memory-summary', factPrompt, {
        plugin: manifest.name,
        purpose: 'fact-extraction',
      });

      const facts = factResult.text.trim();
      if (facts && facts !== '无' && facts !== '无。') {
        await ctx.knowledge.add(`📌 ${dateStr} 提取的事实:\n${facts}`, {
          source: 'auto-memory',
          type: 'user',
          tags: ['extracted-fact', dateStr],
        });
        ctx.logger.info('auto-memory: facts extracted', { date: dateStr, lines: facts.split('\n').length });
      }
    } catch (err) {
      ctx.logger.warn('auto-memory: fact extraction failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Send report to admins
  const recipients = adminIds;

  const reportMessage = [
    reportHeading + summaryText,
    '',
    `📊 统计: 总消息 ${allMessages.length} | 相关消息 ${relevant.length}`,
    kbEntry ? `🧠 记忆ID: ${kbEntry.id.slice(0, 8)}` : '',
  ].join('\n');

  for (const uid of recipients) {
    try {
      await ctx.bot.sendPrivateMessage(uid, reportMessage);
    } catch (err) {
      ctx.logger.warn('auto-memory: failed to send report', {
        recipient: uid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Clear buffer and update state
  await writeState(ctx, {
    ...state,
    lastSummaryDate: dateStr,
    messageBuffer: [],
    totalSummariesGenerated: state.totalSummariesGenerated + 1,
  });

  ctx.logger.info('auto-memory: daily summary generated', {
    date: dateStr,
    totalMessages: allMessages.length,
    relevantMessages: relevant.length,
    ...(kbEntry ? { kbEntryId: kbEntry.id } : {}),
  });
}

// ---------------------------------------------------------------------------
// @Mention handler
// ---------------------------------------------------------------------------

async function handleMention(
  event: NormalizedMessageEvent,
  ctx: PluginContext,
): Promise<void> {
  const state = await readState(ctx);
  const runtime = await ctx.runtime.snapshot();
  const adminIds = runtime.admins;

  if (adminIds.length === 0) return;

  // Get recent messages from the same conversation
  const recentMessages = state.messageBuffer
    .filter((m) => m.conversationId === event.conversationId)
    .slice(-MENTION_CONTEXT_COUNT);

  // Build context for LLM
  const contextText = recentMessages
    .map((m) => {
      const adminTag = m.isAdmin ? '[管理员]' : '';
      return `[${m.time.slice(11, 19)}] ${m.senderName}${adminTag}: ${m.text}`;
    })
    .join('\n');

  const triggerText = `[触发消息] ${event.sender.nickname ?? event.sender.userId}: ${event.content.text}`;

  const prompt = [
    '有人正在向助手账号发送消息。请分析当前对话上下文，',
    '总结求助内容或讨论要点，以便向管理员汇报。',
    '',
    '要求：',
    '1. 判断求助类型（问题咨询 / 功能请求 / 闲聊 / 紧急事项 / 其他）',
    '2. 总结关键信息',
    '3. 给出建议的处理方式供管理员参考',
    '',
    '--- 对话上下文 ---',
    contextText,
    triggerText,
    '',
    '请以简洁的中文输出分析：',
  ].join('\n');

  let analysis: string;
  try {
    const result = await ctx.models.generateText('chat', prompt, {
      plugin: manifest.name,
      contextMessageCount: recentMessages.length,
    });
    analysis = result.text.trim();
  } catch (err) {
    ctx.logger.warn('auto-memory: mention analysis failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    analysis = `[fallback] 收到来自 ${event.sender.nickname ?? event.sender.userId} 的 @提及消息。`;
  }

  // Build admin notification
  const scopeLabel = event.scope === 'group' ? '群聊' : '私聊';
  const senderLabel = event.sender.nickname
    ? `${event.sender.nickname} (${event.sender.userId})`
    : event.sender.userId;

  const mentionReport = [
    '📢 **有人正在寻求帮助**',
    '',
    `👤 发送者: ${senderLabel}`,
    `📍 位置: ${scopeLabel}`,
    `🕐 时间: ${event.receivedAt.slice(0, 19).replace('T', ' ')}`,
    '',
    '--- AI 分析 ---',
    analysis,
    '',
    '--- 最近对话 ---',
    contextText.slice(-500) || '(无更多上下文)',
    '',
    `--- 触发消息 ---`,
    `> ${event.content.text.slice(0, 300)}`,
    '',
    '❓ **请告诉我应如何处理此消息。**',
  ].join('\n');

  // Notify all admins
  for (const adminId of adminIds) {
    try {
      await ctx.bot.sendPrivateMessage(adminId, mentionReport);
    } catch (err) {
      ctx.logger.warn('auto-memory: failed to send mention report to admin', {
        adminId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await writeState(ctx, {
    ...state,
    totalMentionHandled: state.totalMentionHandled + 1,
  });

  ctx.logger.info('auto-memory: @mention handled', {
    senderId: event.sender.userId,
    scope: event.scope,
    conversationId: event.conversationId,
  });
}

// ---------------------------------------------------------------------------
// Timer management
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;

function startTimer(ctx: PluginContext): void {
  if (timer) return;

  timer = setInterval(() => {
    void (async () => {
      try {
        const { hour, minute } = beijingHourMinute();
        const today = beijingDateString();
        const state = await readState(ctx);

        // Fire at 21:30 once per day
        if (
          hour === SUMMARY_HOUR &&
          minute >= SUMMARY_MINUTE &&
          state.lastSummaryDate !== today
        ) {
          ctx.logger.info('auto-memory: triggering daily summary', {
            time: `${hour}:${String(minute).padStart(2, '0')}`,
            date: today,
          });
          await runDailySummary(ctx);
        }
      } catch (err) {
        ctx.logger.error('auto-memory: timer tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, CHECK_INTERVAL_MS);

  // Fire immediately on startup if we're past 21:30 and haven't summarized today
  void (async () => {
    try {
      const { hour, minute } = beijingHourMinute();
      const today = beijingDateString();
      const state = await readState(ctx);

      if (
        (hour > SUMMARY_HOUR || (hour === SUMMARY_HOUR && minute >= SUMMARY_MINUTE)) &&
        state.lastSummaryDate !== today
      ) {
        ctx.logger.info('auto-memory: catch-up summary on startup', {
          time: `${hour}:${String(minute).padStart(2, '0')}`,
          date: today,
        });
        await runDailySummary(ctx);
      }
    } catch (err) {
      ctx.logger.error('auto-memory: startup summary failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: BotPlugin = {
  manifest,

  async setup(ctx: PluginContext) {
    // Initialize or migrate state
    const state = await readState(ctx);
    await writeState(ctx, state);

    // Register admin commands
    ctx.commands.register({
      name: 'auto-memory',
      description: '自动记忆插件管理',
      usage:
        '/auto-memory status | /auto-memory keywords [add|remove|list] | /auto-memory trigger',
      adminOnly: true,
      execute: async (cmdCtx) => {
        const [action, ...rest] = cmdCtx.args;
        const current = await readState(ctx);

        if (!action || action === 'status') {
          const runtime = await ctx.runtime.snapshot();
          return [
            `📋 自动记忆插件状态`,
            `安装时间: ${current.installedAt}`,
            `上次总结日期: ${current.lastSummaryDate || '无'}`,
            `缓冲消息数: ${current.messageBuffer.length}`,
            `累计观察: ${current.totalMessagesObserved}`,
            `累计总结: ${current.totalSummariesGenerated}`,
            `累计 @处理: ${current.totalMentionHandled}`,
            `关键词: ${current.preferences.keywords.length > 0 ? current.preferences.keywords.join(', ') : '未设置'}`,
            `私聊: ${current.preferences.includePrivate ? '✓' : '✗'}`,
            `群聊: ${current.preferences.includeGroups ? '✓' : '✗'}`,
            `管理员: ${runtime.admins.length > 0 ? runtime.admins.join(', ') : '无'}`,
            `管理员: ${runtime.admins.length > 0 ? runtime.admins.join(', ') : '无'}`,
          ].join('\n');
        }

        if (action === 'keywords') {
          const [kwAction, ...kwRest] = rest;
          const kw = kwRest.join(' ').trim();

          if (!kwAction || kwAction === 'list') {
            if (current.preferences.keywords.length === 0) {
              return '当前未设置关键词。用法: /auto-memory keywords add <关键词>';
            }
            return `当前关键词:\n${current.preferences.keywords.map((k, i) => `${i + 1}. ${k}`).join('\n')}`;
          }

          if (kwAction === 'add') {
            if (!kw) return '用法: /auto-memory keywords add <关键词>';
            const updated = [
              ...current.preferences.keywords.filter((k) => k !== kw),
              kw,
            ];
            await writeState(ctx, {
              ...current,
              preferences: { ...current.preferences, keywords: updated },
            });
            return `已添加关键词: ${kw}`;
          }

          if (kwAction === 'remove') {
            if (!kw) return '用法: /auto-memory keywords remove <关键词>';
            const updated = current.preferences.keywords.filter(
              (k) => k !== kw,
            );
            await writeState(ctx, {
              ...current,
              preferences: { ...current.preferences, keywords: updated },
            });
            return updated.length < current.preferences.keywords.length
              ? `已移除关键词: ${kw}`
              : `未找到关键词: ${kw}`;
          }
        }

        if (action === 'trigger') {
          await runDailySummary(ctx);
          return '已手动触发每日总结。';
        }

        return '用法: /auto-memory status | /auto-memory keywords [add|remove|list] | /auto-memory trigger';
      },
    });

    // Start the timer
    startTimer(ctx);

    ctx.logger.info('auto-memory plugin initialized', {
      installedAt: state.installedAt,
      bufferSize: state.messageBuffer.length,
      lastSummary: state.lastSummaryDate || 'never',
    });
  },

  hooks: {
    async onMessage(event, ctx) {
      const runtime = await ctx.runtime.snapshot();
      const selfId = runtime.onebot.selfId?.trim();
      const adminIds = runtime.admins;
      const state = await readState(ctx);

      const stored: StoredMessage = {
        id: event.id,
        time: event.receivedAt,
        scope: event.scope,
        conversationId: event.conversationId,
        senderId: event.sender.userId,
        senderName: event.sender.nickname ?? event.sender.userId,
        text: event.content.text,
        isAdmin: event.sender.isAdmin,
        mentionedAdmin: doesMessageMentionAdmin(event, adminIds),
        mentionedBot: selfId ? isBotMentioned(event, selfId) : false,
      };

      // Always store relevant messages, sample non-relevant ones
      const prefs = state.preferences;
      const isRelevant = isRelevantToAdmin(stored, adminIds, prefs.keywords);
      const shouldStore =
        isRelevant ||
        stored.mentionedBot ||
        state.messageBuffer.length < prefs.maxMessagesPerDay;

      if (shouldStore) {
        const newBuffer = [...state.messageBuffer, stored].slice(
          -MAX_BUFFER_SIZE,
        );
        await writeState(ctx, {
          ...state,
          messageBuffer: newBuffer,
          totalMessagesObserved: state.totalMessagesObserved + 1,
        });
      } else {
        await writeState(ctx, {
          ...state,
          totalMessagesObserved: state.totalMessagesObserved + 1,
        });
      }

      // Handle @mention if bot is mentioned
      if (stored.mentionedBot && !stored.isAdmin) {
        ctx.logger.info('auto-memory: bot mentioned, handling', {
          senderId: event.sender.userId,
          scope: event.scope,
        });
        // Fire and forget - don't block message processing
        void handleMention(event, ctx).catch((err) => {
          ctx.logger.error('auto-memory: mention handling failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    },

    async onAdminMessage(event, ctx) {
      // Admin messages are always relevant - ensure they're stored
      const state = await readState(ctx);
      const runtime = await ctx.runtime.snapshot();
      const selfId = runtime.onebot.selfId?.trim();
      const adminIds = runtime.admins;

      const stored: StoredMessage = {
        id: event.id,
        time: event.receivedAt,
        scope: event.scope,
        conversationId: event.conversationId,
        senderId: event.sender.userId,
        senderName: event.sender.nickname ?? event.sender.userId,
        text: event.content.text,
        isAdmin: true,
        mentionedAdmin: doesMessageMentionAdmin(event, adminIds),
        mentionedBot: selfId ? isBotMentioned(event, selfId) : false,
      };

      const newBuffer = [...state.messageBuffer, stored].slice(-MAX_BUFFER_SIZE);
      await writeState(ctx, {
        ...state,
        messageBuffer: newBuffer,
        totalMessagesObserved: state.totalMessagesObserved + 1,
      });
    },

    async onShutdown(ctx) {
      stopTimer();
      const state = await readState(ctx);
      ctx.logger.info('auto-memory plugin shutting down', {
        totalMessages: state.totalMessagesObserved,
        totalSummaries: state.totalSummariesGenerated,
        totalMentions: state.totalMentionHandled,
        bufferSize: state.messageBuffer.length,
      });
    },
  },
};

export default plugin;
