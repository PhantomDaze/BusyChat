import { randomUUID } from 'node:crypto';

import type {
  KnowledgeBaseSettings,
  KnowledgeEntry,
  KnowledgeQueryResult,
  KnowledgeServiceApi,
  Logger,
  ModelAdminGateway,
  PluginConfigStore,
  RuntimeStore,
} from './types';

// ---------------------------------------------------------------------------
// KnowledgeService dependencies
// ---------------------------------------------------------------------------

interface KnowledgeServiceDependencies {
  runtime: RuntimeStore;
  storage: {
    appendKnowledgeEntry(entry: KnowledgeEntry): Promise<void>;
    listKnowledgeEntries(limit?: number): Promise<KnowledgeEntry[]>;
    listKnowledgeEntriesAfter(cursorId?: string, limit?: number): Promise<KnowledgeEntry[]>;
    /**
     * 可选：按 (created_at, id) 复合游标翻页，避免同一时间戳的条目被跳过。
     * storage 层尚未实现时回退到 listKnowledgeEntriesAfter（旧行为）。
     */
    listKnowledgeEntriesAfterKey?(
      cursor: { createdAt: string; id: string } | undefined,
      limit?: number,
    ): Promise<KnowledgeEntry[]>;
    /** 可选：按 id 精确读取条目，供复合游标解析 createdAt。 */
    getKnowledgeEntry?(id: string): Promise<KnowledgeEntry | null>;
    deleteKnowledgeEntry(id: string): Promise<string | false>;
  };
  models: ModelAdminGateway;
  /** 知识库插件配置（存于插件 storage 命名空间） */
  config: PluginConfigStore<KnowledgeBaseSettings>;
  /** 插件在 config.json runtime.plugins 中的名称（用于判断启用状态） */
  pluginName: string;
  appLogger: Logger;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  // Vectors of different dimensions are incomparable — a mismatch means one
  // side was produced by a different embedding model (e.g. the rule-based
  // fallback). Returning 0 keeps those entries out of the results instead of
  // zero-padding them into a bogus non-zero score.
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 运行时校验持久化/上游返回的向量：非数组、空数组、含非有限数字都视为无效。 */
function isValidVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

// ---------------------------------------------------------------------------
// KnowledgeService
// ---------------------------------------------------------------------------

export class KnowledgeService implements KnowledgeServiceApi {
  private vectorIndex: Array<{ id: string; vector: number[] }> = [];
  /** 未显式配置 vectorDimension 时，观察到的第一个向量维度。 */
  private observedDimension: number | undefined;
  /** 混合维度只告警一次，避免每次 add 都刷日志。 */
  private dimensionWarned = false;

  constructor(private readonly deps: KnowledgeServiceDependencies) {}

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    await this.rebuildIndex();
    this.deps.appLogger.info('knowledge service started', {
      entries: this.vectorIndex.length,
    });
  }

  async stop(): Promise<void> {
    this.vectorIndex = [];
    this.deps.appLogger.info('knowledge service stopped');
  }

  async status(): Promise<KnowledgeBaseSettings & { observedDimension?: number }> {
    const config = await this.deps.config.get();
    return {
      ...config,
      enabled: await this.isEnabled(),
      ...(config.vectorDimension === undefined && this.observedDimension !== undefined
        ? { observedDimension: this.observedDimension }
        : {}),
    };
  }

  /** 知识库开关 = builtin-knowledge 插件是否启用 */
  private async isEnabled(): Promise<boolean> {
    const runtime = await this.deps.runtime.snapshot();
    return runtime.plugins[this.deps.pluginName]?.enabled !== false;
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  async add(
    text: string,
    metadata: KnowledgeEntry['metadata'],
  ): Promise<KnowledgeEntry> {
    if (!(await this.isEnabled())) {
      throw new Error('knowledge base is disabled');
    }

    const config = await this.deps.config.get();
    const response = await this.deps.models.embed([text], {
      source: 'knowledge-add',
    });

    const vector = response.vectors[0];
    if (!vector || vector.length === 0) {
      throw new Error('embedding model returned empty vector');
    }
    if (!isValidVector(vector)) {
      throw new Error('embedding model returned non-numeric vector values');
    }
    // Optional strict dimension check: a vector of the wrong width would be
    // stored but never match anything (cosineSimilarity returns 0 on length
    // mismatch), so fail loudly instead of persisting a dead entry.
    const expectedDim = config.vectorDimension;
    if (expectedDim && vector.length !== expectedDim) {
      throw new Error(
        `embedding dimension mismatch: got ${vector.length}, expected ${expectedDim} (builtin-knowledge config)`,
      );
    }
    this.recordVectorDimension(vector.length);

    const entry: KnowledgeEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      text,
      vector,
      metadata: {
        ...metadata,
        source: metadata.source || 'unknown',
        type: metadata.type || 'user',
      },
    };

    await this.deps.storage.appendKnowledgeEntry(entry);
    this.vectorIndex.push({ id: entry.id, vector });

    this.deps.appLogger.debug('knowledge entry added', {
      id: entry.id,
      textPreview: text.slice(0, 80),
      vectorDim: vector.length,
    });

    return entry;
  }

