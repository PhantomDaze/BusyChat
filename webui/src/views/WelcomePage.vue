<script setup lang="ts">
import { computed } from 'vue';
import type { ApexOptions } from 'apexcharts';
import { useI18n } from 'vue-i18n';

import EmptyState from '@/components/shared/EmptyState.vue';
import StatCard from '@/components/shared/StatCard.vue';
import { useAppStore } from '@/stores/app';
import { useCustomizerStore } from '@/stores/customizer';
import {
  formatDateTime,
  formatNumber,
  formatRelative,
  greetingKey,
  truncate,
} from '@/utils/format';

const { t } = useI18n();
const app = useAppStore();
const customizer = useCustomizerStore();

const REDACTED = '__redacted__';

/** 只有真正加载过 /api/state 之后才展示「未配置」类告警，避免首屏失败误报 */
const stateLoaded = computed(() => app.loaded);

const passwordConfigured = computed(() => {
  const ui = app.ui;
  if (!ui) return true;
  const password = ui.password;
  const hasPassword = typeof password === 'string' && password.length > 0;
  const hasHash = typeof ui.passwordHash === 'string' && ui.passwordHash.length > 0;
  // __redacted__ 也代表密码已配置
  return hasPassword || hasHash || password === REDACTED;
});

const showNoPasswordAlert = computed(
  () => stateLoaded.value && app.ui !== null && !passwordConfigured.value,
);
const showNoAdminAlert = computed(() => stateLoaded.value && app.admins.length === 0);
const showFallbackAlert = computed(() => stateLoaded.value && app.fallbackOnly);

const greeting = computed(() => {
  const keys = {
    morning: 'welcome.greetingMorning',
    afternoon: 'welcome.greetingAfternoon',
    evening: 'welcome.greetingEvening',
    night: 'welcome.greetingNight',
  } as const;
  return `${t(keys[greetingKey()])} 👋`;
});

const summaryLine = computed(() => {
  const status = app.summaryStatus;
  if (!status || !status.enabled) return t('welcome.summaryDisabled');
  const minutes = Math.max(1, Math.round(status.intervalMs / 60000));
  return t('welcome.everyMinute', { minutes });
});

const lastSummaryLine = computed(() => {
  const last = app.summaryStatus?.lastGeneratedAt;
  return last ? t('welcome.lastSummary', { time: formatDateTime(last) }) : '';
});

const transportMode = computed(() => app.onebot?.webSocket.mode ?? 'off');
const transportConfigured = computed(() => transportMode.value !== 'off');
const modelsConfigured = computed(() =>
  app.models.some((model) => model.enabled && model.provider !== 'rule-based'),
);
const adminsConfigured = computed(() => app.admins.length > 0);

const steps = computed(() => [
  {
    key: 'models',
    icon: 'mdi-numeric-1',
    title: t('welcome.onboard.step1Title'),
    desc: t('welcome.onboard.step1Desc'),
    completed: modelsConfigured.value,
    to: { name: 'providers' },
  },
  {
    key: 'platform',
    icon: 'mdi-numeric-2',
    title: t('welcome.onboard.step2Title'),
    desc: t('welcome.onboard.step2Desc'),
    completed: transportConfigured.value,
    to: { name: 'platform' },
  },
  {
    key: 'admins',
    icon: 'mdi-numeric-3',
    title: t('welcome.onboard.step3Title'),
    desc: t('welcome.onboard.step3Desc'),
    completed: adminsConfigured.value,
    to: { name: 'settings', query: { tab: 'admin' } },
  },
]);

