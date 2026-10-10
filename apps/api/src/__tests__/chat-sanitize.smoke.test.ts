/**
 * Smoke tests for the verified-answering post-processor wired into the
 * /api/notebooks/:id/chat route by M1.4.
 *
 * The model sees a strict CITATION_INSTRUCTIONS prompt and is told to use
 * only indices 1..N where N is the number of supplied sources. To prove
 * the API actually defends against an over-citing model we mock Ollama
 * with a reply that contains out-of-range [N] markers, then read the
 * persisted assistant row back and assert the sanitiser replaced them
 * with [?].
 *
 * Also covers the UNSUPPORTED: prefix path: when the model refuses, the
 * full text is stored verbatim (so the UI can render the reason) and the
 * `citations` column stays tied to whatever retrieval actually returned.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { withApiTestEnv } from './helpers.js';
import { messages, notebooks, sources } from '../db/schema.js';

const env = withApiTestEnv();

beforeAll(async () => {
  await env.install();
  const db = await env.getDb();
  db.insert(notebooks)
    .values({
      id: 'nb_sanitize',
      title: 'sanitize notebook',
      defaultProvider: 'ollama',
      defaultModel: 'qwen-test',
    })
    .run();
  // Two ready sources — so retrieval will return 2 citations and any [3]
  // in the model output is provably out of range.
  for (const id of ['src_a', 'src_b']) {
    db.insert(sources)
      .values({
        id,
        notebookId: 'nb_sanitize',
        kind: 'url',
        title: id,
        url: `https://example.com/${id}`,
        status: 'ready',
      })
      .run();
  }
  // Seed two real chunks (one per source) so BM25 actually returns
  // hits for the user query. The content deliberately uses Russian
  // tokens that survive buildFtsQuery's stop-word filter, so the FTS
  // branch in retrieve() finds them.
  const raw = await env.getRawSqlite();
  const insVec = raw.prepare(`INSERT INTO vec_chunks (embedding) VALUES (?)`);
  const insChunk = raw.prepare(
    `INSERT INTO chunks (vec_rowid, notebook_id, source_id, kind, title, url, content, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const dummyVec = Buffer.from(
    new Float32Array(Array.from({ length: 1024 }, (_, i) => 0.01 + (i % 7) * 0.001)).buffer,
  );
  for (const [i, sourceId] of ['src_a', 'src_b'].entries()) {
    const vecInfo = insVec.run(dummyVec);
    const vecRowid = Number(vecInfo.lastInsertRowid);
    insChunk.run(
      vecRowid,
      'nb_sanitize',
      sourceId,
      'url',
      sourceId,
      null,
      // Tokens chosen to survive buildFtsQuery: "расскажи", "оба", "источника".
      'Расскажи кратко про оба источника, это поможет тесту.',
      i,
    );
  }
});

afterAll(async () => {
  await env.restore();
});

async function postChat(chatText: string) {
  // Mock the chat endpoint so we can inject a deterministic reply
  // regardless of what the embedding retriever finds.
  env.mockOllama({ chatText });
  const app = await env.getApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/notebooks/nb_sanitize/chat',
    payload: { message: 'Расскажи про оба источника' },
  });
  env.unmockOllama();
  assert.equal(res.statusCode, 200, `chat route failed: ${res.body}`);
  return res;
}

async function lastAssistantRow(): Promise<{ content: string; citations: string | null }> {
  const db = await env.getDb();
  const row = db
    .select()
    .from(messages)
    .where(eq(messages.notebookId, 'nb_sanitize'))
    .all()
    .filter((r) => r.role === 'assistant')
    .pop();
  if (!row) throw new Error('no assistant row found');
  return { content: row.content, citations: row.citations };
}

describe('chat route — verified-answering sanitiser', () => {
  test('rewrites out-of-range [N] markers to [?] in the persisted row', async () => {
    // The model returns a citation to source 3 even though only 2 were
    // provided. Sanitiser must turn that [3] into [?] before persisting.
    await postChat('Первый тезис [1]. Второй [3]. Третий [0].');

    const { content } = await lastAssistantRow();
    expect(content).toBe('Первый тезис [1]. Второй [?]. Третий [?].');
  });

  test('preserves an UNSUPPORTED: answer verbatim', async () => {
    await postChat('UNSUPPORTED: provided sources do not mention 2026 at all.');

    const { content } = await lastAssistantRow();
    expect(content).toBe('UNSUPPORTED: provided sources do not mention 2026 at all.');
  });

  test('leaves in-range markers untouched', async () => {
    await postChat('Foo [1] и [2] bar.');

    const { content } = await lastAssistantRow();
    expect(content).toBe('Foo [1] и [2] bar.');
  });

  test('does treat markers inside backticks as citations (sanitiser is not Markdown-aware)', async () => {
    // Documented contract: the backstop rewrites every `[N]`, even when it
    // sits inside a code span. To prove this, we use [3] and [4] which are
    // out of range (the route only retrieved 2 citations) and we expect
    // the backticked occurrences to be rewritten to [?] just like the
    // out-of-range ones outside code spans.
    await postChat('Use `array[3]` и `[4]` literally. Citation: [1] and out-of-range [5].');

    const { content } = await lastAssistantRow();
    expect(content).toBe('Use `array[?]` и `[?]` literally. Citation: [1] and out-of-range [?].');
  });
});
