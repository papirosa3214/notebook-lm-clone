/**
 * End-to-end smoke for the Deep Research agent.
 *
 * The route streams SSE (plan → search → fetch/ingest → synthesise).
 * Fastify's `app.inject` returns before `reply.raw.end()` fires for
 * streaming responses, so we boot a real server on an ephemeral port
 * and read the stream via fetch.
 *
 * All network is mocked in one layered fetch:
 *   - duckduckgo.com  → fake result HTML that searchWeb can parse
 *   - example.com     → fake article HTML that fetchUrlToMarkdown can read
 *   - /api/chat       → planner JSON vs synthesis markdown, picked by
 *                       inspecting the system prompt in the body
 *   - /api/embeddings → dummy vector (addSourceText needs it)
 *
 * Rerank is forced to `noop` so the retrieval step doesn't add a third
 * LLM round-trip whose mock response we'd have to shape.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { withApiTestEnv } from './helpers.js';
import { artifacts, notebooks, sources } from '../db/schema.js';
import { config } from '../config.js';
import { resetRerankProvider } from '../lib/rerank/factory.js';

const env = withApiTestEnv();
const NB_ID = `nb_dr_${nanoid(6)}`;

const DDG_HTML = `
<html><body>
  <div class="result">
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Article A</a>
    <a class="result__snippet">Snippet about A.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Article B</a>
    <a class="result__snippet">Snippet about B.</a>
  </div>
</body></html>`;

const ARTICLE_HTML = `
<html><head><title>Mock Article</title></head>
<body><article><h1>Mock Article</h1>
<p>${'Содержательный текст про протоколы и их применение. '.repeat(30)}</p>
</article></body></html>`;

function ollamaNdjson(content: string): Response {
  const body =
    `${JSON.stringify({ message: { content } })}\n` +
    `${JSON.stringify({ done: true })}\n`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

let originalRerank: 'llm' | 'http' | 'noop' = 'llm';
let realFetch: typeof fetch;
let stopMock: (() => void) | null = null;

function installNetworkMock(opts: { plannerText?: string; synthesisText?: string; failAllArticles?: boolean } = {}) {
  const plannerText = opts.plannerText ?? JSON.stringify(['протокол A2A', 'протокол MCP']);
  const synthesisText = opts.synthesisText ?? '# Отчёт\n\nВывод по источникам [1].\n';
  let articleCalls = 0;
  const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes('duckduckgo.com')) {
      return new Response(DDG_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url.includes('example.com')) {
      articleCalls++;
      if (opts.failAllArticles) {
        return new Response('nope', { status: 500, statusText: 'Server Error' });
      }
      return new Response(ARTICLE_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url.includes('/api/chat')) {
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      // The planner prompt says "исследовательский планировщик";
      // the synthesis prompt says "аналитик NotebookLM".
      if (bodyStr.includes('планировщик')) return ollamaNdjson(plannerText);
      if (bodyStr.includes('аналитик NotebookLM')) return ollamaNdjson(synthesisText);
      return ollamaNdjson('0'); // rerank fallback (shouldn't fire)
    }
    if (url.includes('/api/embeddings')) {
      const vec = new Array(1024).fill(0.01);
      return new Response(JSON.stringify({ embedding: vec }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  globalThis.fetch = mock;
  stopMock = () => {
    globalThis.fetch = realFetch;
    stopMock = null;
  };
  return { articleCalls: () => articleCalls };
}

beforeAll(async () => {
  await env.install();
  const db = await env.getDb();
  db.insert(notebooks)
    .values({
      id: NB_ID,
      title: 'deep research smoke',
      defaultProvider: 'ollama',
      defaultModel: 'qwen-test',
    })
    .run();
  // Force noop rerank so retrieval doesn't add an LLM call we'd have
  // to mock separately.
  originalRerank = config.RERANK_PROVIDER;
  (config as { RERANK_PROVIDER: 'llm' | 'http' | 'noop' }).RERANK_PROVIDER = 'noop';
  resetRerankProvider();
  realFetch = globalThis.fetch;
});

afterEach(() => {
  stopMock?.();
});

afterAll(async () => {
  stopMock?.();
  (config as { RERANK_PROVIDER: 'llm' | 'http' | 'noop' }).RERANK_PROVIDER = originalRerank;
  resetRerankProvider();
  await env.restore();
});

async function runDeepResearch(
  payload: Record<string, unknown>,
): Promise<{ status: number; events: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const app = await env.getApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr !== 'object') {
    await app.close();
    throw new Error('listen failed');
  }
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/notebooks/${NB_ID}/deep-research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: Array<Record<string, unknown>> = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      try {
        events.push(JSON.parse(dataLine.slice(5).trim()));
      } catch {
        // ignore malformed
      }
    }
    if (events.some((e) => e.type === 'done' || e.type === 'error')) break;
  }
  return { status: res.status, events, close: () => app.close() };
}

describe('POST /api/notebooks/:id/deep-research', () => {
  it('runs plan → search → ingest → synthesise and persists a cited report', async () => {
    installNetworkMock();
    const r = await runDeepResearch({ question: 'Что такое A2A?' });
    try {
      expect(r.status).toBe(200);

      // Phase order must be planning → searching → fetching → synthesizing.
      const phases = r.events
        .filter((e) => e.type === 'phase')
        .map((e) => e.phase as string);
      expect(phases[0]).toBe('planning');
      expect(phases).toContain('searching');
      expect(phases).toContain('fetching');
      expect(phases).toContain('synthesizing');

      // Planner output surfaced.
      const queriesEvent = r.events.find((e) => e.type === 'queries');
      expect(queriesEvent).toBeDefined();
      expect(queriesEvent!.queries).toEqual(['протокол A2A', 'протокол MCP']);

      // Both hits ingested.
      const hits = r.events.filter((e) => e.type === 'hit');
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits.every((h) => h.ingested === true)).toBe(true);

      // Synthesis tokens streamed.
      expect(r.events.some((e) => e.type === 'token')).toBe(true);

      // Terminal done with counts.
      const done = r.events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      expect(done!.sourceCount).toBeGreaterThanOrEqual(2);
      expect(typeof done!.artifactId).toBe('string');

      // Artifact persisted with the deep_research template.
      const db = await env.getDb();
      const art = db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, done!.artifactId as string))
        .get();
      expect(art).toBeDefined();
      expect(art!.kind).toBe('report');
      const meta = JSON.parse(art!.meta!) as {
        template: string;
        status: string;
        sourceCount: number;
        queries: string[];
      };
      expect(meta.template).toBe('deep_research');
      expect(meta.status).toBe('ready');
      expect(meta.sourceCount).toBeGreaterThanOrEqual(2);
      expect(meta.queries).toEqual(['протокол A2A', 'протокол MCP']);
      expect(art!.contentMd).toContain('# Отчёт');

      // Sources were actually added to the notebook.
      const srcRows = db.select().from(sources).where(eq(sources.notebookId, NB_ID)).all();
      expect(srcRows.length).toBeGreaterThanOrEqual(2);
      expect(srcRows.every((s) => s.status === 'ready')).toBe(true);
    } finally {
      await r.close();
    }
  }, 60_000);

  it('falls back to searching the raw question when the planner returns garbage', async () => {
    installNetworkMock({ plannerText: 'совсем не JSON' });
    const r = await runDeepResearch({ question: 'Что такое MCP?' });
    try {
      const queriesEvent = r.events.find((e) => e.type === 'queries');
      expect(queriesEvent!.queries).toEqual(['Что такое MCP?']);
      // The run still completes.
      expect(r.events.some((e) => e.type === 'done')).toBe(true);
    } finally {
      await r.close();
    }
  }, 60_000);

  it('emits an error when every article fetch fails', async () => {
    installNetworkMock({ failAllArticles: true });
    const r = await runDeepResearch({ question: 'Что-то недоступное' });
    try {
      const err = r.events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/ни одного источника/);
      expect(r.events.some((e) => e.type === 'done')).toBe(false);
    } finally {
      await r.close();
    }
  }, 60_000);

  it('returns 404 for an unknown notebook', async () => {
    installNetworkMock();
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/nb_missing_${nanoid(6)}/deep-research`,
      payload: { question: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when the question is missing', async () => {
    installNetworkMock();
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/deep-research`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
