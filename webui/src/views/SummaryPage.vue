<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '@/api';
import type { NotifySettings } from '@/api/types';
import EmptyState from '@/components/shared/EmptyState.vue';
import PageHeader from '@/components/shared/PageHeader.vue';
import { useAppStore } from '@/stores/app';
import { useToastStore } from '@/stores/toast';
import { formatDateTime, truncate } from '@/utils/format';

const { t } = useI18n();
const app = useAppStore();
const toast = useToastStore();

const summaryForm = reactive({
  enabled: true,
  intervalMs: 120000,
  batchSize: 5,
  maxEventsPerPrompt: 40,
});

const savingSummary = ref(false);
const flushing = ref(false);
const flushResult = ref('');

const notifyForm = reactive<NotifySettings>({
  notifyKeywords: [],
  quietHours: null,
});
const keywordInput = ref('');
const savingKeywords = ref(false);
const savingQuiet = ref(false);
const quietStart = ref('23:00');
const quietEnd = ref('07:00');

const summaries = computed(() => app.summaries);

const quietActive = computed(() => Boolean(notifyForm.quietHours));

const statusLine = computed(() => {
  const status = app.summaryStatus;
  if (!status) return '';
  const last = status.lastGeneratedAt;
  return last ? t('summary.status', { time: formatDateTime(last) }) : t('summary.never');
});

function hydrateSummary(): void {
  const status = app.summaryStatus;
  if (!status) return;
  summaryForm.enabled = status.enabled !== false;
  summaryForm.intervalMs = status.intervalMs || 120000;
  summaryForm.batchSize = status.batchSize || 5;
  summaryForm.maxEventsPerPrompt = status.maxEventsPerPrompt || 40;
}

function hydrateNotify(settings: NotifySettings): void {
  notifyForm.notifyKeywords = settings.notifyKeywords ?? [];
  notifyForm.quietHours = settings.quietHours ?? null;
  quietStart.value = settings.quietHours?.start ?? '23:00';
  quietEnd.value = settings.quietHours?.end ?? '07:00';
}

async function loadNotify(): Promise<void> {
  try {
    hydrateNotify(await api.notify.settings());
  } catch {
    // 插件未启用时忽略
  }
}

