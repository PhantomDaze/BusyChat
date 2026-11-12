<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '@/api';
import type { KnowledgeEntry, KnowledgeSearchResult } from '@/api/types';
import EmptyState from '@/components/shared/EmptyState.vue';
import PageHeader from '@/components/shared/PageHeader.vue';
import { useAppStore } from '@/stores/app';
import { useConfirmStore } from '@/stores/confirm';
import { useToastStore } from '@/stores/toast';
import { formatDateTime, truncate } from '@/utils/format';

const { t } = useI18n();
const app = useAppStore();
const confirm = useConfirmStore();
const toast = useToastStore();

const entries = ref<KnowledgeEntry[]>([]);
const loading = ref(false);
const loadError = ref('');

const searchQuery = ref('');
const searching = ref(false);
const searchResults = ref<KnowledgeSearchResult[] | null>(null);

const settings = reactive({
  enabled: true,
  maxResults: 10,
  vectorDimension: '' as string | number,
});
const savingSettings = ref(false);

const addDialog = ref(false);
const addText = ref('');
const adding = ref(false);

const summarizing = ref(false);
const summaryDialog = ref(false);
const summaryText = ref('');

const displayedEntries = computed(() => entries.value);

function metadataLabel(entry: KnowledgeEntry): string {
  const parts: string[] = [entry.metadata?.type ?? 'user'];
  if (entry.metadata?.source) parts.push(entry.metadata.source);
  return parts.join(' · ');
}

