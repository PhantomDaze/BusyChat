<script setup lang="ts">
import { watch } from 'vue';
import { useDisplay } from 'vuetify';

import { useCustomizerStore } from '@/stores/customizer';
import VerticalHeader from './vertical-header/VerticalHeader.vue';
import VerticalSidebar from './vertical-sidebar/VerticalSidebar.vue';

const { lgAndUp } = useDisplay();
const customizer = useCustomizerStore();

// 桌面端默认展开侧边栏，移动端默认收起
watch(
  () => lgAndUp.value,
  (isDesktop) => customizer.setSidebarDrawer(isDesktop),
  { immediate: true },
);
</script>

<template>
  <VerticalHeader />
  <VerticalSidebar />

  <v-main>
    <v-container fluid class="page-wrapper">
      <router-view />
    </v-container>
  </v-main>
</template>
