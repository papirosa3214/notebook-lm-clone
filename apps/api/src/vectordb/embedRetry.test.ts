/**
 * The embed server in this setup is loaded on demand next to a resident 27B
 * chat model, so "server busy" is a routine answer, not an outage. These
 * tests pin the policy: a busy server is retried, a broken one is not, and
 * the caller is told which of the two happened.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { embed, VectorDbError } from '../vectordb/client.js';

const DIM = config.EMBEDDING_DIM;
const originalFetch = globalThis.fetch;

function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return new Response(typeof r!.body === 'string' ? r!.body : JSON.stringify(r!.body), {
      status: r!.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return () => call;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('embed', () => {
  it('returns the vector on a normal response', async () => {
    stubFetch([{ status: 200, body: { embedding: new Array(DIM).fill(0.1) } }]);
    const vec = await embed('привет');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(DIM);
  });

  it('retries through 503 "server busy" and succeeds', async () => {
    const calls = stubFetch([
      { status: 503, body: { error: 'server busy, please try again.  maximum pending requests exceeded' } },
      { status: 503, body: { error: 'server busy' } },
      { status: 200, body: { embedding: new Array(DIM).fill(0.2) } },
    ]);

    const vec = await embed('привет');
    expect(vec.length).toBe(DIM);
    expect(calls()).toBe(3);
  });

  it('retries 429 as well', async () => {
    const calls = stubFetch([
      { status: 429, body: { error: 'too many requests' } },
      { status: 200, body: { embedding: new Array(DIM).fill(0.3) } },
    ]);
    await embed('привет');
    expect(calls()).toBe(2);
  });

  it('gives up after the retry budget and names the server as busy', async () => {
    const calls = stubFetch([
      { status: 503, body: { error: 'server busy, please try again.  maximum pending requests exceeded' } },
    ]);

    await expect(embed('привет')).rejects.toThrow(/занята/);
    // 1 initial attempt + one per configured delay.
    expect(calls()).toBeGreaterThan(1);
  }, 20_000);

  it('does NOT retry a hard error — a 400 means the request itself is wrong', async () => {
    const calls = stubFetch([{ status: 400, body: { error: 'invalid model' } }]);

    await expect(embed('привет')).rejects.toThrow(VectorDbError);
    expect(calls()).toBe(1);
  });

  it('does not retry a 500 — retrying a payload Ollama rejected just wastes time', async () => {
    const calls = stubFetch([{ status: 500, body: { error: 'boom' } }]);

    await expect(embed('привет')).rejects.toThrow(/embed failed/);
    expect(calls()).toBe(1);
  });

  it('reports a dimension mismatch instead of writing a broken vector', async () => {
    stubFetch([{ status: 200, body: { embedding: [0.1, 0.2] } }]);
    await expect(embed('привет')).rejects.toThrow(/dim mismatch/);
  });
});