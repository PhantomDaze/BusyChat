<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';

import { api } from '@/api';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import { useConfirmStore } from '@/stores/confirm';
import { useCustomizerStore } from '@/stores/customizer';
import { useToastStore } from '@/stores/toast';
import LanguageSwitcher from '@/components/shared/LanguageSwitcher.vue';
import ThemeSwitcher from '@/components/shared/ThemeSwitcher.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { lgAndUp } = useDisplay();

const app = useAppStore();
const auth = useAuthStore();
const confirm = useConfirmStore();
const customizer = useCustomizerStore();
const toast = useToastStore();

const pageTitle = computed(() => {
  const key = typeof route.meta.titleKey === 'string' ? route.meta.titleKey : 'app.name';
  return t(key);
});

function toggleSidebar(): void {
  if (lgAndUp.value) customizer.toggleMiniSidebar();
  else customizer.toggleSidebarDrawer();
}

async function refresh(): Promise<void> {
  try {
    await app.refresh();
    toast.success(t('header.refreshed'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function logout(): Promise<void> {
  const ok = await confirm.ask({
    title: t('header.account'),
    message: t('header.signOutConfirm'),
    confirmText: t('header.logout'),
    color: 'primary',
  });
  if (!ok) return;
  try {
    await api.logout();
  } catch {
    // 会话可能已失效，忽略
  }
  auth.clear();
  app.reset();
  toast.info(t('header.loggedOut'));
  await router.replace({ name: 'login' });
}
</script>

<template>
  <v-app-bar flat height="64" class="top-header" elevation="0">
    <v-btn
      icon
      variant="text"
      class="ms-3"
      :title="t('header.toggleSidebar')"
      @click="toggleSidebar"
    >
      <v-icon>mdi-menu</v-icon>
    </v-btn>

    <div class="ms-1 min-w-0">
      <div class="header-title text-truncate">{{ pageTitle }}</div>
      <div class="header-sub d-none d-sm-block text-truncate">{{ t('app.subtitle') }}</div>
    </div>

    <v-spacer />

    <v-chip
      v-if="app.version"
      size="small"
      variant="tonal"
      color="primary"
      class="me-1 d-none d-sm-flex"
      prepend-icon="mdi-tag-outline"
    >
      {{ t('app.version') }} {{ app.version }}
    </v-chip>

    <v-btn icon variant="text" :title="t('header.refresh')" :loading="app.loading" @click="refresh">
      <v-icon v-if="!app.loading">mdi-refresh</v-icon>
    </v-btn>

    <ThemeSwitcher />
    <LanguageSwitcher />

    <v-menu offset="8" location="bottom end">
      <template #activator="{ props: activatorProps }">
        <v-btn
          v-bind="activatorProps"
          icon
          variant="text"
          class="me-2"
          :title="t('header.account')"
        >
          <v-icon>mdi-account-circle-outline</v-icon>
        </v-btn>
      </template>
      <v-list density="compact" min-width="180">
        <v-list-item
          prepend-icon="mdi-account-cog-outline"
          :title="t('settings.title')"
          :to="{ name: 'settings' }"
        />
        <v-divider class="my-1" />
        <v-list-item prepend-icon="mdi-logout" :title="t('header.logout')" @click="logout" />
      </v-list>
    </v-menu>
  </v-app-bar>
</template>
