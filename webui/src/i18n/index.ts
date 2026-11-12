import { createI18n } from 'vue-i18n';

import enUS from './locales/en-US';
import zhCN from './locales/zh-CN';

export const SUPPORTED_LOCALES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en-US', label: 'English' },
] as const;

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]['code'];

const STORAGE_KEY = 'busychat_locale';

function resolveInitialLocale(): LocaleCode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en-US') return stored;
  } catch {
    // ignore
  }
  const browser = typeof navigator !== 'undefined' ? navigator.language : 'zh-CN';
  return browser.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export const i18n = createI18n({
  legacy: false,
  locale: resolveInitialLocale(),
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
});

export function setLocale(code: LocaleCode): void {
  i18n.global.locale.value = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // ignore
  }
  document.documentElement.lang = code;
}

export function currentLocale(): LocaleCode {
  return i18n.global.locale.value as LocaleCode;
}

/** 供路由守卫 / 非组件代码使用 */
export function translate(key: string, params?: Record<string, unknown>): string {
  return String(i18n.global.t(key, params ?? {}));
}
