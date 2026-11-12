<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave } from 'vue-router';

import { api } from '@/api';
import type {
  ModelCatalogEntry,
  ModelConfig,
  ModelFamily,
  ModelFieldMeta,
  ModelTask,
  ModelProbePayload,
  ModelProbeResult,
  ModelFetchResult,
} from '@/api/types';
import EmptyState from '@/components/shared/EmptyState.vue';
import PageHeader from '@/components/shared/PageHeader.vue';
import { useAppStore } from '@/stores/app';
import { useConfirmStore } from '@/stores/confirm';
import { useToastStore } from '@/stores/toast';

const { t } = useI18n();
const app = useAppStore();
const confirm = useConfirmStore();
const toast = useToastStore();

const REDACTED = '__redacted__';

interface ModelFormState {
  id: string;
  label: string;
  family: ModelFamily;
  provider: string;
  enabled: boolean;
  taskBindings: ModelTask[];
  parameters: Record<string, unknown>;
}

const form = reactive<ModelFormState>({
  id: '',
  label: '',
  family: 'language',
  provider: 'openai-compatible',
  enabled: true,
  taskBindings: [],
  parameters: {},
});

const search = ref('');
const editingId = ref('');
const isNew = ref(false);
const saving = ref(false);
const testing = ref(false);
const fetching = ref(false);
const secretFields = ref<Set<string>>(new Set());
const hiddenSecrets = reactive<Record<string, boolean>>({});
const savedSignature = ref('');

const remoteDialog = ref(false);
const remoteLoading = ref(false);
const remoteModels = ref<string[]>([]);

const activateTask = ref<ModelTask>('summary');
const activateModelId = ref('');
const activating = ref(false);

const models = computed(() => app.models);
const filteredModels = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  if (!keyword) return models.value;
  return models.value.filter(
    (model) =>
      model.id.toLowerCase().includes(keyword) ||
      (model.label ?? '').toLowerCase().includes(keyword) ||
      model.family.toLowerCase().includes(keyword),
  );
});

const familyOptions = computed(() =>
  app.families.map((family) => ({
    title: t(`providers.families.${family}`),
    value: family,
  })),
);

const providerOptions = computed(() => {
  const providers = new Set(app.modelSchema.map((schema) => schema.provider));
  providers.add('openai-compatible');
  providers.add('rule-based');
  return [...providers].map((provider) => ({ title: provider, value: provider }));
});

const schemaFields = computed<ModelFieldMeta[]>(() => {
  const schema = app.modelSchema.find(
    (item) => item.provider === form.provider && item.family === form.family,
  );
  return schema?.fields ?? [];
});

const enabledModels = computed(() => models.value.filter((model) => model.enabled));

const taskBindings = computed(() =>
  app.tasks.map((task) => ({
    task,
    modelId: app.activeModels[task] ?? '',
  })),
);

const isEditingVisible = computed(() => isNew.value || Boolean(editingId.value));

/** 表单是否与最后一次加载/保存的值不同（用于「未保存」提示） */
const formDirty = computed(() => JSON.stringify(buildModel()) !== savedSignature.value);

function formatFamily(family: string): string {
  return t(`providers.families.${family}`);
}

function applyDefaults(): void {
  if (!isNew.value) return;
  for (const field of schemaFields.value) {
    if (!(field.key in form.parameters) && field.default !== undefined) {
      form.parameters[field.key] = field.default;
    }
  }
}

function loadModel(model?: ModelCatalogEntry | null): void {
  const secrets = new Set<string>();
  if (model) {
    editingId.value = model.id;
    isNew.value = false;
    form.id = model.id;
    form.label = model.label ?? '';
    form.family = model.family;
    form.provider = model.provider;
    form.enabled = model.enabled;
    form.taskBindings = [...model.taskBindings];
    form.parameters = { ...(model.parameters ?? {}) };
    for (const [key, value] of Object.entries(form.parameters)) {
      if (value === REDACTED) secrets.add(key);
    }
  } else {
    editingId.value = '';
    isNew.value = true;
    form.id = '';
    form.label = '';
    form.family = 'language';
    form.provider = 'openai-compatible';
    form.enabled = true;
    form.taskBindings = [];
    form.parameters = {};
  }
  secretFields.value = secrets;
  for (const key of Object.keys(hiddenSecrets)) delete hiddenSecrets[key];
  if (isNew.value) applyDefaults();
  savedSignature.value = JSON.stringify(buildModel());
}

