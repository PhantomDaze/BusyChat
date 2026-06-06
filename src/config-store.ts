import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  createDefaultAppConfig,
  createDefaultAppSettings,
  normalizeAppConfig,
  normalizeRuntimeState,
} from './config';
import type { AppConfigFile, AppConfigStore, AppSettings, RuntimeState } from './types';

export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config.json');
const DEFAULT_LEGACY_RUNTIME_PATH = path.resolve(
  process.cwd(),
  createDefaultAppSettings().dataDir,
  'runtime.json',
);

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

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
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

  constructor(private readonly filePath: string = DEFAULT_CONFIG_PATH) {}

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lock.then(task, task);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  async ensureReady(): Promise<void> {
    await loadAppConfigFile(this.filePath);
  }

  async snapshotConfig(): Promise<AppConfigFile> {
    return loadAppConfigFile(this.filePath);
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
      const config = await loadAppConfigFile(this.filePath);
      const next = clone(config);
      await mutator(next.runtime);
      await saveAppConfigFile(this.filePath, next);
      return next.runtime;
    });
  }

  async replace(next: RuntimeState): Promise<RuntimeState> {
    return this.withLock(async () => {
      const config = await loadAppConfigFile(this.filePath);
      config.runtime = next;
      await saveAppConfigFile(this.filePath, config);
      return next;
    });
  }

  async updateSettings(mutator: (settings: AppSettings) => Promise<void> | void): Promise<AppSettings> {
    return this.withLock(async () => {
      const config = await loadAppConfigFile(this.filePath);
      const next = clone(config);
      await mutator(next.settings);
      await saveAppConfigFile(this.filePath, next);
      return next.settings;
    });
  }

  async replaceSettings(next: AppSettings): Promise<AppSettings> {
    return this.withLock(async () => {
      const config = await loadAppConfigFile(this.filePath);
      config.settings = next;
      await saveAppConfigFile(this.filePath, config);
      return next;
    });
  }

  async replaceConfig(next: AppConfigFile): Promise<AppConfigFile> {
    return this.withLock(async () => {
      await saveAppConfigFile(this.filePath, next);
      return next;
    });
  }
}
