<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
  icon?: string;
}>();
</script>

<template>
  <div class="page-header">
    <div class="min-w-0">
      <div class="d-flex align-center ga-2">
        <v-icon v-if="icon" color="primary" size="24">{{ icon }}</v-icon>
        <h1 class="text-truncate">{{ title }}</h1>
      </div>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <div class="d-flex align-center ga-2 flex-wrap">
      <slot name="actions" />
    </div>
  </div>
</template>
