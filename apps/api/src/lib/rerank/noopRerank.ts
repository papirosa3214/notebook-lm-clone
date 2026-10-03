import type { RetrievalChunk } from '../../vectordb/client.js';
import type { RerankProvider } from './provider.js';

/**
 * Pass-through rerank. Used as the kill switch (set RERANK_PROVIDER=noop)
 * and as the implicit fallback for the LLM/Http providers when they fail
 * to score anything usable. The retrieval pipeline already merges dense
 * and BM25 via RRF, so dropping the rerank step just means we trust
 * that merge alone.
 */
export class NoopRerankProvider implements RerankProvider {
  readonly id = 'noop';

  async rerank(
    _query: string,
    candidates: RetrievalChunk[],
    topN: number,
    _opts?: { provider?: string; model?: string },
  ): Promise<RetrievalChunk[]> {
    return candidates.slice(0, Math.min(topN, candidates.length));
  }
}
