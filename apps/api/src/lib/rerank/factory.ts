import { config } from '../../config.js';
import type { RerankProvider } from './provider.js';
import { LlmRerankProvider } from './llmRerank.js';
import { HttpRerankProvider } from './httpRerank.js';
import { NoopRerankProvider } from './noopRerank.js';

/**
 * Resolve the active RerankProvider from environment configuration.
 *
 * - `RERANK_PROVIDER=llm`  (default) — LLM-rerank, same provider as chat
 * - `RERANK_PROVIDER=http`            — POST /rerank to `RERANK_HTTP_URL`
 *                                       (TEI / FlagEmbedding / Infinity)
 * - `RERANK_PROVIDER=noop`            — pass-through (RRF only)
 *
 * The returned instance is cached at module level because constructing
 * a `HttpRerankProvider` is cheap but pointless to do per call.
 */
let cached: RerankProvider | null = null;

export function getRerankProvider(): RerankProvider {
  if (cached) return cached;
  cached = resolveRerankProvider();
  return cached;
}

/** Test seam: reset the cache so a new env (or a new test) picks up
 *  the right provider without restarting the process. */
export function resetRerankProvider(): void {
  cached = null;
}

function resolveRerankProvider(): RerankProvider {
  const id = (config.RERANK_PROVIDER ?? 'llm').toLowerCase();
  switch (id) {
    case 'http':
      return new HttpRerankProvider({
        baseUrl: config.RERANK_HTTP_URL ?? 'http://127.0.0.1:8001',
        model: config.RERANK_HTTP_MODEL,
        timeoutMs: config.RERANK_TIMEOUT_MS,
      });
    case 'noop':
      return new NoopRerankProvider();
    case 'llm':
    default:
      return new LlmRerankProvider();
  }
}
