import { watch } from 'vue';
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

import { ApiError } from '@/api/client';
import { i18n, translate } from '@/i18n';
import { pinia } from '@/stores';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

/**
 * 使用 hash 路由：静态产物用相对 base 构建，挂在任意 settings.uiPath 下都能工作，
 * 服务端只需要把 uiPath/ 映射到 webui-dist/index.html。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginPage.vue'),
    meta: { public: true, titleKey: 'login.title' },
  },
  {
    path: '/',
    component: () => import('@/layouts/full/FullLayout.vue'),
    children: [
      { path: '', redirect: { name: 'welcome' } },
      {
        path: 'welcome',
        name: 'welcome',
        component: () => import('@/views/WelcomePage.vue'),
        meta: { titleKey: 'nav.welcome' },
      },
      {
        path: 'providers',
        name: 'providers',
        component: () => import('@/views/ProviderPage.vue'),
        meta: { titleKey: 'nav.providers' },
      },
      {
        path: 'plugins',
        name: 'plugins',
        component: () => import('@/views/PluginPage.vue'),
        meta: { titleKey: 'nav.plugins' },
      },
      {
        path: 'knowledge',
        name: 'knowledge',
        component: () => import('@/views/KnowledgePage.vue'),
        meta: { titleKey: 'nav.knowledge' },
      },
      {
        path: 'platform',
        name: 'platform',
        component: () => import('@/views/PlatformPage.vue'),
        meta: { titleKey: 'nav.platform' },
      },
      {
        path: 'logs',
        name: 'logs',
        component: () => import('@/views/MessageLogPage.vue'),
        meta: { titleKey: 'nav.logs' },
      },
      {
        path: 'summary',
        name: 'summary',
        component: () => import('@/views/SummaryPage.vue'),
        meta: { titleKey: 'nav.summary' },
      },
      {
        path: 'reply',
        name: 'reply',
        component: () => import('@/views/ReplyPage.vue'),
        meta: { titleKey: 'nav.reply' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/SettingsPage.vue'),
        meta: { titleKey: 'nav.settings' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundPage.vue'),
    meta: { public: true, titleKey: 'notfound.title' },
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;

  const app = useAppStore(pinia);
  if (app.ready) return true;

  try {
    await app.load();
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      useAuthStore(pinia).clear();
      return { name: 'login', query: { redirect: to.fullPath } };
    }
    // 网络错误：仍然进入页面，由页面展示错误状态
    return true;
  }
});

/** 防止 chunk 加载失败后无限刷新：同一次会话只自动重载一次 */
const CHUNK_RELOAD_KEY = 'busychat_chunk_reload_guard';

function isChunkLoadError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module|Loading chunk [\w-]+ failed|Importing a module script failed/i.test(
      message,
    )
  );
}

router.onError((error) => {
  const toast = useToastStore(pinia);

  if (!isChunkLoadError(error)) {
    // 非 chunk 错误保持可见，避免路由切换失败后静默白屏
    console.error('[webui] router error:', error);
    toast.error(
      translate('app.navigationFailed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  let alreadyReloaded = true;
  try {
    alreadyReloaded = sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1';
    if (!alreadyReloaded) sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
  } catch {
    // sessionStorage 不可用时不允许自动刷新，避免死循环
    alreadyReloaded = true;
  }

  toast.show(translate('app.newVersion'), 'warning', 6000);
  if (!alreadyReloaded) {
    // 给提示一点时间显示；刷新后仍失败则不再自动重载
    window.setTimeout(() => window.location.reload(), 800);
  }
});

function applyDocumentTitle(): void {
  const to = router.currentRoute.value;
  const key = typeof to.meta.titleKey === 'string' ? to.meta.titleKey : 'app.name';
  document.title = `${translate(key)} · BusyChat`;
}

router.afterEach(() => {
  // 导航成功说明新版本资源已加载，允许下一次发版再次自动刷新
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // ignore
  }
  applyDocumentTitle();
});

// 切换语言后当前页面标题立即更新
watch(i18n.global.locale, applyDocumentTitle);
