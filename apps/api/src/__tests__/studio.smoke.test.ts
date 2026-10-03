/**
 * End-to-end smoke for the Studio Reports route.
 *
 * Mirrors the audioOverview smoke: mock Ollama chat, seed a notebook
 * with ready sources + BM25-friendly chunks, then exercise the
 * templated routes and assert the artifact is created with the
 * expected kind/meta.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { withApiTestEnv } from './helpers.js';
import { notebooks, sources } from '../db/schema.js';

const env = withApiTestEnv();
const NB_ID = `nb_studio_${nanoid(6)}`;
const SRC_A = `src_studio_a_${nanoid(6)}`;
const SRC_B = `src_studio_b_${nanoid(6)}`;

beforeAll(async () => {
  await env.install();
  const db = await env.getDb();
  db.insert(notebooks)
    .values({
      id: NB_ID,
      title: 'studio e2e',
      defaultProvider: 'ollama',
      defaultModel: 'qwen-test',
    })
    .run();
  for (const id of [SRC_A, SRC_B]) {
    db.insert(sources)
      .values({
        id,
        notebookId: NB_ID,
        kind: 'url',
        title: id,
        url: `https://example.com/${id}`,
        status: 'ready',
      })
      .run();
  }
  const raw = await env.getRawSqlite();
  const insVec = raw.prepare(`INSERT INTO vec_chunks (embedding) VALUES (?)`);
  const insChunk = raw.prepare(
    `INSERT INTO chunks (vec_rowid, notebook_id, source_id, kind, title, url, content, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const dummyVec = Buffer.from(
    new Float32Array(Array.from({ length: 1024 }, (_, i) => 0.01 + (i % 7) * 0.001)).buffer,
  );
  for (const [i, sourceId] of [SRC_A, SRC_B].entries()) {
    const vecInfo = insVec.run(dummyVec);
    const vecRowid = Number(vecInfo.lastInsertRowid);
    insChunk.run(
      vecRowid,
      NB_ID,
      sourceId,
      'url',
      sourceId,
      null,
      // Tokens that survive buildFtsQuery's stop-word filter and let
      // the BM25 branch return hits. Shared with the audio smoke.
      'Обзор ключевых материалов и тезисов для подкаста, тест.',
      i,
    );
  }
});

afterEach(() => {
  env.unmockOllama();
});

afterAll(async () => {
  env.unmockOllama();
  await env.restore();
});

describe('GET /api/notebooks/:id/studio/templates', () => {
  it('returns the four documented templates with id, title, blurb, defaultTopK', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${NB_ID}/studio/templates`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { templates: Array<{ id: string; title: string; blurb: string; defaultTopK: number }> };
    expect(body.templates).toHaveLength(4);
    const ids = body.templates.map((t) => t.id).sort();
    expect(ids).toEqual(['contradictions', 'executive_summary', 'faq', 'timeline']);
    for (const t of body.templates) {
      expect(typeof t.title).toBe('string');
      expect(t.title.length).toBeGreaterThan(0);
      expect(typeof t.blurb).toBe('string');
      expect(t.defaultTopK).toBeGreaterThan(0);
    }
  });
});

describe('POST /api/notebooks/:id/artifacts/studio', () => {
  it('persists a report artifact with kind="report" and meta.template', async () => {
    env.mockOllama({
      chatText: '## TL;DR\n\nЭто тест [1].\n\n## Ключевые тезисы\n\n- Тезис [1].\n',
    });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/artifacts/studio`,
      payload: { template: 'executive_summary', focus: 'тест' },
    });
    expect(res.statusCode).toBe(200);
    // The response is an SSE stream. We can't easily parse it without
    // a ReadableStream consumer in app.inject; instead, fetch the
    // artifact by id from the DB.
    const db = await env.getDb();
    const all = db
      .select()
      .from((await import('../db/schema.js')).artifacts)
      .where((await import('drizzle-orm')).eq((await import('../db/schema.js')).artifacts.notebookId, NB_ID))
      .all();
    expect(all).toHaveLength(1);
    const a = all[0]!;
    expect(a.kind).toBe('report');
    const meta = JSON.parse(a.meta!) as { template: string; citationCount: number; createdAt: string };
    expect(meta.template).toBe('executive_summary');
    expect(meta.citationCount).toBeGreaterThan(0);
    expect(a.contentMd).toContain('## TL;DR');
    expect(a.contentMd).toContain('[1]');
  });

  it('rejects an unknown sourceIds list with 400', async () => {
    env.mockOllama({ chatText: 'ok' });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/artifacts/studio`,
      payload: { template: 'faq', sourceIds: [`src_does_not_exist_${nanoid(6)}`] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/unknown sourceIds/);
  });

  it('rejects an unknown template id with 400', async () => {
    env.mockOllama({ chatText: 'ok' });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/artifacts/studio`,
      payload: { template: 'not_a_real_template' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when the notebook has zero ready sources', async () => {
    // Make a second notebook with no sources.
    const emptyId = `nb_studio_empty_${nanoid(6)}`;
    const db = await env.getDb();
    db.insert(notebooks)
      .values({
        id: emptyId,
        title: 'empty',
        defaultProvider: 'ollama',
        defaultModel: 'qwen-test',
      })
      .run();
    env.mockOllama({ chatText: 'ok' });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${emptyId}/artifacts/studio`,
      payload: { template: 'faq' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/готовых источников/);
  });
});
