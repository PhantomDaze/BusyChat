/**
 * Monaco 懒加载入口。
 *
 * 只在「系统设置 → 配置文件」页打开时才加载编辑器与 JSON worker，
 * 首屏 bundle 不包含 monaco。
 */
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

export type MonacoApi = typeof monaco;

let initialized = false;

export async function loadMonaco(): Promise<MonacoApi> {
  if (!initialized) {
    // Monaco 通过全局钩子创建 worker；Vite 的 ?worker 产物是同源静态文件
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker(_workerId: string, label: string) {
        if (label === 'json') return new JsonWorker();
        return new EditorWorker();
      },
    };
    initialized = true;
  }
  return monaco;
}