async function saveSummary(): Promise<void> {
  savingSummary.value = true;
  try {
    await api.summary.saveSettings({
      enabled: summaryForm.enabled,
      intervalMs: Number(summaryForm.intervalMs) || 120000,
      batchSize: Number(summaryForm.batchSize) || 5,
      maxEventsPerPrompt: Number(summaryForm.maxEventsPerPrompt) || 40,
    });
    await app.load();
    hydrateSummary();
    toast.success(t('summary.saved'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    savingSummary.value = false;
  }
}

async function flushNow(): Promise<void> {
  flushing.value = true;
  flushResult.value = '';
  try {
    const result = await api.summary.flush();
    if (result?.empty) {
      toast.info(t('summary.flushEmpty'));
    } else {
      flushResult.value = truncate(result?.summaryText, 400);
      toast.success(t('summary.flushDone'));
      await app.load();
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    flushing.value = false;
  }
}

async function saveKeywords(keywords: string[]): Promise<void> {
  savingKeywords.value = true;
  try {
    await api.notify.saveSettings({ notifyKeywords: keywords });
    await loadNotify();
    toast.success(t('summary.keywordAdded'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    savingKeywords.value = false;
  }
}

async function addKeyword(): Promise<void> {
  const keyword = keywordInput.value.trim();
  if (!keyword) return;
  if (notifyForm.notifyKeywords.includes(keyword)) {
    toast.warning(t('summary.keywordExists'));
    return;
  }
  await saveKeywords([...notifyForm.notifyKeywords, keyword]);
  keywordInput.value = '';
}

async function removeKeyword(keyword: string): Promise<void> {
  savingKeywords.value = true;
  try {
    await api.notify.saveSettings({
      notifyKeywords: notifyForm.notifyKeywords.filter((item) => item !== keyword),
    });
    await loadNotify();
    toast.success(t('summary.keywordRemoved'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    savingKeywords.value = false;
  }
}

async function saveQuiet(): Promise<void> {
  const start = quietStart.value.trim();
  const end = quietEnd.value.trim();
  if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
    toast.warning(t('summary.invalidTime'));
    return;
  }
  savingQuiet.value = true;
  try {
    await api.notify.saveSettings({ quietHours: { start, end } });
    await loadNotify();
    toast.success(t('summary.quietSaved'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    savingQuiet.value = false;
  }
}

async function disableQuiet(): Promise<void> {
  savingQuiet.value = true;
  try {
    await api.notify.saveSettings({ quietHours: null });
    await loadNotify();
    toast.success(t('summary.quietDisabled'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    savingQuiet.value = false;
  }
}

onMounted(async () => {
  hydrateSummary();
  await loadNotify();
});
</script>

<template>
  <div>
    <PageHeader :title="t('summary.title')" :subtitle="t('summary.subtitle')" icon="mdi-bell-ring-outline" />

    <v-row dense>
      <v-col cols="12" lg="6">
        <v-card
          elevation="0"
          class="h-100"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-title class="px-5 pt-4 text-subtitle-1 font-weight-bold">
            {{ t('summary.summaryTitle') }}
          </v-card-title>
          <v-card-text class="px-5">
            <p class="text-caption muted mb-3">{{ t('summary.summaryDesc') }}</p>

            <v-switch
              v-model="summaryForm.enabled"
              color="primary"
              :label="t('summary.enabled')"
              inset
              hide-details
              class="mb-3"
            />

            <v-row dense>
              <v-col cols="12" sm="6">
                <v-text-field
                  v-model.number="summaryForm.intervalMs"
                  type="number"
                  min="5000"
                  step="1000"
                  :label="t('summary.interval')"
                  :suffix="t('common.ms')"
                  variant="outlined"
                  density="comfortable"
                />
              </v-col>
              <v-col cols="12" sm="6">
                <v-text-field
                  v-model.number="summaryForm.batchSize"
                  type="number"
                  min="1"
                  :label="t('summary.batchSize')"
                  :hint="t('summary.batchSizeHint')"
                  persistent-hint
                  variant="outlined"
                  density="comfortable"
                />
              </v-col>
            </v-row>

            <v-text-field
              v-model.number="summaryForm.maxEventsPerPrompt"
              type="number"
              min="1"
              :label="t('summary.maxEvents')"
              :hint="t('summary.maxEventsHint')"
              persistent-hint
              variant="outlined"
              density="comfortable"
              class="mt-3"
            />

            <div class="d-flex align-center flex-wrap ga-2 mt-4">
              <v-btn color="primary" variant="flat" :loading="savingSummary" @click="saveSummary">
                {{ t('summary.save') }}
              </v-btn>
              <v-btn variant="tonal" color="primary" :loading="flushing" @click="flushNow">
                {{ flushing ? t('summary.flushing') : t('summary.flush') }}
              </v-btn>
            </div>
            <div class="text-caption muted mt-2">{{ statusLine }}</div>

            <v-alert
              v-if="flushResult"
              type="success"
              variant="tonal"
              density="compact"
              class="mt-3"
              style="white-space: pre-wrap"
            >
              {{ flushResult }}
            </v-alert>
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
            {{ t('summary.history') }}
          </v-card-title>
          <v-card-text class="px-5">
            <EmptyState
              v-if="app.loaded && summaries.length === 0"
              icon="mdi-file-document-outline"
              :text="t('summary.emptyHistory')"
            />
            <div v-for="summary in summaries" :key="summary.id" class="list-row">
              <div class="text-body-2" style="display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden">
                {{ summary.summaryText }}
              </div>
              <div class="list-sub mt-1">
                {{ formatDateTime(summary.createdAt) }}
                <template v-if="summary.modelId"> · {{ summary.modelId }}</template>
              </div>
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
          <v-card-title class="px-5 pt-4 text-subtitle-1 font-weight-bold">
            {{ t('summary.notifyTitle') }}
          </v-card-title>
          <v-card-text class="px-5">
            <p class="text-caption muted mb-3">{{ t('summary.notifyDesc') }}</p>

            <div class="d-flex align-center flex-wrap ga-2 mb-3">
              <v-text-field
                v-model="keywordInput"
                :placeholder="t('summary.keywordPlaceholder')"
                variant="outlined"
                density="comfortable"
                hide-details
                style="max-width: 320px; min-width: 220px"
                @keyup.enter="addKeyword"
              />
              <v-btn
                color="primary"
                variant="flat"
                prepend-icon="mdi-plus"
                :loading="savingKeywords"
                @click="addKeyword"
              >
                {{ t('summary.addKeyword') }}
              </v-btn>
            </div>

            <div class="d-flex flex-wrap ga-2 mb-4">
              <v-chip
                v-for="keyword in notifyForm.notifyKeywords"
                :key="keyword"
                color="primary"
                variant="tonal"
                closable
                @click:close="removeKeyword(keyword)"
              >
                {{ keyword }}
              </v-chip>
              <span v-if="notifyForm.notifyKeywords.length === 0" class="text-caption muted">
                {{ t('summary.noKeywords') }}
              </span>
            </div>

            <v-divider class="mb-4" />

            <div class="text-subtitle-2 font-weight-bold mb-1">{{ t('summary.quietTitle') }}</div>
            <p class="text-caption muted mb-3">{{ t('summary.quietDesc') }}</p>

            <div class="d-flex align-center flex-wrap ga-3">
              <v-text-field
                v-model="quietStart"
                type="time"
                :label="t('summary.quietStart')"
                variant="outlined"
                density="comfortable"
                hide-details
                style="max-width: 170px"
              />
              <v-text-field
                v-model="quietEnd"
                type="time"
                :label="t('summary.quietEnd')"
                variant="outlined"
                density="comfortable"
                hide-details
                style="max-width: 170px"
              />
              <v-btn color="primary" variant="flat" :loading="savingQuiet" @click="saveQuiet">
                {{ t('summary.saveQuiet') }}
              </v-btn>
              <v-btn variant="text" :disabled="!quietActive" :loading="savingQuiet" @click="disableQuiet">
                {{ t('summary.disableQuiet') }}
              </v-btn>
              <v-chip size="small" variant="tonal" :color="quietActive ? 'success' : 'default'">
                {{ quietActive ? `${notifyForm.quietHours?.start} – ${notifyForm.quietHours?.end}` : t('summary.quietOff') }}
              </v-chip>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>
