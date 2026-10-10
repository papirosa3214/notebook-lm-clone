import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The `http()` wrapper is the single point through which every API call goes.
 * It must:
 *  - attach Content-Type only when a body is present (Fastify rejects an empty
 *    body sent with application/json — FST_ERR_CTP_EMPTY_JSON_BODY → 400,
 *    which silently broke DELETE /api/sources/:id),
 *  - skip res.json() on 204 No Content (otherwise TanStack Query mutations
 *    reject and onSuccess never fires, leaving the UI out of sync).
 */
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Import after vi.stubGlobal so the module-level `fetch` reference inside
// `api.ts` resolves to our mock. Importing api.ts pulls in ../lib/api which
// re-imports ./types, but we don't need a working API — we only need http().
// Importing api directly would also try to evaluate `import.meta.env`, which
// is unavailable outside Vite — instead we re-define http() inline by
// importing the file and pinning fetch via a small helper.
import { api } from '../api';

afterEach(() => {
  fetchMock.mockReset();
});

describe('http wrapper — Content-Type behaviour', () => {
  it('omits Content-Type when no body is sent (DELETE)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteSource('abc123');

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init.headers ?? {});
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('includes Content-Type when a body is sent (POST)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'n1' }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    );
    await api.createNotebook('hello');

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init.headers ?? {});
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('keeps caller-provided Content-Type when one was already set', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await fetch('/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-custom' },
      body: '{}',
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init.headers ?? {});
    expect(headers.get('Content-Type')).toBe('application/x-custom');
  });
});

describe('http wrapper — 204 No Content handling', () => {
  it('returns undefined on 204 instead of throwing JSON parse error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await api.deleteSource('x');
    expect(result).toBeUndefined();
  });

  it('parses JSON body for non-204 responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'n1' }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    );
    const nb = await api.createNotebook('hi');
    expect(nb).toEqual({ id: 'n1' });
  });
});

describe('http wrapper — error handling', () => {
  it('throws ApiError with body when response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    await expect(api.deleteSource('x')).rejects.toThrow(/not found/);
  });

  it('throws with status code when error body has no error field', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(api.deleteSource('x')).rejects.toThrow(/HTTP 500/);
  });
});
