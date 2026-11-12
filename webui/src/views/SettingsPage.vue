<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';

import { api } from '@/api';
import { ApiError } from '@/api/client';
import type { AppConfigFile } from '@/api/types';
import type { ThemeMode } from '@/config';
import JsonEditor from '@/components/shared/JsonEditor.vue';
import PageHeader from '@/components/shared/PageHeader.vue';
import { SUPPORTED_LOCALES, currentLocale, setLocale, type LocaleCode } from '@/i18n';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import { useConfirmStore } from '@/stores/confirm';
import { useCustomizerStore } from '@/stores/customizer';
import { useToastStore } from '@/stores/toast';

type SettingsTab = 'general' | 'admin' | 'security' | 'config';
const TABS: SettingsTab[] = ['general', 'admin', 'security', 'config'];

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const app = useAppStore();
const auth = useAuthStore();
const confirm = useConfirmStore();
const customizer = useCustomizerStore();
const toast = useToastStore();

const activeTab = ref<SettingsTab>('general');

// ---- 外观 ----
// 直接绑定 store / i18n：从顶栏切换主题或语言后，本页控件保持同步
const themeMode = computed<ThemeMode>({
  get: () => customizer.themeMode,
  set: (mode) => customizer.setThemeMode(mode),
});

const locale = computed<LocaleCode>({
  get: () => currentLocale(),
  set: (code) => setLocale(code),
});

// ---- 管理员 ----
const adminInput = ref('');

