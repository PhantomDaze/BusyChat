<script setup lang="ts">
withDefaults(
  defineProps<{
    icon: string;
    label: string;
    value: string | number;
    hint?: string;
    color?: string;
  }>(),
  { color: 'primary', hint: '' },
);
</script>

<template>
  <v-card
    class="stat-card"
    elevation="0"
    variant="flat"
    style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
  >
    <v-card-text class="d-flex align-center ga-3 py-4">
      <v-avatar :color="color" variant="tonal" size="42" rounded="lg">
        <v-icon size="22">{{ icon }}</v-icon>
      </v-avatar>
      <div class="min-w-0">
        <div class="stat-value">{{ value }}</div>
        <div class="stat-label">{{ label }}</div>
        <div v-if="hint" class="text-caption muted text-truncate">{{ hint }}</div>
      </div>
    </v-card-text>
  </v-card>
</template>
