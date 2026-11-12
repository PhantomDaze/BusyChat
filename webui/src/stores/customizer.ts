import { defineStore } from 'pinia';

import {
  readThemeMode,
  resolveUiTheme,
  writeThemeMode,
  type ThemeMode,
} from '@/config';

/**
 * 界面自定义状态：侧边栏折叠、主题模式。
 * 与 AstrBot 的 customizer store 对齐，但只保留 BusyChat 需要的字段。
 */
export const useCustomizerStore = defineStore('customizer', {
  state: () => {
    const mode = readThemeMode();
    return {
      drawer: true,
      miniSidebar: false,
      themeMode: mode as ThemeMode,
      uiTheme: resolveUiTheme(mode),
      fontTheme: 'busychat-font',
    };
  },
  getters: {
    isDark: (state) => state.uiTheme === 'BusyChatDark',
  },
  actions: {
    toggleSidebarDrawer() {
      this.drawer = !this.drawer;
    },
    setSidebarDrawer(value: boolean) {
      this.drawer = value;
    },
    toggleMiniSidebar() {
      this.miniSidebar = !this.miniSidebar;
    },
    setThemeMode(mode: ThemeMode) {
      this.themeMode = mode;
      writeThemeMode(mode);
      this.uiTheme = resolveUiTheme(mode);
    },
    /** 系统主题变化时（仅 system 模式）重新计算 Vuetify 主题 */
    syncSystemTheme() {
      if (this.themeMode !== 'system') return;
      this.uiTheme = resolveUiTheme('system');
    },
  },
});
