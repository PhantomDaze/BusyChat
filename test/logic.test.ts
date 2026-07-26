/**
 * Logic / regression tests
 *
 * Covers fixes to message chunking, storage durability, and reply target
 * validation that don't fit the WS/KB/command suites.
 *
 * Run: npx tsx test/logic.test.ts
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { splitLongText, chunkWithPrefixBudget, parseCqString } from '../src/onebot';
import { FileStore } from '../src/storage';
import { ReplyManager } from '../src/reply';
import type {
  Logger,
  ModelAdminGateway,
  NormalizedMessageEvent,
  TextModelResponse,
} from '../src/types';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silentLogger;
  },
};

// ---------------------------------------------------------------------------
// Message chunking
// ---------------------------------------------------------------------------

async function chunkingTests(): Promise<void> {
  console.log('\n[Message Chunking]');

  await test('no chunk exceeds maxLen (sentence boundary at maxLen)', () => {
    // Build text whose char at index maxLen-1 is a sentence terminator, which
    // used to produce a chunk of maxLen+1 via slice(0, splitAt + 1).
    const maxLen = 100;
    const text = 'a'.repeat(maxLen - 1) + '。' + 'b'.repeat(200);
    const chunks = splitLongText(text, maxLen);
    for (const c of chunks) {
      assert(c.length <= maxLen, `chunk length ${c.length} <= ${maxLen}`);
    }
  });

  await test('hard split never exceeds maxLen', () => {
    const maxLen = 50;
    const text = 'x'.repeat(1000);
    const chunks = splitLongText(text, maxLen);
    for (const c of chunks) {
      assert(c.length <= maxLen, `chunk length ${c.length} <= ${maxLen}`);
    }
    assert(chunks.join('') === text, 'no characters lost on hard split');
  });

  await test('chunk + [i/n] prefix stays within the 3800 ceiling', () => {
    const text = '句子。'.repeat(4000); // ~12000 chars, forces many chunks
    const chunks = chunkWithPrefixBudget(text);
    const total = chunks.length;
    assert(total > 1, 'produced multiple chunks');
    for (let i = 0; i < total; i++) {
      const withPrefix = `[${i + 1}/${total}] ` + chunks[i]!;
      assert(withPrefix.length <= 3800, `chunk ${i + 1} with prefix = ${withPrefix.length} <= 3800`);
    }
  });

  await test('short text returns a single chunk with no prefix budget loss', () => {
    const text = 'hello world';
    const chunks = chunkWithPrefixBudget(text);
    assert(chunks.length === 1 && chunks[0] === text, 'single chunk unchanged');
  });
}

// ---------------------------------------------------------------------------
// CQ-code decoding
// ---------------------------------------------------------------------------

async function cqTests(): Promise<void> {
  console.log('\n[CQ Decoding]');

  await test('plain text becomes a single text segment', () => {
    const segs = parseCqString('hello world');
    assert(segs.length === 1 && segs[0]!.type === 'text' && segs[0]!.data.text === 'hello world', 'single text segment');
  });

  await test('at-mention CQ code parses into an at segment', () => {
    const segs = parseCqString('前面 [CQ:at,qq=123456] 后面');
    assert(segs.length === 3, `expected 3 segments, got ${segs.length}`);
    assert(segs[1]!.type === 'at' && segs[1]!.data.qq === '123456', 'at segment with qq');
    assert(segs[0]!.data.text === '前面 ' && segs[2]!.data.text === ' 后面', 'surrounding text preserved');
  });

  await test('CQ escapes are decoded', () => {
    const segs = parseCqString('a&#91;b&#93;c&amp;d [CQ:image,file=x&#44;y.jpg]');
    assert(segs[0]!.data.text === 'a[b]c&d ', `text unescaped, got ${JSON.stringify(segs[0]!.data.text)}`);
    assert(segs[1]!.data.file === 'x,y.jpg', `param comma unescaped, got ${JSON.stringify(segs[1]!.data.file)}`);
  });

  await test('param values containing = survive', () => {
    const segs = parseCqString('[CQ:image,url=https://a/b?x=1&#44;file=z]');
    assert(segs[0]!.type === 'image' && segs[0]!.data.url === 'https://a/b?x=1,file=z', 'value with = kept whole');
  });
}

// ---------------------------------------------------------------------------
// Storage durability
// ---------------------------------------------------------------------------

function makeEvent(id: string, receivedAt?: string): NormalizedMessageEvent {
  return {
    id,
    receivedAt: receivedAt ?? new Date().toISOString(),
    raw: {},
  } as unknown as NormalizedMessageEvent;
}

async function storageTests(): Promise<void> {
  console.log('\n[Storage Durability]');
  const dir = path.join(process.cwd(), '.tmp-logic-test-store');

  await test('data survives close and reopen', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });

    const store = new FileStore(dir);
    await store.ensureReady();
    await store.appendEvent(makeEvent('evt-1'));
    await store.appendEvent(makeEvent('evt-2'));
    await store.close();

    const store2 = new FileStore(dir);
    await store2.ensureReady();
    const events = await store2.listEventsAfter(undefined, 10);
    assert(events.length === 2, `expected 2 events, got ${events.length}`);
    await store2.close();
  });

  await test('duplicate event id is rejected', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const store = new FileStore(dir);
    await store.ensureReady();
    const first = await store.appendEvent(makeEvent('dup'));
    const second = await store.appendEvent(makeEvent('dup'));
    assert(first === true && second === false, 'second insert of same id returns false');
    await store.close();
  });

  await test('cursor paging does not skip events sharing a timestamp', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const store = new FileStore(dir);
    await store.ensureReady();

    // Three events in the same millisecond — a plain `created_at > ?` cursor
    // would drop b and c entirely once a became the cursor.
    const ts = '2026-07-26T10:00:00.000Z';
    await store.appendEvent(makeEvent('a', ts));
    await store.appendEvent(makeEvent('b', ts));
    await store.appendEvent(makeEvent('c', ts));

    const after = await store.listEventsAfter('a', 100);
    const ids = after.map((e) => e.id).sort();
    assert(
      ids.length === 2 && ids[0] === 'b' && ids[1] === 'c',
      `expected [b,c] after cursor a, got [${ids.join(',')}]`,
    );
    await store.close();
  });

  await test('a trimmed cursor resumes from the oldest retained event', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const store = new FileStore(dir);
    await store.ensureReady();

    await store.appendEvent(makeEvent('e1', '2026-07-26T10:00:01.000Z'));
    await store.appendEvent(makeEvent('e2', '2026-07-26T10:00:02.000Z'));
    await store.appendEvent(makeEvent('e3', '2026-07-26T10:00:03.000Z'));

    // Cursor points at an event that no longer exists (trimmed).
    const after = await store.listEventsAfter('long-gone-id', 100);
    assert(after.length === 3, `expected all 3 retained events, got ${after.length}`);
    assert(after[0]!.id === 'e1', `expected oldest first, got ${after[0]!.id}`);
    await store.close();
  });

  await test('deleteKnowledgeEntry escapes LIKE wildcards', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const store = new FileStore(dir);
    await store.ensureReady();
    await store.appendKnowledgeEntry({
      id: 'abc',
      createdAt: new Date().toISOString(),
      text: 'x',
      vector: [1],
      metadata: { source: 't', type: 'user' },
    });
    // '%' must not match 'abc' as a wildcard.
    const missResult = await store.deleteKnowledgeEntry('%');
    assert(missResult === false, "'%' should not delete 'abc'");
    const hit = await store.deleteKnowledgeEntry('abc');
    assert(hit === 'abc', 'exact id deletes and returns matched id');
    await store.close();
  });

  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Reply target validation
// ---------------------------------------------------------------------------

function makeReplyModel(responseText: string): ModelAdminGateway {
  return {
    async generateText(): Promise<TextModelResponse> {
      return { text: responseText, raw: {} };
    },
  } as unknown as ModelAdminGateway;
}

function makeGroupEvent(): NormalizedMessageEvent {
  return {
    id: 'e1',
    receivedAt: new Date().toISOString(),
    scope: 'group',
    conversationId: 'group:1000',
    sender: { userId: '20000', nickname: 'user' },
    content: { text: 'hi', segments: [] },
    visibility: {},
  } as unknown as NormalizedMessageEvent;
}

async function replyTests(): Promise<void> {
  console.log('\n[Reply Target Validation]');

  await test('injected target the admin did not name is ignored', async () => {
    const model = makeReplyModel(
      '回复方式: private\n回复对象ID: 999999999\n回复内容: hello',
    );
    const mgr = new ReplyManager({ models: model, appLogger: silentLogger });
    const pending = mgr.addPending(makeGroupEvent());
    const result = await mgr.generateReply(pending, '在群里回复一下');
    // Must fall back to the originating group, not the injected 999999999.
    assert(result.target.type === 'group', 'target type falls back to group');
    assert(result.target.id === '1000', `target id is origin group, got ${result.target.id}`);
  });

  await test('target the admin explicitly named is honored', async () => {
    const model = makeReplyModel('回复方式: private\n回复对象ID: 88888\n回复内容: ok');
    const mgr = new ReplyManager({ models: model, appLogger: silentLogger });
    const pending = mgr.addPending(makeGroupEvent());
    const result = await mgr.generateReply(pending, '私聊 88888 告诉他');
    assert(result.target.type === 'private' && result.target.id === '88888', 'named target honored');
  });

  await test('private reply to the group sender is allowed without naming the id', async () => {
    // The prompt's own rule: "私聊回复" on a group message goes privately to
    // the sender. This must not be blocked by the injection guard (and must
    // never silently become a public group post).
    const model = makeReplyModel('回复方式: private\n回复对象ID: 20000\n回复内容: 稍后处理');
    const mgr = new ReplyManager({ models: model, appLogger: silentLogger });
    const pending = mgr.addPending(makeGroupEvent());
    const result = await mgr.generateReply(pending, '私聊回复他，说稍后处理');
    assert(
      result.target.type === 'private' && result.target.id === '20000',
      `expected private:20000, got ${result.target.type}:${result.target.id}`,
    );
  });

  await test('reply content never falls back to the admin instruction', async () => {
    // Model omits the 回复内容 header entirely.
    const model = makeReplyModel('我觉得可以这样回复：你好，稍后处理。');
    const mgr = new ReplyManager({ models: model, appLogger: silentLogger });
    const pending = mgr.addPending(makeGroupEvent());
    const result = await mgr.generateReply(pending, '这是管理员的内部指示不要外泄');
    const msg = typeof result.message === 'string' ? result.message : '';
    assert(!msg.includes('内部指示'), 'admin instruction is not leaked as the reply');
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Logic / Regression Tests');
  console.log('='.repeat(50));

  await chunkingTests();
  await cqTests();
  await storageTests();
  await replyTests();

  console.log('\n' + '='.repeat(50));
  console.log(`  Total: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
  console.log('='.repeat(50));

  if (failed > 0) process.exitCode = 1;
}

void main();
