<script setup lang="ts">
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useDisplay } from 'vuetify';

import { useAppStore } from '@/stores/app';
import { useCustomizerStore } from '@/stores/customizer';
import NavItem from './NavItem.vue';
import { sidebarItems } from './sidebarItem';

const { t } = useI18n();
const { lgAndUp } = useDisplay();
const route = useRoute();
const customizer = useCustomizerStore();
const app = useAppStore();

const rail = computed(() => lgAndUp.value && customizer.miniSidebar);
const version = computed(() => app.version);

// 移动端抽屉不常驻：点击导航跳转后自动收起
watch(
  () => route.fullPath,
  () => {
    if (!lgAndUp.value) customizer.setSidebarDrawer(false);
  },
);
</script>

<template>
  <v-navigation-drawer
    v-model="customizer.drawer"
    :rail="rail"
    :permanent="lgAndUp"
    :temporary="!lgAndUp"
    width="235"
    class="leftSidebar"
  >
    <div class="sidebar-container">
      <div class="d-flex align-center ga-2 px-4 py-4">
        <v-icon color="primary" size="28">mdi-robot-happy-outline</v-icon>
        <div v-if="!rail" class="min-w-0">
          <div class="text-subtitle-1 font-weight-bold" style="line-height: 1.2">
            {{ t('app.name') }}
          </div>
          <div class="text-caption muted" style="line-height: 1.2">
            {{ t('app.subtitle') }}
          </div>
        </div>
      </div>

      <v-divider />

      <div class="sidebar-scroll">
        <v-list nav density="compact">
          <template v-for="(item, index) in sidebarItems" :key="item.header ?? item.to ?? index">
            <v-list-subheader v-if="item.header && !rail">
              {{ t(item.header) }}
            </v-list-subheader>
            <v-divider v-else-if="item.header && rail" class="my-2 mx-3" />
            <NavItem v-else :item="item" :rail="rail" />
          </template>
        </v-list>
      </div>

      <div class="sidebar-footer">
        <div v-if="!rail" class="d-flex align-center justify-space-between text-caption muted">
          <span>AGPL-3.0-or-later</span>
          <span v-if="version">v{{ version }}</span>
        </div>
        <div v-else class="d-flex justify-center">
          <v-icon size="18" color="primary">mdi-shield-check-outline</v-icon>
        </div>
      </div>
    </div>
  </v-navigation-drawer>
</template>
