/** 内置告警插件：关键词告警 + 免打扰时段 */

import type {
  AppServices,
  BotPlugin,
  JsonObject,
  NormalizedMessageEvent,
  PluginContext,
  PluginManifest,
} from '../../../types';

/** 告警插件配置（存于 builtin-notify 插件的 storage 命名空间，config 键） */
interface NotifySettings {
  notifyKeywords: string[];
  quietHours: { start: string; end: string } | null;
}

const DEFAULT_NOTIFY_CONFIG: NotifySettings = {
  notifyKeywords: [],
  quietHours: null,
};

/** 从 JsonObject 规范化配置，缺字段回落到默认值 */
function readNotifyConfig(raw: JsonObject): NotifySettings {
  const notifyKeywords = Array.isArray(raw.notifyKeywords)
    ? raw.notifyKeywords.filter((k): k is string => typeof k === 'string')
    : [...DEFAULT_NOTIFY_CONFIG.notifyKeywords];
  const qh = raw.quietHours;
  let quietHours: NotifySettings['quietHours'] = null;
  if (qh && typeof qh === 'object' && !Array.isArray(qh)) {
    const q = qh as Record<string, unknown>;
    const start = typeof q.start === 'string' ? q.start : null;
    const end = typeof q.end === 'string' ? q.end : null;
    if (start && end) quietHours = { start, end };
  }
  return { notifyKeywords, quietHours };
}

function parseHhmm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function isWithinQuietHours(nowMinutes: number, start: string, end: string): boolean {
  const s = parseHhmm(start);
  const e = parseHhmm(end);
  if (s === null || e === null || s === e) return false;
  return s < e ? nowMinutes >= s && nowMinutes < e : nowMinutes >= s || nowMinutes < e;
}

