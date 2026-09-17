import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * SSE reader (`streamChat` / `streamSummary`) must:
 *  - call onAbort (and NOT onDone/onError) when the fetch fails with an
 *    AbortError. Otherwise the panel keeps `streaming=true` and the loader
 *    spins forever (the bug Maks hit in dev with Strict-Mode double-mount).
 *  - call onDone when the server emits `{type:'done', ...}`.
 *  - call onError for non-Abort failures (e.g. HTTP 4xx/5xx).
 */
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { streamChat, streamSummary } from '../stream';

afterEach(() => {
  fetchMock.mockReset();
});

/** Resolve a Promise-based callback once any of the listed handlers fires.
 *  IMPORTANT: handlers MUST be attached BEFORE `streamChat(...)` runs — the SSE
 *  IIFE kicks off synchronously and may fire `done`/`error`/`abort` before the
 *  caller's next microtask if we race. */
function makeHandler<T>(target: Partial<Record<string, (arg: T) => void>>, key: string) {
  let resolve!: (arg: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  target[key] = ((arg: T) => resolve(arg)) as never;
  return promise;
}

/** Build a Response that streams the given SSE blocks back to the reader.
 *  Each block must be terminated by `\n\n` (real Fastify-sse behaviour).
 *  Without that trailing blank line the reader's `buf` holds the final
 *  `data:` line on EOF and the parser silently drops it — masking any test
 *  that depends on a terminal `done` event. */
function sseResponse(blocks: string[], status = 200): Response {
  const body = blocks.map((b) => (b.endsWith('\n\n') ? b : b + '\n\n')).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('streamChat — done event', () => {
  it('fires onDone with the messageId from the server', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'data: {"type":"citations","chunks":[]}',
        'data: {"type":"token","text":"hi"}',
        'data: {"type":"done","messageId":"m-1"}',
      ]),
    );

    const handlers: { onDone?: (id: string) => void } = {};
    const done = makeHandler<string>(handlers, 'onDone');
    streamChat({ notebookId: 'n1', message: 'q' }, handlers);

    const id = await done;
    expect(id).toBe('m-1');
  });
});

describe('streamSummary — abort handling', () => {
  it('fires onAbort (not onError or onDone) when fetch rejects with AbortError', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abortError);

    const handlers: {
      onAbort?: () => void;
      onError?: (m: string) => void;
      onDone?: (id: string) => void;
    } = {};
    const abort = makeHandler<void>(handlers, 'onAbort');
    streamSummary({ notebookId: 'n1' }, handlers);

    await abort;
    expect(handlers.onError).toBeUndefined(); // never assigned = never called
    expect(handlers.onDone).toBeUndefined();
  });
});

describe('streamChat — error handling', () => {
  it('fires onError with status text for non-Abort HTTP failures', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const handlers: { onError?: (m: string) => void; onAbort?: () => void } = {};
    const error = makeHandler<string>(handlers, 'onError');
    streamChat({ notebookId: 'n1', message: 'q' }, handlers);

    const msg = await error;
    expect(msg).toMatch(/429/);
    expect(handlers.onAbort).toBeUndefined();
  });
});