const statCards = computed(() => [
  {
    icon: 'mdi-account-group-outline',
    label: t('welcome.stats.admins'),
    value: formatNumber(app.admins.length),
    color: 'primary',
    hint: '',
  },
  {
    icon: 'mdi-creation-outline',
    label: t('welcome.stats.models'),
    value: formatNumber(app.models.length),
    color: 'secondary',
    hint: t('welcome.stats.enabled', { count: app.enabledModelCount }),
  },
  {
    icon: 'mdi-puzzle-outline',
    label: t('welcome.stats.plugins'),
    value: formatNumber(app.plugins.length),
    color: 'info',
    hint: t('welcome.stats.enabled', { count: app.enabledPluginCount }),
  },
  {
    icon: 'mdi-message-text-outline',
    label: t('welcome.stats.messages'),
    value: formatNumber(app.events.length),
    color: 'success',
    hint: t('welcome.stats.recent', { count: app.events.length }),
  },
  {
    icon: 'mdi-file-document-outline',
    label: t('welcome.stats.summaries'),
    value: formatNumber(app.summaries.length),
    color: 'warning',
    hint: summaryLine.value,
  },
  {
    icon: 'mdi-book-open-variant',
    label: t('welcome.stats.knowledge'),
    value: formatNumber(app.kbCount),
    color: 'primary',
    hint: t('welcome.stats.entries', { count: app.kbCount }),
  },
]);

const hourLabels = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);

const hourly = computed(() => {
  const buckets = new Array<number>(24).fill(0);
  for (const event of app.events) {
    const date = new Date(event.receivedAt);
    if (Number.isNaN(date.getTime())) continue;
    buckets[date.getHours()] += 1;
  }
  return buckets;
});

const chartSeries = computed(() => [{ name: t('welcome.stats.messages'), data: hourly.value }]);

const chartOptions = computed<ApexOptions>(() => ({
  chart: {
    type: 'area',
    toolbar: { show: false },
    background: 'transparent',
    fontFamily: 'inherit',
    animations: { enabled: false },
  },
  colors: [customizer.isDark ? '#5ba4d4' : '#3c96ca'],
  dataLabels: { enabled: false },
  stroke: { curve: 'smooth', width: 2 },
  fill: {
    type: 'gradient',
    gradient: { shadeIntensity: 0.2, opacityFrom: 0.35, opacityTo: 0.04 },
  },
  grid: {
    borderColor: customizer.isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.07)',
    strokeDashArray: 4,
    padding: { left: 4, right: 8 },
  },
  xaxis: {
    categories: hourLabels,
    tickAmount: 6,
    labels: {
      style: { colors: customizer.isDark ? '#b0b0b0' : '#616161', fontSize: '11px' },
    },
    axisBorder: { show: false },
    axisTicks: { show: false },
  },
  yaxis: {
    min: 0,
    tickAmount: 4,
    labels: {
      style: { colors: customizer.isDark ? '#b0b0b0' : '#616161', fontSize: '11px' },
      formatter: (value: number) => String(Math.round(value)),
    },
  },
  tooltip: { theme: customizer.isDark ? 'dark' : 'light' },
  legend: { show: false },
}));

const recentEvents = computed(() => app.events.slice(0, 8));
const recentSummaries = computed(() => app.summaries.slice(0, 5));

function scopeIcon(scope: string): string {
  return scope === 'group' ? 'mdi-account-group-outline' : 'mdi-account-outline';
}
</script>

