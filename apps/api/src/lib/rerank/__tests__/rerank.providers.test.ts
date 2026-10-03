/**
 * Unit tests for the RerankProvider implementations.
 *
 * Each test pins one observable behaviour of one provider. We mock
 * `globalThis.fetch` (HttpRerankProvider) and inject a fake chat
 * provider (LlmRerankProvider) so the suite stays hermetic — no real
 * Ollama, no real TEI, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoopRerankProvider } from '../noopRerank.js';
import { HttpRerankProvider } from '../httpRerank.js';
import { LlmRerankProvider, parseScoreArray } from '../llmRerank.js';
import type { RetrievalChunk } from '../../../vectordb/client.js';

function chunk(i: number, content: string): RetrievalChunk {
  return {
    id: `c${i}`,
    source_id: `s${i}`,
    notebook_id: 'n1',
    document_keyword: `Title ${i}`,
    content,
    similarity: 0.5,
  } as unknown as RetrievalChunk;
}

describe('NoopRerankProvider', () => {
  it('returns the first topN candidates in input order', async () => {
    const provider = new NoopRerankProvider();
    const candidates = [chunk(0, 'a'), chunk(1, 'b'), chunk(2, 'c'), chunk(3, 'd')];
    const result = await provider.rerank('q', candidates, 2);
    expect(result.map((c) => c.id)).toEqual(['c0', 'c1']);
  });

  it('returns all candidates when topN exceeds the list', async () => {
    const provider = new NoopRerankProvider();
    const result = await provider.rerank('q', [chunk(0, 'a'), chunk(1, 'b')], 10);
    expect(result).toHaveLength(2);
  });
});

describe('HttpRerankProvider', () => {
  const originalFetch = globalThis.fetch;
  let mocked: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocked = vi.fn();
    globalThis.fetch = mocked as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to /rerank with the TEI shape and re-orders by score', async () => {
    mocked.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { index: 2, score: 0.9 },
          { index: 0, score: 0.4 },
          { index: 1, score: 0.2 },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new HttpRerankProvider({ baseUrl: 'http://tei.local:8001' });
    const candidates = [chunk(0, 'a'), chunk(1, 'b'), chunk(2, 'c')];
    const result = await provider.rerank('what is foo', candidates, 2);

    expect(result.map((c) => c.id)).toEqual(['c2', 'c0']);
    expect(mocked).toHaveBeenCalledTimes(1);
    const [url, init] = mocked.mock.calls[0]!;
    expect(url).toBe('http://tei.local:8001/rerank');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.query).toBe('what is foo');
    expect(body.texts).toEqual(['a', 'b', 'c']);
    expect(body.top_n).toBe(3);
    expect(body.return_text).toBe(false);
  });

  it('accepts the {relevance_score} alias used by some TEI forks', async () => {
    mocked.mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ index: 1, relevance_score: 0.7 }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const provider = new HttpRerankProvider({ baseUrl: 'http://tei' });
    const result = await provider.rerank('q', [chunk(0, 'a'), chunk(1, 'b')], 1);
    expect(result.map((c) => c.id)).toEqual(['c1']);
  });

  it('falls back to input order on HTTP error', async () => {
    mocked.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const provider = new HttpRerankProvider({ baseUrl: 'http://tei' });
    const candidates = [chunk(0, 'a'), chunk(1, 'b')];
    const result = await provider.rerank('q', candidates, 2);
    expect(result.map((c) => c.id)).toEqual(['c0', 'c1']);
  });

  it('falls back to input order on transport error', async () => {
    mocked.mockRejectedValueOnce(new Error('econnrefused'));
    const provider = new HttpRerankProvider({ baseUrl: 'http://tei' });
    const candidates = [chunk(0, 'a'), chunk(1, 'b')];
    const result = await provider.rerank('q', candidates, 2);
    expect(result.map((c) => c.id)).toEqual(['c0', 'c1']);
  });

  it('skips out-of-range indices in the response', async () => {
    mocked.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { index: 99, score: 1.0 },
          { index: 0, score: 0.5 },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const provider = new HttpRerankProvider({ baseUrl: 'http://tei' });
    const result = await provider.rerank('q', [chunk(0, 'a'), chunk(1, 'b')], 1);
    // index=99 is out of range and must be dropped, not crash the call.
    expect(result.map((c) => c.id)).toEqual(['c0']);
  });

  it('trims a trailing slash on the baseUrl', async () => {
    mocked.mockResolvedValueOnce(
      new Response(JSON.stringify([{ index: 0, score: 1 }, { index: 1, score: 0.5 }]), {
        status: 200,
      }),
    );
    const provider = new HttpRerankProvider({ baseUrl: 'http://tei/' });
    await provider.rerank('q', [chunk(0, 'a'), chunk(1, 'b')], 2);
    expect(mocked.mock.calls[0]![0]).toBe('http://tei/rerank');
  });
});

describe('LlmRerankProvider', () => {
  it('parses a clean JSON array of scores', () => {
    expect(parseScoreArray('[{"idx":0,"score":8},{"idx":1,"score":2}]', 2)).toEqual([8, 2]);
  });

  it('parses fenced JSON (```json … ```)', () => {
    expect(parseScoreArray('```json\n[{"idx":0,"score":7}]\n```', 1)).toEqual([7]);
  });

  it('clamps out-of-range scores to [0, 10]', () => {
    expect(parseScoreArray('[{"idx":0,"score":-3},{"idx":1,"score":99}]', 2)).toEqual([0, 10]);
  });

  it('fills missing indices with 0', () => {
    expect(parseScoreArray('[{"idx":0,"score":5}]', 3)).toEqual([5, 0, 0]);
  });

  it('returns null on garbage input', () => {
    expect(parseScoreArray('this is not json at all', 3)).toBeNull();
  });

  it('returns null when the JSON is valid but not an array', () => {
    expect(parseScoreArray('{"idx":0,"score":1}', 1)).toBeNull();
  });
});
