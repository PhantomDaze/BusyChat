/**
 * 插件配置访问器
 *
 * 每个插件通过 PluginContext.config 读写自己的配置：配置保存在插件
 * storage 命名空间的 `config` 键下（data/plugins/<name>.json，sqlite
 * plugin_kv 表），因此 config.json 只保留内核配置，插件配置完全归插件。
 */

import type { JsonObject, JsonValue, NamespacedStorage, PluginConfigStore } from './types';

/** 插件配置在命名空间中使用的键名 */
export const PLUGIN_CONFIG_KEY = 'config';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createPluginConfigStore<T extends object>(
  namespace: NamespacedStorage,
  defaults: T,
): PluginConfigStore<T> {
  return {
    async get(): Promise<T> {
      const stored = await namespace.get<JsonValue>(PLUGIN_CONFIG_KEY);
      // 未显式配置过时返回默认值（不写回，避免首次读取产生副作用）
      return stored !== undefined ? (stored as T) : clone(defaults);
    },
    async update(mutator): Promise<T> {
      const stored = await namespace.get<JsonValue>(PLUGIN_CONFIG_KEY);
      const current = (stored !== undefined ? stored : clone(defaults)) as T;
      const next = mutator(current);
      // 插件的配置接口没有 JsonObject 索引签名，存储层要求 JsonValue，
      // 这里做一次受控的序列化 cast（配置本身就是 JSON 结构）。
      await namespace.set(PLUGIN_CONFIG_KEY, next as unknown as JsonValue);
      return next;
    },
    async reset(config: T): Promise<T> {
      await namespace.set(PLUGIN_CONFIG_KEY, config as unknown as JsonValue);
      return config;
    },
  };
}
