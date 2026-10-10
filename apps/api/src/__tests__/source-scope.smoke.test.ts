/**
 * Source Workspace v1 — backend contract tests.
 *
 * Covers the sourceIds filter on /api/notebooks/:id/chat and the
 * /api/notebooks/:id/sources/:sourceId?include=chunks endpoint. The
 * plan's DoD for the first backend step requires:
 *
 *  - retrieval without sourceIds searches all chunks in the notebook
 *  - retrieval with sourceIds never returns a citation from a
 *    non-selected source
 *  - sourceId from another notebook is rejected (no cross-notebook
 *    leak via stale id)
 *  - cache does not mix two different source scopes
 *  - citations carry the real sourceKind and a `location` like
 *    "Фрагмент N"
 *
 * We seed two notebooks with sources and chunks, then drive the
 * Fastify app via app.inject(). /retrieve is a dry-run endpoint that
 * shares the retrieveRaw code path with /chat and returns JSON, so
 * we can assert the contract end-to-end without dealing with SSE.
 *
 * Mocking strategy: any test that triggers retrieval must mock
 * Ollama — otherwise embed() hits the real 192.168.1.110:11434 and
 * fails with "model not found". The `withOllamaMocked` wrapper
 * installs the mock, runs the body, then unmocks.
 */

import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { withApiTestEnv, type ApiTestEnv } from './helpers.js';
import { notebooks, sources } from '../db/schema.js';

const env = withApiTestEnv();