  async search(
    query: string,
    limit?: number,
  ): Promise<KnowledgeQueryResult[]> {
    if (this.vectorIndex.length === 0) {
      return [];
    }

    const config = await this.deps.config.get();
    const maxResults = limit ?? config.maxResults;

    // Step 1: Embed the query
    const response = await this.deps.models.embed([query], {
      source: 'knowledge-search',
    });
    const queryVector = response.vectors[0];
    if (!queryVector || !isValidVector(queryVector)) {
      return [];
    }

    // Step 2: Cosine similarity against all entries. 单条坏向量（缺字段/空/
    // 非数字）只跳过该条，不能让整个检索抛错。
    const scored: Array<{ id: string; score: number }> = [];
    for (const item of this.vectorIndex) {
      if (!isValidVector(item.vector)) continue;
      scored.push({ id: item.id, score: cosineSimilarity(queryVector, item.vector) });
    }
    scored.sort((a, b) => b.score - a.score);

    // Step 3: Retrieve wider set for rerank
    const retrievalCount = Math.min(scored.length, maxResults * 3);
    const topCandidates = scored.slice(0, retrievalCount);

    // Look up full entries from storage
    const allEntries = await this.deps.storage.listKnowledgeEntries();
    const entryMap = new Map(allEntries.map((e) => [e.id, e]));

    // Keep each score bound to its entry: an indexed id missing from storage
    // (e.g. trimmed away) must not shift every following entry's score.
    const candidates: Array<{ entry: KnowledgeEntry; score: number }> = [];
    for (const candidate of topCandidates) {
      const entry = entryMap.get(candidate.id);
      if (entry) candidates.push({ entry, score: candidate.score });
    }

    // Step 4: Rerank if we have more than maxResults
    const results: KnowledgeQueryResult[] = [];

    if (candidates.length > maxResults) {
      try {
        const rerankResponse = await this.deps.models.rerank(
          query,
          candidates.map((c) => c.entry.text),
          { source: 'knowledge-search' },
        );

        const rerankScores = new Map(
          rerankResponse.ranking.map((r) => [r.index, r.score]),
        );

        for (let i = 0; i < candidates.length; i++) {
          const { entry, score } = candidates[i]!;
          const item: KnowledgeQueryResult = {
            entry,
            similarityScore: score,
          };
          const rs = rerankScores.get(i);
          if (rs !== undefined) {
            item.rerankScore = rs;
          }
          results.push(item);
        }

        results.sort(
          (a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0),
        );
      } catch {
        // Rerank failed — fall back to similarity-only ordering
        this.deps.appLogger.warn('rerank failed, falling back to similarity');
        for (const { entry, score } of candidates) {
          results.push({ entry, similarityScore: score });
        }
      }
    } else {
      for (const { entry, score } of candidates) {
        results.push({ entry, similarityScore: score });
      }
    }

    return results.slice(0, maxResults);
  }

  async delete(id: string): Promise<boolean> {
    // Delete from storage first — it resolves prefix ids to the exact id that
    // was actually removed, which we then use to keep the in-memory index in
    // sync (a plain `id !== item.id` filter would miss prefix deletions).
    const matchedId = await this.deps.storage.deleteKnowledgeEntry(id);

    const targetId = matchedId || id;
    const before = this.vectorIndex.length;
    this.vectorIndex = this.vectorIndex.filter((item) => item.id !== targetId);
    const removed = this.vectorIndex.length < before;

    if (removed || matchedId) {
      this.deps.appLogger.debug('knowledge entry deleted', { id: targetId });
    }

    return removed || Boolean(matchedId);
  }

  async list(limit?: number): Promise<KnowledgeEntry[]> {
    return this.deps.storage.listKnowledgeEntries(limit ?? 50);
  }

