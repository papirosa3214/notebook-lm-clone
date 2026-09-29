/**
 * Smoke test for the 06c6081 commit:
 *   feat(api): wire buildTriplesForSource into post-ingest + delete
 *
 * Before: buildTriplesForSource was defined but never called. The
 *   graph_triples table stayed empty, so /graph-related returned
 *   nothing and the chat prompt had no GRAPH block.
 * After: the function is wired into the post-ingest path of URL,
 *   YouTube, and file upload. This test exercises the function
 *   directly (we don't need to drive a full ingest here — the wiring
 *   is just three fire-and-forget calls; the function itself is the
 *   unit of work that matters).
 *
 * Also covers the cleanup added to DELETE /api/sources/:id:
 *   removeTriplesForSource must drop the rows for a removed source.
 */

import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { withApiTestEnv } from './helpers.js';
import { notebooks, sources } from '../db/schema.js';

const env = withApiTestEnv();

beforeAll(async () => {
  await env.install();
  const db = await env.getDb();
  db.insert(notebooks)
    .values({
      id: 'nb_g',
      title: 'graph smoke',
      defaultProvider: 'ollama',
      defaultModel: 'qwen-test',
    })
    .run();
  db.insert(sources)
    .values({
      id: 'src_g',
      notebookId: 'nb_g',
      kind: 'url',
      title: 'graph source',
      url: 'https://example.com',
      status: 'ready',
    })
    .run();
});

afterAll(async () => {
  await env.restore();
});

test('buildTriplesForSource extracts triples from chunks and stores them', async () => {
  env.mockOllama({
    // /api/generate response body — parsed by llmExtract.
    generateText:
      '[{"subject":"Anthropic","predicate":"founded in","object":"2021"},' +
      '{"subject":"Claude","predicate":"made by","object":"Anthropic"}]',
  });
  try {
    const { buildTriplesForSource } = await import('../vectordb/graph.js');
    const inserted = await buildTriplesForSource({
      notebookId: 'nb_g',
      sourceId: 'src_g',
      providerId: 'ollama',
      model: 'qwen-test',
      chunks: [
        { id: 1, content: 'Anthropic was founded in 2021 by former OpenAI researchers.' },
        { id: 2, content: 'Claude is a model made by Anthropic.' },
      ],
    });
    assert.equal(inserted, 4, 'expected 2 triples per chunk, 2 chunks = 4 rows');

    // Verify the rows are actually in graph_triples, scoped to our
    // notebook + source.
    const raw = await env.getRawSqlite();
    const rows = raw
      .prepare(
        `SELECT subject, predicate, object FROM graph_triples
         WHERE notebook_id = ? AND source_id = ?
         ORDER BY id ASC`,
      )
      .all('nb_g', 'src_g') as Array<{ subject: string; predicate: string; object: string }>;
    assert.equal(rows.length, 4);
    // Both chunks get the same canned LLM output, so the expected
    // rows are the two triples, each duplicated once per chunk.
    const expectedKeys = new Set([
      'Anthropic|founded in|2021',
      'Claude|made by|Anthropic',
    ]);
    const actualKeys = rows.map((r) => `${r.subject}|${r.predicate}|${r.object}`);
    assert.equal(actualKeys.length, expectedKeys.size * 2);
    for (const key of actualKeys) {
      assert.ok(expectedKeys.has(key), `unexpected triple: ${key}`);
    }
  } finally {
    env.unmockOllama();
  }
});

test('buildTriplesForSource swallows LLM errors and still resolves with 0 inserted', async () => {
  // Mock /api/generate to return 500. The function should catch and
  // return 0 — a single failed extraction must not poison the whole
  // source (per the comment on the function).
  env.mockOllama({ generateText: 'NOT_USED' });
  try {
    // Override the mock to error out for this test only.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/api/generate')) {
        return new Response('boom', { status: 500 });
      }
      return realFetch(input as RequestInfo);
    }) as typeof fetch;
    const { buildTriplesForSource } = await import('../vectordb/graph.js');
    const inserted = await buildTriplesForSource({
      notebookId: 'nb_g',
      sourceId: 'src_g',
      providerId: 'ollama',
      model: 'qwen-test',
      chunks: [{ id: 3, content: 'irrelevant chunk that will fail to extract from' }],
    });
    assert.equal(inserted, 0, 'failed LLM call must not insert anything');
    // Restore for the next test (unmockOllama also restores the original fetch).
  } finally {
    env.unmockOllama();
  }
});

test('removeTriplesForSource drops only rows for the given source (06c6081 cleanup)', async () => {
  // Add a second source, give it one triple, then remove that source
  // and verify the first source's triples stay put.
  const db = await env.getDb();
  db.insert(sources)
    .values({
      id: 'src_g2',
      notebookId: 'nb_g',
      kind: 'url',
      title: 'graph source 2',
      url: 'https://example.com/2',
      status: 'ready',
    })
    .run();
  const raw = await env.getRawSqlite();
  raw
    .prepare(
      `INSERT INTO graph_triples (notebook_id, source_id, subject, predicate, object)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('nb_g', 'src_g2', 'S2', 'has', 'triple');

  const { removeTriplesForSource } = await import('../vectordb/graph.js');
  const removed = removeTriplesForSource('src_g2');
  assert.equal(removed, 1);

  const remaining = raw
    .prepare(
      `SELECT source_id, COUNT(*) as n FROM graph_triples WHERE notebook_id = ? GROUP BY source_id`,
    )
    .all('nb_g') as Array<{ source_id: string; n: number }>;
  // src_g's triples from the previous test should still be there;
  // src_g2's row is gone.
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.source_id, 'src_g');
  assert.ok(remaining[0]!.n >= 1);
});
