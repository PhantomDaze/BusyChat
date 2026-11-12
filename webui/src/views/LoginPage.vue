<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';

import { api } from '@/api';
import { ApiError } from '@/api/client';
import LanguageSwitcher from '@/components/shared/LanguageSwitcher.vue';
import ThemeSwitcher from '@/components/shared/ThemeSwitcher.vue';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/toast';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const app = useAppStore();
const auth = useAuthStore();
const toast = useToastStore();

const password = ref('');
const showPassword = ref(false);
const loading = ref(false);
const checking = ref(true);
const error = ref('');
const noPasswordConfigured = ref(false);

const redirectTarget = computed(() => {
  const raw = route.query.redirect;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.startsWith('/') ? value : '/welcome';
});

async function enter(): Promise<void> {
  await router.replace(redirectTarget.value);
}

onMounted(async () => {
  // 没有设置密码时 /api/state 直接可读，跳过登录页
  try {
    await app.load();
    await enter();
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 401) {
      // 需要登录
    } else if (caught instanceof ApiError) {
      error.value = caught.message;
    } else {
      error.value = caught instanceof Error ? caught.message : String(caught);
    }
  } finally {
    checking.value = false;
  }
});

async function submit(): Promise<void> {
  error.value = '';
  if (!password.value) {
    error.value = t('login.required');
    return;
  }
  loading.value = true;
  try {
    const result = await api.login(password.value);
    auth.remember(result.token);
    await app.load();
    toast.success(t('login.submit'));
    await enter();
  } catch (caught) {
    if (caught instanceof ApiError) {
      if (caught.status === 401) error.value = t('login.wrongPassword');
      else if (caught.status === 429) error.value = t('login.rateLimited');
      else if (caught.status === 400) {
        noPasswordConfigured.value = true;
        error.value = '';
      } else error.value = caught.message;
    } else {
      error.value = caught instanceof Error ? caught.message : String(caught);
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth-shell">
    <div style="position: fixed; top: 12px; right: 12px; display: flex; gap: 4px">
      <ThemeSwitcher />
      <LanguageSwitcher />
    </div>

    <v-card class="auth-card" elevation="0">
      <div class="auth-brand">
        <v-icon color="primary" size="32">mdi-robot-happy-outline</v-icon>
        <span>{{ t('login.title') }}</span>
      </div>
      <p class="text-body-2 muted mb-6">{{ t('login.subtitle') }}</p>

      <div v-if="checking" class="d-flex align-center ga-3 py-6">
        <v-progress-circular indeterminate color="primary" size="22" />
        <span class="text-body-2 muted">{{ t('app.loading') }}</span>
      </div>

      <template v-else>
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          density="compact"
          class="mb-4"
          :text="error"
        />

        <v-alert
          v-if="noPasswordConfigured"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-4"
        >
          <div class="font-weight-medium">{{ t('login.noPasswordTitle') }}</div>
          <div class="text-body-2 mt-1">{{ t('login.noPasswordBody') }}</div>
        </v-alert>

        <v-form @submit.prevent="submit">
          <v-text-field
            v-model="password"
            :label="t('login.password')"
            :placeholder="t('login.passwordPlaceholder')"
            :type="showPassword ? 'text' : 'password'"
            prepend-inner-icon="mdi-lock-outline"
            :append-inner-icon="showPassword ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
            variant="outlined"
            density="comfortable"
            autocomplete="current-password"
            autofocus
            @click:append-inner="showPassword = !showPassword"
          />

          <v-btn
            type="submit"
            color="primary"
            variant="flat"
            block
            size="large"
            class="mt-2"
            :loading="loading"
            :disabled="noPasswordConfigured"
          >
            {{ loading ? t('login.submitting') : t('login.submit') }}
          </v-btn>
        </v-form>

        <v-btn
          v-if="noPasswordConfigured"
          variant="tonal"
          color="primary"
          block
          class="mt-3"
          @click="enter"
        >
          {{ t('login.noPasswordButton') }}
        </v-btn>

        <p class="text-caption muted mt-5" style="line-height: 1.5">{{ t('login.tokenHint') }}</p>
      </template>

      <v-divider class="my-5" />
      <div class="text-caption muted text-center">{{ t('login.footer') }}</div>
    </v-card>
  </div>
</template>
