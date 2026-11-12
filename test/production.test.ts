/**
 * Production-hardening regression tests
 *
 * Covers the durability, auth, retry and summary guarantees that the other
 * suites do not: atomic writes, corrupt-DB recovery, the single-instance lock,
 * last-known-good config, password hashing/migration, WebUI auth edge cases,
 * upstream retry behaviour and summary cursor semantics.
 *
 * Run: npx tsx test/production.test.ts
 */

import { copyFile, chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type AddressInfo } from 'node:http';
import * as path from 'node:path';

import {
  createDefaultAppConfig,
  createDefaultAppSettings,
  createDefaultRuntimeState,
} from '../src/config';
import { JsonConfigStore, saveAppConfigFile } from '../src/config-store';
import { atomicWriteFile } from '../src/fs-utils';
import { ModelRegistry } from '../src/models';
import { credentialFingerprint, hashPassword, verifyPassword } from '../src/security';
import { FileStore } from '../src/storage';
import { SummaryWorker } from '../src/summary';
import { createWebServer } from '../src/webui';
import type {
  Logger,
  ModelConfig,
  NormalizedMessageEvent,
  StorageHealthSnapshot,
  SummaryRecord,
  SummarySettings,
  UiSettings,
} from '../src/types';

let passed = 0;
let failed = 0;
let skipped = 0;
let skippedNow = false;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  skippedNow = false;
  try {
    await fn();
    if (!skippedNow) {
      passed++;
      console.log(`  ✓ ${name}`);
    }
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

function skip(name: string, reason: string): void {
  skipped++;
  skippedNow = true;
  console.log(`  - ${name} (skipped: ${reason})`);
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 暂时静音 console.error：测试会故意触发存储/配置错误，避免污染输出。 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

const silentLogger: Logger = {
  scope: 'test',
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silentLogger;
  },
};

const isPosix = process.platform !== 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const tmpRoot = path.join(process.cwd(), '.tmp-prod-test');

async function freshDir(name: string): Promise<string> {
  const dir = path.join(tmpRoot, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

function modeOf(filePath: string): Promise<number> {
  return stat(filePath).then((info) => info.mode & 0o777);
}

function makeEvent(id: string, receivedAt = new Date().toISOString()): NormalizedMessageEvent {
  return {
    id,
    source: 'onebot-v11',
    receivedAt,
    botSelfId: '10000',
    scope: 'group',
    conversationId: 'group:1000',
    messageId: undefined,
    sender: {
      userId: '20000',
      nickname: 'user',
      card: undefined,
      role: 'member',
      isAdmin: false,
      isBot: false,
    },
    content: { text: 'hi', segments: [], rawText: 'hi' } as any,
    raw: {} as any,
    visibility: {
      fromAdmin: false,
      fromBot: false,
      includeInReports: true,
      eligibleForAdvice: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Storage durability
// ---------------------------------------------------------------------------

async function storageDurabilityTests(): Promise<void> {
  console.log('\n[Storage Durability]');

  await check('atomic write leaves no partial .tmp file and the full payload', async () => {
    const dir = await freshDir('atomic');
    const file = path.join(dir, 'value.json');
    await atomicWriteFile(file, 'old-value');
    await atomicWriteFile(file, 'new-value');
    assert((await readFile(file, 'utf8')) === 'new-value', 'target holds the new payload');
    const entries = await readdir(dir);
    assert(!entries.some((entry) => entry.endsWith('.tmp')), `no temp file left behind: ${entries.join(',')}`);
    if (isPosix) {
      assert((await modeOf(file)) === 0o600, `atomic file mode is 0600, got 0${(await modeOf(file)).toString(8)}`);
    }
  });

  await check('failed atomic write keeps the previous file intact', async () => {
    if (!isPosix) {
      skip('failed atomic write keeps the previous file intact', 'POSIX permissions required');
      return;
    }
    if (isRoot) {
      skip('failed atomic write keeps the previous file intact', 'root ignores directory permissions');
      return;
    }
    const dir = await freshDir('atomic-fail');
    const file = path.join(dir, 'value.json');
    await atomicWriteFile(file, 'known-good');
    await chmod(dir, 0o500);
    let threw = false;
    try {
      await atomicWriteFile(file, 'should-not-land');
    } catch {
      threw = true;
    } finally {
      await chmod(dir, 0o700);
    }
    assert(threw, 'write into an unwritable directory rejects');
    assert((await readFile(file, 'utf8')) === 'known-good', 'old content is preserved');
    const entries = await readdir(dir);
    assert(!entries.some((entry) => entry.endsWith('.tmp')), 'failed write cleans up its temp file');
  });

  await check('dataDir is 0700, DB and config files are 0600', async () => {
    const dir = await freshDir('permissions');
    const store = new FileStore(dir);
    await store.ensureReady();
    await store.appendEvent(makeEvent('perm-event'));
    await store.close();

    const configPath = path.join(dir, 'config.json');
    const configStore = new JsonConfigStore(configPath);
    await configStore.ensureReady();

    if (isPosix) {
      assert((await modeOf(dir)) === 0o700, `dataDir mode is 0700, got 0${(await modeOf(dir)).toString(8)}`);
      const dbMode = await modeOf(path.join(dir, 'f261agent.db'));
      assert(dbMode === 0o600, `DB mode is 0600, got 0${dbMode.toString(8)}`);
      const configMode = await modeOf(configPath);
      assert(configMode === 0o600, `config mode is 0600, got 0${configMode.toString(8)}`);
    }
  });

  await check('flush and close surface an injected save failure', async () => {
    if (!isPosix) {
      skip('flush and close surface an injected save failure', 'POSIX permissions required');
      return;
    }
    if (isRoot) {
      skip('flush and close surface an injected save failure', 'root ignores directory permissions');
      return;
    }
    const dir = await freshDir('save-failure');
    const store = new FileStore(dir);
    await store.ensureReady();
    await store.appendEvent(makeEvent('fail-event'));

    await chmod(dir, 0o500);
    let flushError: unknown;
    let closeError: unknown;
    try {
      await quietly(async () => {
        try {
          await store.flush();
        } catch (error) {
          flushError = error;
        }
        try {
          await store.close();
        } catch (error) {
          closeError = error;
        }
      });
    } finally {
      await chmod(dir, 0o700);
    }

    const flushMessage = flushError instanceof Error ? flushError.message : String(flushError);
    const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
    assert(flushError instanceof Error, 'flush rejects when the DB cannot be written');
    assert(/EACCES|save/i.test(flushMessage), `flush surfaces the save failure, got: ${flushMessage}`);
    assert(closeError instanceof Error, 'close rejects when the final save cannot be written');
    assert(/EACCES|save/i.test(closeMessage), `close surfaces the save failure, got: ${closeMessage}`);
  });

  await check('instance lock rejects a second store and allows it after close', async () => {
    const dir = await freshDir('instance-lock');
    const first = new FileStore(dir);
    await first.ensureReady();

    const second = new FileStore(dir);
    let lockedError = '';
    try {
      await second.ensureReady();
    } catch (error) {
      lockedError = error instanceof Error ? error.message : String(error);
    }
    assert(lockedError.includes('already locked by live process'), `second store is rejected: ${lockedError}`);

    await first.close();
    await quietly(async () => {
      await second.ensureReady();
    });
    await second.appendEvent(makeEvent('after-close'));
    await second.close();
  });

  await check('stale lock with a dead pid is reclaimed', async () => {
    const dir = await freshDir('stale-lock');
    const lockPath = path.join(dir, 'instance.lock');
    // 2^31-2 is outside the Linux pid range, so kill(pid, 0) reports ESRCH.
    await writeFile(lockPath, JSON.stringify({ pid: 2147483646, startedAt: new Date().toISOString() }), {
      mode: 0o600,
    });
    const store = new FileStore(dir);
    await quietly(async () => {
      await store.ensureReady();
    });
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number };
    assert(owner.pid === process.pid, `lock now belongs to this process, got ${String(owner.pid)}`);
    await store.close();
  });

  await check('knowledge composite cursor does not skip same-timestamp entries', async () => {
    const dir = await freshDir('kb-cursor');
    const store = new FileStore(dir);
    await store.ensureReady();
    const createdAt = '2026-01-01T00:00:00.000Z';
    const base = {
      createdAt,
      updatedAt: createdAt,
      vector: [1, 0],
      metadata: { source: 'test', type: 'user' as const },
    };
    await store.appendKnowledgeEntry({ id: 'kb-a', text: 'a', ...base });
    await store.appendKnowledgeEntry({ id: 'kb-b', text: 'b', ...base });
    await store.appendKnowledgeEntry({
      id: 'kb-c',
      text: 'c',
      ...base,
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });

    const after = await store.listKnowledgeEntriesAfterKey({ createdAt, id: 'kb-a' }, 10);
    assert(after.map((entry) => entry.id).join(',') === 'kb-b,kb-c', `cursor resumes after kb-a, got ${after.map((entry) => entry.id).join(',')}`);
    const exact = await store.getKnowledgeEntry('kb-b');
    assert(exact?.text === 'b', 'getKnowledgeEntry returns the requested entry');
    await store.close();
  });

  await check('0-byte DB is rejected and a valid .bak is recovered', async () => {
    const dir = await freshDir('backup-recovery');
    const dbPath = path.join(dir, 'f261agent.db');
    const bakPath = `${dbPath}.bak`;

    const seed = new FileStore(dir);
    await seed.ensureReady();
    await seed.appendEvent(makeEvent('recovered-event'));
    await seed.close();
    // Simulate a known-good previous snapshot.
    await copyFile(dbPath, bakPath);
    // Then truncate the live DB to 0 bytes (the classic power-loss shape).
    await writeFile(dbPath, Buffer.alloc(0));

    const restored = new FileStore(dir);
    await quietly(async () => {
      await restored.ensureReady();
    });
    const events = await restored.listEventsAfter(undefined, 10);
    assert(events.length === 1 && events[0]!.id === 'recovered-event', `event restored from backup, got ${events.length}`);
    await restored.close();
  });
}

// ---------------------------------------------------------------------------
// 2. Config store
// ---------------------------------------------------------------------------

async function configStoreTests(): Promise<void> {
  console.log('\n[Config Store]');

  await check('revision changes after a successful write', async () => {
    const dir = await freshDir('config-revision');
    const store = new JsonConfigStore(path.join(dir, 'config.json'));
    await store.ensureReady();
    const before = store.getRevision();
    assert(before.length === 64, `revision is a sha256 hex digest, got ${before.length} chars`);

    await store.update((state) => {
      state.admins = ['42'];
    });
    const after = store.getRevision();
    assert(after.length === 64 && after !== before, 'revision changes after a write');
    const snapshot = await store.snapshotConfig();
    assert(snapshot.runtime.admins.includes('42'), 'write is visible in the snapshot');
  });

  await check('a corrupt file mid-run keeps the last-known-good config', async () => {
    const dir = await freshDir('config-corrupt');
    const file = path.join(dir, 'config.json');
    const store = new JsonConfigStore(file);
    await store.ensureReady();
    await store.update((state) => {
      state.admins = ['777'];
    });

    await delay(30);
    await quietly(async () => {
      await writeFile(file, '{ this is not json', 'utf8');
      const runtime = await store.snapshot();
      assert(runtime.admins.includes('777'), 'last-known-good runtime is served');
      assert(store.getLastError() !== undefined, 'load failure is recorded');
    });
  });

  await check('a valid rewrite recovers after corruption', async () => {
    const dir = await freshDir('config-recover');
    const file = path.join(dir, 'config.json');
    const store = new JsonConfigStore(file);
    await store.ensureReady();
    await store.update((state) => {
      state.admins = ['111'];
    });
    const revisionBefore = store.getRevision();

    await delay(30);
    await quietly(async () => {
      await writeFile(file, 'garbage', 'utf8');
      await store.snapshot();
    });

    const fixed = createDefaultAppConfig();
    fixed.runtime.admins = ['999'];
    await delay(30);
    await saveAppConfigFile(file, fixed);

    const runtime = await store.snapshot();
    assert(runtime.admins.includes('999'), `rewritten config is loaded, got [${runtime.admins.join(',')}]`);
    assert(store.getLastError() === undefined, 'error is cleared after recovery');
    assert(store.getRevision() !== revisionBefore, 'revision reflects the recovered content');
  });
}

// ---------------------------------------------------------------------------
// 3. Password helpers & legacy migration
// ---------------------------------------------------------------------------

async function passwordTests(): Promise<void> {
  console.log('\n[Password]');

  await check('scrypt hash verifies its password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert(hash.startsWith('scrypt$'), `hash uses scrypt format, got ${hash.slice(0, 20)}`);
    const ui: UiSettings = { enabled: true, title: 'test', passwordHash: hash };
    assert(await verifyPassword('correct horse battery staple', ui), 'correct password verifies');
    assert(!(await verifyPassword('wrong password', ui)), 'wrong password is rejected');
  });

  await check('legacy plaintext password still verifies', async () => {
    const ui: UiSettings = { enabled: true, title: 'test', password: 'legacy-secret' };
    assert(await verifyPassword('legacy-secret', ui), 'legacy plaintext verifies');
    assert(!(await verifyPassword('legacy-secret-2', ui)), 'wrong legacy plaintext is rejected');
  });

  await check('credential fingerprint changes with the password', async () => {
    const first = await hashPassword('first-password');
    const second = await hashPassword('second-password');
    const fpFirst = credentialFingerprint({ enabled: true, title: 't', passwordHash: first });
    const fpSecond = credentialFingerprint({ enabled: true, title: 't', passwordHash: second });
    assert(fpFirst !== fpSecond, 'different hashes produce different fingerprints');
    const fpLegacyA = credentialFingerprint({ enabled: true, title: 't', password: 'legacy-a' });
    const fpLegacyB = credentialFingerprint({ enabled: true, title: 't', password: 'legacy-b' });
    assert(fpLegacyA !== fpLegacyB, 'different legacy passwords produce different fingerprints');
  });

  await check('ui.password -> passwordHash migration is idempotent', async () => {
    const dir = await freshDir('password-migration');
    const file = path.join(dir, 'config.json');
    const initial = createDefaultAppConfig();
    initial.runtime.ui.password = 'legacy-secret';
    await saveAppConfigFile(file, initial);

    const store = new JsonConfigStore(file);
    await store.ensureReady();

    // 与 BotApplication.migrateLegacyUiPassword（private）相同的步骤。
    const migrate = async (): Promise<void> => {
      const runtime = await store.snapshot();
      const plaintext = runtime.ui.password;
      if (!plaintext || runtime.ui.passwordHash) return;
      const passwordHash = await hashPassword(plaintext);
      await store.update((state) => {
        if (!state.ui.password || state.ui.passwordHash) return;
        state.ui.passwordHash = passwordHash;
        delete state.ui.password;
      });
    };

    await migrate();
    const first = await store.snapshot();
    assert(Boolean(first.ui.passwordHash?.startsWith('scrypt$')), 'plaintext is migrated to a scrypt hash');
    assert(first.ui.password === undefined, 'plaintext is removed');
    const firstHash = first.ui.passwordHash;

    await migrate();
    const second = await store.snapshot();
    assert(second.ui.passwordHash === firstHash, 'second migration is a no-op');
    assert(await verifyPassword('legacy-secret', second.ui), 'migrated hash still verifies the old password');
  });
}

// ---------------------------------------------------------------------------
// 4. WebUI hardening (live Hapi server)
// ---------------------------------------------------------------------------

/** 发送带自定义 Host 头的原始 GET，用于验证 DNS rebinding 防护。 */
function rawGet(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function webUiTests(): Promise<void> {
  console.log('\n[WebUI Hardening]');

  const runtimeState = createDefaultRuntimeState();
  // 无密码、无 token：回环直连可用，代理转发/远程来源必须被拒绝。
  const settings = { ...createDefaultAppSettings(), host: '127.0.0.1', port: 0, trustProxy: true };

  let storageHealthOk = true;
  const storageCalls: Array<{ cursor?: string; limit?: number }> = [];
  const storage = {
    async listSummaries() {
      return [];
    },
    async listAdvice() {
      return [];
    },
    async listCommands() {
      return [];
    },
    async listEventsAfter(cursor?: string, limit?: number) {
      const call: { cursor?: string; limit?: number } = {};
      if (cursor !== undefined) call.cursor = cursor;
      if (limit !== undefined) call.limit = limit;
      storageCalls.push(call);
      return [];
    },
    async countKnowledgeEntries() {
      return 0;
    },
    getHealth(): StorageHealthSnapshot {
      return { ok: storageHealthOk, sizeBytes: 0, locked: true };
    },
  };

  const pluginRoutes: Array<{ owner: string; route: any }> = [];
  const plugins = {
    async list() {
      return [];
    },
    collectWebUiRoutes() {
      return pluginRoutes;
    },
  };
  const probeCalls: ModelConfig[] = [];
  const models = {
    async listModels() {
      return runtimeState.models.language;
    },
    listTasks() {
      return ['summary'];
    },
    listFamilies() {
      return ['language', 'embedding', 'rerank', 'speech-to-text'];
    },
    async hasOnlyFallbackModels() {
      return false;
    },
    async testConnection(model: ModelConfig) {
      probeCalls.push(model);
      return 'ok';
    },
    async listRemoteModels() {
      return [];
    },
    async setActiveModel() {
      throw new Error('setActiveModel should not be called for an invalid task');
    },
    async setModelEnabled() {
      throw new Error('setModelEnabled should not be called for a non-boolean payload');
    },
  };
  const summaries = { async status() {
    return {};
  }, async start() {} };
  const knowledge = {
    async status() {
      return { enabled: true, maxResults: 10 };
    },
  };

  const runtime = {
    async snapshot() {
      return runtimeState;
    },
    async update(fn: (state: any) => unknown) {
      await fn(runtimeState);
      return runtimeState;
    },
    async replace(next: any) {
      return next;
    },
  };
  const config = {
    async snapshotConfig() {
      return { settings, runtime: runtimeState };
    },
    async ensureReady() {},
    async replaceConfig(next: any) {
      return next;
    },
  };

  const server = await createWebServer({
    settings,
    config,
    runtime,
    models,
    plugins,
    summaries,
    knowledge,
    storage,
    handleIncomingEvent: async () => ({}),
    appLogger: silentLogger,
  } as any);
  await server.start();
  const port = (server.info as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    await check('no-password + trustProxy + non-loopback X-Forwarded-For -> 401', async () => {
      const response = await fetch(`${base}/api/state`, {
        headers: { 'x-forwarded-for': '203.0.113.5' },
      });
      assert(response.status === 401, `expected 401, got ${response.status}`);
    });

    await check('DNS-rebinding Host header is rejected when no password is set', async () => {
      const status = await rawGet(`${base}/api/state`, 'evil.test');
      assert(status === 401, `expected 401 for a non-loopback Host, got ${status}`);
    });

    await check('loopback no-password still works', async () => {
      const response = await fetch(`${base}/api/state`);
      assert(response.status === 200, `expected 200, got ${response.status}`);
    });

    await check('cross-origin POST /api/admins is rejected with 403', async () => {
      const response = await fetch(`${base}/api/admins`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.test' },
        body: JSON.stringify({ userId: '12345' }),
      });
      assert(response.status === 403, `expected 403, got ${response.status}`);
    });

    await check('form-encoded POST /api/admins is rejected (415/400)', async () => {
      const response = await fetch(`${base}/api/admins`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'userId=12345',
      });
      assert(
        response.status === 415 || response.status === 400,
        `expected 415/400, got ${response.status}`,
      );
    });

    await check('/health always returns 200, even with the WebUI disabled', async () => {
      runtimeState.ui.enabled = false;
      const response = await fetch(`${base}/health`);
      const body = (await response.json()) as { ok?: boolean };
      assert(response.status === 200 && body.ok === true, `expected 200/ok, got ${response.status}`);
      const disabledApi = await fetch(`${base}/api/state`);
      assert(disabledApi.status === 404, `disabled UI returns 404 for /api/state, got ${disabledApi.status}`);
      runtimeState.ui.enabled = true;
    });

    await check('/health/ready is 200 with healthy storage and 503 when storage is not ok', async () => {
      const healthy = await fetch(`${base}/health/ready`);
      const healthyBody = (await healthy.json()) as any;
      assert(healthy.status === 200, `expected 200, got ${healthy.status}`);
      assert(healthyBody.checks?.storage?.ok === true, 'storage check is ok');

      storageHealthOk = false;
      const unhealthy = await fetch(`${base}/health/ready`);
      const unhealthyBody = (await unhealthy.json()) as any;
      assert(unhealthy.status === 503, `expected 503, got ${unhealthy.status}`);
      assert(unhealthyBody.checks?.storage?.ok === false, 'storage check reports not ok');
      storageHealthOk = true;
    });

    await check('events?limit=-1 stays capped at the default', async () => {
      storageCalls.length = 0;
      const response = await fetch(`${base}/api/events?limit=-1`);
      assert(response.status === 200, `expected 200, got ${response.status}`);
      const call = storageCalls.at(-1);
      assert(call?.limit === 64, `expected default limit 64, got ${String(call?.limit)}`);
    });

    await check('invalid task activate returns 400', async () => {
      const response = await fetch(`${base}/api/models/not-a-task/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: 'm1' }),
      });
      assert(response.status === 400, `expected 400, got ${response.status}`);
    });

    await check('model enabled without a boolean returns 400', async () => {
      const response = await fetch(`${base}/api/models/m1/enabled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      });
      assert(response.status === 400, `expected 400, got ${response.status}`);
    });

    await check('a probe with a changed baseUrl never receives the saved API key', async () => {
      runtimeState.models.language = [
        {
          id: 'm-key',
          label: 'Key Model',
          family: 'language',
          provider: 'openai-compatible',
          enabled: true,
          taskBindings: ['summary'],
          parameters: { baseUrl: 'https://api.example/v1', apiKey: 'sk-secret', model: 'm' },
        },
      ];
      probeCalls.length = 0;
      const response = await fetch(`${base}/api/models/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'm-key',
          family: 'language',
          provider: 'openai-compatible',
          parameters: { baseUrl: 'https://evil.test/v1', apiKey: '__redacted__' },
        }),
      });
      const body = (await response.json()) as { warning?: string };
      assert(response.status === 200, `expected 200, got ${response.status}`);
      assert(typeof body.warning === 'string', 'a warning explains the key was not restored');
      assert(
        probeCalls.at(-1)?.parameters?.apiKey === undefined,
        'the saved key is not sent to the changed baseUrl',
      );
    });

    await check('a probe with the same baseUrl restores the saved API key', async () => {
      probeCalls.length = 0;
      const response = await fetch(`${base}/api/models/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'm-key',
          family: 'language',
          provider: 'openai-compatible',
          parameters: { baseUrl: 'https://api.example/v1/', apiKey: '__redacted__' },
        }),
      });
      const body = (await response.json()) as { warning?: string };
      assert(response.status === 200, `expected 200, got ${response.status}`);
      assert(body.warning === undefined, 'no warning when the target is unchanged');
      assert(
        probeCalls.at(-1)?.parameters?.apiKey === 'sk-secret',
        'the saved key is restored for the same baseUrl',
      );
    });

    await check('invalid WebSocket mode returns 400', async () => {
      const response = await fetch(`${base}/api/ws-config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'sideways' }),
      });
      assert(response.status === 400, `expected 400, got ${response.status}`);
    });

    await check('a plugin route registered after start is served', async () => {
      pluginRoutes.push({
        owner: 'prod-test-plugin',
        route: {
          method: 'GET',
          path: '/api/plugin/ping',
          handler: async () => ({ ok: true, ping: 'pong' }),
        },
      });
      const response = await fetch(`${base}/api/plugin/ping`);
      const body = (await response.json()) as { ping?: string };
      assert(response.status === 200 && body.ping === 'pong', `expected 200/pong, got ${response.status}`);
    });

    await check('plugin requireAuth:false route still requires auth', async () => {
      // 路由已在上一个用例中注册；带远程 X-Forwarded-For 时不是本机直连。
      const response = await fetch(`${base}/api/plugin/ping`, {
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      assert(response.status === 401, `expected 401, got ${response.status}`);
    });
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// 5. Model retry semantics
// ---------------------------------------------------------------------------

async function modelRetryTests(): Promise<void> {
  console.log('\n[Model Retry]');

  let chatCalls = 0;
  let badCalls = 0;
  let embedCalls = 0;
  const upstream = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const url = request.url ?? '';
      if (url === '/v1/chat/completions') {
        chatCalls += 1;
        if (chatCalls <= 2) {
          response.writeHead(500, { 'content-type': 'application/json', 'retry-after': '0' });
          response.end('{"error":"temporary"}');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: 'upstream-ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      if (url === '/bad/v1/chat/completions') {
        badCalls += 1;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{"error":"invalid request"}');
        return;
      }
      if (url === '/v1/embeddings') {
        embedCalls += 1;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end('{"error":"bad input"}');
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const badBaseUrl = `http://127.0.0.1:${address.port}/bad/v1`;

  const state = createDefaultRuntimeState();
  state.models.language = [
    {
      id: 'bad-model',
      label: 'Bad',
      family: 'language',
      provider: 'openai-compatible',
      enabled: true,
      taskBindings: ['chat'],
      parameters: { baseUrl: badBaseUrl, model: 'bad', apiKey: 'sk-test', maxRetries: 2 },
    },
    {
      id: 'real-model',
      label: 'Real',
      family: 'language',
      provider: 'openai-compatible',
      enabled: true,
      taskBindings: ['chat'],
      parameters: { baseUrl, model: 'real', apiKey: 'sk-test', maxRetries: 2 },
    },
  ];
  state.models.embedding = [
    {
      id: 'real-embedding',
      label: 'Real Embedding',
      family: 'embedding',
      provider: 'openai-compatible',
      enabled: true,
      taskBindings: ['embedding'],
      parameters: { baseUrl, model: 'embed', apiKey: 'sk-test', maxRetries: 0 },
    },
  ];
  state.activeModels.chat = 'real-model';
  state.activeModels.embedding = 'real-embedding';

  const runtime = {
    async snapshot() {
      return state;
    },
    async update(fn: (value: typeof state) => unknown) {
      await fn(state);
      return state;
    },
    async replace(next: typeof state) {
      return next;
    },
  };
  const registry = new ModelRegistry(runtime, silentLogger);

  try {
    await check('OpenAI-compatible generateText retries 5xx and then succeeds', async () => {
      const result = await registry.generateText('chat', 'hello');
      assert(result.text === 'upstream-ok', `expected upstream text, got ${result.text}`);
      assert(chatCalls === 3, `expected 3 upstream calls (2 failures + success), got ${chatCalls}`);
      assert(result.degraded !== true, 'successful call is not marked degraded');
    });

    await check('a 400 is not retried', async () => {
      state.activeModels.chat = 'bad-model';
      const result = await registry.generateText('chat', 'hello');
      assert(badCalls === 1, `expected exactly 1 upstream call, got ${badCalls}`);
      assert(result.degraded === true, 'provider failure falls back and is marked degraded');
    });

    await check('embeddings never fall back to the rule-based embedder on failure', async () => {
      let rejected = false;
      try {
        await registry.embed(['hello']);
      } catch {
        rejected = true;
      }
      assert(rejected, 'embed() rejects instead of returning rule-based vectors');
      assert(embedCalls === 1, `expected 1 embedding call, got ${embedCalls}`);
    });
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// 6. Summary semantics
// ---------------------------------------------------------------------------

async function summaryTests(): Promise<void> {
  console.log('\n[Summary Semantics]');

  const events = [makeEvent('summary-event-1', '2026-11-12T00:00:00.000Z')];
  const summaries: SummaryRecord[] = [];
  const sent: Array<{ userId: string; message: string }> = [];
  const dispatched: SummaryRecord[] = [];
  let degraded = true;
  let cfg: SummarySettings = {
    enabled: true,
    intervalMs: 3_600_000,
    batchSize: 1,
    maxEventsPerPrompt: 40,
  };

  const configStore = {
    async get() {
      return { ...cfg };
    },
    async update(mutator: (current: SummarySettings) => SummarySettings) {
      cfg = mutator({ ...cfg });
      return { ...cfg };
    },
    async reset(next: SummarySettings) {
      cfg = { ...next };
      return { ...cfg };
    },
  };

  const storage = {
    async listEventsAfter() {
      return events;
    },
    async appendSummary(summary: SummaryRecord) {
      summaries.push(summary);
    },
  };

  const bot = {
    async sendPrivateMessage(userId: string, message: any) {
      sent.push({ userId, message: String(message) });
      return {} as any;
    },
  };

  const modelsStub = {
    async generateText(task: string) {
      if (task === 'classifier') return { text: '1:3', raw: {} };
      if (task === 'summary') {
        if (degraded) {
          return {
            text: '摘要（fallback）\n规则兜底',
            degraded: true,
            modelId: 'real-model',
            provider: 'openai-compatible',
            raw: {},
          };
        }
        return {
          text: '摘要：测试摘要\n建议：测试建议',
          modelId: 'real-model',
          provider: 'openai-compatible',
          raw: {},
        };
      }
      throw new Error(`unexpected task ${task}`);
    },
  };

  const plugins = {
    async dispatchSummary(summary: SummaryRecord) {
      dispatched.push(summary);
    },
  };

  const runtime = {
    async snapshot() {
      return { admins: ['90001'] };
    },
  };

  const worker = new SummaryWorker({
    runtime,
    storage,
    bot,
    models: modelsStub,
    plugins,
    config: configStore,
    appLogger: silentLogger,
  } as any);

  try {
    await check('a degraded model response does not append a summary or advance the cursor', async () => {
      const record = await worker.flush('manual');
      assert(record === null, 'flush returns null when the model is degraded');
      assert(summaries.length === 0, 'no summary is persisted');
      assert(sent.length === 0, 'nothing is delivered');
      assert(cfg.cursorEventId === undefined, 'cursor is not advanced');
      const status = await worker.status();
      assert(status.degraded !== null, 'degraded state is surfaced');
    });

    await check('a successful send appends the summary and advances the cursor', async () => {
      degraded = false;
      const record = await worker.flush('manual');
      assert(record !== null, 'flush returns the persisted summary');
      assert(summaries.length === 1, `expected 1 summary, got ${summaries.length}`);
      assert(sent.length === 1 && sent[0]!.userId === '90001', 'summary is delivered to the admin');
      assert(cfg.cursorEventId === 'summary-event-1', `cursor advanced to the last event, got ${String(cfg.cursorEventId)}`);
      assert(dispatched.length === 1, 'summary is dispatched to plugins');
      const status = await worker.status();
      assert(status.degraded === null, 'degraded state is cleared after success');
    });
  } finally {
    await worker.stop();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Production Hardening Tests');
  console.log('='.repeat(50));

  try {
    await storageDurabilityTests();
    await configStoreTests();
    await passwordTests();
    await webUiTests();
    await modelRetryTests();
    await summaryTests();
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  console.log('\n' + '='.repeat(50));
  console.log(
    `  Total: ${passed + failed + skipped}  |  Passed: ${passed}  |  Failed: ${failed}` +
      (skipped > 0 ? `  |  Skipped: ${skipped}` : ''),
  );
  console.log('='.repeat(50));
  if (failed > 0) process.exitCode = 1;
}

void main();
