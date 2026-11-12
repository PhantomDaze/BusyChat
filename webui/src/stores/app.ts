import { defineStore } from 'pinia';

import { api } from '@/api';
import { ApiError } from '@/api/client';
import type { AppState } from '@/api/types';

interface AppStoreState {
  state: AppState | null;
  /** 是否至少成功加载过一次；首屏失败时不能把空数组当成真实状态 */
  loaded: boolean;
  loading: boolean;
  /** 最近一次加载失败的提示（英文技术信息，由页面/横幅展示） */
  lastError: string;
  /** 最近一次失败的状态码；0 = 网络错误/超时 */
  lastErrorStatus: number;
}

/** 全局状态缓存：/api/state 是所有页面的数据源 */
export const useAppStore = defineStore('app', {
  state: (): AppStoreState => ({
    state: null,
    loaded: false,
    loading: false,
    lastError: '',
    lastErrorStatus: 0,
  }),
  getters: {
    /** 兼容旧代码：ready 表示至少成功加载过一次 */
    ready: (s) => s.loaded,
    runtime: (s) => s.state?.runtime ?? null,
    settings: (s) => s.state?.settings ?? null,
    config: (s) => s.state?.config ?? null,
    models: (s) => s.state?.models ?? [],
    plugins: (s) => s.state?.plugins ?? [],
    events: (s) => s.state?.events ?? [],
    summaries: (s) => s.state?.summaries ?? [],
    tasks: (s) => s.state?.tasks ?? [],
    families: (s) => s.state?.families ?? [],
    modelSchema: (s) => s.state?.modelSchema ?? [],
    admins: (s) => s.state?.runtime.admins ?? [],
    ui: (s) => s.state?.runtime.ui ?? null,
    onebot: (s) => s.state?.runtime.onebot ?? null,
    activeModels: (s) => s.state?.runtime.activeModels ?? {},
    summaryStatus: (s) => s.state?.summaryStatus ?? null,
    knowledgeStatus: (s) => s.state?.knowledgeStatus ?? null,
    kbCount: (s) => s.state?.kbCount ?? 0,
    fallbackOnly: (s) => s.state?.fallbackOnly ?? false,
    version: (s) => s.state?.version ?? '',
    enabledPluginCount: (s) => (s.state?.plugins ?? []).filter((p) => p.enabled).length,
    enabledModelCount: (s) => (s.state?.models ?? []).filter((m) => m.enabled).length,
  },
  actions: {
    /** 拉取 /api/state；401 会向上抛出，由路由守卫/调用方处理 */
    async load(): Promise<void> {
      if (this.loading) return;
      this.loading = true;
      try {
        const next = await api.state();
        this.state = next;
        this.loaded = true;
        this.lastError = '';
        this.lastErrorStatus = 0;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.lastErrorStatus = error instanceof ApiError ? error.status : 0;
        // 保留上一次成功加载的数据；不要把 loaded 重置为 false
        throw error;
      } finally {
        this.loading = false;
      }
    },
    /** 顶栏等手动刷新；失败时同样保留旧数据 */
    async refresh(): Promise<void> {
      this.loading = true;
      try {
        const next = await api.state();
        this.state = next;
        this.loaded = true;
        this.lastError = '';
        this.lastErrorStatus = 0;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.lastErrorStatus = error instanceof ApiError ? error.status : 0;
        throw error;
      } finally {
        this.loading = false;
      }
    },
    reset(): void {
      this.state = null;
      this.loaded = false;
      this.loading = false;
      this.lastError = '';
      this.lastErrorStatus = 0;
    },
  },
});
