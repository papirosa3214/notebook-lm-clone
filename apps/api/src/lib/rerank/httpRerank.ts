import type { RetrievalChunk } from '../../vectordb/client.js';
import type { RerankProvider } from './provider.js';

/**
 * HTTP-based rerank against a TEI-compatible `/rerank` endpoint.
 *
 * Text Embeddings Inference (https://github.com/huggingface/text-embeddings-inference)
 * is the standard way to host bge-reranker-v2-m3 (and any other
 * sentence-transformers cross-encoder) behind a small HTTP server.
 * TEI's `/rerank` accepts the body we send below and returns the same
 * shape, so any rerank server that follows the contract works
 * (FlagEmbedding's rerank-server, Infinity, llama.cpp's rerank, etc.).
 *
 * Example wire-up on the inference box:
 *   docker run -p 8001:80 ghcr.io/huggingface/text-embeddings-inference:1.5 \
 *     --model-id BAAI/bge-reranker-v2-m3
 *   RERANK_PROVIDER=http RERANK_HTTP_URL=http://192.168.1.110:8001
 *
 * Failure handling: any transport / parse / schema error returns the
 * input order unchanged. We treat the rerank step as best-effort —
 * RRF has already given us a defensible baseline.
 */
export class HttpRerankProvider implements RerankProvider {
  readonly id = 'http';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly model?: string;

  constructor(opts: { baseUrl: string; timeoutMs?: number; model?: string }) {
    // Normalise trailing slash so `${baseUrl}/rerank` is always well-formed.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.model = opts.model;
  }

  async rerank(
    query: string,
    candidates: RetrievalChunk[],
    topN: number,
    _opts?: { provider?: string; model?: string },
  ): Promise<RetrievalChunk[]> {
    if (candidates.length <= 1) return candidates.slice(0, topN);
    const effectiveTopN = Math.min(topN, candidates.length);

    // TEI accepts {query, texts: string[]} and returns
    // [{index, score}] or [{index, relevance_score}]. We send the
    // chunk content (not a preview — the cross-encoder reads the
    // whole chunk to score it).
    const body = {
      query,
      texts: candidates.map((c) => c.content),
      ...(this.model ? { model: this.model } : {}),
      // TEI's `top_n` is optional; asking for more than we need is
      // cheaper than asking for exactly N then re-merging.
      top_n: candidates.length,
      return_text: false,
    };

    let parsed: Array<{ index: number; score?: number; relevance_score?: number }>;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return candidates.slice(0, effectiveTopN);
      }
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) return candidates.slice(0, effectiveTopN);
      parsed = data as Array<{ index: number; score?: number; relevance_score?: number }>;
    } catch {
      return candidates.slice(0, effectiveTopN);
    }

    // Sort by score desc, take topN, drop the response's payload.
    // TEI emits {index, score}; some other servers (Infinity) use
    // {index, relevance_score} — accept either.
    return parsed
      .map((entry) => ({
        idx: entry.index,
        score: typeof entry.score === 'number' ? entry.score : entry.relevance_score ?? 0,
      }))
      .filter((entry) => Number.isFinite(entry.idx) && entry.idx >= 0 && entry.idx < candidates.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, effectiveTopN)
      .map((entry) => candidates[entry.idx]!)
      .filter((c): c is RetrievalChunk => c !== undefined);
  }
}
