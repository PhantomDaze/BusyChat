export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'busychat_theme_mode';
export const THEME_LIGHT = 'BusyChatLight';
export const THEME_DARK = 'BusyChatDark';

export function readThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // 隐私模式下 localStorage 可能不可用
  }
  return 'system';
}

export function writeThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 忽略存储失败
  }
}

export function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 主题模式 → Vuetify 主题名 */
export function resolveUiTheme(mode: ThemeMode): string {
  if (mode === 'light') return THEME_LIGHT;
  if (mode === 'dark') return THEME_DARK;
  return prefersDark() ? THEME_DARK : THEME_LIGHT;
}
