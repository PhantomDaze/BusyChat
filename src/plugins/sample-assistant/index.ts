import type { BotPlugin, JsonObject, PluginContext, PluginManifest } from '../../types';

interface SampleAssistantState {
  installedAt: string;
  messageCount: number;
  adminMessageCount: number;
  summaryCount: number;
  adviceCount: number;
  lastMessageAt: string | undefined;
  lastMessagePreview: string | undefined;
  lastAdminMessageAt: string | undefined;
  lastAdminMessagePreview: string | undefined;
  lastSummaryId: string | undefined;
  lastAdviceId: string | undefined;
  notes: string[];
}

const STATE_KEY = 'state';
const MAX_NOTES = 20;

export const manifest: PluginManifest = {
  name: 'sample-assistant',
  version: '2.0.0',
  description: 'A practical example plugin that tracks notes, observes messages, and exposes admin commands.',
  author: 'F261Agent',
  permissions: [
    'message:observe',
    'admin:observe',
    'summary:observe',
    'model:use',
    'storage:read',
    'storage:write',
    'command:register',
  ],
};

function nowIso(): string {
  return new Date().toISOString();
}

function createDefaultState(): SampleAssistantState {
  return {
    installedAt: nowIso(),
    messageCount: 0,
    adminMessageCount: 0,
    summaryCount: 0,
    adviceCount: 0,
    lastMessageAt: undefined,
    lastMessagePreview: undefined,
    lastAdminMessageAt: undefined,
    lastAdminMessagePreview: undefined,
    lastSummaryId: undefined,
    lastAdviceId: undefined,
    notes: [],
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => readString(item))
    .filter((item): item is string => typeof item === 'string')
    .slice(-MAX_NOTES);
}

function normalizeState(value: JsonObject | undefined): SampleAssistantState {
  const fallback = createDefaultState();
  if (!value) {
    return fallback;
  }

  return {
    installedAt: readString(value.installedAt) ?? fallback.installedAt,
    messageCount: typeof value.messageCount === 'number' && Number.isFinite(value.messageCount) ? value.messageCount : fallback.messageCount,
    adminMessageCount:
      typeof value.adminMessageCount === 'number' && Number.isFinite(value.adminMessageCount)
        ? value.adminMessageCount
        : fallback.adminMessageCount,
    summaryCount: typeof value.summaryCount === 'number' && Number.isFinite(value.summaryCount) ? value.summaryCount : fallback.summaryCount,
    adviceCount: typeof value.adviceCount === 'number' && Number.isFinite(value.adviceCount) ? value.adviceCount : fallback.adviceCount,
    lastMessageAt: readString(value.lastMessageAt),
    lastMessagePreview: readString(value.lastMessagePreview),
    lastAdminMessageAt: readString(value.lastAdminMessageAt),
    lastAdminMessagePreview: readString(value.lastAdminMessagePreview),
    lastSummaryId: readString(value.lastSummaryId),
    lastAdviceId: readString(value.lastAdviceId),
    notes: readStringArray(value.notes),
  };
}

function serializeState(state: SampleAssistantState): JsonObject {
  return {
    installedAt: state.installedAt,
    messageCount: state.messageCount,
    adminMessageCount: state.adminMessageCount,
    summaryCount: state.summaryCount,
    adviceCount: state.adviceCount,
    notes: [...state.notes],
    ...(state.lastMessageAt ? { lastMessageAt: state.lastMessageAt } : {}),
    ...(state.lastMessagePreview ? { lastMessagePreview: state.lastMessagePreview } : {}),
    ...(state.lastAdminMessageAt ? { lastAdminMessageAt: state.lastAdminMessageAt } : {}),
    ...(state.lastAdminMessagePreview ? { lastAdminMessagePreview: state.lastAdminMessagePreview } : {}),
    ...(state.lastSummaryId ? { lastSummaryId: state.lastSummaryId } : {}),
    ...(state.lastAdviceId ? { lastAdviceId: state.lastAdviceId } : {}),
  };
}

async function readState(ctx: PluginContext): Promise<SampleAssistantState> {
  const stored = await ctx.storage.get<JsonObject>(STATE_KEY);
  return normalizeState(stored);
}

async function writeState(ctx: PluginContext, state: SampleAssistantState): Promise<void> {
  await ctx.storage.set(STATE_KEY, serializeState(state));
}

function truncate(text: string, maxLength = 120): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function appendNote(notes: string[], note: string): string[] {
  const trimmed = note.trim();
  if (!trimmed) {
    return notes;
  }

  return [...notes, trimmed].slice(-MAX_NOTES);
}

function extractNoteHint(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('#sample-note ')) {
    const note = trimmed.slice('#sample-note '.length).trim();
    return note.length > 0 ? note : null;
  }

  if (trimmed.startsWith('#note ')) {
    const note = trimmed.slice('#note '.length).trim();
    return note.length > 0 ? note : null;
  }

  return null;
}

function formatStatus(state: SampleAssistantState, admins: string[]): string {
  return [
    `插件: ${manifest.name}`,
    `安装时间: ${state.installedAt}`,
    `普通消息: ${state.messageCount}`,
    `管理员消息: ${state.adminMessageCount}`,
    `摘要回调: ${state.summaryCount}`,
    `建议回调: ${state.adviceCount}`,
    `最近普通消息: ${state.lastMessageAt ?? 'none'}`,
    `普通消息预览: ${state.lastMessagePreview ?? 'none'}`,
    `最近管理员消息: ${state.lastAdminMessageAt ?? 'none'}`,
    `管理员消息预览: ${state.lastAdminMessagePreview ?? 'none'}`,
    `最近摘要 ID: ${state.lastSummaryId ?? 'none'}`,
    `最近建议 ID: ${state.lastAdviceId ?? 'none'}`,
    `笔记数量: ${state.notes.length}`,
    `管理员: ${admins.length > 0 ? admins.join(', ') : 'none'}`,
  ].join('\n');
}

