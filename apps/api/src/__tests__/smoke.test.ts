/**
 * Smoke test for Gate 0.2: confirm the API test rig works at all.
 *
 * What this test does NOT do yet (will come in 0.2b/0.2c):
 *   - hit the mindmap endpoint
 *   - hit the SSE-fallback endpoint
 *   - exercise buildTriplesForSource with a mocked LLM
 *
 * What it does do:
 *   - create a tmp SQLite via DB_PATH override
 *   - run the real migrate() (it must succeed on a fresh DB)
 *   - insert and read back a notebook row
 *   - leave the tmp dir behind for inspection if a future debug is needed
 *
 * If this passes, the rig plumbing is correct and 0.2b can focus purely
 * on the routes/behavior under test.
 */

import { afterAll, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// IMPORTANT: env vars must be set BEFORE any module under test loads
// config.ts. node:test runs this file in its own worker by default,
// which is fine — the env mutation doesn't leak to other test files.
const tmpDir = mkdtempSync(join(tmpdir(), 'notebook-api-smoke-'));
process.env.DB_PATH = join(tmpDir, 'smoke.db');
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:11434';
process.env.EMBEDDING_DIM = '1024';
process.env.NODE_ENV = 'test';

test('API smoke: migrate() runs on a fresh tmp DB', async () => {
  const { getDb } = await import('../db/index.js');
  const { notebooks, sources } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');

  const db = getDb();

  // Insert a notebook + a source. If migrate() didn't run, this throws
  // "no such table: notebooks".
  const nbId = 'nb_smoke_1';
  db.insert(notebooks)
    .values({ id: nbId, title: 'smoke', defaultProvider: 'ollama', defaultModel: 'qwen' })
    .run();

  const back = db.select().from(notebooks).where(eq(notebooks.id, nbId)).get();
  assert.ok(back, 'notebook row should be readable');
  assert.equal(back!.id, nbId);
  assert.equal(back!.title, 'smoke');

  // sources table also has the new schema (summary columns added later
  // via addColumnIfMissing). Insert+select to prove the table is there.
  db.insert(sources)
    .values({
      id: 'src_smoke_1',
      notebookId: nbId,
      kind: 'url',
      title: 'smoke source',
      url: 'https://example.com',
      status: 'ready',
    })
    .run();
  const src = db.select().from(sources).where(eq(sources.id, 'src_smoke_1')).get();
  assert.ok(src);
  assert.equal(src!.status, 'ready');
});

test('API smoke: addColumnIfMissing left graph_triples ready', async () => {
  const { getRawSqlite } = await import('../db/index.js');
  const raw = getRawSqlite();
  // After migrate(), the graph_triples table must exist (the knowledge-
  // graph fix f924271 reads from it). If it doesn't, the test fails —
  // migration regression would be caught here before a route is hit.
  const row = raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='graph_triples'`,
    )
    .get() as { name: string } | undefined;
  assert.ok(row, 'graph_triples table must exist after migrate()');
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