async function addAdmin(): Promise<void> {
  const id = adminInput.value.trim();
  if (!id) return;
  try {
    await api.addAdmin(id);
    adminInput.value = '';
    await app.load();
    await refreshConfigSnapshot();
    toast.success(t('settings.adminAdded', { id }));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function removeAdmin(id: string): Promise<void> {
  const ok = await confirm.ask({
    title: t('settings.removeAdmin'),
    message: t('settings.removeAdminConfirm', { id }),
    confirmText: t('common.remove'),
  });
  if (!ok) return;
  try {
    await api.removeAdmin(id);
    await app.load();
    await refreshConfigSnapshot();
    toast.success(t('settings.adminRemoved', { id }));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

// ---- 安全 ----
const password = ref('');
const showPassword = ref(false);
const savingPassword = ref(false);

async function savePassword(): Promise<void> {
  if (password.value.length < 6) {
    toast.warning(t('settings.passwordTooShort'));
    return;
  }
  savingPassword.value = true;
  try {
    const result = await api.setPassword(password.value);
    if (result.token) auth.remember(result.token);
    password.value = '';
    await app.load();
    await refreshConfigSnapshot();
    toast.success(t('settings.passwordSaved'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    savingPassword.value = false;
  }
}

// ---- 配置文件 ----
const configText = ref('');
const configLoaded = ref(false);
const configDirty = ref(false);
const savingConfig = ref(false);
const configStatus = ref('');
const configWarnings = ref<string[]>([]);

async function loadConfig(quiet = false): Promise<void> {
  try {
    const config = await api.config();
    configText.value = JSON.stringify(config, null, 2);
    configLoaded.value = true;
    configDirty.value = false;
    configStatus.value = '';
    configWarnings.value = [];
  } catch (error) {
    if (quiet) return;
    toast.error(
      t('settings.configLoadFailed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * 其他会改动配置的操作（管理员/密码等）成功后，同步已加载的编辑器快照。
 * 用户编辑器里有未保存内容时不覆盖，避免丢编辑。
 */
async function refreshConfigSnapshot(): Promise<void> {
  if (!configLoaded.value || configDirty.value) return;
  await loadConfig(true);
}

function onConfigInput(value: string): void {
  if (value === configText.value) return;
  configText.value = value;
  configDirty.value = true;
  configStatus.value = t('settings.configUnsaved');
  configWarnings.value = [];
}

async function saveConfig(): Promise<void> {
  if (!configLoaded.value) {
    toast.warning(t('settings.configNotLoaded'));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText.value);
  } catch (error) {
    toast.error(
      t('settings.configInvalid', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('settings' in parsed) ||
    !('runtime' in parsed)
  ) {
    toast.error(t('settings.configMissingSections'));
    return;
  }

  savingConfig.value = true;
  try {
    const result = await api.saveConfig(parsed as AppConfigFile);
    configDirty.value = false;
    // 保存成功后重新拉取服务端规范化后的配置，避免编辑器继续持有旧快照
    await loadConfig(true);
    configStatus.value = t('settings.configSaved');
    configWarnings.value = result.warnings ?? [];
    toast.success(t('settings.configSaved'));
    try {
      await app.load();
    } catch {
      // 保存本身已成功；状态刷新失败由全局横幅提示，不误报为保存失败
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      // 版本冲突：不要覆盖服务端的新配置，交给用户决定是否重新加载
      const reload = await confirm.ask({
        title: t('settings.configConflictTitle'),
        message: t('settings.configConflictBody'),
        confirmText: t('settings.configReload'),
        color: 'warning',
      });
      if (reload) await loadConfig();
    } else {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  } finally {
    savingConfig.value = false;
  }
}

function formatConfig(): void {
  try {
    configText.value = JSON.stringify(JSON.parse(configText.value), null, 2);
    configStatus.value = t('settings.configUnsaved');
  } catch {
    // 非法 JSON 不做格式化，用户继续编辑
  }
}

async function reloadConfig(): Promise<void> {
  await loadConfig();
  toast.success(t('settings.configReloaded'));
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!configDirty.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onMounted(() => {
  const tab = route.query.tab;
  if (typeof tab === 'string' && (TABS as string[]).includes(tab)) {
    activeTab.value = tab as SettingsTab;
  }
  window.addEventListener('beforeunload', beforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
});

watch(activeTab, (tab) => {
  void router.replace({ query: { ...route.query, tab } });
  if (tab === 'config' && !configLoaded.value) void loadConfig();
});

onBeforeRouteLeave(async () => {
  if (!configDirty.value) return true;
  return confirm.ask({
    title: t('settings.configTitle'),
    message: t('settings.dirtyGuard'),
    confirmText: t('common.confirm'),
    color: 'warning',
  });
});
</script>

<template>
  <div>
    <PageHeader :title="t('settings.title')" :subtitle="t('settings.subtitle')" icon="mdi-cog-outline" />

    <v-card
      elevation="0"
      style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
    >
      <v-tabs v-model="activeTab" color="primary" density="comfortable" class="px-3 pt-2">
        <v-tab value="general">
          <v-icon start size="18">mdi-palette-outline</v-icon>
          {{ t('settings.tabs.general') }}
        </v-tab>
        <v-tab value="admin">
          <v-icon start size="18">mdi-account-group-outline</v-icon>
          {{ t('settings.tabs.admin') }}
        </v-tab>
        <v-tab value="security">
          <v-icon start size="18">mdi-shield-lock-outline</v-icon>
          {{ t('settings.tabs.security') }}
        </v-tab>
        <v-tab value="config">
          <v-icon start size="18">mdi-code-json</v-icon>
          {{ t('settings.tabs.config') }}
        </v-tab>
      </v-tabs>

      <v-divider />

      <v-window v-model="activeTab">
        <!-- 外观 -->
        <v-window-item value="general">
          <v-card-text class="pa-6">
            <div class="text-subtitle-1 font-weight-bold">{{ t('settings.generalTitle') }}</div>
            <p class="text-caption muted mb-4">{{ t('settings.generalDesc') }}</p>

            <div class="text-body-2 font-weight-medium mb-2">{{ t('settings.theme') }}</div>
            <p class="text-caption muted mb-2">{{ t('settings.themeDesc') }}</p>
            <v-btn-toggle v-model="themeMode" mandatory color="primary" variant="outlined" density="comfortable">
              <v-btn value="light" prepend-icon="mdi-white-balance-sunny">
                {{ t('header.themeLight') }}
              </v-btn>
              <v-btn value="dark" prepend-icon="mdi-weather-night">
                {{ t('header.themeDark') }}
              </v-btn>
              <v-btn value="system" prepend-icon="mdi-monitor-eye">
                {{ t('header.themeSystem') }}
              </v-btn>
            </v-btn-toggle>

            <v-divider class="my-6" />

            <div class="text-body-2 font-weight-medium mb-2">{{ t('settings.language') }}</div>
            <p class="text-caption muted mb-2">{{ t('settings.languageDesc') }}</p>
            <v-select
              v-model="locale"
              :items="SUPPORTED_LOCALES.map((item) => ({ title: item.label, value: item.code }))"
              density="comfortable"
              variant="outlined"
              hide-details
              style="max-width: 260px"
            />
          </v-card-text>
        </v-window-item>

        <!-- 管理员 -->
        <v-window-item value="admin">
          <v-card-text class="pa-6">
            <div class="text-subtitle-1 font-weight-bold">{{ t('settings.adminTitle') }}</div>
            <p class="text-caption muted mb-4">{{ t('settings.adminDesc') }}</p>

            <div class="d-flex align-center flex-wrap ga-2 mb-4" style="max-width: 520px">
              <v-text-field
                v-model="adminInput"
                :placeholder="t('settings.adminPlaceholder')"
                variant="outlined"
                density="comfortable"
                hide-details
                style="flex: 1 1 220px"
                @keyup.enter="addAdmin"
              />
              <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" @click="addAdmin">
                {{ t('settings.addAdmin') }}
              </v-btn>
            </div>

            <div v-if="app.loaded && app.admins.length === 0" class="text-body-2 muted">
              {{ t('settings.noAdmins') }}
            </div>
            <div v-for="id in app.admins" :key="id" class="list-row d-flex align-center justify-space-between">
              <div class="d-flex align-center ga-2">
                <v-avatar size="30" variant="tonal" color="primary">
                  <v-icon size="16">mdi-account-outline</v-icon>
                </v-avatar>
                <span class="mono text-body-2">{{ id }}</span>
              </div>
              <v-btn size="small" variant="text" color="error" @click="removeAdmin(id)">
                {{ t('settings.removeAdmin') }}
              </v-btn>
            </div>
          </v-card-text>
        </v-window-item>

        <!-- 安全 -->
        <v-window-item value="security">
          <v-card-text class="pa-6">
            <div class="text-subtitle-1 font-weight-bold">{{ t('settings.passwordTitle') }}</div>
            <p class="text-caption muted mb-4">{{ t('settings.passwordDesc') }}</p>

            <v-alert
              :type="app.ui?.password ? 'success' : 'warning'"
              variant="tonal"
              density="compact"
              class="mb-4"
              style="max-width: 620px"
            >
              {{ app.ui?.password ? t('settings.passwordHint') : t('settings.noPasswordHint') }}
            </v-alert>

            <div class="d-flex align-center flex-wrap ga-2" style="max-width: 520px">
              <v-text-field
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                :placeholder="t('settings.passwordPlaceholder')"
                prepend-inner-icon="mdi-lock-outline"
                :append-inner-icon="showPassword ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
                variant="outlined"
                density="comfortable"
                hide-details
                autocomplete="new-password"
                style="flex: 1 1 220px"
                @click:append-inner="showPassword = !showPassword"
              />
              <v-btn color="primary" variant="flat" :loading="savingPassword" @click="savePassword">
                {{ t('settings.savePassword') }}
              </v-btn>
            </div>

            <p class="text-caption muted mt-4">{{ t('settings.securityNote') }}</p>
          </v-card-text>
        </v-window-item>

        <!-- 配置文件 -->
        <v-window-item value="config">
          <v-card-text class="pa-6">
            <div class="d-flex align-center flex-wrap ga-2 mb-2">
              <div class="text-subtitle-1 font-weight-bold">{{ t('settings.configTitle') }}</div>
              <v-chip v-if="configDirty" size="small" color="warning" variant="tonal">
                {{ t('settings.configUnsaved') }}
              </v-chip>
              <v-spacer />
              <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" @click="reloadConfig">
                {{ t('settings.configReload') }}
              </v-btn>
              <v-btn size="small" variant="tonal" prepend-icon="mdi-code-braces" @click="formatConfig">
                {{ t('settings.configFormat') }}
              </v-btn>
              <v-btn
                size="small"
                color="primary"
                variant="flat"
                prepend-icon="mdi-content-save-outline"
                :loading="savingConfig"
                @click="saveConfig"
              >
                {{ t('settings.configSave') }}
              </v-btn>
            </div>
            <p class="text-caption muted mb-3">{{ t('settings.configDesc') }}</p>

            <v-alert
              v-if="configWarnings.length > 0"
              type="warning"
              variant="tonal"
              density="comfortable"
              class="mb-3"
            >
              <div class="font-weight-medium mb-1">
                {{ t('settings.configWarnings', { count: configWarnings.length }) }}
              </div>
              <ul class="text-body-2 ps-5 mb-0">
                <li v-for="(warning, index) in configWarnings" :key="index">{{ warning }}</li>
              </ul>
            </v-alert>

            <JsonEditor
              :model-value="configText"
              :dark="customizer.isDark"
              @update:model-value="onConfigInput"
            />

            <div class="d-flex align-center justify-space-between mt-2">
              <span class="text-caption muted">{{ t('settings.configTip') }}</span>
              <span class="text-caption muted">{{ configStatus }}</span>
            </div>
          </v-card-text>
        </v-window-item>
      </v-window>
    </v-card>
  </div>
</template>
