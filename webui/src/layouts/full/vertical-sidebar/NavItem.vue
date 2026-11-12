<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';

import type { NavEntry } from './sidebarItem';

const props = defineProps<{ item: NavEntry; rail: boolean }>();
const { t } = useI18n();
const route = useRoute();

const title = computed(() => (props.item.title ? t(props.item.title) : ''));
const active = computed(() => {
  const target = props.item.to;
  if (!target) return false;
  const path = route.path.replace(/\/$/, '') || '/';
  return path === target || path.startsWith(`${target}/`);
});
</script>

<template>
  <v-tooltip v-if="rail" location="right" :text="title" open-delay="180">
    <template #activator="{ props: tooltipProps }">
      <v-list-item
        v-bind="tooltipProps"
        :to="item.to"
        :active="active"
        color="primary"
        rounded
        class="mb-1"
        :aria-label="title"
      >
        <template #prepend>
          <v-icon v-if="item.icon" :icon="item.icon" size="22" />
        </template>
        <v-list-item-title>{{ title }}</v-list-item-title>
      </v-list-item>
    </template>
  </v-tooltip>

  <v-list-item v-else :to="item.to" :active="active" color="primary" rounded class="mb-1">
    <template #prepend>
      <v-icon v-if="item.icon" :icon="item.icon" size="22" />
    </template>
    <v-list-item-title>{{ title }}</v-list-item-title>
    <template v-if="item.chip" #append>
      <v-chip size="x-small" color="primary" variant="flat">{{ item.chip }}</v-chip>
    </template>
  </v-list-item>
</template>
