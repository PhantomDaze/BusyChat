/**
 * Knowledge Base Tests
 *
 * Tests the KnowledgeService: add, search, delete, list, summarize,
 * vector index rebuild, and cosine similarity math.
 *
 * Run: npx tsx test/knowledge.test.ts
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { KnowledgeService } from '../src/knowledge';
import { FileStore } from '../src/storage';
import type {
  KnowledgeEntry,
  KnowledgeQueryResult,
  Logger,
  ModelAdminGateway,
  RuntimeStore,
  RuntimeState,
  EmbeddingResponse,
  RerankResponse,
  TextModelResponse,
} from '../src/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testsPassed = 0;
let testsFailed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Deterministic embedding helper (SHA-256 based, like the fallback model)
// ---------------------------------------------------------------------------

function deterministicEmbed(texts: string[], dimension: number): number[][] {
  return texts.map((text) => {
    const hash = createHash('sha256').update(text).digest();
    const vector: number[] = [];
    for (let i = 0; i < dimension; i++) {
      const byte = hash[i % hash.length]!;
      vector.push((byte / 128) - 1); // normalize to [-1, 1]
    }
    // L2 normalize
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return vector.map((v) => (norm === 0 ? 0 : v / norm));
  });
}

// ---------------------------------------------------------------------------
// Mock runtime and model
// ---------------------------------------------------------------------------

function createMockRuntimeStore(): RuntimeStore {
  const state: RuntimeState = {
    admins: [],
    onebot: {
      baseUrl: 'http://127.0.0.1:5700',
      apiPrefix: '/api',
      timeoutMs: 5000,
      webSocket: {
        mode: 'off',
        reversePath: '/onebot/ws',
        reconnectIntervalMs: 5000,
        actionTimeoutMs: 3000,
      },
    },
    summary: { enabled: false, intervalMs: 120000, batchSize: 20, maxEventsPerPrompt: 40 },
    knowledgeBase: { enabled: true, maxResults: 10, vectorDimension: 8 },
    activeModels: {
      'memory-summary': 'language-fallback',
      embedding: 'embedding-fallback',
      rerank: 'rerank-fallback',
    },
    models: { language: [], 'speech-to-text': [], embedding: [], rerank: [] },
    plugins: {},
    ui: { enabled: false, title: 'Test' },
  };

  return {
    async snapshot(): Promise<RuntimeState> {
      return JSON.parse(JSON.stringify(state)) as RuntimeState;
    },
    async update(): Promise<RuntimeState> {
      return JSON.parse(JSON.stringify(state)) as RuntimeState;
    },
    async replace(next: RuntimeState): Promise<RuntimeState> {
      Object.assign(state, next);
      return JSON.parse(JSON.stringify(state)) as RuntimeState;
    },
  };
}

function createMockModels(): ModelAdminGateway {
  const dimension = 8; // small dimension for tests

  return {
    async embed(inputs: string[]): Promise<EmbeddingResponse> {
      return { vectors: deterministicEmbed(inputs, dimension) };
    },

    async rerank(query: string, candidates: string[]): Promise<RerankResponse> {
      // Simple word-overlap reranker
      const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
      const ranking = candidates.map((text, index) => {
        const textWords = text.toLowerCase().split(/\s+/).filter(Boolean);
        const overlap = textWords.filter((w) => queryWords.has(w)).length;
        const score = textWords.length > 0
          ? overlap / Math.max(textWords.length, 1)
          : 0;
        return { index, score };
      });
      ranking.sort((a, b) => b.score - a.score);
      return { ranking };
    },

    async generateText(task: string, input: string): Promise<TextModelResponse> {
      return {
        text: `[${task}] Summary of ${input.split('\n').length} lines: key points extracted.`,
      };
    },

    async transcribe(): Promise<{ text: string }> {
      return { text: 'mock transcription' };
    },

    // Admin methods (not needed for service tests)
    listFamilies() { return ['language', 'embedding', 'rerank'] as const; },
    listTasks() { return ['summary', 'memory-summary', 'embedding', 'rerank'] as const; },
    async listModels() { return []; },
    async listModelsByFamily() { return []; },
    async upsertModel() {},
    async setModelEnabled() {},
    async setActiveModel() {},
    async removeModel() {},
  } as ModelAdminGateway;
}

function createMockLogger(name: string): Logger {
  return {
    scope: name,
    child: (scope: string) => createMockLogger(`${name}:${scope}`),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

const TEST_DATA_DIR = path.resolve(process.cwd(), 'data-test-kb');

async function createTestFileStore(): Promise<FileStore> {
  // Clean up any leftover data first to ensure test isolation
  await cleanupTestData();
  await mkdir(TEST_DATA_DIR, { recursive: true });
  const store = new FileStore(TEST_DATA_DIR);
  await store.ensureReady();
  return store;
}

async function cleanupTestData(): Promise<void> {
  try {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Knowledge Base Tests');
  console.log('='.repeat(50));

  // -------------------------------------------------------------------
  // Cosine similarity math
  // -------------------------------------------------------------------
  console.log('\n[Cosine Similarity]');

  await test('identical vectors -> 1.0', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      // Add two entries to verify similarity computation internally
      const e1 = await svc.add('hello world', { source: 'test', type: 'user' });
      const results = await svc.search('hello world', 5);
      assert(results.length >= 1, 'should find the added entry');
      assert(results[0]!.similarityScore > 0.9, `similarity should be high, got ${results[0]!.similarityScore}`);
    } finally {
      await svc.stop();
    }
  });

  await test('orthogonal queries return lower scores', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      await svc.add('machine learning algorithms', { source: 'test', type: 'user' });
      const results = await svc.search('cooking recipes food', 5);
      assert(results.length >= 1, 'should return results');
      assert(results[0]!.similarityScore < 0.9, `unrelated query should have lower similarity, got ${results[0]!.similarityScore}`);
    } finally {
      await svc.stop();
    }
  });

  // -------------------------------------------------------------------
  // CRUD operations
  // -------------------------------------------------------------------
  console.log('\n[CRUD Operations]');

  await test('add creates entry with vector', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      const entry = await svc.add('test knowledge entry', {
        source: 'test',
        type: 'user',
        tags: ['test', 'demo'],
      });

      assert(typeof entry.id === 'string' && entry.id.length > 0, 'entry should have an id');
      assert(entry.text === 'test knowledge entry', 'text should match');
      assert(entry.vector.length > 0, 'vector should not be empty');
      assert(entry.metadata.type === 'user', 'type should be user');
      assert(entry.metadata.tags?.includes('test'), 'tags should include test');
    } finally {
      await svc.stop();
    }
  });

  await test('search returns ranked results', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      await svc.add('Python is a programming language', { source: 'test', type: 'user' });
      await svc.add('JavaScript for web development', { source: 'test', type: 'user' });
      await svc.add('Cooking Italian pasta recipes', { source: 'test', type: 'user' });

      const results = await svc.search('programming code language', 3);
      assert(results.length >= 2, 'should find at least 2 results');

      // First result should be more about programming than cooking
      const firstText = results[0]!.entry.text.toLowerCase();
      assert(
        firstText.includes('python') || firstText.includes('javascript'),
        `first result should be programming-related, got: ${firstText}`,
      );
    } finally {
      await svc.stop();
    }
  });

  await test('search empty index returns empty array', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      const results = await svc.search('anything', 10);
      assert(Array.isArray(results) && results.length === 0, 'should return empty array');
    } finally {
      await svc.stop();
    }
  });

  await test('delete removes from index and storage', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      const entry = await svc.add('entry to delete', { source: 'test', type: 'user' });
      assert((await svc.list()).length === 1, 'should have 1 entry');

      const deleted = await svc.delete(entry.id);
      assert(deleted, 'delete should return true');
      assert((await svc.list()).length === 0, 'should have 0 entries after delete');
    } finally {
      await svc.stop();
    }
  });

  await test('delete nonexistent returns false', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      const deleted = await svc.delete('nonexistent-id');
      assert(!deleted, 'should return false for nonexistent id');
    } finally {
      await svc.stop();
    }
  });

  await test('list returns entries in correct order', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      await svc.add('first entry', { source: 'test', type: 'user' });
      await svc.add('second entry', { source: 'test', type: 'user' });
      await svc.add('third entry', { source: 'test', type: 'user' });

      const list = await svc.list(2);
      assertEqual(list.length, 2, 'should return 2 entries');
      // Most recent first
      assert(list[0]!.text === 'third entry', 'first should be most recent');
      assert(list[1]!.text === 'second entry', 'second should be middle');
    } finally {
      await svc.stop();
    }
  });

  // -------------------------------------------------------------------
  // Memory summarization
  // -------------------------------------------------------------------
  console.log('\n[Memory Summarization]');

  await test('summarize creates summary entry', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      await svc.add('User prefers dark mode UI', { source: 'test', type: 'user' });
      await svc.add('Project deadline is next Friday', { source: 'test', type: 'user' });
      await svc.add('Server needs database migration', { source: 'test', type: 'user' });

      const summary = await svc.summarize();
      assert(summary !== null, 'should create a summary');
      assert(summary!.metadata.type === 'summary', 'summary type should be summary');
      assert(summary!.metadata.summaryOfEntryIds!.length === 3, 'should reference 3 source entries');
      assert(summary!.text.length > 0, 'summary should have text');
    } finally {
      await svc.stop();
    }
  });

  await test('summarize empty returns null', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      const summary = await svc.summarize();
      assert(summary === null, 'should return null for empty index');
    } finally {
      await svc.stop();
    }
  });

  await test('summarize with specific entry IDs', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      const e1 = await svc.add('Important note A', { source: 'test', type: 'user' });
      await svc.add('Noise entry to ignore', { source: 'test', type: 'user' });
      const e3 = await svc.add('Important note B', { source: 'test', type: 'user' });

      const summary = await svc.summarize([e1.id, e3.id]);
      assert(summary !== null, 'should create summary for specific entries');
      assertEqual(summary!.metadata.summaryOfEntryIds!.length, 2, 'should reference 2 entries');
    } finally {
      await svc.stop();
    }
  });

  // -------------------------------------------------------------------
  // Index rebuild
  // -------------------------------------------------------------------
  console.log('\n[Index Rebuild]');

  await test('index is rebuilt on restart', async () => {
    const store = await createTestFileStore();
    const deps = {
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    };

    // First instance - add entries
    const svc1 = new KnowledgeService(deps);
    try {
      await svc1.add('persistent entry 1', { source: 'test', type: 'user' });
      await svc1.add('persistent entry 2', { source: 'test', type: 'user' });
      await svc1.stop();

      // Second instance - should rebuild from storage
      const svc2 = new KnowledgeService(deps);
      await svc2.start();

      const results = await svc2.search('persistent', 5);
      assertEqual(results.length, 2, 'should find both entries after rebuild');

      await svc2.stop();
    } finally {
      await svc1.stop().catch(() => {});
    }
  });

  await test('deleted entries do not reappear after restart', async () => {
    const store = await createTestFileStore();
    const deps = {
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    };

    const svc1 = new KnowledgeService(deps);
    try {
      const entry = await svc1.add('entry to be removed', { source: 'test', type: 'user' });
      await svc1.add('entry to keep', { source: 'test', type: 'user' });
      await svc1.delete(entry.id);
      await svc1.stop();

      const svc2 = new KnowledgeService(deps);
      await svc2.start();

      const list = await svc2.list();
      assertEqual(list.length, 1, 'should have 1 entry after restart');
      assert(list[0]!.text === 'entry to keep', 'kept entry should survive');

      await svc2.stop();
    } finally {
      await svc1.stop().catch(() => {});
    }
  });

  // -------------------------------------------------------------------
  // Status and settings
  // -------------------------------------------------------------------
  console.log('\n[Status & Settings]');

  await test('status returns knowledgeBase settings', async () => {
    const store = await createTestFileStore();
    const svc = new KnowledgeService({
      runtime: createMockRuntimeStore(),
      storage: store,
      models: createMockModels(),
      appLogger: createMockLogger('test'),
    });
    try {
      const status = await svc.status();
      assertEqual(status.enabled, true, 'should be enabled');
      assertEqual(status.maxResults, 10, 'should have default maxResults');
      assertEqual(status.vectorDimension, 8, 'should have test dimension');
    } finally {
      await svc.stop();
    }
  });

  // -------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Total: ${testsPassed + testsFailed}  |  Passed: ${testsPassed}  |  Failed: ${testsFailed}`);
  console.log(`${'='.repeat(50)}`);

  await cleanupTestData();

  if (testsFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
