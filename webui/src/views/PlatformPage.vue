<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '@/api';
import type { OneBotWebSocketMode, WebSocketStatus } from '@/api/types';
import PageHeader from '@/components/shared/PageHeader.vue';
import StatusDot from '@/components/shared/StatusDot.vue';
import { useAppStore } from '@/stores/app';
import { useToastStore } from '@/stores/toast';

const { t } = useI18n();
const app = useAppStore();
const toast = useToastStore();

const ws = reactive({
  mode: 'off' as OneBotWebSocketMode,
  forwardUrl: '',
  reversePath: '/onebot/ws',
  reconnectIntervalMs: 5000,
  actionTimeoutMs: 10000,
});

const onebot = reactive({
  baseUrl: '',
  apiPrefix: '/api',
  accessToken: '',
  selfId: '',
  timeoutMs: 10000,
});

const status = ref<WebSocketStatus | null>(null);
const refreshingStatus = ref(false);
const savingWs = ref(false);
const savingOnebot = ref(false);
const accessTokenConfigured = ref(false);

let statusTimer: ReturnType<typeof setInterval> | undefined;

const modeOptions = computed(() => [
  { title: t('platform.modes.off'), value: 'off' },
  { title: t('platform.modes.forward'), value: 'forward' },
  { title: t('platform.modes.reverse'), value: 'reverse' },
  { title: t('platform.modes.both'), value: 'both' },
]);

const forwardEnabled = computed(() => ws.mode === 'forward' || ws.mode === 'both');
const reverseEnabled = computed(() => ws.mode === 'reverse' || ws.mode === 'both');

const eventPath = computed(() => app.settings?.eventPath ?? '/onebot/event');

const forwardDetail = computed(() => {
  if (status.value?.transport.forwardConnected) return t('platform.connected');
  if (forwardEnabled.value) return t('platform.waitingForward');
  return t('platform.closed');
});

const reverseDetail = computed(() => {
  const transport = status.value?.transport;
  if (transport?.reverseConnected) {
    return `${t('platform.connected')} · ${t('platform.peerCount', { count: transport.reversePeerCount })}`;
  }
  if (reverseEnabled.value) return t('platform.waitingReverse');
  return t('platform.closed');
});

const apiReady = computed(
  () => Boolean(status.value?.transport.forwardConnected || status.value?.transport.reverseConnected),
);

function hydrate(): void {
  const onebotConfig = app.onebot;
  if (!onebotConfig) return;
  ws.mode = onebotConfig.webSocket.mode ?? 'off';
  ws.forwardUrl = onebotConfig.webSocket.forwardUrl ?? '';
  ws.reversePath = onebotConfig.webSocket.reversePath ?? '/onebot/ws';
  ws.reconnectIntervalMs = onebotConfig.webSocket.reconnectIntervalMs ?? 5000;
  ws.actionTimeoutMs = onebotConfig.webSocket.actionTimeoutMs ?? 10000;

  onebot.baseUrl = onebotConfig.baseUrl ?? '';
  onebot.apiPrefix = onebotConfig.apiPrefix ?? '/api';
  onebot.selfId = onebotConfig.selfId ?? '';
  onebot.timeoutMs = onebotConfig.timeoutMs ?? 10000;
  accessTokenConfigured.value = Boolean(onebotConfig.accessToken);
  onebot.accessToken = '';
}

async function refreshStatus(showToast = false): Promise<void> {
  refreshingStatus.value = true;
  try {
    status.value = await api.wsStatus();
    if (showToast) toast.success(t('platform.statusRefreshed'));
  } catch (error) {
    if (showToast) toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    refreshingStatus.value = false;
  }
}

