/** 轻量时间/文本格式化工具（不依赖 dayjs，保持产物精简） */

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value?: string | null): string {
  const date = toDate(value);
  if (!date) return value ?? '—';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTime(value?: string | null): string {
  const date = toDate(value);
  if (!date) return '--:--:--';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatClock(value?: string | null): string {
  const date = toDate(value);
  if (!date) return '—';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatRelative(value?: string | null): string {
  const date = toDate(value);
  if (!date) return '—';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (Math.abs(seconds) < 45) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return `${days} 天前`;
  return formatDateTime(value);
}

export function formatDuration(ms?: number | null): string {
  if (!Number.isFinite(ms) || !ms || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

export function truncate(text: string | undefined | null, max = 120): string {
  if (!text) return '';
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 问候语 key：由首页决定文案 */
export function greetingKey(now = new Date()): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = now.getHours();
  if (hour < 5) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  if (hour < 23) return 'evening';
  return 'night';
}

export function formatNumber(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '0';
  return new Intl.NumberFormat().format(value);
}
