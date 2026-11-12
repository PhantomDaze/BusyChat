<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>

<template>
  <div class="d-flex flex-column align-center justify-center text-center" style="min-height: 70vh">
    <v-icon size="64" color="grey-lighten-1">mdi-map-search-outline</v-icon>
    <h1 class="text-h5 font-weight-bold mt-4">{{ t('notfound.title') }}</h1>
    <p class="text-body-2 muted mt-2">{{ t('notfound.desc') }}</p>
    <v-btn color="primary" variant="flat" class="mt-6" :to="{ name: 'welcome' }">
      {{ t('notfound.back') }}
    </v-btn>
  </div>
</template>