async function confirmDiscard(): Promise<boolean> {
  if (!formDirty.value) return true;
  return confirm.ask({
    title: t('providers.unsaved'),
    message: t('providers.discardConfirm'),
    confirmText: t('common.confirm'),
    color: 'warning',
  });
}

async function selectModel(model: ModelCatalogEntry): Promise<void> {
  if (model.id === editingId.value) return;
  if (!(await confirmDiscard())) return;
  loadModel(model);
}

async function newModel(): Promise<void> {
  if (!(await confirmDiscard())) return;
  loadModel(null);
}

/** 重置按钮：已保存的模型回到服务端值，新建表单清空 */
function resetForm(): void {
  if (editingId.value) {
    loadModel(app.models.find((model) => model.id === editingId.value) ?? null);
  } else {
    loadModel(null);
  }
}

// 切换 family/provider 时补齐新 schema 的默认值
watch(
  () => [form.family, form.provider],
  () => {
    if (!isNew.value) return;
    for (const field of schemaFields.value) {
      if (!(field.key in form.parameters) && field.default !== undefined) {
        form.parameters[field.key] = field.default;
      }
    }
  },
);

function passwordValue(field: ModelFieldMeta): string {
  const value = form.parameters[field.key];
  if (value === REDACTED) return '';
  return value === undefined || value === null ? '' : String(value);
}

function onPasswordInput(field: ModelFieldMeta, value: string): void {
  if (value) {
    form.parameters[field.key] = value;
    return;
  }
  if (secretFields.value.has(field.key)) form.parameters[field.key] = REDACTED;
  else delete form.parameters[field.key];
}

/**
 * 显式清除已保存的密钥：从表单参数中删除该字段，
 * 保存时发送缺失的 key（而不是 __redacted__），后端会真正清空它。
 */
function clearSecret(field: ModelFieldMeta): void {
  delete form.parameters[field.key];
  secretFields.value.delete(field.key);
  delete hiddenSecrets[field.key];
}

function numberValue(field: ModelFieldMeta): number | string {
  const value = form.parameters[field.key];
  if (value === undefined || value === null || value === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : '';
}

function setNumber(field: ModelFieldMeta, value: number | string): void {
  if (value === '' || value === null || value === undefined) {
    if (field.default !== undefined) form.parameters[field.key] = field.default;
    else delete form.parameters[field.key];
    return;
  }
  form.parameters[field.key] = Number(value);
}

function setSlider(field: ModelFieldMeta, value: number): void {
  form.parameters[field.key] = Number(value);
}

function toggleTask(task: ModelTask): void {
  if (form.taskBindings.includes(task)) {
    form.taskBindings = form.taskBindings.filter((item) => item !== task);
  } else {
    form.taskBindings = [...form.taskBindings, task];
  }
}

function buildParameters(): Record<string, unknown> {
  const schema = schemaFields.value;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(form.parameters)) {
    if (raw === undefined || raw === null || raw === '') continue;
    const field = schema.find((item) => item.key === key);
    if (field?.type === 'int') {
      const value = Number(raw);
      if (Number.isFinite(value)) result[key] = Math.round(value);
      continue;
    }
    if (field?.type === 'float') {
      const value = Number(raw);
      if (Number.isFinite(value)) result[key] = value;
      continue;
    }
    if (field?.type === 'bool') {
      result[key] = Boolean(raw);
      continue;
    }
    result[key] = raw;
  }
  return result;
}

function buildModel(): ModelConfig {
  return {
    id: form.id.trim(),
    label: form.label.trim(),
    family: form.family,
    provider: form.provider,
    enabled: form.enabled,
    taskBindings: [...form.taskBindings],
    parameters: buildParameters(),
  };
}

function buildProbePayload(): ModelProbePayload {
  const model = buildModel();
  return {
    id: model.id,
    family: model.family,
    provider: model.provider,
    parameters: model.parameters,
  };
}

function needBaseUrl(): boolean {
  if (form.provider !== 'openai-compatible') return false;
  const baseUrl = form.parameters['baseUrl'];
  return !(typeof baseUrl === 'string' && baseUrl.trim());
}

async function refreshModels(selectId?: string): Promise<void> {
  await app.load();
  if (selectId) {
    const found = app.models.find((model) => model.id === selectId) ?? null;
    loadModel(found);
  } else if (editingId.value) {
    loadModel(app.models.find((model) => model.id === editingId.value) ?? null);
  }
}