<template>
  <div>
    <div class="mb-4">
      <h1 class="text-h4 font-weight-bold mb-1">{{ greeting }}</h1>
      <p class="text-body-2 muted mb-0">{{ t('welcome.subtitle') }}</p>
      <p v-if="lastSummaryLine" class="text-caption muted mt-1">{{ lastSummaryLine }}</p>
    </div>

    <v-alert
      v-if="showNoPasswordAlert"
      type="warning"
      variant="tonal"
      density="comfortable"
      class="mb-3"
    >
      <div class="font-weight-bold">{{ t('welcome.alerts.noPasswordTitle') }}</div>
      <div class="text-body-2">{{ t('welcome.alerts.noPasswordBody') }}</div>
      <v-btn
        variant="text"
        color="warning"
        size="small"
        class="px-0 mt-1"
        :to="{ name: 'settings', query: { tab: 'security' } }"
      >
        {{ t('settings.passwordTitle') }}
        <v-icon end>mdi-arrow-right</v-icon>
      </v-btn>
    </v-alert>

    <v-alert v-if="showNoAdminAlert" type="info" variant="tonal" density="comfortable" class="mb-3">
      <div class="font-weight-bold">{{ t('welcome.alerts.noAdminTitle') }}</div>
      <div class="text-body-2">{{ t('welcome.alerts.noAdminBody') }}</div>
      <v-btn
        variant="text"
        color="info"
        size="small"
        class="px-0 mt-1"
        :to="{ name: 'settings', query: { tab: 'admin' } }"
      >
        {{ t('settings.adminTitle') }}
        <v-icon end>mdi-arrow-right</v-icon>
      </v-btn>
    </v-alert>

    <v-alert
      v-if="showFallbackAlert"
      type="error"
      variant="tonal"
      density="comfortable"
      class="mb-4"
    >
      <div class="font-weight-bold">{{ t('welcome.alerts.fallbackTitle') }}</div>
      <div class="text-body-2">{{ t('welcome.alerts.fallbackBody') }}</div>
      <v-btn
        variant="text"
        color="error"
        size="small"
        class="px-0 mt-1"
        :to="{ name: 'providers' }"
      >
        {{ t('welcome.quickProviders') }}
        <v-icon end>mdi-arrow-right</v-icon>
      </v-btn>
    </v-alert>

    <v-row dense>
      <v-col cols="12" md="7">
        <v-card
          elevation="0"
          class="h-100"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-title class="text-h6 font-weight-bold pt-5 px-6">
            {{ t('welcome.onboard.title') }}
          </v-card-title>
          <v-card-text class="px-4 pb-4">
            <v-timeline align="start" side="end" density="compact" truncate-line="both">
              <v-timeline-item
                v-for="step in steps"
                :key="step.key"
                :dot-color="step.completed ? 'success' : 'primary'"
                :icon="step.completed ? 'mdi-check' : step.icon"
                fill-dot
                size="small"
              >
                <div class="pl-2">
                  <div class="text-subtitle-1 font-weight-bold mb-1">{{ step.title }}</div>
                  <p class="text-body-2 muted mb-3">{{ step.desc }}</p>
                  <div class="d-flex align-center flex-wrap ga-3">
                    <v-btn
                      v-if="!step.completed"
                      color="primary"
                      variant="flat"
                      rounded="pill"
                      class="px-5"
                      :to="step.to"
                    >
                      {{ t('welcome.onboard.configure') }}
                    </v-btn>
                    <span v-else class="text-success text-body-2 font-weight-medium">
                      <v-icon size="18" color="success" class="me-1">mdi-check-circle</v-icon>
                      {{ t('welcome.onboard.completed') }}
                    </span>
                  </div>
                </div>
              </v-timeline-item>
            </v-timeline>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="5">
        <v-card
          elevation="0"
          class="h-100"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-title class="text-h6 font-weight-bold pt-5 px-6">
            {{ t('welcome.quickActions') }}
          </v-card-title>
          <v-card-text class="d-flex flex-column ga-3 px-6 pb-6">
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="mdi-creation-outline"
              :to="{ name: 'providers' }"
            >
              {{ t('welcome.quickProviders') }}
            </v-btn>
            <v-btn
              color="primary"
              variant="tonal"
              prepend-icon="mdi-connection"
              :to="{ name: 'platform' }"
            >
              {{ t('welcome.quickPlatform') }}
            </v-btn>
            <v-btn
              color="primary"
              variant="tonal"
              prepend-icon="mdi-cog-outline"
              :to="{ name: 'settings' }"
            >
              {{ t('welcome.quickSettings') }}
            </v-btn>
            <v-divider class="my-1" />
            <div class="d-flex align-center justify-between text-body-2">
              <span class="muted">{{ t('welcome.stats.summaries') }}</span>
              <v-chip size="small" variant="tonal" :color="app.summaryStatus?.enabled ? 'success' : 'error'">
                {{ summaryLine }}
              </v-chip>
            </div>
            <div class="d-flex align-center justify-between text-body-2">
              <span class="muted">{{ t('platform.websocket') }}</span>
              <v-chip
                size="small"
                variant="tonal"
                :color="transportConfigured ? 'success' : 'warning'"
              >
                {{ t(`platform.modes.${transportMode}`) }}
              </v-chip>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row dense class="mt-1">
      <v-col v-for="card in statCards" :key="card.label" cols="12" sm="6" md="4" lg="2">
        <StatCard
          :icon="card.icon"
          :label="card.label"
          :value="card.value"
          :hint="card.hint"
          :color="card.color"
        />
      </v-col>
    </v-row>

    <v-row dense class="mt-1">
      <v-col cols="12" lg="7">
        <v-card
          elevation="0"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-title class="d-flex align-center justify-space-between px-6 pt-5">
            <span class="text-h6 font-weight-bold">{{ t('welcome.activity') }}</span>
            <span class="text-caption muted">{{ t('welcome.activityDesc') }}</span>
          </v-card-title>
          <v-card-text class="px-4 pb-4">
            <apexchart type="area" height="240" :options="chartOptions" :series="chartSeries" />
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" lg="5">
        <v-card
          elevation="0"
          class="h-100"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-title class="px-6 pt-5 text-h6 font-weight-bold">
            {{ t('welcome.recentEvents') }}
          </v-card-title>
          <v-card-text class="px-6 pb-4">
            <EmptyState
              v-if="stateLoaded && recentEvents.length === 0"
              icon="mdi-message-outline"
              :text="t('welcome.emptyEvents')"
            />
            <div
              v-for="event in recentEvents"
              :key="event.id"
              class="list-row d-flex align-center ga-3"
            >
              <v-avatar size="30" variant="tonal" color="primary">
                <v-icon size="16">{{ scopeIcon(event.scope) }}</v-icon>
              </v-avatar>
              <div class="min-w-0 flex-grow-1">
                <div class="list-title">
                  [{{ event.scope === 'group' ? t('logs.scopes.group') : t('logs.scopes.private') }}]
                  {{ truncate(event.content?.text, 64) || t('common.empty') }}
                </div>
                <div class="list-sub">
                  {{ formatRelative(event.receivedAt) }} · {{ event.sender?.userId }}
                </div>
              </div>
              <v-chip
                v-if="event.visibility?.fromAdmin"
                size="x-small"
                variant="tonal"
                color="primary"
              >
                {{ t('logs.flagAdmin') }}
              </v-chip>
              <v-chip v-else-if="event.visibility?.fromBot" size="x-small" variant="tonal" color="secondary">
                {{ t('logs.flagBot') }}
              </v-chip>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-row dense class="mt-1">
      <v-col cols="12">
        <v-card
          elevation="0"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-title class="px-6 pt-5 text-h6 font-weight-bold">
            {{ t('welcome.recentSummaries') }}
          </v-card-title>
          <v-card-text class="px-6 pb-5">
            <EmptyState
              v-if="stateLoaded && recentSummaries.length === 0"
              icon="mdi-file-document-outline"
              :text="t('welcome.emptySummaries')"
            />
            <div
              v-for="summary in recentSummaries"
              :key="summary.id"
              class="list-row d-flex align-start ga-3"
            >
              <v-icon size="18" color="primary" class="mt-1">mdi-file-document-outline</v-icon>
              <div class="min-w-0">
                <div class="text-body-2">{{ truncate(summary.summaryText, 220) }}</div>
                <div class="list-sub mt-1">
                  {{ formatDateTime(summary.createdAt) }}
                  <template v-if="summary.modelId"> · {{ summary.modelId }}</template>
                </div>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>
