/**
 * In-memory LRU cache for retrieval results.
 *
 * Keyed by (notebookId, question, topK, provider, model). Stores up to 256
 * entries (~16 MB worst case for large chunks), each TTL 5 min — long enough
 * that a noisy / fast-retried / scrolled-and-asked-again hit is free, short
 * enough that an ingest of a new source doesn't show stale results for long.
 *
 * Intentionally process-local — no Redis, no fsync. If a hot process restarts,
 * we lose the cache and ask Ollama once per question. The vector store is the
 * source of truth, this just hides Ollama latency on repeat queries.
 *
 * We cache *raw* candidate chunks (the wide pool before rerank), not the
 * topK output — rerank is cheap enough to re-run on each call, but rerank
 * output depends on the rerank LLM temperature which we treat as a
 * non-cacheable side effect.
 */

import { createHash } from 'node:crypto';

interface Entry {
  expiresAt: number;
  // Stored loosely to avoid importing the vectordb type from here (circular risk).
  // RetrievalChunk has { id, content, similarity, doc_id, docnm_kwd }.
  chunks: unknown[];
}

const MAX_ENTRIES = 256;
const TTL_MS = 5 * 60 * 1000;

class RetrievalCache {
  private map = new Map<string, Entry>();

  private hashKey(key: {
    notebookId: string;
    question: string;
    topK: number;
    provider?: string;
    model?: string;
  }): string {
    const normalized = key.question.trim().toLowerCase();
    return createHash('sha256')
      .update(key.notebookId)
      .update('|')
      .update(normalized)
      .update('|')
      .update(String(key.topK))
      .update('|')
      .update(key.provider ?? '')
      .update('|')
      .update(key.model ?? '')
      .digest('hex');
  }

  get(key: { notebookId: string; question: string; topK: number; provider?: string; model?: string }): unknown[] | null {
    const k = this.hashKey(key);
    const entry = this.map.get(k);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(k);
      return null;
    }
    // Touch — move to the end so the LRU eviction keeps the working set.
    this.map.delete(k);
    this.map.set(k, entry);
    return entry.chunks;
  }

  set(
    key: { notebookId: string; question: string; topK: number; provider?: string; model?: string },
    chunks: unknown[],
  ): void {
    const k = this.hashKey(key);
    this.map.set(k, { expiresAt: Date.now() + TTL_MS, chunks });
    if (this.map.size > MAX_ENTRIES) {
      // Drop the oldest insertion (first key in iteration order = not recently used).
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
  }

  /** Called by ingest to invalidate cached results after a new source is added.
   *  We can't compute every key a user might ask, so we drop *all* entries for
   *  this notebook. Cheap because we limit not by notebook but by hot-set size. */
  invalidateNotebook(notebookId: string): void {
    // No notebook prefix in the hash (we just hash the whole thing), so we
    // either keep a side index or accept a full flush. Chose flush — it's
    // bounded by MAX_ENTRIES (256) and rarely happens (only on ingest).
    this.map.clear();
    // Suppress unused-param warning until we add the side-index optimisation.
    void notebookId;
  }

  size(): number {
    return this.map.size;
  }
}

export const retrievalCache = new RetrievalCache();
