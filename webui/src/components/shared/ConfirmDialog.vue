<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { useConfirmStore } from '@/stores/confirm';

const { t } = useI18n();
const confirm = useConfirmStore();

const visible = computed({
  get: () => confirm.visible,
  set: (value: boolean) => {
    if (!value) confirm.resolve(false);
  },
});
</script>

<template>
  <v-dialog v-model="visible" max-width="440" persistent>
    <v-card>
      <v-card-title class="text-h6 py-4">
        {{ confirm.options.title || t('common.confirm') }}
      </v-card-title>
      <v-card-text class="text-body-2" style="white-space: pre-wrap">
        {{ confirm.options.message }}
      </v-card-text>
      <v-card-actions class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="confirm.resolve(false)">
          {{ confirm.options.cancelText || t('common.cancel') }}
        </v-btn>
        <v-btn
          :color="confirm.options.color || 'error'"
          variant="flat"
          @click="confirm.resolve(true)"
        >
          {{ confirm.options.confirmText || t('common.confirm') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
