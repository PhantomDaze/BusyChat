<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type { ThemeMode } from '@/config';
import { useCustomizerStore } from '@/stores/customizer';

const { t } = useI18n();
const customizer = useCustomizerStore();

const options = computed(() => [
  { value: 'light' as ThemeMode, icon: 'mdi-white-balance-sunny', label: t('header.themeLight') },
  { value: 'dark' as ThemeMode, icon: 'mdi-weather-night', label: t('header.themeDark') },
  { value: 'system' as ThemeMode, icon: 'mdi-monitor-eye', label: t('header.themeSystem') },
]);

const currentIcon = computed(
  () => options.value.find((item) => item.value === customizer.themeMode)?.icon ?? 'mdi-white-balance-sunny',
);
</script>

<template>
  <v-menu offset="8" location="bottom end">
    <template #activator="{ props: activatorProps }">
      <v-btn
        v-bind="activatorProps"
        icon
        variant="text"
        :title="t('header.theme')"
        :aria-label="t('header.theme')"
      >
        <v-icon>{{ currentIcon }}</v-icon>
      </v-btn>
    </template>
    <v-list density="compact" min-width="170">
      <v-list-item
        v-for="item in options"
        :key="item.value"
        :prepend-icon="item.icon"
        :title="item.label"
        @click="customizer.setThemeMode(item.value)"
      >
        <template #append>
          <v-icon v-if="customizer.themeMode === item.value" size="18" color="primary">
            mdi-check
          </v-icon>
        </template>
      </v-list-item>
    </v-list>
  </v-menu>
</template>
