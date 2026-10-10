/**
 * Factory tests. We mutate the live `config.RERANK_PROVIDER` and call
 * `resetRerankProvider()` so each test gets a fresh instance. Vitest
 * runs files in parallel by default — these tests only touch
 * `config` and the module-level cache, so we mark them serial via
 * `describe.sequential`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../../config.js';
import { getRerankProvider, resetRerankProvider } from '../factory.js';
import { LlmRerankProvider } from '../llmRerank.js';
import { NoopRerankProvider } from '../noopRerank.js';
import { HttpRerankProvider } from '../httpRerank.js';

describe.sequential('rerank factory', () => {
  beforeEach(() => {
    resetRerankProvider();
  });

  it('returns LlmRerankProvider when RERANK_PROVIDER=llm (default)', () => {
    // config is a frozen-ish object exported from config.ts; we mutate
    // the field directly because it's the only way to swap providers
    // at runtime in tests. The factory reads it via `config.RERANK_PROVIDER`.
    (config as { RERANK_PROVIDER: 'llm' | 'http' | 'noop' }).RERANK_PROVIDER = 'llm';
    resetRerankProvider();
    expect(getRerankProvider()).toBeInstanceOf(LlmRerankProvider);
  });

  it('returns NoopRerankProvider when RERANK_PROVIDER=noop', () => {
    (config as { RERANK_PROVIDER: 'llm' | 'http' | 'noop' }).RERANK_PROVIDER = 'noop';
    resetRerankProvider();
    expect(getRerankProvider()).toBeInstanceOf(NoopRerankProvider);
  });

  it('returns HttpRerankProvider when RERANK_PROVIDER=http with RERANK_HTTP_URL', () => {
    (config as { RERANK_PROVIDER: 'llm' | 'http' | 'noop' }).RERANK_PROVIDER = 'http';
    (config as { RERANK_HTTP_URL?: string }).RERANK_HTTP_URL = 'http://tei.local:8001';
    (config as { RERANK_HTTP_MODEL?: string }).RERANK_HTTP_MODEL = 'bge-reranker-v2-m3';
    resetRerankProvider();
    const provider = getRerankProvider();
    expect(provider).toBeInstanceOf(HttpRerankProvider);
    expect(provider.id).toBe('http');
  });

  it('caches the resolved provider until reset', () => {
    (config as { RERANK_PROVIDER: 'llm' | 'http' | 'noop' }).RERANK_PROVIDER = 'noop';
    resetRerankProvider();
    const first = getRerankProvider();
    const second = getRerankProvider();
    expect(first).toBe(second);
  });
});