async function refreshEntries(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const result = await api.knowledge.list(50);
    entries.value = result.items ?? [];
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadSettings(): Promise<void> {
  try {
    const result = await api.knowledge.settings();
    settings.enabled = result.enabled !== false;
    settings.maxResults = result.maxResults ?? 10;
    settings.vectorDimension =
      result.vectorDimension === null || result.vectorDimension === undefined
        ? ''
        : result.vectorDimension;
  } catch {
    // 插件未启用时没有设置接口，保持默认值
  }
}

async function runSearch(): Promise<void> {
  const query = searchQuery.value.trim();
  if (!query) {
    searchResults.value = null;
    return;
  }
  searching.value = true;
  try {
    const result = await api.knowledge.search(query, settings.maxResults);
    searchResults.value = result.results ?? [];
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    searching.value = false;
  }
}

function clearSearch(): void {
  searchQuery.value = '';
  searchResults.value = null;
}

async function addEntry(): Promise<void> {
  const text = addText.value.trim();
  if (!text) return;
  adding.value = true;
  try {
    await api.knowledge.add(text);
    addText.value = '';
    addDialog.value = false;
    await refreshEntries();
    await app.load();
    toast.success(t('knowledge.addSuccess'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    adding.value = false;
  }
}

async function removeEntry(entry: KnowledgeEntry): Promise<void> {
  const ok = await confirm.ask({
    title: t('common.delete'),
    message: t('knowledge.deleteConfirm'),
    confirmText: t('common.delete'),
  });
  if (!ok) return;
  try {
    const result = await api.knowledge.remove(entry.id);
    if (result?.deleted) {
      toast.success(t('knowledge.deleted'));
      await refreshEntries();
      await app.load();
    } else {
      toast.warning(t('knowledge.notFound'));
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function saveSettings(): Promise<void> {
  savingSettings.value = true;
  try {
    const dimension = String(settings.vectorDimension).trim();
    await api.knowledge.saveSettings({
      enabled: settings.enabled,
      maxResults: Number(settings.maxResults) || 10,
      vectorDimension: dimension === '' ? null : Number(dimension) || null,
    });
    await app.load();
    toast.success(t('knowledge.settingsSaved'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    savingSettings.value = false;
  }
}

async function summarize(): Promise<void> {
  summarizing.value = true;
  try {
    const result = await api.knowledge.summarize();
    if (result?.text) {
      summaryText.value = result.text;
      summaryDialog.value = true;
      toast.success(t('knowledge.summarizeSuccess'));
      await refreshEntries();
    } else {
      toast.warning(t('knowledge.summarizeEmpty'));
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    summarizing.value = false;
  }
}

onMounted(async () => {
  await Promise.all([refreshEntries(), loadSettings()]);
});
</script>

<template>
  <div>
    <PageHeader :title="t('knowledge.title')" :subtitle="t('knowledge.subtitle')" icon="mdi-book-open-variant">
      <template #actions>
        <v-chip size="small" variant="tonal" color="primary">
          {{ t('knowledge.entries', { count: entries.length }) }}
        </v-chip>
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="mdi-file-document-refresh-outline"
          :loading="summarizing"
          @click="summarize"
        >
          {{ summarizing ? t('knowledge.summarizing') : t('knowledge.summarize') }}
        </v-btn>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-plus"
          @click="addDialog = true"
        >
          {{ t('knowledge.add') }}
        </v-btn>
      </template>
    </PageHeader>

    <v-row dense>
      <v-col cols="12" md="8">
        <v-card
          elevation="0"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-text class="pb-2">
            <div class="d-flex align-center ga-2 flex-wrap">
              <v-text-field
                v-model="searchQuery"
                density="comfortable"
                variant="outlined"
                hide-details
                prepend-inner-icon="mdi-magnify"
                :placeholder="t('knowledge.searchPlaceholder')"
                style="min-width: 240px; flex: 1 1 320px"
                @keyup.enter="runSearch"
              />
              <v-btn
                color="primary"
                variant="flat"
                :loading="searching"
                @click="runSearch"
              >
                {{ searching ? t('knowledge.searching') : t('knowledge.search') }}
              </v-btn>
              <v-btn v-if="searchResults" variant="text" @click="clearSearch">
                {{ t('knowledge.clearSearch') }}
              </v-btn>
              <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="refreshEntries">
                {{ t('knowledge.refresh') }}
              </v-btn>
            </div>
          </v-card-text>

          <v-card-text class="pt-2">
            <v-alert
              v-if="loadError"
              type="warning"
              variant="tonal"
              density="compact"
              class="mb-3"
            >
              {{ t('knowledge.loadFailed', { message: loadError }) }}
            </v-alert>

            <EmptyState
              v-if="displayedEntries.length === 0 && !searchResults"
              icon="mdi-book-open-variant"
              :text="t('knowledge.empty')"
            />

            <template v-if="searchResults">
              <div class="text-subtitle-2 font-weight-bold mb-2">
                {{ t('knowledge.results') }} ({{ searchResults.length }})
              </div>
              <div
                v-for="result in searchResults"
                :key="result.entry.id"
                class="list-row"
              >
                <div class="d-flex align-start ga-3">
                  <div class="min-w-0 flex-grow-1">
                    <div class="text-body-2">{{ truncate(result.entry.text, 320) }}</div>
                    <div class="list-sub mt-1">
                      {{ formatDateTime(result.entry.createdAt) }} ·
                      {{ metadataLabel(result.entry) }} ·
                      {{ t('knowledge.similarity', { score: result.similarityScore.toFixed(3) }) }}
                    </div>
                  </div>
                  <v-btn
                    icon="mdi-trash-can-outline"
                    size="small"
                    variant="text"
                    color="error"
                    @click="removeEntry(result.entry)"
                  />
                </div>
              </div>
              <EmptyState
                v-if="searchResults.length === 0"
                icon="mdi-magnify-close"
                :text="t('knowledge.empty')"
              />
            </template>

            <template v-else>
              <div v-for="entry in displayedEntries" :key="entry.id" class="list-row">
                <div class="d-flex align-start ga-3">
                  <v-icon size="18" color="primary" class="mt-1">mdi-text-box-outline</v-icon>
                  <div class="min-w-0 flex-grow-1">
                    <div class="text-body-2">{{ truncate(entry.text, 320) }}</div>
                    <div class="list-sub mt-1">
                      {{ formatDateTime(entry.createdAt) }} · {{ metadataLabel(entry) }}
                    </div>
                  </div>
                  <v-btn
                    icon="mdi-trash-can-outline"
                    size="small"
                    variant="text"
                    color="error"
                    @click="removeEntry(entry)"
                  />
                </div>
              </div>
            </template>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="4">
        <v-card
          elevation="0"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-title class="px-5 pt-4 text-subtitle-1 font-weight-bold">
            {{ t('knowledge.settingsTitle') }}
          </v-card-title>
          <v-card-text class="px-5">
            <p class="text-caption muted mb-4">{{ t('knowledge.settingsDesc') }}</p>

            <v-switch
              v-model="settings.enabled"
              color="primary"
              :label="t('knowledge.enabled')"
              inset
              hide-details
              class="mb-4"
            />

            <v-text-field
              v-model.number="settings.maxResults"
              type="number"
              min="1"
              :label="t('knowledge.maxResults')"
              variant="outlined"
              density="comfortable"
              class="mb-3"
            />

            <v-text-field
              v-model="settings.vectorDimension"
              type="number"
              min="1"
              :label="t('knowledge.vectorDimension')"
              :hint="t('knowledge.dimensionHint')"
              persistent-hint
              variant="outlined"
              density="comfortable"
              class="mb-4"
            />

            <v-btn
              color="primary"
              variant="flat"
              block
              :loading="savingSettings"
              @click="saveSettings"
            >
              {{ t('knowledge.saveSettings') }}
            </v-btn>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-dialog v-model="addDialog" max-width="520">
      <v-card>
        <v-card-title class="text-subtitle-1 font-weight-bold">
          {{ t('knowledge.addTitle') }}
        </v-card-title>
        <v-card-text>
          <v-textarea
            v-model="addText"
            :placeholder="t('knowledge.addPlaceholder')"
            variant="outlined"
            rows="4"
            autofocus
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="addDialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="adding" @click="addEntry">
            {{ t('common.add') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="summaryDialog" max-width="560">
      <v-card>
        <v-card-title class="text-subtitle-1 font-weight-bold">
          {{ t('knowledge.summarize') }}
        </v-card-title>
        <v-card-text class="text-body-2" style="white-space: pre-wrap">
          {{ summaryText }}
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="summaryDialog = false">{{ t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
