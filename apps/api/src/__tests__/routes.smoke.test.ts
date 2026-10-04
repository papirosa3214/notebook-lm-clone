/**
 * Smoke tests for the f5c76f1 and f924271 commits.
 *
 * f5c76f1 — fix(api): register mindmapRoutes
 *   Before: POST /api/notebooks/:id/mindmap returned 404 because the
 *   route file existed but was never registered in index.ts.
 *   After: the route is registered. The handler still calls Ollama,
 *   so we mock fetch to return a deterministic mindmap JSON.
 *
 * f924271 — fix(api): GET /api/notebooks/:id/sources/:sourceId
 *   Before: the endpoint did not exist, so the SSE-fallback path
 *   hit 404 and the source appeared stuck.
 *   After: the route returns the source row, and verifies the source
 *   belongs to :id (so a stale id from another notebook cannot leak).
 */

import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { withApiTestEnv } from './helpers.js';
import { artifacts, notebooks, sources } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const env = withApiTestEnv();

const MINDMAP_JSON = JSON.stringify({
  title: 'Тестовая карта',
  nodes: [
    { id: 'n1', label: 'A' },
    { id: 'n2', label: 'B' },
    { id: 'n3', label: 'C' },
  ],
  edges: [
    { from: 'n1', to: 'n2' },
    { from: 'n2', to: 'n3' },
  ],
});

beforeAll(async () => {
  await env.install();
  // Seed a notebook + a ready source so mindmap has something to chew on.
  const db = await env.getDb();
  for (const id of ['nb_smoke', 'nb_other']) {
    db.insert(notebooks)
      .values({
        id,
        title: `${id} notebook`,
        defaultProvider: 'ollama',
        defaultModel: 'qwen-test',
      })
      .run();
  }
  db.insert(sources)
    .values({
      id: 'src_1',
      notebookId: 'nb_smoke',
      kind: 'url',
      title: 'A',
      url: 'https://example.com',
      status: 'ready',
    })
    .run();
  db.insert(sources)
    .values({
      id: 'src_2',
      notebookId: 'nb_other',
      kind: 'url',
      title: 'B',
      url: 'https://other.example',
      status: 'ready',
    })
    .run();

  // A source row alone is not enough: retrieval reads chunks. Without
  // one the mindmap has nothing to map and now refuses (see the 409
  // regression test below) instead of inventing a topic.
  const raw = await env.getRawSqlite();
  const dummyVec = Buffer.from(
    new Float32Array(Array.from({ length: 1024 }, (_, i) => 0.01 + (i % 7) * 0.001)).buffer,
  );
  const vecRowid = Number(raw.prepare('INSERT INTO vec_chunks (embedding) VALUES (?)').run(dummyVec).lastInsertRowid);
  raw
    .prepare(
      `INSERT INTO chunks (vec_rowid, notebook_id, source_id, kind, title, url, content, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(vecRowid, 'nb_smoke', 'src_1', 'url', 'A', null, 'Концепция A связана с концепцией B.', 0);
});

afterAll(async () => {
  await env.restore();
});

test('POST /api/notebooks/:id/mindmap refuses instead of inventing a topic (no chunks)', async () => {
  // nb_other has a sources row but no chunks, so there is nothing to
  // map. The route used to pass "(нет фрагментов — сгенерируй из общего
  // знания о теме)" to the model, which produced confident mind maps
  // about entirely unrelated subjects inside empty notebooks.
  env.mockOllama({ chatText: MINDMAP_JSON });
  try {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/notebooks/nb_other/mindmap',
      payload: {},
    });
    assert.equal(res.statusCode, 409, `expected 409, got ${res.statusCode}: ${res.body}`);
    const body = res.json() as { detail?: string };
    assert.match(body.detail ?? '', /источник/i, 'detail explains the missing sources');

    // Nothing was persisted.
    const db = await env.getDb();
    const rows = db.select().from(artifacts).where(eq(artifacts.notebookId, 'nb_other')).all();
    assert.equal(rows.length, 0, 'no artifact written for an ungrounded mindmap');
  } finally {
    env.unmockOllama();
  }
});

test('GET /api/notebooks/:id/sources/:sourceId returns the source when it belongs to the notebook', async () => {
  const app = await env.getApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/notebooks/nb_smoke/sources/src_1',
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { id: string; notebookId: string };
  assert.equal(body.id, 'src_1');
  assert.equal(body.notebookId, 'nb_smoke');
});

test('GET /api/notebooks/:id/sources/:sourceId returns 404 for a source that does not exist', async () => {
  const app = await env.getApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/notebooks/nb_smoke/sources/src_does_not_exist',
  });
  assert.equal(res.statusCode, 404);
});

test('GET /api/notebooks/:id/sources/:sourceId returns 404 when the source belongs to a different notebook (f924271 anti-leak)', async () => {
  // src_2 was inserted with notebookId='nb_other' above. Asking for it
  // under nb_smoke must 404, not 200 with src_2's data — that would be
  // a cross-notebook leak.
  const app = await env.getApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/notebooks/nb_smoke/sources/src_2',
  });
  assert.equal(res.statusCode, 404);
});

test('GET /api/notebooks/:id/sources/:sourceId returns 404 for a non-existent notebook too', async () => {
  const app = await env.getApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/notebooks/nb_missing/sources/src_1',
  });
  assert.equal(res.statusCode, 404);
});

test('POST /api/notebooks/:id/mindmap is no longer 404 and writes an artifact (f5c76f1)', async () => {
  // Mock Ollama BEFORE injecting the request. The mindmap handler
  // calls retrieveWithRerank (which hits /api/embeddings) and then
  // provider.chat (which hits /api/chat). Both must return canned data.
  env.mockOllama({ chatText: MINDMAP_JSON });
  try {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/notebooks/nb_smoke/mindmap',
      payload: {},
    });
    // Before f5c76f1 this was 404. After, we get 201 with an artifact.
    assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${res.body}`);
    const body = res.json() as {
      artifact: { id: string; contentMd: string };
      mindmap: { title: string; nodes: Array<{ id: string }> };
    };
    assert.ok(body.artifact.id, 'artifact id present');
    assert.match(body.artifact.contentMd, /<svg/, 'artifact content is SVG');
    assert.equal(body.mindmap.title, 'Тестовая карта');
    assert.equal(body.mindmap.nodes.length, 3);

    // And the artifact row is actually in the DB.
    const db = await env.getDb();
    const row = db
      .select()
      .from((await import('../db/schema.js')).artifacts)
      .where(eq((await import('../db/schema.js')).artifacts.id, body.artifact.id))
      .get();
    assert.ok(row, 'artifact persisted in DB');
  } finally {
    env.unmockOllama();
  }
});

test('POST /api/notebooks/:id/mindmap returns 404 for an unknown notebook', async () => {
  const app = await env.getApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/notebooks/nb_missing/mindmap',
    payload: {},
  });
  assert.equal(res.statusCode, 404);
});
