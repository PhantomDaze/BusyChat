import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { link, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import initSqlJs, { type Database, type QueryExecResult, type SqlJsStatic } from 'sql.js';

import {
  atomicWriteFile,
  ensurePrivateDir,
  fsyncDirectory,
  hardenFile,
  isAlreadyExistsError,
  isMissingFileError,
  isSqliteFile,
} from './fs-utils';

import type {
  AdviceRecord,
  CommandRecord,
  JsonObject,
  JsonValue,
  KnowledgeEntry,
  NamespacedStorage,
  NormalizedMessageEvent,
  SummaryRecord,
} from './types';

// ---------------------------------------------------------------------------
// Schema & limits
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS advice (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_summaries_created ON summaries(created_at);
CREATE INDEX IF NOT EXISTS idx_advice_created ON advice(created_at);
CREATE INDEX IF NOT EXISTS idx_commands_created ON commands(created_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge(created_at);
`;

/** Coalescing window for database flushes (each flush rewrites the whole file). */
const SAVE_DEBOUNCE_MS = 500;

/** 超过该耗时（毫秒）的单次保存会告警一次。 */
const SLOW_SAVE_WARN_MS = 500;

/** 数据库超过该大小（100 MiB）会告警一次。 */
const MAX_DB_WARN_BYTES = 100 * 1024 * 1024;

/** 单个插件命名空间的硬上限：达到后拒绝新增 key（已有 key 仍可更新）。 */
const PLUGIN_KV_MAX_KEYS = 10_000;

/** 单个插件键序列化后的硬上限：1 MiB。 */
const PLUGIN_KV_MAX_VALUE_BYTES = 1024 * 1024;

/** Warn once a plugin namespace grows past this many keys — nothing prunes it. */
const PLUGIN_KV_WARN_THRESHOLD = PLUGIN_KV_MAX_KEYS;

const LIMITS: Record<string, number> = {
  events: 2000,
  summaries: 200,
  advice: 200,
  commands: 500,
  knowledge: 5000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function rowsToArray<T>(result: QueryExecResult | undefined): T[] {
  if (!result || result.values.length === 0) return [];
  const items: T[] = [];
  for (const row of result.values) {
    try {
      items.push(JSON.parse(String(row[0])) as T);
    } catch {
      // Skip rows with corrupt payloads instead of failing the whole read.
    }
  }
  return items;
}

async function readOrMigrateJson<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const items: T[] = [];
    for (const line of lines) {
      try { items.push(JSON.parse(line) as T); } catch { /* skip */ }
    }
    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// SqliteStore (exported as FileStore for backward compat)
// ---------------------------------------------------------------------------

export interface StorageHealth {
  ok: boolean;
  lastSaveAt?: string;
  lastSaveError?: string;
  sizeBytes: number;
  locked: boolean;
}

export class FileStore {
  private db: Database | null = null;
  private readonly dbPath: string;
  private readonly backupPath: string;
  private readonly lockPath: string;
  private eventIdCache = new Set<string>();
  private saveChain: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private closed = false;
  private pluginKvWarned = new Set<string>();
  private lockAcquired = false;
  private hadExistingDb = false;
  private backupWrittenThisBoot = false;
  private lastSaveAt: string | undefined;
  private lastSaveError: string | undefined;
  private lastSizeBytes = 0;
  private slowSaveWarned = false;
  private largeDbWarned = false;

  constructor(private readonly rootDir: string) {
    this.dbPath = path.join(rootDir, 'f261agent.db');
    this.backupPath = `${this.dbPath}.bak`;
    this.lockPath = path.join(rootDir, 'instance.lock');
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async ensureReady(): Promise<void> {
    // 幂等：重复调用不再重新加锁/重开数据库。
    if (this.db) return;

    await ensurePrivateDir(this.rootDir);
    await this.acquireInstanceLock();
    try {
      // 先收紧已有文件的权限，再读取。
      await hardenFile(this.dbPath, 0o600);
      await hardenFile(this.backupPath, 0o600);

      await this.openDatabase();
      await this.migrateIfNeeded();
      this.rebuildEventCache();
      await this.save();
    } catch (error) {
      // 初始化失败必须释放实例锁，否则下次启动会被自己的残留锁挡住。
      await this.releaseInstanceLock();
      throw error;
    }
  }

  /**
   * 打开数据库并做完整性校验。主库为空/损坏/未通过 integrity_check 时，
   * 只在主库确实存在的情况下回退到 f261agent.db.bak；两者都不可用则抛出
   * 可操作的错误，绝不把损坏文件当成空库静默打开（那会在首次保存时覆盖现场）。
   */
  private async openDatabase(): Promise<void> {
    const SQL = await initSqlJs();
    this.hadExistingDb = existsSync(this.dbPath);

    let mainBytes: Buffer | undefined;
    let mainRejected = false;
    if (this.hadExistingDb) {
      mainBytes = await readFile(this.dbPath);
      if (!isSqliteFile(mainBytes)) {
        mainRejected = true;
        mainBytes = undefined;
        console.error(
          `[storage] database file ${this.dbPath} is empty or does not start with the SQLite header; ` +
            `refusing to open it as an empty database. Trying backup ${this.backupPath}.`,
        );
      }
    }

    let db: Database | undefined;
    let sourceBytes: Buffer | undefined;
    let recoveredFromBackup = false;

    if (mainBytes) {
      db = this.tryOpenDatabase(SQL, mainBytes);
      if (db) {
        sourceBytes = mainBytes;
      } else {
        mainRejected = true;
        console.error(
          `[storage] database file ${this.dbPath} failed PRAGMA integrity_check; ` +
            `trying backup ${this.backupPath}.`,
        );
      }
    }

    if (!db && this.hadExistingDb) {
      const backupBytes = await this.readBackupBytes();
      if (backupBytes) {
        db = this.tryOpenDatabase(SQL, backupBytes);
        if (db) {
          sourceBytes = backupBytes;
          recoveredFromBackup = true;
        } else {
          console.error(`[storage] backup ${this.backupPath} failed PRAGMA integrity_check.`);
        }
      }
    }

    if (!db) {
      if (this.hadExistingDb) {
        throw new Error(
          `[storage] database ${this.dbPath} is corrupt and no usable backup was found at ` +
            `${this.backupPath}. Stop the bot, restore f261agent.db from a known-good backup, ` +
            'or delete it to start with an empty database, then restart.',
        );
      }
      // 全新目录：正常创建空库，不擅自恢复可能过期的旧备份。
      db = new SQL.Database();
      sourceBytes = undefined;
    }

    // 主库不可用时保留现场，避免恢复后的首次保存直接覆盖掉诊断线索。
    if (mainRejected) {
      const corruptPath = `${this.dbPath}.corrupt-${Date.now()}`;
      if (await rename(this.dbPath, corruptPath).then(() => true, () => false)) {
        console.error(`[storage] preserved the unreadable database file as ${corruptPath}`);
      }
    }

    // 启动后留一份 previous-good 快照（每个进程只写一次）。
    if (sourceBytes && sourceBytes.length > 0 && !this.backupWrittenThisBoot) {
      this.backupWrittenThisBoot = await this.writeBackup(sourceBytes);
    }

    if (recoveredFromBackup) {
      console.error(
        `[storage] RECOVERED database from ${this.backupPath}. The restored snapshot may be ` +
          'older than the last write — verify your data.',
      );
    }

    this.db = db;
    this.lastSizeBytes = sourceBytes?.length ?? 0;
    this.db.run('PRAGMA journal_mode=WAL');
    this.db.run('PRAGMA synchronous=NORMAL');
    this.db.exec(SCHEMA);
  }

  /** 打开候选数据库并运行 integrity_check；失败返回 undefined。 */
  private tryOpenDatabase(SQL: SqlJsStatic, bytes: Buffer): Database | undefined {
    let db: Database | undefined;
    try {
      db = new SQL.Database(bytes);
      const result = db.exec('PRAGMA integrity_check');
      const verdict = String(result[0]?.values[0]?.[0] ?? '').toLowerCase();
      if (verdict === 'ok') return db;
      db.close();
      return undefined;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // 未成功创建或已关闭
      }
      console.error('[storage] failed to open database candidate:', error);
      return undefined;
    }
  }

  private async readBackupBytes(): Promise<Buffer | undefined> {
    try {
      const raw = await readFile(this.backupPath);
      if (isSqliteFile(raw)) return raw;
      console.error(`[storage] backup ${this.backupPath} is empty or not a SQLite database.`);
      return undefined;
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.error(`[storage] failed to read backup ${this.backupPath}:`, error);
      }
      return undefined;
    }
  }

  /** 把一份已验证的数据库字节写入 .bak（原子写入，权限 0600）。 */
  private async writeBackup(bytes?: Buffer): Promise<boolean> {
    try {
      const data = bytes ?? (this.db ? Buffer.from(this.db.export()) : undefined);
      if (!data || data.length === 0 || !isSqliteFile(data)) return false;
      await atomicWriteFile(this.backupPath, data, { mode: 0o600 });
      return true;
    } catch (error) {
      // 备份失败不应阻断主流程，但必须可见。
      console.warn('[storage] failed to write database backup:', error);
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Single-instance lock
  // -----------------------------------------------------------------------

  /**
   * 单实例锁：dataDir/instance.lock 以 wx 模式原子创建。
   * 已存在时用 pid + process.kill(pid, 0) 判断持有者是否存活；陈旧或无法解析
   * 的锁会被删除并重试一次。
   */
  private async acquireInstanceLock(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      // 先在独立临时文件里写完整内容，再用 link() 原子地发布到锁路径。
      // 直接用 open(..., 'wx') 再写 pid 存在一个窗口：另一个进程可能在 pid
      // 写入前看到空锁文件、误判为陈旧锁并删除它，导致两个实例同时运行。
      const tempPath = `${this.lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(
          tempPath,
          JSON.stringify({ pid: process.pid, startedAt: nowIso() }),
          { mode: 0o600, flag: 'wx' },
        );
        await hardenFile(tempPath, 0o600);
        try {
          await link(tempPath, this.lockPath);
          await fsyncDirectory(this.rootDir);
          this.lockAcquired = true;
          return;
        } catch (error) {
          if (!isAlreadyExistsError(error)) throw error;
        }
      } finally {
        await unlink(tempPath).catch(() => undefined);
      }

      const owner = await this.inspectLock();
      if (owner.live) {
        throw new Error(
          `dataDir ${this.rootDir} is already locked by live process pid ${owner.pid}`,
        );
      }
      await unlink(this.lockPath).catch(() => undefined);
    }
    throw new Error(`failed to acquire instance lock ${this.lockPath}`);
  }

  private async inspectLock(): Promise<{ live: boolean; pid?: number }> {
    let pid: number | undefined;
    try {
      const raw = await readFile(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: unknown };
      const value = Number(parsed.pid);
      if (Number.isInteger(value) && value > 0) pid = value;
    } catch {
      // 无法读取/解析：按陈旧锁处理。
    }
    if (pid === undefined) return { live: false };

    try {
      process.kill(pid, 0);
      return { live: true, pid };
    } catch (error) {
      // EPERM 说明进程存在但属于其他用户，仍应视为存活。
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: string }).code
          : undefined;
      return code === 'EPERM' ? { live: true, pid } : { live: false, pid };
    }
  }

  /** 仅在锁文件仍记录着本进程 pid 时释放，绝不删除其他实例的锁。 */
  private async releaseInstanceLock(): Promise<void> {
    if (!this.lockAcquired) return;
    this.lockAcquired = false;
    try {
      const raw = await readFile(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: unknown };
      if (Number(parsed.pid) === process.pid) {
        await unlink(this.lockPath);
        await fsyncDirectory(this.rootDir);
      }
    } catch {
      // 锁文件已不存在或内容无法解析：保持不变。
    }
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private save(): Promise<void> {
    // 所有写入串行化：每个链节先吸收前一个失败（.catch 在 .then 之前），
    // 否则一次失败会让后续所有排队写入被跳过，包括 close() 的最后一次 flush。
    // 每个链节都做「临时文件 + fsync + rename + 目录 fsync」，崩溃不会截断旧库。
    const link = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        if (!this.db) return;
        this.dirty = false;
        const started = Date.now();
        const data = Buffer.from(this.db.export());
        await atomicWriteFile(this.dbPath, data, { mode: 0o600 });
        const durationMs = Date.now() - started;
        this.lastSizeBytes = data.length;
        this.lastSaveAt = new Date().toISOString();
        this.lastSaveError = undefined;

        console.debug(
          `[storage] database saved in ${durationMs} ms (${data.length} bytes)`,
        );
        if (durationMs > SLOW_SAVE_WARN_MS && !this.slowSaveWarned) {
          this.slowSaveWarned = true;
          console.warn(
            `[storage] database save took ${durationMs} ms (> ${SLOW_SAVE_WARN_MS} ms); ` +
              'the data directory may be on slow or contended storage.',
          );
        }
        if (data.length > MAX_DB_WARN_BYTES && !this.largeDbWarned) {
          this.largeDbWarned = true;
          console.warn(
            `[storage] database is ${(data.length / (1024 * 1024)).toFixed(1)} MiB ` +
              `(> ${MAX_DB_WARN_BYTES / (1024 * 1024)} MiB); consider cleaning old events.`,
          );
        }
      })
      .catch((error: unknown) => {
        // 失败信息必须留给 flush()/close() 观察，让进程以非零码退出。
        this.dirty = true;
        this.lastSaveError = error instanceof Error ? error.message : String(error);
        console.error('[storage] failed to persist database:', error);
        throw error;
      });
    this.saveChain = link;
    return link;
  }

  /** 运行期健康状态（供 WebUI / 运维探针使用）。 */
  getHealth(): StorageHealth {
    let sizeBytes = this.lastSizeBytes;
    try {
      sizeBytes = statSync(this.dbPath).size;
    } catch {
      // 文件尚未创建时沿用最近一次保存的大小。
    }
    const health: StorageHealth = {
      ok: this.lastSaveError === undefined,
      sizeBytes,
      locked: this.lockAcquired,
    };
    if (this.lastSaveAt !== undefined) health.lastSaveAt = this.lastSaveAt;
    if (this.lastSaveError !== undefined) health.lastSaveError = this.lastSaveError;
    return health;
  }

  private throwIfSaveFailed(): void {
    // 「最近一次保存」失败才抛出；后续成功保存会清空 lastSaveError。
    if (this.lastSaveError !== undefined) {
      throw new Error(`database save failed: ${this.lastSaveError}`);
    }
  }

  /**
   * Schedule a save. Writes are debounced because each save serializes and
   * rewrites the WHOLE database — without coalescing, a busy group would
   * re-export a multi-MB file once per message.
   */
  private markSave(): void {
    if (!this.db || this.closed) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // 延迟保存的失败由 lastSaveError 记录，由 flush/close 统一上报；
      // 这里必须吸收 rejection，避免触发 unhandledRejection。
      void this.save().catch(() => undefined);
    }, SAVE_DEBOUNCE_MS);
    // Don't hold the event loop open just for a pending flush.
    this.saveTimer.unref?.();
  }

  /** Flush any pending writes to disk and stop accepting new ones. */
  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.closed) {
      await this.saveChain.catch(() => undefined);
      this.throwIfSaveFailed();
      return;
    }

    this.closed = true;
    try {
      // Force one final save regardless of dirty, then drain the chain.
      this.dirty = false;
      await this.save();
      await this.saveChain.catch(() => undefined);
      this.throwIfSaveFailed();
    } finally {
      await this.releaseInstanceLock();
    }
  }

  /** Flush pending writes without closing the store. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      // 直接 await 让本链节失败向上抛出。
      await this.save();
    } else {
      // 没有待写内容也要排空正在进行/已排队的保存，再检查最近一次结果。
      await this.saveChain.catch(() => undefined);
    }
    this.throwIfSaveFailed();
  }

  // -----------------------------------------------------------------------
  // Migration from old NDJSON files
  // -----------------------------------------------------------------------

  private tableIsEmpty(table: string): boolean {
    const db = this.db!;
    const countResult = db.exec(`SELECT COUNT(*) FROM ${table}`);
    return !(countResult[0] && Number(countResult[0].values[0]?.[0]) > 0);
  }

  private async migrateIfNeeded(): Promise<void> {
    const db = this.db!;
    // 任何会改写数据库内容的迁移之前，先留一份上一版本快照。
    // 启动时已经成功写过 .bak 的话无需重复复制整个数据库。
    if (this.hadExistingDb && !this.backupWrittenThisBoot) {
      this.backupWrittenThisBoot = await this.writeBackup();
    }

    const migrations: Array<{ file: string; table: string }> = [
      { file: 'events.ndjson', table: 'events' },
      { file: 'summaries.ndjson', table: 'summaries' },
      { file: 'advice.ndjson', table: 'advice' },
      { file: 'commands.ndjson', table: 'commands' },
      { file: 'knowledge.ndjson', table: 'knowledge' },
    ];

    for (const { file, table } of migrations) {
      // Migrate each table independently: only import an NDJSON file when its
      // target table is still empty, so restoring one legacy file later still
      // works even though other tables already hold data.
      if (!this.tableIsEmpty(table)) continue;
      const filePath = path.join(this.rootDir, file);
      const rows = await readOrMigrateJson<Record<string, unknown>>(filePath);
      if (rows.length === 0) continue;

      const stmt = db.prepare(
        `INSERT OR IGNORE INTO ${table} (id, payload, created_at) VALUES (?, ?, ?)`,
      );
      for (const row of rows) {
        const id = String(row.id ?? '');
        if (!id) continue;
        const createdAt = String(row.createdAt ?? row.created_at ?? nowIso());
        stmt.run([id, JSON.stringify(row), createdAt]);
      }
      stmt.free();
      // Retire the source file so it is imported exactly once. Leaving it in
      // place would re-import it whenever the table becomes empty again —
      // resurrecting rows the user deliberately deleted.
      await rename(filePath, `${filePath}.migrated`).catch(() => undefined);
    }

    // Migrate plugin state JSON files (only when no plugin state exists yet)
    if (this.tableIsEmpty('plugin_kv')) {
      const pluginDir = path.join(this.rootDir, 'plugins');
      const { readdir } = await import('node:fs/promises');
      let files: string[] = [];
      try { files = await readdir(pluginDir); } catch { /* no plugin dir */ }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const ns = f.replace(/\.json$/, '');
        const fullPath = path.join(pluginDir, f);
        try {
          const raw = await readFile(fullPath, 'utf8');
          const obj = JSON.parse(raw) as JsonObject;
          const stmt = db.prepare(
            'INSERT OR REPLACE INTO plugin_kv (namespace, key, value) VALUES (?, ?, ?)',
          );
          for (const [key, value] of Object.entries(obj)) {
            stmt.run([ns, key, JSON.stringify(value)]);
          }
          stmt.free();
          await rename(fullPath, `${fullPath}.migrated`).catch(() => undefined);
        } catch { /* corrupt */ }
      }
    }

    await this.save();
  }

  private rebuildEventCache(): void {
    if (!this.db) return;
    const result = this.db.exec('SELECT id FROM events');
    this.eventIdCache.clear();
    if (result[0]) {
      for (const row of result[0].values) {
        this.eventIdCache.add(String(row[0]));
      }
    }
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  async appendEvent(event: NormalizedMessageEvent): Promise<boolean> {
    const db = this.db!;
    if (this.eventIdCache.has(event.id)) return false;

    db.run('INSERT INTO events (id, payload, created_at) VALUES (?, ?, ?)', [
      event.id,
      JSON.stringify(event),
      event.receivedAt,
    ]);
    this.eventIdCache.add(event.id);
    this.trimEvents();
    this.markSave();
    return true;
  }

  async listEventsAfter(cursorEventId?: string, limit?: number): Promise<NormalizedMessageEvent[]> {
    const db = this.db!;
    if (cursorEventId) {
      const cursorResult = db.exec('SELECT created_at FROM events WHERE id = ?', [cursorEventId]);
      if (cursorResult[0] && cursorResult[0].values[0]) {
        const cursorTime = String(cursorResult[0].values[0][0]);
        const lim = typeof limit === 'number' ? Math.min(limit, 1000) : 500;
        // Compare on the (created_at, id) tuple. A plain `created_at > ?`
        // dropped EVERY event sharing the cursor's timestamp (OneBot time is
        // second-granularity, so bursts collide constantly). Ids are content
        // hashes, not sequential, so an event that arrives after the cursor
        // advanced within the same second can still sort below it — rarer,
        // but not fully eliminated.
        const result = db.exec(
          `SELECT payload FROM events
             WHERE created_at > ? OR (created_at = ? AND id > ?)
             ORDER BY created_at ASC, id ASC
             LIMIT ?`,
          [cursorTime, cursorTime, cursorEventId, lim],
        );
        return rowsToArray<NormalizedMessageEvent>(result[0]);
      }
      // Cursor row was trimmed away. Return from the OLDEST retained event
      // rather than the newest — everything still in the table is unprocessed,
      // so jumping to the tail would silently skip the middle.
      const lim = typeof limit === 'number' ? Math.min(limit, 1000) : 500;
      const result = db.exec(
        'SELECT payload FROM events ORDER BY created_at ASC, id ASC LIMIT ?',
        [lim],
      );
      return rowsToArray<NormalizedMessageEvent>(result[0]);
    }

    const lim = typeof limit === 'number' ? Math.min(limit, 500) : 64;
    const result = db.exec(
      'SELECT payload FROM events ORDER BY created_at DESC, id DESC LIMIT ?',
      [lim],
    );
    const items = rowsToArray<NormalizedMessageEvent>(result[0]);
    return items.reverse();
  }

  // -----------------------------------------------------------------------
  // Summaries
  // -----------------------------------------------------------------------

  async appendSummary(summary: SummaryRecord): Promise<void> {
    const db = this.db!;
    db.run('INSERT INTO summaries (id, payload, created_at) VALUES (?, ?, ?)', [
      summary.id,
      JSON.stringify(summary),
      summary.createdAt,
    ]);
    this.trimTable('summaries');
    this.markSave();
  }

  async listSummaries(limit = 20): Promise<SummaryRecord[]> {
    const db = this.db!;
    const result = db.exec(
      'SELECT payload FROM summaries ORDER BY created_at DESC LIMIT ?',
      [Math.min(limit, 200)],
    );
    return rowsToArray<SummaryRecord>(result[0]);
  }

  // -----------------------------------------------------------------------
  // Advice
  // -----------------------------------------------------------------------

  async appendAdvice(advice: AdviceRecord): Promise<void> {
    const db = this.db!;
    db.run('INSERT INTO advice (id, payload, created_at) VALUES (?, ?, ?)', [
      advice.id,
      JSON.stringify(advice),
      advice.createdAt,
    ]);
    this.trimTable('advice');
    this.markSave();
  }

  async listAdvice(limit = 20): Promise<AdviceRecord[]> {
    const db = this.db!;
    const result = db.exec(
      'SELECT payload FROM advice ORDER BY created_at DESC LIMIT ?',
      [Math.min(limit, 200)],
    );
    return rowsToArray<AdviceRecord>(result[0]);
  }

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  async appendCommand(command: CommandRecord): Promise<void> {
    const db = this.db!;
    db.run('INSERT INTO commands (id, payload, created_at) VALUES (?, ?, ?)', [
      command.id,
      JSON.stringify(command),
      command.createdAt,
    ]);
    this.trimTable('commands');
    this.markSave();
  }

  async listCommands(limit = 50): Promise<CommandRecord[]> {
    const db = this.db!;
    const result = db.exec(
      'SELECT payload FROM commands ORDER BY created_at DESC LIMIT ?',
      [Math.min(limit, 500)],
    );
    return rowsToArray<CommandRecord>(result[0]);
  }

  // -----------------------------------------------------------------------
  // Knowledge
  // -----------------------------------------------------------------------

  async appendKnowledgeEntry(entry: KnowledgeEntry): Promise<void> {
    const db = this.db!;
    db.run('INSERT INTO knowledge (id, payload, created_at) VALUES (?, ?, ?)', [
      entry.id,
      JSON.stringify(entry),
      entry.createdAt,
    ]);
    this.trimTable('knowledge');
    this.markSave();
  }

  async listKnowledgeEntries(limit?: number): Promise<KnowledgeEntry[]> {
    const db = this.db!;
    const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 5000) : 5000;
    const result = db.exec(
      'SELECT payload FROM knowledge ORDER BY created_at DESC LIMIT ?',
      [lim],
    );
    return rowsToArray<KnowledgeEntry>(result[0]);
  }

  async listKnowledgeEntriesAfter(cursorId?: string, limit?: number): Promise<KnowledgeEntry[]> {
    const db = this.db!;
    if (!cursorId) {
      const lim = typeof limit === 'number' ? Math.min(limit, 5000) : 5000;
      const result = db.exec(
        'SELECT payload FROM knowledge ORDER BY created_at DESC LIMIT ?',
        [lim],
      );
      return rowsToArray<KnowledgeEntry>(result[0]);
    }

    const cursorResult = db.exec('SELECT created_at FROM knowledge WHERE id = ?', [cursorId]);
    if (cursorResult[0] && cursorResult[0].values[0]) {
      const cursorTime = String(cursorResult[0].values[0][0]);
      const lim = typeof limit === 'number' ? Math.min(limit, 5000) : 5000;
      const result = db.exec(
        'SELECT payload FROM knowledge WHERE created_at > ? ORDER BY created_at ASC LIMIT ?',
        [cursorTime, lim],
      );
      return rowsToArray<KnowledgeEntry>(result[0]);
    }
    return [];
  }

  async getKnowledgeEntry(id: string): Promise<KnowledgeEntry | null> {
    const db = this.db!;
    const result = db.exec('SELECT payload FROM knowledge WHERE id = ?', [id]);
    return rowsToArray<KnowledgeEntry>(result[0])[0] ?? null;
  }

  /**
   * (created_at, id) 复合游标翻页。仅比较 created_at 会漏掉与游标同一毫秒
   * 写入、但 id 排序在后的条目。
   */
  async listKnowledgeEntriesAfterKey(
    cursor: { createdAt: string; id: string } | undefined,
    limit?: number,
  ): Promise<KnowledgeEntry[]> {
    const db = this.db!;
    const lim = typeof limit === 'number' && limit > 0 ? Math.min(limit, 5000) : 5000;
    if (!cursor) {
      return this.listKnowledgeEntries(lim);
    }
    const result = db.exec(
      `SELECT payload FROM knowledge
         WHERE created_at > ? OR (created_at = ? AND id > ?)
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      [cursor.createdAt, cursor.createdAt, cursor.id, lim],
    );
    return rowsToArray<KnowledgeEntry>(result[0]);
  }

  async countKnowledgeEntries(): Promise<number> {
    const db = this.db!;
    const result = db.exec('SELECT COUNT(*) FROM knowledge');
    return Number(result[0]?.values[0]?.[0] ?? 0);
  }

  async deleteKnowledgeEntry(id: string): Promise<string | false> {
    const db = this.db!;
    // Escape LIKE wildcards so ids containing % or _ match literally.
    const pattern = `${id.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = db.exec(
      "SELECT id FROM knowledge WHERE id LIKE ? ESCAPE '\\' LIMIT 2",
      [pattern],
    );
    if (!rows[0] || rows[0].values.length === 0) return false;

    let matchedId: string;
    if (rows[0].values.length > 1) {
      // Ambiguous prefix: only proceed if an exact id match exists.
      const exact = db.exec('SELECT id FROM knowledge WHERE id = ?', [id]);
      if (!exact[0] || exact[0].values.length === 0) return false;
      matchedId = id;
    } else {
      matchedId = String(rows[0].values[0]![0]);
    }
    db.run('DELETE FROM knowledge WHERE id = ?', [matchedId]);
    this.markSave();
    return matchedId;
  }

  // -----------------------------------------------------------------------
  // Plugin namespaced storage
  // -----------------------------------------------------------------------

  namespace(name: string): NamespacedStorage {
    const getDb = (): Database => this.db!;
    const doSave = (): void => this.markSave();
    const warnIfLarge = (): void => {
      // plugin_kv is never pruned (evicting plugin state could corrupt a
      // plugin's invariants), so surface unbounded growth instead of hiding it.
      if (this.pluginKvWarned.has(name)) return;
      const result = getDb().exec('SELECT COUNT(*) FROM plugin_kv WHERE namespace = ?', [name]);
      const count = Number(result[0]?.values[0]?.[0] ?? 0);
      if (count >= PLUGIN_KV_WARN_THRESHOLD) {
        this.pluginKvWarned.add(name);
        console.warn(
          `[storage] plugin namespace "${name}" holds ${count} keys and is never pruned — ` +
            'the plugin should clean up its own state.',
        );
      }
    };

    return {
      async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
        const result = getDb().exec(
          'SELECT value FROM plugin_kv WHERE namespace = ? AND key = ?',
          [name, key],
        );
        if (!result[0] || result[0].values.length === 0) return undefined;
        try {
          return JSON.parse(String(result[0].values[0]![0])) as T;
        } catch {
          return undefined;
        }
      },
      async set<T extends JsonValue = JsonValue>(key: string, value: T): Promise<void> {
        const serialized = JSON.stringify(value) ?? 'null';
        const valueBytes = Buffer.byteLength(serialized, 'utf8');
        if (valueBytes > PLUGIN_KV_MAX_VALUE_BYTES) {
          throw new Error(
            `plugin storage value "${name}/${key}" is ${valueBytes} bytes; ` +
              `the limit is ${PLUGIN_KV_MAX_VALUE_BYTES} bytes (1 MiB)`,
          );
        }

        // 只限制「新增 key」：已有 key 仍可更新，避免插件因写满而无法修正自身状态。
        const existing = getDb().exec(
          'SELECT 1 FROM plugin_kv WHERE namespace = ? AND key = ? LIMIT 1',
          [name, key],
        )[0];
        if (!existing || existing.values.length === 0) {
          const countResult = getDb().exec(
            'SELECT COUNT(*) FROM plugin_kv WHERE namespace = ?',
            [name],
          );
          const count = Number(countResult[0]?.values[0]?.[0] ?? 0);
          if (count >= PLUGIN_KV_MAX_KEYS) {
            throw new Error(
              `plugin storage namespace "${name}" already holds ${count} keys ` +
                `(limit ${PLUGIN_KV_MAX_KEYS}); delete unused keys before adding new ones`,
            );
          }
        }

        getDb().run(
          'INSERT OR REPLACE INTO plugin_kv (namespace, key, value) VALUES (?, ?, ?)',
          [name, key, serialized],
        );
        warnIfLarge();
        doSave();
      },
      async delete(key: string): Promise<void> {
        getDb().run('DELETE FROM plugin_kv WHERE namespace = ? AND key = ?', [name, key]);
        doSave();
      },
      async listKeys(): Promise<string[]> {
        const result = getDb().exec(
          'SELECT key FROM plugin_kv WHERE namespace = ?',
          [name],
        );
        if (!result[0]) return [];
        return result[0].values.map((row: unknown[]) => String(row[0]));
      },
    };
  }

  // -----------------------------------------------------------------------
  // Auto-cleanup
  // -----------------------------------------------------------------------

  private trimTable(table: string): void {
    // Table names are interpolated into SQL below, so assert membership in the
    // known set BEFORE any other use — an unknown name is a bug, not a no-op.
    if (!Object.prototype.hasOwnProperty.call(LIMITS, table)) {
      throw new Error(`refusing to trim unknown table: ${table}`);
    }
    const limit = LIMITS[table];
    if (!limit) return;

    const db = this.db!;
    const countResult = db.exec(`SELECT COUNT(*) FROM ${table}`);
    const count = Number(countResult[0]?.values[0]?.[0] ?? 0);
    if (count <= limit + Math.ceil(limit * 0.2)) return;

    const excess = count - limit;
    db.run(
      `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY created_at ASC LIMIT ?)`,
      [excess],
    );
  }

  /** Trim the events table and keep the in-memory id cache in sync. */
  private trimEvents(): void {
    const limit = LIMITS.events;
    if (!limit) return;

    const db = this.db!;
    const countResult = db.exec('SELECT COUNT(*) FROM events');
    const count = Number(countResult[0]?.values[0]?.[0] ?? 0);
    if (count <= limit + Math.ceil(limit * 0.2)) return;

    const excess = count - limit;
    // The select and the delete must use an identical, fully-deterministic
    // ordering (id as tiebreaker) or the cache prune and the actual delete
    // could disagree about which rows go.
    const doomed = db.exec(
      'SELECT id FROM events ORDER BY created_at ASC, id ASC LIMIT ?',
      [excess],
    );
    if (doomed[0]) {
      for (const row of doomed[0].values) {
        this.eventIdCache.delete(String(row[0]));
      }
    }
    db.run(
      'DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY created_at ASC, id ASC LIMIT ?)',
      [excess],
    );
  }
}
