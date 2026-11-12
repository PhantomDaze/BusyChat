<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '@/api';
import type { PendingReply } from '@/api/types';
import EmptyState from '@/components/shared/EmptyState.vue';
import PageHeader from '@/components/shared/PageHeader.vue';
import { useToastStore } from '@/stores/toast';
import { formatDateTime } from '@/utils/format';

const { t } = useI18n();
const toast = useToastStore();

const items = ref<PendingReply[]>([]);
const loading = ref(false);
const generatingId = ref('');
const dismissingId = ref('');
const instructions = reactive<Record<string, string>>({});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.reply.pending();
    items.value = result.items ?? [];
    for (const item of items.value) {
      if (!(item.id in instructions)) instructions[item.id] = '';
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function generate(item: PendingReply): Promise<void> {
  const instruction = (instructions[item.id] ?? '').trim();
  if (!instruction) {
    toast.warning(t('reply.instructionRequired'));
    return;
  }
  generatingId.value = item.id;
  try {
    const result = await api.reply.generate(item.id, instruction);
    toast.success(t('reply.generated', { target: result.target }));
    delete instructions[item.id];
    await load();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    generatingId.value = '';
  }
}

async function dismiss(item: PendingReply): Promise<void> {
  dismissingId.value = item.id;
  try {
    await api.reply.dismiss(item.id);
    toast.success(t('reply.dismissed'));
    delete instructions[item.id];
    await load();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    dismissingId.value = '';
  }
}

function scopeLabel(item: PendingReply): string {
  return item.scope === 'group' ? t('reply.scopeGroup') : t('reply.scopePrivate');
}

onMounted(load);
</script>

<template>
  <div>
    <PageHeader :title="t('reply.title')" :subtitle="t('reply.subtitle')" icon="mdi-message-reply-text-outline">
      <template #actions>
        <v-chip size="small" variant="tonal" color="primary">
          {{ t('reply.pendingCount', { count: items.length }) }}
        </v-chip>
        <v-btn variant="tonal" color="primary" prepend-icon="mdi-refresh" :loading="loading" @click="load">
          {{ t('reply.refresh') }}
        </v-btn>
      </template>
    </PageHeader>

    <v-card
      v-if="items.length === 0"
      elevation="0"
      style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
    >
      <EmptyState icon="mdi-message-check-outline" :text="t('reply.empty')" />
    </v-card>

    <v-row v-else dense>
      <v-col v-for="item in items" :key="item.id" cols="12" lg="6">
        <v-card
          elevation="0"
          class="h-100 d-flex flex-column"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-text class="pb-2">
            <div class="d-flex align-center ga-2 flex-wrap">
              <v-avatar size="32" rounded="lg" variant="tonal" color="primary">
                <v-icon size="17">
                  {{ item.scope === 'group' ? 'mdi-account-group-outline' : 'mdi-account-outline' }}
                </v-icon>
              </v-avatar>
              <div class="min-w-0">
                <div class="text-body-2 font-weight-bold text-truncate">
                  {{ t('reply.sender', { name: item.senderName, id: item.senderId }) }}
                </div>
                <div class="text-caption muted">
                  [{{ scopeLabel(item) }}] {{ formatDateTime(item.createdAt) }} · {{ item.idShort }}
                </div>
              </div>
            </div>

            <div class="text-body-2 mt-3" style="white-space: pre-wrap; word-break: break-word">
              {{ item.text }}
            </div>
          </v-card-text>

          <v-card-text class="pt-0 flex-grow-1">
            <v-text-field
              v-model="instructions[item.id]"
              :label="t('reply.instruction')"
              :placeholder="t('reply.instructionPlaceholder')"
              variant="outlined"
              density="comfortable"
              hide-details
              @keyup.enter="generate(item)"
            />
          </v-card-text>

          <v-card-actions class="px-4 pb-4">
            <v-btn
              color="primary"
              variant="flat"
              prepend-icon="mdi-send-outline"
              :loading="generatingId === item.id"
              @click="generate(item)"
            >
              {{ generatingId === item.id ? t('reply.generating') : t('reply.generate') }}
            </v-btn>
            <v-spacer />
            <v-btn
              variant="text"
              color="error"
              :loading="dismissingId === item.id"
              @click="dismiss(item)"
            >
              {{ t('reply.dismiss') }}
            </v-btn>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>
