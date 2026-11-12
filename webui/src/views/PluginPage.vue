<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '@/api';
import type { PluginInfo } from '@/api/types';
import EmptyState from '@/components/shared/EmptyState.vue';
import PageHeader from '@/components/shared/PageHeader.vue';
import { useAppStore } from '@/stores/app';
import { useToastStore } from '@/stores/toast';

const { t } = useI18n();
const app = useAppStore();
const toast = useToastStore();

const search = ref('');
const reloading = ref(false);
const toggling = reactive<Record<string, boolean>>({});

const plugins = computed<PluginInfo[]>(() => app.plugins);

const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  if (!keyword) return plugins.value;
  return plugins.value.filter(
    (plugin) =>
      plugin.name.toLowerCase().includes(keyword) ||
      (plugin.description ?? '').toLowerCase().includes(keyword),
  );
});

function isBuiltin(plugin: PluginInfo): boolean {
  return plugin.name.startsWith('builtin-') || plugin.name.startsWith('sample-');
}

function pluginIcon(plugin: PluginInfo): string {
  if (plugin.name.includes('notify')) return 'mdi-bell-ring-outline';
  if (plugin.name.includes('knowledge')) return 'mdi-book-open-variant';
  if (plugin.name.includes('reply')) return 'mdi-message-reply-text-outline';
  if (plugin.name.includes('summary')) return 'mdi-file-document-outline';
  if (plugin.name.includes('command')) return 'mdi-console-line';
  return 'mdi-puzzle-outline';
}

async function reload(): Promise<void> {
  reloading.value = true;
  try {
    await api.reloadPlugins();
    await app.load();
    toast.success(t('plugins.reloaded'));
  } catch (error) {
    toast.error(t('plugins.reloadFailed', { message: error instanceof Error ? error.message : String(error) }));
  } finally {
    reloading.value = false;
  }
}

async function setEnabled(plugin: PluginInfo, enabled: boolean): Promise<void> {
  toggling[plugin.name] = true;
  try {
    await api.setPluginEnabled(plugin.name, enabled);
    await app.load();
    toast.success(
      t('plugins.toggleSuccess', {
        name: plugin.name,
        status: enabled ? t('common.enabled') : t('common.disabled'),
      }),
    );
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    toggling[plugin.name] = false;
  }
}
</script>

<template>
  <div>
    <PageHeader :title="t('plugins.title')" :subtitle="t('plugins.subtitle')" icon="mdi-puzzle-outline">
      <template #actions>
        <v-chip variant="tonal" color="primary" size="small">
          {{ t('plugins.enabledCount', { enabled: app.enabledPluginCount, total: plugins.length }) }}
        </v-chip>
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-restart"
          :loading="reloading"
          @click="reload"
        >
          {{ t('plugins.reload') }}
        </v-btn>
      </template>
    </PageHeader>

    <v-text-field
      v-model="search"
      class="mb-4"
      style="max-width: 420px"
      density="comfortable"
      variant="outlined"
      hide-details
      prepend-inner-icon="mdi-magnify"
      :placeholder="t('plugins.searchPlaceholder')"
      clearable
    />

    <EmptyState
      v-if="app.loaded && filtered.length === 0"
      icon="mdi-puzzle-outline"
      :text="t('plugins.empty')"
    />

    <v-row v-else dense>
      <v-col v-for="plugin in filtered" :key="plugin.name" cols="12" sm="6" lg="4">
        <v-card
          class="h-100 d-flex flex-column"
          elevation="0"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-text class="flex-grow-1 pb-2">
            <div class="d-flex align-start ga-3">
              <v-avatar size="40" rounded="lg" variant="tonal" color="primary">
                <v-icon size="21">{{ pluginIcon(plugin) }}</v-icon>
              </v-avatar>
              <div class="min-w-0 flex-grow-1">
                <div class="d-flex align-center ga-2 flex-wrap">
                  <span class="text-subtitle-1 font-weight-bold text-truncate">{{ plugin.name }}</span>
                  <v-chip size="x-small" variant="tonal" :color="isBuiltin(plugin) ? 'primary' : 'secondary'">
                    {{ isBuiltin(plugin) ? t('plugins.builtin') : t('plugins.external') }}
                  </v-chip>
                  <v-chip size="x-small" variant="outlined">v{{ plugin.version }}</v-chip>
                </div>
                <div class="text-caption muted mt-1">
                  {{ plugin.description || t('plugins.noDescription') }}
                </div>
              </div>
              <v-switch
                :model-value="plugin.enabled"
                :loading="Boolean(toggling[plugin.name])"
                density="compact"
                color="primary"
                hide-details
                inset
                @update:model-value="(value) => setEnabled(plugin, Boolean(value))"
              />
            </div>

            <div v-if="plugin.permissions && plugin.permissions.length > 0" class="mt-3">
              <div class="text-caption muted mb-1">{{ t('plugins.permissions') }}</div>
              <div class="d-flex flex-wrap ga-1">
                <v-chip
                  v-for="permission in plugin.permissions"
                  :key="permission"
                  size="x-small"
                  variant="tonal"
                  color="info"
                >
                  {{ permission }}
                </v-chip>
              </div>
            </div>
          </v-card-text>

          <v-card-text class="pt-0 d-flex align-center justify-space-between">
            <span class="text-caption" :class="plugin.enabled ? 'text-success' : 'muted'">
              <v-icon size="14" class="me-1" :color="plugin.enabled ? 'success' : undefined">
                {{ plugin.enabled ? 'mdi-check-circle-outline' : 'mdi-pause-circle-outline' }}
              </v-icon>
              {{ plugin.enabled ? t('common.enabled') : t('common.disabled') }}
            </span>
            <v-tooltip v-if="plugin.filePath" location="top">
              <template #activator="{ props: tooltipProps }">
                <v-icon v-bind="tooltipProps" size="16" class="muted">mdi-file-code-outline</v-icon>
              </template>
              <span class="mono text-caption">{{ plugin.filePath }}</span>
            </v-tooltip>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>
