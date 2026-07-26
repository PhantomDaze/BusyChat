import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import initSqlJs, { type Database, type QueryExecResult } from 'sql.js';

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

/** Warn once a plugin namespace grows past this many keys — nothing prunes it. */
const PLUGIN_KV_WARN_THRESHOLD = 10_000;

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

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
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

export class FileStore {
  private db: Database | null = null;
  private readonly dbPath: string;
  private readonly tmpPath: string;
  private eventIdCache = new Set<string>();
  private savePending = false;
  private saveChain: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private pluginKvWarned = new Set<string>();

  constructor(private readonly rootDir: string) {
    this.dbPath = path.join(rootDir, 'f261agent.db');
    this.tmpPath = `${this.dbPath}.tmp`;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async ensureReady(): Promise<void> {
    await ensureDir(this.rootDir);
    const SQL = await initSqlJs();

    let buffer: Buffer | undefined;
    if (existsSync(this.dbPath)) {
      buffer = await readFile(this.dbPath);
    }

    this.db = new SQL.Database(buffer);
    this.db.run('PRAGMA journal_mode=WAL');
    this.db.run('PRAGMA synchronous=NORMAL');
    this.db.exec(SCHEMA);

    await this.migrateIfNeeded();
    this.rebuildEventCache();
    await this.save();
  }

  private async save(): Promise<void> {
    // Serialize all writes through a single chain so two exports can never
    // race on the same file. Each link first absorbs any predecessor failure
    // (`.catch` before `.then`) — chaining with a bare `.then` would skip every
    // queued write after one failure, including the final flush in close().
    // Each link writes to a temp file then atomically renames it over the real
    // DB, so a crash mid-write can never truncate a previously-good database.
    const link = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        if (!this.db) return;
        this.savePending = false;
        const data = Buffer.from(this.db.export());
        await writeFile(this.tmpPath, data);
        await rename(this.tmpPath, this.dbPath);
      });
    this.saveChain = link;
    return link.catch((err) => {
      // Surface the failure; the chain reference stays on this link so later
      // writes queue behind it rather than racing a still-running export.
      console.error('[storage] failed to persist database:', err);
    });
  }

  /**
   * Schedule a save. Writes are debounced because each save serializes and
   * rewrites the WHOLE database — without coalescing, a busy group would
   * re-export a multi-MB file once per message.
   */
  private markSave(): void {
    if (!this.db || this.closed) return;
    this.savePending = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
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
      return;
    }
    this.closed = true;
    // Force one final save regardless of savePending, then drain the chain.
    this.savePending = false;
    await this.save();
    await this.saveChain.catch(() => undefined);
  }

  /** Flush pending writes without closing the store. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.savePending) {
      await this.saveChain.catch(() => undefined);
      return;
    }
    await this.save();
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
        getDb().run(
          'INSERT OR REPLACE INTO plugin_kv (namespace, key, value) VALUES (?, ?, ?)',
          [name, key, JSON.stringify(value)],
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
