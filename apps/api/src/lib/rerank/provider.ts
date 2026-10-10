import type { RetrievalChunk } from '../../vectordb/client.js';

/**
 * A rerank provider takes a list of retrieval candidates (already ranked
 * by RRF merge of dense + BM25) and returns them re-ordered by a more
 * expressive relevance signal. Top-N truncation is part of the contract:
 * the provider returns the top `topN` after re-ranking, not the full
 * list. That keeps the call-site simple.
 *
 * Three providers ship today (see ./providers.ts for the factory):
 *   - LlmRerankProvider     — uses the chat LLM (qwen3.6 / Haiku / etc.)
 *                             to score each candidate 0-10. Default.
 *                             Slow but works without extra infrastructure.
 *   - HttpRerankProvider    — POST {query, documents[]} to a TEI-compatible
 *                             /rerank endpoint. ~300 ms per call when
 *                             backed by bge-reranker-v2-m3 on the same
 *                             GPU as the chat LLM.
 *   - NoopRerankProvider    — pass-through (no re-ranking). Useful as
 *                             a kill switch via env.
 */
export interface RerankProvider {
  /** Stable identifier for log lines and the /api/providers family. */
  readonly id: string;
  /**
   * Re-rank `candidates` for `query` and return the top `topN` of them.
   *
   * Implementations must:
   *  - never throw on transport / parse failures — fall back to the
   *    input order (caller already trusts the RRF baseline).
   *  - never return more than `topN` items.
   *  - never mutate `candidates`.
   *
   `opts` is provider-specific (e.g. LlmRerankProvider uses it to pick
   * the chat LLM); the contract only requires `query`, `candidates`,
   * `topN`.
   */
  rerank(
    query: string,
    candidates: RetrievalChunk[],
    topN: number,
    opts?: { provider?: string; model?: string },
  ): Promise<RetrievalChunk[]>;
}
