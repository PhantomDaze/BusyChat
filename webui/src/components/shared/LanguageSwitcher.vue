<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { SUPPORTED_LOCALES, currentLocale, setLocale, type LocaleCode } from '@/i18n';

const { t } = useI18n();

const locales = computed(() => SUPPORTED_LOCALES);
const active = computed(() => currentLocale());

function choose(code: LocaleCode): void {
  setLocale(code);
}
</script>

<template>
  <v-menu offset="8" location="bottom end">
    <template #activator="{ props: activatorProps }">
      <v-btn
        v-bind="activatorProps"
        icon
        variant="text"
        :title="t('header.language')"
        :aria-label="t('header.language')"
      >
        <v-icon>mdi-translate</v-icon>
      </v-btn>
    </template>
    <v-list density="compact" min-width="150">
      <v-list-item
        v-for="locale in locales"
        :key="locale.code"
        :title="locale.label"
        @click="choose(locale.code)"
      >
        <template #append>
          <v-icon v-if="active === locale.code" size="18" color="primary">mdi-check</v-icon>
        </template>
      </v-list-item>
    </v-list>
  </v-menu>
</template>