async function save(): Promise<void> {
  const payload = buildModel();
  if (!payload.id) {
    toast.error(t('providers.idRequired'));
    return;
  }
  saving.value = true;
  try {
    await api.saveModel(payload);
    await refreshModels(payload.id);
    toast.success(t('providers.saved'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(model: ModelCatalogEntry, enabled: boolean): Promise<void> {
  try {
    await api.setModelEnabled(model.id, enabled);
    await app.load();
    // 同步本地表单与「已保存签名」：否则之后点保存会把刚切换的启用状态写回旧值
    if (editingId.value === model.id) {
      form.enabled = enabled;
      try {
        const saved = JSON.parse(savedSignature.value) as ModelConfig;
        saved.enabled = enabled;
        savedSignature.value = JSON.stringify(saved);
      } catch {
        savedSignature.value = JSON.stringify(buildModel());
      }
    }
    toast.success(
      t('plugins.toggleSuccess', {
        name: model.id,
        status: enabled ? t('common.enabled') : t('common.disabled'),
      }),
    );
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function remove(): Promise<void> {
  if (!editingId.value) return;
  const ok = await confirm.ask({
    title: t('providers.delete'),
    message: t('providers.deleteConfirm', { id: editingId.value }),
    confirmText: t('common.delete'),
  });
  if (!ok) return;
  try {
    await api.deleteModel(editingId.value);
    editingId.value = '';
    loadModel(null);
    await app.load();
    if (app.models.length > 0) loadModel(app.models[0] ?? null);
    toast.success(t('providers.deleted'));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

async function testConnection(): Promise<void> {
  if (needBaseUrl()) {
    toast.error(t('providers.baseUrlRequired'));
    return;
  }
  testing.value = true;
  try {
    const result: ModelProbeResult = await api.testModel(buildProbePayload());
    if (result.ok) toast.success(t('providers.testOk', { message: result.message ?? 'OK' }));
    else toast.error(t('providers.testFail', { message: result.message ?? '-' }));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    testing.value = false;
  }
}

async function fetchRemote(): Promise<void> {
  if (needBaseUrl()) {
    toast.error(t('providers.baseUrlRequired'));
    return;
  }
  fetching.value = true;
  remoteLoading.value = true;
  try {
    const result: ModelFetchResult = await api.fetchRemoteModels(buildProbePayload());
    if (result.ok) {
      remoteModels.value = result.models ?? [];
      remoteDialog.value = true;
    } else {
      toast.error(result.message ?? t('app.loadFailed'));
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    fetching.value = false;
    remoteLoading.value = false;
  }
}

function useRemoteModel(id: string): void {
  form.parameters['model'] = id;
  remoteDialog.value = false;
  toast.success(t('providers.useModelSuccess', { model: id }));
}

async function activate(): Promise<void> {
  if (!activateTask.value || !activateModelId.value) return;
  activating.value = true;
  try {
    await api.activateModel(activateTask.value, activateModelId.value);
    await app.load();
    toast.success(
      t('providers.activate.success', {
        task: activateTask.value,
        model: activateModelId.value,
      }),
    );
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    activating.value = false;
  }
}

// 进入页面时选中第一个模型
watch(
  () => app.models.length,
  () => {
    if (!editingId.value && !isNew.value && app.models.length > 0) {
      loadModel(app.models[0] ?? null);
    }
  },
  { immediate: true },
);

watch(
  () => app.tasks,
  (tasks) => {
    if (tasks.length > 0 && !tasks.includes(activateTask.value)) {
      activateTask.value = tasks[0] as ModelTask;
    }
  },
  { immediate: true },
);

// 页面内有未保存修改时，关闭标签页/离开路由都先确认
function beforeUnload(event: BeforeUnloadEvent): void {
  if (!formDirty.value) return;
  event.preventDefault();
  event.returnValue = '';
}

onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));

onBeforeRouteLeave(async () => {
  if (!formDirty.value) return true;
  return confirmDiscard();
});
</script>

<template>
  <div>
    <PageHeader :title="t('providers.title')" :subtitle="t('providers.subtitle')" icon="mdi-creation-outline">
      <template #actions>
        <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" @click="newModel">
          {{ t('providers.new') }}
        </v-btn>
      </template>
    </PageHeader>

    <v-row dense>
      <v-col cols="12" md="4">
        <v-card
          elevation="0"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <v-card-title class="px-5 pt-4 pb-1 text-subtitle-1 font-weight-bold">
            {{ t('providers.listTitle') }}
            <v-chip class="ms-2" size="x-small" variant="tonal" color="primary">
              {{ models.length }}
            </v-chip>
          </v-card-title>
          <v-card-text class="pb-2">
            <v-text-field
              v-model="search"
              density="compact"
              variant="outlined"
              hide-details
              prepend-inner-icon="mdi-magnify"
              :placeholder="t('providers.searchPlaceholder')"
              clearable
            />
          </v-card-text>
          <v-card-text class="pt-0 model-list-scroll">
            <EmptyState
              v-if="app.loaded && filteredModels.length === 0"
              icon="mdi-creation-outline"
              :text="t('providers.empty')"
              :hint="t('providers.emptyHint')"
            />

            <div
              v-for="model in filteredModels"
              :key="model.id"
              class="model-list-item mb-1"
              :class="{ active: editingId === model.id }"
              @click="selectModel(model)"
            >
              <div class="d-flex align-center ga-2">
                <div class="min-w-0 flex-grow-1">
                  <div class="text-body-2 font-weight-bold text-truncate">
                    {{ model.id }}
                    <span v-if="model.label" class="font-weight-regular muted">· {{ model.label }}</span>
                  </div>
                  <div class="text-caption muted">
                    {{ formatFamily(model.family) }} · {{ model.provider }}
                  </div>
                </div>
                <v-switch
                  :model-value="model.enabled"
                  density="compact"
                  color="primary"
                  hide-details
                  inset
                  @update:model-value="(value) => toggleEnabled(model, Boolean(value))"
                  @click.stop
                />
              </div>
              <div class="d-flex flex-wrap ga-1 mt-1">
                <v-chip
                  v-for="task in model.activeTasks"
                  :key="task"
                  size="x-small"
                  variant="tonal"
                  color="success"
                >
                  {{ task }}
                </v-chip>
                <v-chip
                  v-if="model.taskBindings.length > 0"
                  size="x-small"
                  variant="tonal"
                  color="primary"
                >
                  {{ model.taskBindings.length }} {{ t('providers.fields.tasks') }}
                </v-chip>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>

      <v-col cols="12" md="8">
        <v-card
          v-if="!isEditingVisible"
          elevation="0"
          style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
        >
          <EmptyState
            icon="mdi-creation-outline"
            :text="t('providers.empty')"
            :hint="t('providers.emptyHint')"
          >
            <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" @click="newModel">
              {{ t('providers.new') }}
            </v-btn>
          </EmptyState>
        </v-card>

        <template v-else>
          <v-card
            elevation="0"
            class="mb-3"
            style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
          >
            <v-card-title class="d-flex align-center flex-wrap ga-2 px-5 pt-4">
              <span class="text-subtitle-1 font-weight-bold text-truncate">
                {{ isNew ? t('providers.formNew') : form.id }}
              </span>
              <v-chip size="x-small" variant="tonal" color="primary">
                {{ formatFamily(form.family) }}
              </v-chip>
              <v-chip size="x-small" variant="tonal" color="secondary">
                {{ form.provider }}
              </v-chip>
              <v-spacer />
              <v-switch
                v-model="form.enabled"
                density="compact"
                color="primary"
                hide-details
                inset
                :label="t('providers.fields.enabled')"
              />
            </v-card-title>
            <v-card-text class="px-5 pt-2">
              <div class="d-flex flex-wrap ga-2">
                <v-btn
                  variant="tonal"
                  color="primary"
                  size="small"
                  prepend-icon="mdi-lan-connect"
                  :loading="testing"
                  @click="testConnection"
                >
                  {{ testing ? t('providers.testing') : t('providers.test') }}
                </v-btn>
                <v-btn
                  variant="tonal"
                  color="primary"
                  size="small"
                  prepend-icon="mdi-cloud-download-outline"
                  :loading="fetching"
                  @click="fetchRemote"
                >
                  {{ fetching ? t('providers.fetching') : t('providers.fetch') }}
                </v-btn>
                <v-btn
                  v-if="editingId"
                  variant="tonal"
                  color="error"
                  size="small"
                  prepend-icon="mdi-trash-can-outline"
                  @click="remove"
                >
                  {{ t('providers.delete') }}
                </v-btn>
              </div>
            </v-card-text>
          </v-card>

          <v-card
            elevation="0"
            class="mb-3"
            style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
          >
            <v-card-text class="px-5 py-4">
              <v-row dense>
                <v-col cols="12" md="6">
                  <v-text-field
                    v-model="form.id"
                    :label="t('providers.fields.id')"
                    :hint="t('providers.fields.idHint')"
                    persistent-hint
                    variant="outlined"
                    density="comfortable"
                    :disabled="!isNew"
                  />
                </v-col>
                <v-col cols="12" md="6">
                  <v-text-field
                    v-model="form.label"
                    :label="t('providers.fields.label')"
                    :hint="t('providers.fields.labelHint')"
                    persistent-hint
                    variant="outlined"
                    density="comfortable"
                  />
                </v-col>
                <v-col cols="12" md="6">
                  <v-select
                    v-model="form.family"
                    :items="familyOptions"
                    :label="t('providers.fields.family')"
                    variant="outlined"
                    density="comfortable"
                  />
                </v-col>
                <v-col cols="12" md="6">
                  <v-select
                    v-model="form.provider"
                    :items="providerOptions"
                    :label="t('providers.fields.provider')"
                    variant="outlined"
                    density="comfortable"
                  />
                </v-col>
              </v-row>

              <v-divider class="my-4" />

              <div class="text-subtitle-2 font-weight-bold mb-3">
                {{ t('providers.fields.providerParams') }}
              </div>
              <div v-if="schemaFields.length === 0" class="text-body-2 muted">
                {{ t('providers.fields.noParams') }}
              </div>

              <v-row dense>
                <v-col
                  v-for="field in schemaFields"
                  :key="field.key"
                  :cols="12"
                  :md="field.type === 'text' ? 12 : 6"
                >
                  <v-textarea
                    v-if="field.type === 'text'"
                    :model-value="String(form.parameters[field.key] ?? '')"
                    :label="field.label"
                    :hint="field.hint"
                    :placeholder="field.placeholder"
                    persistent-hint
                    rows="2"
                    variant="outlined"
                    density="comfortable"
                    @update:model-value="(value) => (form.parameters[field.key] = value)"
                  />

                  <v-text-field
                    v-else-if="field.type === 'password'"
                    :model-value="passwordValue(field)"
                    :label="field.label"
                    :hint="field.hint"
                    :placeholder="
                      secretFields.has(field.key) ? t('providers.apiKeyMasked') : field.placeholder
                    "
                    persistent-hint
                    :type="hiddenSecrets[field.key] ? 'text' : 'password'"
                    :append-inner-icon="hiddenSecrets[field.key] ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
                    variant="outlined"
                    density="comfortable"
                    @update:model-value="(value) => onPasswordInput(field, String(value ?? ''))"
                    @click:append-inner="hiddenSecrets[field.key] = !hiddenSecrets[field.key]"
                  >
                    <template v-if="field.key === 'apiKey' && secretFields.has(field.key)" #append>
                      <v-btn
                        variant="text"
                        size="small"
                        color="error"
                        @click="clearSecret(field)"
                      >
                        {{ t('providers.clearApiKey') }}
                      </v-btn>
                    </template>
                  </v-text-field>

                  <div v-else-if="field.type === 'int' || field.type === 'float'">
                    <div v-if="field.slider" class="d-flex align-center ga-3">
                      <v-slider
                        :model-value="Number(form.parameters[field.key] ?? field.default ?? field.min ?? 0)"
                        :min="field.min ?? 0"
                        :max="field.max ?? 2"
                        :step="field.step ?? 0.1"
                        color="primary"
                        hide-details
                        @update:model-value="(value) => setSlider(field, Number(value))"
                      />
                      <v-text-field
                        :model-value="numberValue(field)"
                        type="number"
                        density="compact"
                        variant="outlined"
                        hide-details
                        style="max-width: 96px"
                        @update:model-value="(value) => setNumber(field, String(value ?? ''))"
                      />
                    </div>
                    <v-text-field
                      v-else
                      :model-value="numberValue(field)"
                      :label="field.label"
                      :hint="field.hint"
                      persistent-hint
                      type="number"
                      :min="field.min"
                      :max="field.max"
                      :step="field.step ?? 1"
                      variant="outlined"
                      density="comfortable"
                      @update:model-value="(value) => setNumber(field, String(value ?? ''))"
                    />
                  </div>

                  <v-switch
                    v-else-if="field.type === 'bool'"
                    :model-value="Boolean(form.parameters[field.key])"
                    color="primary"
                    :label="field.label"
                    :hint="field.hint"
                    inset
                    hide-details
                    @update:model-value="(value) => (form.parameters[field.key] = Boolean(value))"
                  />

                  <v-text-field
                    v-else
                    :model-value="String(form.parameters[field.key] ?? '')"
                    :label="field.label"
                    :hint="field.hint"
                    :placeholder="field.placeholder"
                    :required="field.required"
                    persistent-hint
                    variant="outlined"
                    density="comfortable"
                    @update:model-value="(value) => (form.parameters[field.key] = value)"
                  />
                </v-col>
              </v-row>

              <v-divider class="my-4" />

              <div class="text-subtitle-2 font-weight-bold mb-1">
                {{ t('providers.fields.tasks') }}
              </div>
              <div class="text-caption muted mb-2">{{ t('providers.fields.tasksHint') }}</div>
              <div class="d-flex flex-wrap ga-2">
                <v-chip
                  v-for="task in app.tasks"
                  :key="task"
                  :color="form.taskBindings.includes(task) ? 'primary' : undefined"
                  :variant="form.taskBindings.includes(task) ? 'flat' : 'outlined'"
                  size="small"
                  @click="toggleTask(task)"
                >
                  {{ task }}
                </v-chip>
              </div>

              <div class="d-flex align-center ga-3 mt-5">
                <v-btn color="primary" variant="flat" :loading="saving" @click="save">
                  {{ t('providers.save') }}
                </v-btn>
                <v-btn variant="text" @click="resetForm">
                  {{ t('common.reset') }}
                </v-btn>
                <v-chip v-if="formDirty" size="small" color="warning" variant="tonal">
                  {{ t('providers.unsaved') }}
                </v-chip>
              </div>
            </v-card-text>
          </v-card>

          <v-card
            elevation="0"
            style="border: 1px solid rgba(var(--v-theme-borderLight), 0.55)"
          >
            <v-card-title class="px-5 pt-4 text-subtitle-1 font-weight-bold">
              {{ t('providers.activate.title') }}
            </v-card-title>
            <v-card-text class="px-5 pt-1 pb-4">
              <p class="text-caption muted mb-3">{{ t('providers.activate.desc') }}</p>
              <v-row dense align="center">
                <v-col cols="12" sm="4">
                  <v-select
                    v-model="activateTask"
                    :items="app.tasks"
                    :label="t('providers.activate.task')"
                    density="compact"
                    variant="outlined"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="5">
                  <v-select
                    v-model="activateModelId"
                    :items="enabledModels.map((model) => ({ title: model.id, value: model.id }))"
                    :label="t('providers.activate.model')"
                    density="compact"
                    variant="outlined"
                    hide-details
                    :no-data-text="t('providers.activate.empty')"
                  />
                </v-col>
                <v-col cols="12" sm="3">
                  <v-btn
                    color="primary"
                    variant="flat"
                    block
                    :loading="activating"
                    :disabled="!activateModelId"
                    @click="activate"
                  >
                    {{ t('providers.activate.button') }}
                  </v-btn>
                </v-col>
              </v-row>

              <div class="d-flex flex-wrap ga-2 mt-3">
                <v-chip
                  v-for="binding in taskBindings"
                  :key="binding.task"
                  size="small"
                  variant="tonal"
                  :color="binding.modelId ? 'success' : 'default'"
                >
                  {{ binding.task }}:
                  {{ binding.modelId || t('providers.activate.none') }}
                </v-chip>
              </div>
            </v-card-text>
          </v-card>
        </template>
      </v-col>
    </v-row>

    <v-dialog v-model="remoteDialog" max-width="520">
      <v-card>
        <v-card-title class="text-subtitle-1 font-weight-bold">
          {{ t('providers.fetchTitle') }}
        </v-card-title>
        <v-card-subtitle>
          {{ t('providers.fetchNote', { count: remoteModels.length }) }}
        </v-card-subtitle>
        <v-card-text style="max-height: 50vh; overflow: auto">
          <v-progress-linear v-if="remoteLoading" indeterminate color="primary" />
          <div
            v-for="id in remoteModels"
            :key="id"
            class="d-flex align-center justify-space-between ga-3 py-2"
            style="border-bottom: 1px solid rgba(var(--v-theme-borderLight), 0.3)"
          >
            <code class="mono text-body-2 text-truncate">{{ id }}</code>
            <v-btn size="small" color="primary" variant="flat" @click="useRemoteModel(id)">
              {{ t('providers.useModel') }}
            </v-btn>
          </div>
          <EmptyState
            v-if="!remoteLoading && remoteModels.length === 0"
            icon="mdi-cloud-off-outline"
            :text="t('providers.fetchEmpty')"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="remoteDialog = false">{{ t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