async function saveWs(): Promise<void> {
  savingWs.value = true;
  try {
    await api.saveWsConfig({
      mode: ws.mode,
      forwardUrl: ws.forwardUrl.trim(),
      reversePath: ws.reversePath.trim() || '/onebot/ws',
      reconnectIntervalMs: Number(ws.reconnectIntervalMs) || 5000,
      actionTimeoutMs: Number(ws.actionTimeoutMs) || 10000,
    });
    await app.load();
    hydrate();
    await refreshStatus();
    toast.success(t('platform.wsSaved'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    savingWs.value = false;
  }
}

async function saveOnebot(): Promise<void> {
  savingOnebot.value = true;
  try {
    const payload: Record<string, unknown> = {
      baseUrl: onebot.baseUrl.trim(),
      apiPrefix: onebot.apiPrefix.trim() || '/api',
      selfId: onebot.selfId.trim(),
      timeoutMs: Number(onebot.timeoutMs) || 10000,
    };
    // 只有输入了新 token 才提交；留空表示保持原值
    if (onebot.accessToken.trim()) payload.accessToken = onebot.accessToken.trim();
    await api.saveOneBotConfig(payload);
    await app.load();
    hydrate();
    toast.success(t('platform.onebotSaved'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    savingOnebot.value = false;
  }
}

async function copyEventPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(eventPath.value);
    toast.success(t('common.copied'));
  } catch {
    toast.error(t('common.error'));
  }
}

onMounted(async () => {
  hydrate();
  await refreshStatus();
  statusTimer = setInterval(() => {
    if (!document.hidden) void refreshStatus();
  }, 5000);
});

onBeforeUnmount(() => {
  if (statusTimer) clearInterval(statusTimer);
});
</script>

<template>
  <div>
    <PageHeader :title="t('platform.title')" :subtitle="t('platform.subtitle')" icon="mdi-connection">
      <template #actions>
        <v-chip size="small" variant="tonal" color="primary">
          {{ t(`platform.modes.${ws.mode}`) }}
        </v-chip>
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="mdi-refresh"
          :loading="refreshingStatus"
          @click="refreshStatus(true)"
        >
          {{ t('platform.refreshStatus') }}
        </v-btn>
      </template>
    </PageHeader>

    <v-row dense class="mb-1">
      <v-col cols="12" sm="6" md="4">
        <v-card
          elevation="0"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-text class="d-flex align-center ga-3 py-4">
            <v-avatar size="40" rounded="lg" variant="tonal" color="primary">
              <v-icon size="20">mdi-arrow-top-right</v-icon>
            </v-avatar>
            <div>
              <div class="text-body-2 font-weight-bold">{{ t('platform.forward') }}</div>
              <StatusDot
                :online="Boolean(status?.transport.forwardConnected)"
                :text="forwardDetail"
              />
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" sm="6" md="4">
        <v-card
          elevation="0"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-text class="d-flex align-center ga-3 py-4">
            <v-avatar size="40" rounded="lg" variant="tonal" color="secondary">
              <v-icon size="20">mdi-arrow-bottom-left</v-icon>
            </v-avatar>
            <div>
              <div class="text-body-2 font-weight-bold">{{ t('platform.reverse') }}</div>
              <StatusDot
                :online="Boolean(status?.transport.reverseConnected)"
                :text="reverseDetail"
              />
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="4">
        <v-card
          elevation="0"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-text class="d-flex align-center ga-3 py-4">
            <v-avatar size="40" rounded="lg" variant="tonal" color="success">
              <v-icon size="20">mdi-lan-connect</v-icon>
            </v-avatar>
            <div>
              <div class="text-body-2 font-weight-bold">{{ t('platform.ready') }}</div>
              <StatusDot
                :online="apiReady"
                :text="apiReady ? t('platform.apiReady') : t('platform.apiNotReady')"
              />
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row dense class="mt-1">
      <v-col cols="12" lg="6">
        <v-card
          elevation="0"
          class="h-100"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-title class="px-5 pt-4 text-subtitle-1 font-weight-bold">
            <v-icon size="18" color="primary" class="me-2">mdi-access-point</v-icon>
            {{ t('platform.wsTitle') }}
          </v-card-title>
          <v-card-text class="px-5">
            <p class="text-caption muted mb-4">{{ t('platform.wsDesc') }}</p>

            <v-select
              v-model="ws.mode"
              :items="modeOptions"
              :label="t('platform.mode')"
              variant="outlined"
              density="comfortable"
              class="mb-3"
            />

            <v-text-field
              v-if="forwardEnabled"
              v-model="ws.forwardUrl"
              :label="t('platform.forwardUrl')"
              :hint="t('platform.forwardUrlHint')"
              persistent-hint
              variant="outlined"
              density="comfortable"
              class="mb-3"
            />

            <v-text-field
              v-if="reverseEnabled"
              v-model="ws.reversePath"
              :label="t('platform.reversePath')"
              variant="outlined"
              density="comfortable"
              class="mb-3"
            />

            <v-row dense>
              <v-col cols="12" sm="6">
                <v-text-field
                  v-model.number="ws.reconnectIntervalMs"
                  type="number"
                  min="1000"
                  step="500"
                  :label="t('platform.reconnect')"
                  :suffix="t('common.ms')"
                  variant="outlined"
                  density="comfortable"
                />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field
                  v-model.number="ws.actionTimeoutMs"
                  type="number"
                  min="1000"
                  step="1000"
                  :label="t('platform.actionTimeout')"
                  :suffix="t('common.ms')"
                  variant="outlined"
                  density="comfortable"
                />
              </v-col>
            </v-row>

            <div class="d-flex align-center ga-2 mt-2">
              <v-btn color="primary" variant="flat" :loading="savingWs" @click="saveWs">
                {{ t('platform.saveWs') }}
              </v-btn>
              <span class="text-caption muted">{{ t('platform.autoRefresh') }}</span>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" lg="6">
        <v-card
          elevation="0"
          class="h-100"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-title class="px-5 pt-4 text-subtitle-1 font-weight-bold">
            <v-icon size="18" color="primary" class="me-2">mdi-api</v-icon>
            {{ t('platform.onebotTitle') }}
          </v-card-title>
          <v-card-text class="px-5">
            <p class="text-caption muted mb-4">{{ t('platform.onebotDesc') }}</p>

            <v-text-field
              v-model="onebot.baseUrl"
              :label="t('platform.baseUrl')"
              :hint="t('platform.baseUrlHint')"
              persistent-hint
              variant="outlined"
              density="comfortable"
              class="mb-3"
            />

            <v-row dense>
              <v-col cols="12" sm="6">
                <v-text-field
                  v-model="onebot.apiPrefix"
                  :label="t('platform.apiPrefix')"
                  variant="outlined"
                  density="comfortable"
                />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field
                  v-model="onebot.selfId"
                  :label="t('platform.selfId')"
                  :hint="t('platform.selfIdHint')"
                  persistent-hint
                  variant="outlined"
                  density="comfortable"
                />
              </v-col>
            </v-row>

            <v-text-field
              v-model="onebot.accessToken"
              type="password"
              :label="t('platform.accessToken')"
              :hint="
                accessTokenConfigured
                  ? t('platform.accessTokenMasked')
                  : t('platform.accessTokenHint')
              "
              persistent-hint
              variant="outlined"
              density="comfortable"
              class="mt-3 mb-3"
            />

            <v-text-field
              v-model.number="onebot.timeoutMs"
              type="number"
              min="500"
              step="500"
              :label="t('platform.timeout')"
              :suffix="t('common.ms')"
              variant="outlined"
              density="comfortable"
            />

            <v-btn color="primary" variant="flat" class="mt-4" :loading="savingOnebot" @click="saveOnebot">
              {{ t('platform.saveOnebot') }}
            </v-btn>

            <v-divider class="my-4" />

            <div class="text-caption muted">{{ t('platform.eventPath') }}</div>
            <div class="d-flex align-center ga-2 mt-1">
              <code class="mono text-body-2">{{ eventPath }}</code>
              <v-btn
                size="x-small"
                variant="text"
                color="primary"
                :title="t('platform.copyPath')"
                @click="copyEventPath"
              >
                {{ t('common.copy') }}
              </v-btn>
            </div>
            <div class="text-caption muted mt-1">{{ t('platform.eventPathHint') }}</div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>
