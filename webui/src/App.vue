<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTheme } from 'vuetify';

import { useAppStore } from '@/stores/app';
import { useConfirmStore } from '@/stores/confirm';
import { useCustomizerStore } from '@/stores/customizer';
import { useToastStore } from '@/stores/toast';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';

const { t } = useI18n();
const app = useAppStore();
const confirm = useConfirmStore();
const customizer = useCustomizerStore();
const toast = useToastStore();
const theme = useTheme();

// 后端不可达时的全局横幅：用户可关闭，出现新的错误时重新显示
const bannerDismissed = ref(false);
const retrying = ref(false);
const showBackendBanner = computed(
  () => Boolean(app.lastError) && app.lastErrorStatus === 0 && !bannerDismissed.value,
);

watch(
  () => app.lastError,
  (value, previous) => {
    if (value && value !== previous) bannerDismissed.value = false;
  },
);

async function retryConnection(): Promise<void> {
  retrying.value = true;
  try {
    await app.refresh();
    bannerDismissed.value = false;
    toast.success(t('header.refreshed'));
  } catch {
    // 失败信息已写入 app.lastError，横幅保持显示
  } finally {
    retrying.value = false;
  }
}

/** Vuetify 主题 + 首屏 data-app-theme 同步（供非 Vuetify 样式使用） */
function applyTheme(): void {
  theme.global.name.value = customizer.uiTheme;
  document.documentElement.setAttribute('data-app-theme', customizer.isDark ? 'dark' : 'light');
}

watch(() => customizer.uiTheme, applyTheme, { immediate: true });

const media = window.matchMedia('(prefers-color-scheme: dark)');
media.addEventListener('change', () => {
  customizer.syncSystemTheme();
  applyTheme();
});
</script>

<template>
  <v-app :theme="customizer.uiTheme" :class="customizer.fontTheme">
    <v-progress-linear
      v-if="app.loading"
      indeterminate
      color="primary"
      height="2"
      fixed
      top
      style="z-index: 9999; opacity: 0.75"
    />

    <v-alert
      v-if="showBackendBanner"
      type="error"
      variant="tonal"
      density="comfortable"
      class="backend-banner"
      closable
      @click:close="bannerDismissed = true"
    >
      <div class="d-flex align-center flex-wrap ga-3">
        <div class="flex-grow-1">
          <div class="font-weight-bold">{{ t('app.unreachableTitle') }}</div>
          <div class="text-body-2">{{ t('app.unreachableBody') }}</div>
          <div v-if="app.lastError" class="text-caption mt-1">{{ app.lastError }}</div>
        </div>
        <v-btn color="error" variant="flat" size="small" :loading="retrying" @click="retryConnection">
          {{ t('common.retry') }}
        </v-btn>
      </div>
    </v-alert>

    <router-view />

    <v-snackbar
      v-model="toast.visible"
      :color="toast.color"
      :timeout="toast.timeout"
      location="top"
      elevation="6"
    >
      <div class="d-flex align-center ga-3">
        <v-icon
          size="20"
          :icon="
            toast.color === 'error'
              ? 'mdi-alert-circle-outline'
              : toast.color === 'warning'
                ? 'mdi-alert-outline'
                : toast.color === 'info'
                  ? 'mdi-information-outline'
                  : 'mdi-check-circle-outline'
          "
        />
        <span class="text-body-2 font-weight-medium">{{ toast.message }}</span>
      </div>
      <template #actions>
        <v-btn variant="text" size="small" icon="mdi-close" @click="toast.visible = false" />
      </template>
    </v-snackbar>

    <ConfirmDialog />
  </v-app>
</template>

<style scoped>
.backend-banner {
  position: fixed;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  width: min(720px, calc(100vw - 24px));
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
}
</style>
