import { createApp } from 'vue';
import VueApexCharts from 'vue3-apexcharts';

import App from './App.vue';
import { consumeUrlToken, setUnauthorizedHandler } from './api/client';
import { setLocale, i18n, currentLocale } from './i18n';
import vuetify from './plugins/vuetify';
import { router } from './router';
import { pinia } from './stores';
import { useAuthStore } from './stores/auth';
import { useToastStore } from './stores/toast';

import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import '@/styles/main.scss';

// 兼容旧链接：/ui?token=<legacy authToken>（已废弃，不再支持把会话 token 放进 URL）
consumeUrlToken();

document.documentElement.lang = currentLocale();
setLocale(currentLocale());

setUnauthorizedHandler(() => {
  const auth = useAuthStore(pinia);
  auth.clear();
  // 已经在登录页时只清 token，不再提示/跳转，避免重复弹窗或循环
  if (router.currentRoute.value.name === 'login') return;
  const toast = useToastStore(pinia);
  toast.warning(i18n.global.t('login.sessionExpired'));
  void router.replace({ name: 'login' });
});

const app = createApp(App);
app.use(pinia);
app.use(router);
app.use(vuetify);
app.use(i18n);
app.use(VueApexCharts);

// 渲染/生命周期里的未捕获异常：提示用户而不是白屏
app.config.errorHandler = (error, _instance, info) => {
  console.error('[webui] unhandled error:', error, info);
  const toast = useToastStore(pinia);
  toast.error(error instanceof Error ? error.message : String(error));
};

app.mount('#app');
