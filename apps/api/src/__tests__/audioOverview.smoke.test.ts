/**
 * End-to-end smoke for the Audio Overview route.
 *
 * The script-only mode (TTS_PROVIDER=noop, the default) is the
 * production-shaped path for the first iteration: LLM writes a
 * script, artifact is persisted with kind='audio_overview', no mp3
 * is rendered. The test asserts the artifact is created with the
 * expected meta and that GET /api/audio/:filename returns 404
 * because the noop TTS provider explicitly clears the placeholder.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { withApiTestEnv } from './helpers.js';
import { notebooks, sources } from '../db/schema.js';

const env = withApiTestEnv();
const NB_ID = `nb_audio_${nanoid(6)}`;
const SRC_A = `src_audio_a_${nanoid(6)}`;
const SRC_B = `src_audio_b_${nanoid(6)}`;

beforeAll(async () => {
  await env.install();
  const db = await env.getDb();
  db.insert(notebooks)
    .values({
      id: NB_ID,
      title: 'audio e2e',
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

describe('POST /api/notebooks/:id/audio-overview (script-only)', () => {
  it('creates an audio_overview artifact with parsed script and no audio file', async () => {
    // Mock Ollama chat with a known script. The script builder will
    // parse it into 4 lines; TTS_PROVIDER=noop leaves audioFilename=null.
    env.mockOllama({
      chatText: [
        'SCRIPT: Привет, это подкаст о [1].',
        'MIRA: Давайте начнём с ключевого тезиса.',
        'SCRIPT: Что думаешь про деталь?',
        'MIRA: Я думаю, тут есть нюанс.',
      ].join('\n'),
    });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/audio-overview`,
      payload: { style: 'short', focus: 'обзор' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { artifact: { id: string; kind: string; meta: string; contentMd: string }; meta: { status: string; lineCount: number; audioFilename: string | null; style: string } };

    expect(body.artifact.kind).toBe('audio_overview');
    const meta = JSON.parse(body.artifact.meta) as { status: string; lineCount: number; audioFilename: string | null; style: string };
    expect(meta.status).toBe('ready');
    expect(meta.style).toBe('short');
    expect(meta.lineCount).toBe(4);
    expect(meta.audioFilename).toBeNull();
    expect(body.artifact.contentMd).toContain('**SCRIPT:**');
    expect(body.artifact.contentMd).toContain('**MIRA:**');

    // The audio route must report 404 — noop TTS never writes a real
    // mp3, and the route cleans up the placeholder.
    const audioRes = await app.inject({
      method: 'GET',
      url: `/api/audio/${NB_ID}/${body.artifact.id}.mp3`,
    });
    expect(audioRes.statusCode).toBe(404);
  });

  it('rejects unknown sourceIds with 400 (no silent fallback to all sources)', async () => {
    env.mockOllama({ chatText: 'SCRIPT: ok' });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/audio-overview`,
      payload: { sourceIds: [`src_does_not_exist_${nanoid(6)}`] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/unknown sourceIds/);
  });

  it('refuses audio filenames outside the nanoid(12).mp3 shape', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/audio/${NB_ID}/../etc/passwd`,
    });
    expect(res.statusCode).toBe(400);
  });
});
