<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '@/api';
import type { NormalizedEvent } from '@/api/types';
import PageHeader from '@/components/shared/PageHeader.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import { useToastStore } from '@/stores/toast';
import { formatTime } from '@/utils/format';

const { t } = useI18n();
const toast = useToastStore();

const events = ref<NormalizedEvent[]>([]);
const loading = ref(false);
const lastUpdated = ref('');
const scope = ref<'all' | 'private' | 'group'>('all');
const showAdmin = ref(true);
const showBot = ref(false);
const showUser = ref(true);
const autoRefresh = ref(true);

let timer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;

const filtered = computed(() =>
  events.value.filter((event) => {
    if (scope.value !== 'all' && event.scope !== scope.value) return false;
    if (event.visibility?.fromAdmin) return showAdmin.value;
    if (event.visibility?.fromBot) return showBot.value;
    return showUser.value;
  }),
);

function conversationLabel(event: NormalizedEvent): string {
  if (event.scope === 'group') {
    const id = event.conversationId.replace('group:', '');
    return event.sender?.card ? `${id} @${event.sender.card}` : id;
  }
  return event.sender?.userId ?? '';
}

/** 取消正在进行的请求（页面隐藏/卸载或发起新一轮刷新时） */
function cancelLoad(): void {
  if (controller) {
    controller.abort();
    controller = undefined;
  }
  loading.value = false;
}

async function load(showToast = false): Promise<void> {
  cancelLoad();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  try {
    events.value = await api.events(64, current.signal);
    lastUpdated.value = formatTime(new Date().toISOString());
    if (showToast) toast.success(t('logs.refresh'));
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return;
    if (showToast) toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    if (controller === current) {
      controller = undefined;
      loading.value = false;
    }
  }
}

function startTimer(): void {
  stopTimer();
  timer = setInterval(() => {
    if (!document.hidden && !loading.value) void load();
  }, 5000);
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function handleVisibility(): void {
  if (document.hidden) {
    // 页面不可见时停止轮询并中止尚未完成的请求
    stopTimer();
    cancelLoad();
  } else if (autoRefresh.value && timer === undefined) {
    startTimer();
    void load();
  }
}

watch(autoRefresh, (enabled) => {
  if (enabled) {
    if (!document.hidden) startTimer();
  } else {
    stopTimer();
  }
});

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibility);
  void load();
  if (autoRefresh.value) startTimer();
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibility);
  stopTimer();
  cancelLoad();
});
</script>

<template>
  <div>
    <PageHeader :title="t('logs.title')" :subtitle="t('logs.subtitle')" icon="mdi-text-box-search-outline">
      <template #actions>
        <v-btn variant="tonal" color="primary" prepend-icon="mdi-refresh" :loading="loading" @click="load(true)">
          {{ t('logs.refresh') }}
        </v-btn>
      </template>
    </PageHeader>

    <v-card
      elevation="0"
      style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
    >
      <v-card-text class="pb-2">
        <div class="d-flex align-center flex-wrap ga-3">
          <v-select
            v-model="scope"
            :items="[
              { title: t('logs.scopes.all'), value: 'all' },
              { title: t('logs.scopes.private'), value: 'private' },
              { title: t('logs.scopes.group'), value: 'group' },
            ]"
            :label="t('logs.scope')"
            density="compact"
            variant="outlined"
            hide-details
            style="max-width: 160px"
          />

          <v-checkbox
            v-model="showAdmin"
            density="compact"
            hide-details
            color="primary"
            :label="t('logs.admin')"
          />
          <v-checkbox
            v-model="showBot"
            density="compact"
            hide-details
            color="primary"
            :label="t('logs.bot')"
          />
          <v-checkbox
            v-model="showUser"
            density="compact"
            hide-details
            color="primary"
            :label="t('logs.user')"
          />
          <v-switch
            v-model="autoRefresh"
            density="compact"
            hide-details
            color="primary"
            inset
            :label="t('logs.autoRefresh')"
          />

          <v-spacer />
          <v-chip size="small" variant="tonal" color="primary">
            {{ t('logs.count', { shown: filtered.length, total: events.length }) }}
          </v-chip>
          <span v-if="lastUpdated" class="text-caption muted">
            {{ lastUpdated }}
          </span>
        </div>
      </v-card-text>

      <v-divider />

      <div class="log-scroll">
        <v-table v-if="filtered.length > 0" class="log-table" density="comfortable">
          <thead>
            <tr>
              <th style="width: 96px">{{ t('logs.time') }}</th>
              <th style="width: 150px">{{ t('logs.conversation') }}</th>
              <th style="width: 150px">{{ t('logs.sender') }}</th>
              <th>{{ t('logs.content') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in filtered" :key="event.id">
              <td class="mono">{{ formatTime(event.receivedAt) }}</td>
              <td>
                <span class="text-caption">
                  [{{ event.scope === 'group' ? t('logs.scopes.group') : t('logs.scopes.private') }}]
                  {{ conversationLabel(event) }}
                </span>
              </td>
              <td>
                <div class="d-flex align-center ga-1 flex-wrap">
                  <span class="text-body-2">
                    {{ event.sender?.nickname || event.sender?.userId || '?' }}
                  </span>
                  <v-chip
                    v-if="event.visibility?.fromAdmin"
                    size="x-small"
                    variant="tonal"
                    color="primary"
                  >
                    {{ t('logs.flagAdmin') }}
                  </v-chip>
                  <v-chip v-if="event.visibility?.fromBot" size="x-small" variant="tonal" color="secondary">
                    {{ t('logs.flagBot') }}
                  </v-chip>
                </div>
              </td>
              <td class="text-body-2" style="word-break: break-word">
                {{ event.content?.text || t('common.empty') }}
              </td>
            </tr>
          </tbody>
        </v-table>

        <EmptyState v-else icon="mdi-message-outline" :text="t('logs.empty')" />
      </div>
    </v-card>
  </div>
</template>
