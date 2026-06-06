import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

const LIMITS: Record<string, number> = {
  events: 64,
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
  return result.values.map((row: unknown[]) => JSON.parse(String(row[0])) as T);
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
  private eventIdCache = new Set<string>();
  private savePending = false;

  constructor(private readonly rootDir: string) {
    this.dbPath = path.join(rootDir, 'f261agent.db');
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
    if (!this.db) return;
    this.savePending = false;
    const data = Buffer.from(this.db.export());
    await writeFile(this.dbPath, data);
  }

  private markSave(): void {
    if (this.savePending || !this.db) return;
    this.savePending = true;
    setImmediate(() => {
      void this.save();
    });
  }

  // -----------------------------------------------------------------------
  // Migration from old NDJSON files
  // -----------------------------------------------------------------------

  private async migrateIfNeeded(): Promise<void> {
    const db = this.db!;
    const countResult = db.exec('SELECT COUNT(*) as c FROM events');
    if (countResult[0] && Number(countResult[0].values[0]?.[0]) > 0) return;

    const migrations: Array<{ file: string; table: string }> = [
      { file: 'events.ndjson', table: 'events' },
      { file: 'summaries.ndjson', table: 'summaries' },
      { file: 'advice.ndjson', table: 'advice' },
      { file: 'commands.ndjson', table: 'commands' },
      { file: 'knowledge.ndjson', table: 'knowledge' },
    ];

    for (const { file, table } of migrations) {
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
    }

    // Migrate plugin state JSON files
    try {
      const pluginDir = path.join(this.rootDir, 'plugins');
      const { readdir } = await import('node:fs/promises');
      let files: string[] = [];
      try { files = await readdir(pluginDir); } catch { /* empty */ }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const ns = f.replace(/\.json$/, '');
        try {
          const raw = await readFile(path.join(pluginDir, f), 'utf8');
          const obj = JSON.parse(raw) as JsonObject;
          const stmt = db.prepare(
            'INSERT OR REPLACE INTO plugin_kv (namespace, key, value) VALUES (?, ?, ?)',
          );
          for (const [key, value] of Object.entries(obj)) {
            stmt.run([ns, key, JSON.stringify(value)]);
          }
          stmt.free();
        } catch { /* corrupt */ }
      }
    } catch { /* no plugin dir */ }

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
    this.trimTable('events');
    this.markSave();
    return true;
  }

  async listEventsAfter(cursorEventId?: string, limit?: number): Promise<NormalizedMessageEvent[]> {
    const db = this.db!;
    if (cursorEventId) {
      const cursorResult = db.exec('SELECT created_at FROM events WHERE id = ?', [cursorEventId]);
      if (cursorResult[0] && cursorResult[0].values[0]) {
        const cursorTime = String(cursorResult[0].values[0][0]);
        const lim = typeof limit === 'number' ? Math.min(limit, 500) : 500;
        const result = db.exec(
          'SELECT payload FROM events WHERE created_at > ? ORDER BY created_at ASC LIMIT ?',
          [cursorTime, lim],
        );
        return rowsToArray<NormalizedMessageEvent>(result[0]);
      }
      // Cursor was trimmed — return latest batch
      const lim = typeof limit === 'number' ? limit : 32;
      const result = db.exec(
        'SELECT payload FROM events ORDER BY created_at DESC LIMIT ?',
        [lim],
      );
      const items = rowsToArray<NormalizedMessageEvent>(result[0]);
      return items.reverse();
    }

    const lim = typeof limit === 'number' ? Math.min(limit, 500) : 64;
    const result = db.exec(
      'SELECT payload FROM events ORDER BY created_at DESC LIMIT ?',
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

  async deleteKnowledgeEntry(id: string): Promise<boolean> {
    const db = this.db!;
    const rows = db.exec('SELECT id FROM knowledge WHERE id LIKE ? LIMIT 2', [`${id}%`]);
    if (!rows[0] || rows[0].values.length === 0) return false;

    if (rows[0].values.length > 1) {
      const exact = db.exec('SELECT id FROM knowledge WHERE id = ?', [id]);
      if (!exact[0] || exact[0].values.length === 0) return false;
      db.run('DELETE FROM knowledge WHERE id = ?', [id]);
    } else {
      const matchedId = String(rows[0].values[0]![0]);
      db.run('DELETE FROM knowledge WHERE id = ?', [matchedId]);
    }
    this.markSave();
    return true;
  }

  // -----------------------------------------------------------------------
  // Plugin namespaced storage
  // -----------------------------------------------------------------------

  namespace(name: string): NamespacedStorage {
    const getDb = (): Database => this.db!;
    const doSave = (): void => this.markSave();

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
}
