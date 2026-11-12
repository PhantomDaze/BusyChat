import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

import {
  createDefaultAppConfig,
  createDefaultAppSettings,
  normalizeAppConfig,
  normalizeRuntimeState,
} from './config';
import { atomicWriteFile, hardenFile, isMissingFileError } from './fs-utils';
import type { AppConfigFile, AppConfigStore, AppSettings, RuntimeState } from './types';

export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config.json');
const DEFAULT_LEGACY_RUNTIME_PATH = path.resolve(
  process.cwd(),
  createDefaultAppSettings().dataDir,
  'runtime.json',
);

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  // 原子且持久的写入（临时文件 + fsync + rename + 目录 fsync），
  // 崩溃时不会留下被截断、无法解析的 config.json。
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 配置内容指纹：用于 WebUI 判断配置是否发生变化。 */
function computeRevision(config: AppConfigFile): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

async function loadLegacyRuntimeState(filePath: string): Promise<RuntimeState | undefined> {
  const raw = await readJsonFile<unknown>(filePath);
  if (raw === undefined) {
    return undefined;
  }

  if (!isPlainObject(raw)) {
    throw new Error(`invalid legacy runtime file: ${filePath}`);
  }

  return normalizeRuntimeState(raw as Partial<RuntimeState>);
}

export async function loadAppConfigFile(filePath = DEFAULT_CONFIG_PATH): Promise<AppConfigFile> {
  const raw = await readJsonFile<unknown>(filePath);
  if (raw !== undefined) {
    if (!isPlainObject(raw)) {
      throw new Error(`invalid config file: ${filePath}`);
    }
    return normalizeAppConfig(raw as Partial<AppConfigFile>);
  }

  const fallback = createDefaultAppConfig();
  const legacyRuntime = await loadLegacyRuntimeState(DEFAULT_LEGACY_RUNTIME_PATH);
  if (legacyRuntime) {
    fallback.runtime = legacyRuntime;
  }

  await writeJsonFile(filePath, fallback);
  return fallback;
}

export async function saveAppConfigFile(filePath: string, config: AppConfigFile): Promise<void> {
  await writeJsonFile(filePath, config);
}

export class JsonConfigStore implements AppConfigStore {
  private lock: Promise<void> = Promise.resolve();
  /** 最近一次成功加载/保存的配置（last-known-good）。 */
  private cache: AppConfigFile | null = null;
  private cacheMtimeMs = -1;
  /** 最近一次加载失败时文件的 mtime；只有 mtime 再次变化才重试。 */
  private failedMtimeMs: number | null = null;
  private lastError: string | undefined;
  /** 已记录过日志的失败 mtime，避免每次访问都刷错误日志。 */
  private loggedFailureMtimeMs: number | null = null;
  private revision = '';

  constructor(private readonly filePath: string = DEFAULT_CONFIG_PATH) {}

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lock.then(task, task);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  private async fileMtimeMs(): Promise<number> {
    try {
      return (await stat(this.filePath)).mtimeMs;
    } catch {
      return -1;
    }
  }

  private async acceptLoaded(config: AppConfigFile): Promise<void> {
    this.cache = config;
    this.cacheMtimeMs = await this.fileMtimeMs();
    this.failedMtimeMs = null;
    this.loggedFailureMtimeMs = null;
    this.lastError = undefined;
    this.revision = computeRevision(config);
  }

  /**
   * 缓存读取，按文件 mtime 失效：每次访问只需一次 stat，同时仍支持运行期间
   * 手工编辑 config.json。文件损坏时退回 last-known-good，而不是让所有访问
   * 永久抛错；同一次损坏（mtime 未变）只记录一次日志，mtime 变化后才重试。
   */
  private async loadCached(): Promise<AppConfigFile> {
    const mtime = await this.fileMtimeMs();

    // 上次已确认这个 mtime 的文件坏掉：文件没再变化就不要反复解析。
    if (this.failedMtimeMs !== null && mtime === this.failedMtimeMs) {
      if (this.cache) return this.cache;
      throw new Error(this.lastError ?? `invalid config file: ${this.filePath}`);
    }

    if (this.cache && mtime === this.cacheMtimeMs) {
      return this.cache;
    }

    try {
      const loaded = await loadAppConfigFile(this.filePath);
      await this.acceptLoaded(loaded);
      return loaded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.failedMtimeMs = mtime;
      if (this.loggedFailureMtimeMs !== mtime) {
        this.loggedFailureMtimeMs = mtime;
        console.error(
          `[config] failed to load ${this.filePath}: ${message}` +
            (this.cache ? ' — keeping last-known-good config in memory' : ''),
        );
      }
      // 没有任何可用旧配置时保持原有行为：向上抛出。
      if (!this.cache) throw error;
      return this.cache;
    }
  }

  private async persist(config: AppConfigFile): Promise<void> {
    await saveAppConfigFile(this.filePath, config);
    await this.acceptLoaded(config);
  }

  async ensureReady(): Promise<void> {
    // config.json 可能位于 dataDir 之外，因此在这里单独收紧权限。
    await hardenFile(this.filePath, 0o600);
    try {
      await this.loadCached();
    } finally {
      // 首次启动会新建 config.json；无论成功与否都确保权限不宽于 0600。
      await hardenFile(this.filePath, 0o600);
    }
  }

  /** 最近一次加载失败的错误信息（成功加载后清空）。 */
  getLastError(): string | undefined {
    return this.lastError;
  }

  /** 当前生效配置的内容指纹（sha256，十六进制）。 */
  getRevision(): string {
    return this.revision;
  }

  /**
   * 读取磁盘上的原始配置（不经过 normalize），用于迁移旧版字段等一次性操作。
   * 注意：normalize 会把已废弃的 runtime 业务字段丢弃，迁移必须从原始文件取。
   */
  async readRawConfig(): Promise<Partial<AppConfigFile> | undefined> {
    return readJsonFile<Partial<AppConfigFile>>(this.filePath);
  }

  async snapshotConfig(): Promise<AppConfigFile> {
    return clone(await this.loadCached());
  }

  async snapshotSettings(): Promise<AppSettings> {
    const config = await this.snapshotConfig();
    return config.settings;
  }

  async snapshot(): Promise<RuntimeState> {
    const config = await this.snapshotConfig();
    return config.runtime;
  }

  async update(mutator: (state: RuntimeState) => Promise<void> | void): Promise<RuntimeState> {
    return this.withLock(async () => {
      const config = await this.loadCached();
      const next = clone(config);
      await mutator(next.runtime);
      await this.persist(next);
      return clone(next.runtime);
    });
  }

  async replace(next: RuntimeState): Promise<RuntimeState> {
    return this.withLock(async () => {
      const config = clone(await this.loadCached());
      config.runtime = next;
      await this.persist(config);
      return next;
    });
  }

  async updateSettings(mutator: (settings: AppSettings) => Promise<void> | void): Promise<AppSettings> {
    return this.withLock(async () => {
      const config = await this.loadCached();
      const next = clone(config);
      await mutator(next.settings);
      await this.persist(next);
      return clone(next.settings);
    });
  }

  async replaceSettings(next: AppSettings): Promise<AppSettings> {
    return this.withLock(async () => {
      const config = clone(await this.loadCached());
      config.settings = next;
      await this.persist(config);
      return next;
    });
  }

  async replaceConfig(next: AppConfigFile): Promise<AppConfigFile> {
    return this.withLock(async () => {
      await this.persist(next);
      return next;
    });
  }
}
