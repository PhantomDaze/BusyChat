import { defineStore } from 'pinia';

import { clearToken, getToken, setToken } from '@/api/client';

/** 会话状态：token 实际存放在 api client 的 sessionStorage 里 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken(),
  }),
  getters: {
    authenticated: (s) => s.token.length > 0,
  },
  actions: {
    remember(token: string) {
      setToken(token);
      this.token = token;
    },
    clear() {
      clearToken();
      this.token = '';
    },
  },
});
