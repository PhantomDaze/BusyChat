<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { loadMonaco, type MonacoApi } from '@/utils/monaco';
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    readonly?: boolean;
    dark?: boolean;
  }>(),
  { readonly: false, dark: false },
);

const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>();

const host = ref<HTMLElement | null>(null);
let monacoApi: MonacoApi | undefined;
let instance: Monaco.editor.IStandaloneCodeEditor | undefined;
let disposed = false;

onMounted(async () => {
  if (!host.value) return;
  monacoApi = await loadMonaco();
  if (disposed || !host.value) return;

  instance = monacoApi.editor.create(host.value, {
    value: props.modelValue,
    language: 'json',
    theme: props.dark ? 'vs-dark' : 'vs',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 2,
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    readOnly: props.readonly,
    renderLineHighlight: 'none',
    fixedOverflowWidgets: true,
  });

  instance.onDidChangeModelContent(() => {
    emit('update:modelValue', instance?.getValue() ?? '');
  });
});

onBeforeUnmount(() => {
  disposed = true;
  instance?.dispose();
  instance = undefined;
});

watch(
  () => props.modelValue,
  (value) => {
    if (instance && value !== instance.getValue()) instance.setValue(value);
  },
);

watch(
  () => props.dark,
  (dark) => monacoApi?.editor.setTheme(dark ? 'vs-dark' : 'vs'),
);

defineExpose({
  format() {
    instance?.getAction('editor.action.formatDocument')?.run();
  },
});
</script>

<template>
  <div ref="host" class="editor-shell" />
</template>
