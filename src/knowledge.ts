import { randomUUID } from 'node:crypto';

import type {
  KnowledgeBaseSettings,
  KnowledgeEntry,
  KnowledgeQueryResult,
  KnowledgeServiceApi,
  Logger,
  ModelAdminGateway,
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
    deleteKnowledgeEntry(id: string): Promise<string | false>;
  };
  models: ModelAdminGateway;
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

// ---------------------------------------------------------------------------
// KnowledgeService
// ---------------------------------------------------------------------------

export class KnowledgeService implements KnowledgeServiceApi {
  private vectorIndex: Array<{ id: string; vector: number[] }> = [];

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

  async status(): Promise<KnowledgeBaseSettings> {
    const runtime = await this.deps.runtime.snapshot();
    return runtime.knowledgeBase;
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  async add(
    text: string,
    metadata: KnowledgeEntry['metadata'],
  ): Promise<KnowledgeEntry> {
    const runtime = await this.deps.runtime.snapshot();
    if (!runtime.knowledgeBase.enabled) {
      throw new Error('knowledge base is disabled');
    }

    const response = await this.deps.models.embed([text], {
      source: 'knowledge-add',
    });

    const vector = response.vectors[0];
    if (!vector || vector.length === 0) {
      throw new Error('embedding model returned empty vector');
    }
    // Optional strict dimension check: a vector of the wrong width would be
    // stored but never match anything (cosineSimilarity returns 0 on length
    // mismatch), so fail loudly instead of persisting a dead entry.
    const expectedDim = runtime.knowledgeBase.vectorDimension;
    if (expectedDim && vector.length !== expectedDim) {
      throw new Error(
        `embedding dimension mismatch: got ${vector.length}, expected ${expectedDim} (runtime.knowledgeBase.vectorDimension)`,
      );
    }

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

    const runtime = await this.deps.runtime.snapshot();
    const maxResults = limit ?? runtime.knowledgeBase.maxResults;

    // Step 1: Embed the query
    const response = await this.deps.models.embed([query], {
      source: 'knowledge-search',
    });
    const queryVector = response.vectors[0];
    if (!queryVector || queryVector.length === 0) {
      return [];
    }

    // Step 2: Cosine similarity against all entries
    const scored = this.vectorIndex.map((item) => ({
      id: item.id,
      score: cosineSimilarity(queryVector, item.vector),
    }));
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
    return this.deps.storage.listKnowledgeEntriesAfter(
      cursorId,
      limit ?? 50,
    );
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

  private async rebuildIndex(): Promise<void> {
    const entries = await this.deps.storage.listKnowledgeEntries();
    this.vectorIndex = entries.map((entry) => ({
      id: entry.id,
      vector: entry.vector,
    }));
    this.deps.appLogger.debug('knowledge vector index rebuilt', {
      entries: this.vectorIndex.length,
    });
  }
}
