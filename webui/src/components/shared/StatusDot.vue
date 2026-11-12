<script setup lang="ts">
withDefaults(
  defineProps<{
    online?: boolean;
    text: string;
    colored?: boolean;
  }>(),
  { online: false, colored: true },
);
</script>

<template>
  <span class="d-inline-flex align-center ga-2">
    <span
      class="status-dot"
      :style="{
        width: '9px',
        height: '9px',
        borderRadius: '50%',
        flex: '0 0 auto',
        background: online
          ? 'rgb(var(--v-theme-success))'
          : colored
            ? 'rgb(var(--v-theme-error))'
            : 'rgba(var(--v-theme-secondaryText), .4)',
        boxShadow: online ? '0 0 0 3px rgba(var(--v-theme-success), .18)' : 'none',
      }"
    />
    <span>{{ text }}</span>
  </span>
</template>