function formatNotes(notes: string[]): string {
  if (notes.length === 0) {
    return '暂无笔记。';
  }

  return notes.map((note, index) => `${index + 1}. ${note}`).join('\n');
}

async function summarizeNotes(ctx: PluginContext, notes: string[]): Promise<string> {
  const prompt = [
    '你是一个插件内置的笔记整理助手。',
    '请根据下面的笔记输出两部分内容：摘要和建议。',
    '要求：',
    '- 简短、明确、不要编造信息。',
    '- 摘要部分先概括当前记录。',
    '- 建议部分给出可执行建议。',
    '',
    `笔记数量: ${notes.length}`,
    '笔记列表:',
    ...notes.map((note, index) => `${index + 1}. ${note}`),
  ].join('\n');

  const result = await ctx.models.generateText('summary', prompt, {
    plugin: manifest.name,
    noteCount: notes.length,
  });
  return result.text.trim();
}

async function updateState(ctx: PluginContext, mutator: (state: SampleAssistantState) => SampleAssistantState): Promise<void> {
  const current = await readState(ctx);
  await writeState(ctx, mutator(current));
}

const plugin: BotPlugin = {
  manifest,
  async setup(ctx) {
    const state = await readState(ctx);
    if (!state.installedAt) {
      await writeState(ctx, createDefaultState());
    } else {
      await writeState(ctx, state);
    }

    ctx.commands.register({
      name: 'sample-status',
      description: '查看示例插件状态',
      usage: '/sample-status',
      adminOnly: true,
      execute: async () => {
        const current = await readState(ctx);
        const runtime = await ctx.runtime.snapshot();
        return formatStatus(current, runtime.admins);
      },
    });

    ctx.commands.register({
      name: 'sample-note',
      description: '管理示例插件笔记',
      usage: '/sample-note add <text> | /sample-note list | /sample-note clear | /sample-note brief',
      adminOnly: true,
      execute: async (commandCtx) => {
        const [action, ...rest] = commandCtx.args;
        const current = await readState(ctx);

        if (!action || action === 'help') {
          return '用法: /sample-note add <text> | /sample-note list | /sample-note clear | /sample-note brief';
        }

        if (action === 'list') {
          return formatNotes(current.notes);
        }

        if (action === 'clear') {
          await writeState(ctx, {
            ...current,
            notes: [],
          });
          return '示例插件笔记已清空。';
        }

        if (action === 'add') {
          const note = rest.join(' ').trim();
          if (!note) {
            return '用法: /sample-note add <text>';
          }
          await writeState(ctx, {
            ...current,
            notes: appendNote(current.notes, note),
          });
          return `已记录笔记: ${truncate(note, 80)}`;
        }

        if (action === 'brief') {
          if (current.notes.length === 0) {
            return '当前没有可用于生成简报的笔记。';
          }

          try {
            return await summarizeNotes(ctx, current.notes);
          } catch (error) {
            ctx.logger.warn('brief generation failed', {
              error: error instanceof Error ? error.message : String(error),
            });
            return '生成简报失败，请检查模型配置或稍后重试。';
          }
        }

        return '用法: /sample-note add <text> | /sample-note list | /sample-note clear | /sample-note brief';
      },
    });

    ctx.logger.info('sample assistant initialized', {
      installedAt: state.installedAt,
      noteCount: state.notes.length,
    });
  },
  hooks: {
    async onMessage(event, ctx) {
      const note = extractNoteHint(event.content.text);
      await updateState(ctx, (current) => ({
        ...current,
        messageCount: current.messageCount + 1,
        lastMessageAt: nowIso(),
        lastMessagePreview: truncate(event.content.text, 160),
        notes: note ? appendNote(current.notes, note) : current.notes,
      }));
    },
    async onAdminMessage(event, ctx) {
      const note = extractNoteHint(event.content.text);
      await updateState(ctx, (current) => ({
        ...current,
        adminMessageCount: current.adminMessageCount + 1,
        lastAdminMessageAt: nowIso(),
        lastAdminMessagePreview: truncate(event.content.text, 160),
        notes: note ? appendNote(current.notes, note) : current.notes,
      }));
    },
    async onSummaryReady(summary, ctx) {
      const state = await readState(ctx);
      await writeState(ctx, {
        ...state,
        summaryCount: state.summaryCount + 1,
        lastSummaryId: summary.id,
      });
      ctx.logger.info('summary observed', {
        summaryId: summary.id,
        sourceEvents: summary.sourceEventIds.length,
      });
    },
    async onAdviceReady(advice, ctx) {
      const state = await readState(ctx);
      await writeState(ctx, {
        ...state,
        adviceCount: state.adviceCount + 1,
        lastAdviceId: advice.id,
      });
      ctx.logger.info('advice observed', {
        adviceId: advice.id,
        adminId: advice.adminId,
      });
    },
    async onShutdown(ctx) {
      const state = await readState(ctx);
      ctx.logger.info('sample assistant shutting down', {
        noteCount: state.notes.length,
        messageCount: state.messageCount,
        adminMessageCount: state.adminMessageCount,
      });
    },
  },
};

export default plugin;