function normalizeHhmm(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function createNotifyPlugin(services: AppServices): BotPlugin {
  const manifest: PluginManifest = {
    name: 'builtin-notify',
    version: '1.0.0',
    description: '关键词告警 + 免打扰时段 — 匹配关键词时私聊通知管理员',
    author: 'F261Agent',
    permissions: ['message:observe', 'bot:send', 'command:register', 'webui:route'],
  };

  return {
    manifest,
    async setup(ctx: PluginContext) {
      // WebUI 路由：关键词告警 + 免打扰时段可视化设置
      if (ctx.webui) {
        ctx.webui.register({
          method: 'GET',
          path: '/api/notify/settings',
          handler: async () => {
            const cfg = readNotifyConfig(await ctx.config.get());
            return {
              notifyKeywords: cfg.notifyKeywords,
              quietHours: cfg.quietHours,
            } as unknown as JsonObject;
          },
        });
        ctx.webui.register({
          method: 'POST',
          path: '/api/notify/settings',
          handler: async (payload) => {
            const p = payload as { notifyKeywords?: unknown; quietHours?: unknown };
            await ctx.config.update((state) => {
              const next = { ...state };
              if (Array.isArray(p.notifyKeywords)) {
                next.notifyKeywords = p.notifyKeywords
                  .filter((k): k is string => typeof k === 'string')
                  .map((k) => k.trim())
                  .filter(Boolean);
              }
              if (p.quietHours === null) {
                delete next.quietHours;
              } else if (p.quietHours && typeof p.quietHours === 'object') {
                const q = p.quietHours as { start?: unknown; end?: unknown };
                const start = typeof q.start === 'string' ? normalizeHhmm(q.start) : null;
                const end = typeof q.end === 'string' ? normalizeHhmm(q.end) : null;
                if (start && end && start !== end) {
                  next.quietHours = { start, end };
                }
              }
              return next;
            });
            return { ok: true } as unknown as JsonObject;
          },
        });
      }

      ctx.commands.register({
        name: 'notify',
        description: '管理关键词告警和免打扰时段',
        usage: '/notify keywords [add|remove|list] | /notify quiet <开始> <结束> | /notify quiet off',
        adminOnly: true,
        execute: async (cmdCtx) => {
          const [sub, ...rest] = cmdCtx.args;

          if (!sub || sub === 'keywords') {
            const [kwAction, ...kwRest] = rest;
            const kw = kwRest.join(' ').trim();

            if (!kwAction || kwAction === 'list') {
              const cfg = readNotifyConfig(await cmdCtx.config.get());
              const kws = cfg.notifyKeywords;
              if (kws.length === 0) return '当前未设置通知关键词。用法: /notify keywords add <关键词>';
              return `当前通知关键词:\n${kws.map((k, i) => `${i + 1}. ${k}`).join('\n')}`;
            }

            if (kwAction === 'add' && kw) {
              await cmdCtx.config.update((state) => {
                const kws = Array.isArray(state.notifyKeywords)
                  ? state.notifyKeywords.filter((k): k is string => typeof k === 'string')
                  : [];
                if (!kws.includes(kw)) state.notifyKeywords = [...kws, kw];
                return state;
              });
              return `已添加通知关键词: ${kw}`;
            }

            if (kwAction === 'remove' && kw) {
              await cmdCtx.config.update((state) => {
                const kws = Array.isArray(state.notifyKeywords)
                  ? state.notifyKeywords.filter((k): k is string => typeof k === 'string')
                  : [];
                state.notifyKeywords = kws.filter((k) => k !== kw);
                return state;
              });
              return `已移除通知关键词: ${kw}`;
            }

            return '用法: /notify keywords [add|remove|list]';
          }

          if (sub === 'quiet') {
            const [start, end] = rest;
            if (!start || start === 'off') {
              await cmdCtx.config.update((state) => {
                delete state.quietHours;
                return state;
              });
              return '免打扰已关闭。';
            }
            if (start && end) {
              const normStart = normalizeHhmm(start.trim());
              const normEnd = normalizeHhmm(end.trim());
              if (!normStart || !normEnd) return '时间格式无效，请使用 HH:MM (如 /notify quiet 23:00 07:00)。';
              if (normStart === normEnd) return '开始与结束时间不能相同。';
              await cmdCtx.config.update((state) => {
                state.quietHours = { start: normStart, end: normEnd };
                return state;
              });
              return `免打扰时段已设为 ${normStart} - ${normEnd}（含关键词的紧急消息仍会在非免打扰时段通知）。`;
            }
            return '用法: /notify quiet <开始时间> <结束时间> (如 /notify quiet 23:00 07:00)';
          }

          return '用法: /notify keywords [add|remove|list] | /notify quiet <开始> <结束> | /notify quiet off';
        },
      });
    },
    hooks: {
      async onMessage(event: NormalizedMessageEvent, ctx: PluginContext) {
        if (event.visibility.fromAdmin || event.visibility.fromBot) return;

        const cfg = readNotifyConfig(await ctx.config.get());
        const keywords = cfg.notifyKeywords;
        if (!keywords || keywords.length === 0) return;

        const text = event.content.text.toLowerCase();
        const matched = keywords.find((kw) => text.includes(kw.toLowerCase()));
        if (!matched) return;

        const qh = cfg.quietHours;
        let inQuiet = false;
        if (qh) {
          const now = new Date();
          inQuiet = isWithinQuietHours(now.getHours() * 60 + now.getMinutes(), qh.start, qh.end);
        }

        if (inQuiet) return;

        const sender = event.sender.nickname ?? event.sender.userId;
        const scope = event.scope === 'group'
          ? `群 ${event.conversationId.replace(/^group:/, '')}`
          : '私聊';
        const alert = `🔔 关键词告警: "${matched}"\n发送者: ${sender} (${event.sender.userId})\n来源: ${scope}\n内容: ${event.content.text.slice(0, 300)}`;
        const runtime = await ctx.runtime.snapshot();
        for (const adminId of runtime.admins) {
          void ctx.bot.sendPrivateMessage(adminId, alert).catch(() => {});
        }
      },
    },
  };
}
