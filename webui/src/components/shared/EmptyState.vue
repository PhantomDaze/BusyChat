<script setup lang="ts">
withDefaults(
  defineProps<{
    icon?: string;
    text: string;
    hint?: string;
  }>(),
  { icon: 'mdi-inbox-outline', hint: '' },
);
</script>

<template>
  <div class="d-flex flex-column align-center justify-center text-center py-10 px-4">
    <v-icon size="44" color="grey-lighten-1">{{ icon }}</v-icon>
    <div class="mt-3 text-body-2 font-weight-medium">{{ text }}</div>
    <div v-if="hint" class="text-caption muted mt-1">{{ hint }}</div>
    <div v-if="$slots.default" class="mt-3">
      <slot />
    </div>
  </div>
</template>