beforeAll(async () => {
  await env.install();
  const db = await env.getDb();
  for (const id of ['nb_a', 'nb_b']) {
    db.insert(notebooks)
      .values({
        id,
        title: `${id}`,
        defaultProvider: 'ollama',
        defaultModel: 'qwen-test',
      })
      .run();
  }
  for (const [id, nb, kind] of [
    ['src_a1', 'nb_a', 'url'],
    ['src_a2', 'nb_a', 'file'],
    ['src_b1', 'nb_b', 'youtube'],
  ] as const) {
    db.insert(sources)
      .values({
        id,
        notebookId: nb,
        kind,
        title: id,
        url: null,
        status: 'ready',
      })
      .run();
  }
  const raw = await env.getRawSqlite();
  const insertChunk = raw.prepare(
    `INSERT INTO chunks (vec_rowid, notebook_id, source_id, kind, title, url, content, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // sqlite-vec's vec0 virtual table does not accept an explicit rowid
  // — we have to insert the embedding first, capture lastInsertRowid,
  // then use that id as chunks.vec_rowid. (The production path in
  // apps/api/src/vectordb/client.ts does the same.)
  const insertVec = raw.prepare(`INSERT INTO vec_chunks (embedding) VALUES (?)`);
  const dummyVec = Buffer.from(new Float32Array(
    Array.from({ length: 1024 }, (_, i) => 0.01 + (i % 7) * 0.001),
  ).buffer);
  for (const row of [
    ['src_a1', 0, 'about A1'],
    ['src_a2', 0, 'about A2'],
    ['src_b1', 0, 'about B1'],
  ]) {
    const src = row[0] as string;
    const ordinal = row[1] as number;
    const content = row[2] as string;
    const nb = src.startsWith('src_a') ? 'nb_a' : 'nb_b';
    const kind = src === 'src_a1' ? 'url' : src === 'src_a2' ? 'file' : 'youtube';
    const vecInfo = insertVec.run(dummyVec);
    const vecRowid = Number(vecInfo.lastInsertRowid);
    insertChunk.run(vecRowid, nb, src, kind, src, null, content, ordinal);
  }
});

afterAll(async () => {
  await env.restore();
});

async function withOllamaMocked(env: ApiTestEnv, body: () => Promise<void>): Promise<void> {
  env.mockOllama();
  try {
    await body();
  } finally {
    env.unmockOllama();
  }
}

test('GET /retrieve without sourceIds searches every source in the notebook', async () => {
  await withOllamaMocked(env, async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notebooks/nb_a/retrieve?q=A&topK=10',
    });
    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    const body = res.json() as { chunks: Array<{ document_id: string }> };
    const sourceIds = new Set(body.chunks.map((c) => c.document_id));
    assert.ok(sourceIds.size > 0, 'should have at least one chunk');
    for (const sid of sourceIds) {
      assert.ok(
        sid === 'src_a1' || sid === 'src_a2',
        `unexpected source ${sid} — retrieval leaked from another notebook`,
      );
    }
  });
});

test('GET /retrieve with sourceIds restricts to that subset only', async () => {
  await withOllamaMocked(env, async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notebooks/nb_a/retrieve?q=A&topK=10&sourceIds=src_a1',
    });
    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    const body = res.json() as { chunks: Array<{ document_id: string }> };
    for (const c of body.chunks) {
      assert.equal(c.document_id, 'src_a1', `unexpected source ${c.document_id}`);
    }
  });
});

test('SQL filter blocks cross-notebook id (defence-in-depth)', async () => {
  await withOllamaMocked(env, async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notebooks/nb_a/retrieve?q=anything&topK=5&sourceIds=src_b1',
    });
    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    const body = res.json() as { chunks: Array<{ document_id: string }> };
    for (const c of body.chunks) {
      assert.notEqual(c.document_id, 'src_b1', 'cross-notebook id leaked');
    }
  });
});

test('POST /chat rejects sourceIds that belong to a different notebook (400)', async () => {
  await withOllamaMocked(env, async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/notebooks/nb_a/chat',
      payload: { message: 'q', sourceIds: ['src_b1'] },
    });
    assert.equal(res.statusCode, 400, `body: ${res.body}`);
    const body = res.json() as { error: string };
    assert.match(body.error, /cross-notebook/i);
    assert.match(body.error, /src_b1/);
  });
});

test('POST /chat rejects unknown sourceIds with 400 listing the missing id', async () => {
  await withOllamaMocked(env, async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/notebooks/nb_a/chat',
      payload: { message: 'q', sourceIds: ['src_a1', 'src_does_not_exist'] },
    });
    assert.equal(res.statusCode, 400, `body: ${res.body}`);
    const body = res.json() as { error: string };
    assert.match(body.error, /src_does_not_exist/);
  });
});

test('cache does not mix two different source scopes', async () => {
  await withOllamaMocked(env, async () => {
    const app = await env.getApp();
    const r1 = await app.inject({
      method: 'GET',
      url: '/api/notebooks/nb_a/retrieve?q=cache&topK=5&sourceIds=src_a1',
    });
    const r2 = await app.inject({
      method: 'GET',
      url: '/api/notebooks/nb_a/retrieve?q=cache&topK=5&sourceIds=src_a2',
    });
    // eslint-disable-next-line no-console
    // console.error('DEBUG cache r1=%s r2=%s', r1.body, r2.body);
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);
    const b1 = r1.json() as { chunks: Array<{ document_id: string }> };
    const b2 = r2.json() as { chunks: Array<{ document_id: string }> };
    assert.ok(b1.chunks.every((c) => c.document_id === 'src_a1'));
    assert.ok(b2.chunks.every((c) => c.document_id === 'src_a2'));
    const { retrievalCache } = await import('../vectordb/cache.js');
    assert.ok(retrievalCache.size() >= 1, 'cache should hold at least one entry');
  });
});

test('CitationChunkSchema accepts real sourceKind and optional location', async () => {
  const { CitationChunkSchema } = await import('@notebook/shared');
  for (const kind of ['url', 'file', 'youtube'] as const) {
    const parsed = CitationChunkSchema.safeParse({
      id: 'c1',
      sourceId: 's1',
      sourceTitle: 't',
      sourceKind: kind,
      text: 'body',
      score: 0.5,
      location: 'Фрагмент 1',
    });
    assert.ok(parsed.success, `CitationChunkSchema must accept kind=${kind}`);
    if (parsed.success) {
      assert.equal(parsed.data.sourceKind, kind);
      assert.equal(parsed.data.location, 'Фрагмент 1');
    }
  }
  const noLoc = CitationChunkSchema.safeParse({
    id: 'c1',
    sourceId: 's1',
    sourceTitle: 't',
    sourceKind: 'url',
    text: 'body',
    score: 0.5,
  });
  assert.ok(noLoc.success, 'location is optional');
});

test('GET /sources/:sourceId?include=chunks&limit=N returns chunks in ordinal order, capped at 200', async () => {
  const raw = await env.getRawSqlite();
  const ins = raw.prepare(
    `INSERT INTO chunks (vec_rowid, notebook_id, source_id, kind, title, url, content, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insVec = raw.prepare(`INSERT INTO vec_chunks (embedding) VALUES (?)`);
  const dummyVec = Buffer.from(new Float32Array(
    Array.from({ length: 1024 }, (_, i) => 0.02 + (i % 5) * 0.001),
  ).buffer);
  for (let i = 1; i <= 5; i++) {
    const vecInfo = insVec.run(dummyVec);
    const vecRowid = Number(vecInfo.lastInsertRowid);
    ins.run(vecRowid, 'nb_a', 'src_a1', 'url', 'src_a1', null, `chunk ${i}`, i);
  }
  const app = await env.getApp();

  const r1 = await app.inject({
    method: 'GET',
    url: '/api/notebooks/nb_a/sources/src_a1?include=chunks',
  });
  assert.equal(r1.statusCode, 200, `body: ${r1.body}`);
  const b1 = r1.json() as {
    chunks: Array<{ ordinal: number }>;
    chunksReturned: number;
  };
  assert.equal(b1.chunksReturned, 6);
  for (let i = 0; i < b1.chunks.length; i++) {
    assert.equal(b1.chunks[i]!.ordinal, i);
  }

  const r2 = await app.inject({
    method: 'GET',
    url: '/api/notebooks/nb_a/sources/src_a1?include=chunks&limit=2',
  });
  assert.equal(r2.statusCode, 200);
  const b2 = r2.json() as { chunks: Array<{ ordinal: number }>; chunksReturned: number };
  assert.equal(b2.chunksReturned, 2);
  assert.equal(b2.chunks[0]!.ordinal, 0);
  assert.equal(b2.chunks[1]!.ordinal, 1);

  const r3 = await app.inject({
    method: 'GET',
    url: '/api/notebooks/nb_a/sources/src_a1?include=chunks&limit=999',
  });
  assert.equal(r3.statusCode, 200);
  const b3 = r3.json() as { chunksReturned: number };
  assert.equal(b3.chunksReturned, 6);
});

test('GET /sources/:sourceId without include=chunks returns plain source row (backwards compatible)', async () => {
  const app = await env.getApp();
  const res = await app.inject({
    method: 'GET',
    url: '/api/notebooks/nb_a/sources/src_a1',
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { id: string; notebookId: string; chunks?: unknown };
  assert.equal(body.id, 'src_a1');
  assert.equal(body.notebookId, 'nb_a');
  assert.equal(body.chunks, undefined, 'no chunks key when include=chunks is absent');
});