  async listAfter(
    cursorId?: string,
    limit?: number,
  ): Promise<KnowledgeEntry[]> {
    const max = limit ?? 50;
    const { storage } = this.deps;

    if (!cursorId) {
      return storage.listKnowledgeEntriesAfter(undefined, max);
    }

    // 优先使用 (created_at, id) 复合游标：仅按 created_at > cursor 比较会漏掉
    // 与游标同一时间戳、但 id 更大的条目。
    if (storage.listKnowledgeEntriesAfterKey) {
      const cursorEntry = storage.getKnowledgeEntry
        ? await storage.getKnowledgeEntry(cursorId)
        : (await storage.listKnowledgeEntries()).find((entry) => entry.id === cursorId) ??
          null;
      if (!cursorEntry) return [];
      return storage.listKnowledgeEntriesAfterKey(
        { createdAt: cursorEntry.createdAt, id: cursorEntry.id },
        max,
      );
    }

    // 回退：存储层尚未提供复合游标时，从最近条目里补齐与游标同时间戳、
    // 但 id 更大的条目，避免它们因为 `created_at > cursor` 被永久跳过。
    const recent = await storage.listKnowledgeEntries();
    const cursorEntry = recent.find((entry) => entry.id === cursorId);
    const later = await storage.listKnowledgeEntriesAfter(cursorId, max);
    if (!cursorEntry) return later;

    const sameTimestamp = recent.filter(
      (entry) => entry.createdAt === cursorEntry.createdAt && entry.id > cursorEntry.id,
    );
    if (sameTimestamp.length === 0) return later;

    return [...sameTimestamp, ...later]
      .sort((a, b) => {
        const byTime = a.createdAt.localeCompare(b.createdAt);
        return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
      })
      .slice(0, max);
  }

  // -----------------------------------------------------------------------
  // Memory summarization
  // -----------------------------------------------------------------------

  async summarize(
    entryIds?: string[],
    timeRange?: { after: string; before: string },
  ): Promise<KnowledgeEntry | null> {
    const runtime = await this.deps.runtime.snapshot();

    let entries: KnowledgeEntry[];

    if (entryIds && entryIds.length > 0) {
      // Fetch specific entries
      const all = await this.deps.storage.listKnowledgeEntries();
      const idSet = new Set(entryIds);
      entries = all.filter((e) => idSet.has(e.id));
    } else {
      entries = await this.deps.storage.listKnowledgeEntries(50);
    }

    // Apply time range filter if provided
    if (timeRange) {
      entries = entries.filter((e) => {
        const after = timeRange.after ? e.createdAt >= timeRange.after : true;
        const before = timeRange.before
          ? e.createdAt <= timeRange.before
          : true;
        return after && before;
      });
    }

    if (entries.length === 0) {
      return null;
    }

    // Build summarization prompt
    const itemsText = entries
      .map((e, i) => {
        const date = e.createdAt.slice(0, 19).replace('T', ' ');
        return `[${i + 1}] (${date}) [${e.metadata.type}] ${e.text}`;
      })
      .join('\n\n');

    const prompt = [
      '你是一个记忆总结助手。请阅读以下知识库条目，生成一份简洁的记忆总结。',
      '总结应包括：',
      '1. 核心主题和关键信息',
      '2. 重要的时间节点或关联关系',
      '3. 值得注意的待办事项或后续行动',
      '',
      '--- 知识库条目 ---',
      itemsText,
      '',
      '请用中文输出总结：',
    ].join('\n');

    const response = await this.deps.models.generateText(
      'memory-summary',
      prompt,
      {
        source: 'knowledge-summarize',
        entryCount: entries.length,
      },
    );

    // Store the summary as a new knowledge entry
    const summaryEntry = await this.add(response.text, {
      source: 'summary',
      type: 'summary',
      summaryOfEntryIds: entries.map((e) => e.id),
      modelId:
        runtime.activeModels['memory-summary'] ?? 'language-fallback',
    });

    this.deps.appLogger.info('memory summary generated', {
      summaryId: summaryEntry.id,
      sourceEntryCount: entries.length,
    });

    return summaryEntry;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * 记录向量维度：首个有效向量确定 observedDimension；之后出现不同维度时
   * 只告警一次（通常意味着混用了不同 embedding 模型）。
   */
  private recordVectorDimension(dimension: number): void {
    if (this.observedDimension === undefined) {
      this.observedDimension = dimension;
      return;
    }
    if (this.observedDimension !== dimension && !this.dimensionWarned) {
      this.dimensionWarned = true;
      this.deps.appLogger.warn('knowledge base has mixed embedding dimensions', {
        observedDimension: this.observedDimension,
        newDimension: dimension,
      });
    }
  }

  private async rebuildIndex(): Promise<void> {
    const entries = await this.deps.storage.listKnowledgeEntries();
    const next: Array<{ id: string; vector: number[] }> = [];
    let skipped = 0;

    for (const entry of entries) {
      const vector = (entry as { vector?: unknown }).vector;
      if (!isValidVector(vector)) {
        // 缺向量/空向量/非数字向量：跳过而不是让整个索引重建失败。
        skipped += 1;
        continue;
      }
      next.push({ id: entry.id, vector });
      this.recordVectorDimension(vector.length);
    }

    this.vectorIndex = next;
    if (skipped > 0) {
      this.deps.appLogger.warn('knowledge vector index skipped invalid entries', {
        skipped,
        indexed: next.length,
      });
    }
    this.deps.appLogger.debug('knowledge vector index rebuilt', {
      entries: this.vectorIndex.length,
    });
  }
}
