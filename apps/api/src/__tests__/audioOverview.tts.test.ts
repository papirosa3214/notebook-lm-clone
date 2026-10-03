/**
 * Real end-to-end integration test for the audio overview route
 * with `TTS_PROVIDER=mac-say`.
 *
 * This test is **skipped** when `/usr/bin/say` is not available
 * (i.e. on non-macOS hosts or in containers without the binary)
 * OR when `TTS_PROVIDER` is not set to `mac-say`. The CI
 * environment we target runs on a Mac mini, so this test
 * exercises the real `say` + `ffmpeg` pipeline end-to-end and
 * asserts a non-zero mp3 is written to the data/audio directory.
 *
 * To run: `TTS_PROVIDER=mac-say pnpm test`. The test sets the env
 * itself via process.env before importing the helpers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, stat } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { withApiTestEnv } from './helpers.js';
import { artifacts, notebooks, sources } from '../db/schema.js';
import { getTtsProvider, resetTtsProvider } from '../lib/audio/factory.js';

const env = withApiTestEnv();
const NB_ID = `nb_aov_tts_${nanoid(6)}`;
const SRC_A = `src_aov_tts_a_${nanoid(6)}`;
const SRC_B = `src_aov_tts_b_${nanoid(6)}`;

let sayAvailable = false;
let ttsProviderId: string | null = null;

beforeAll(async () => {
  try {
    await access('/usr/bin/say');
    sayAvailable = true;
  } catch {
    sayAvailable = false;
  }
  // Force mac-say so the test exercises the real provider rather
  // than the default NoopTtsProvider.
  process.env.TTS_PROVIDER = 'mac-say';
  resetTtsProvider();
  ttsProviderId = getTtsProvider().id;
  if (!sayAvailable || ttsProviderId !== 'mac-say') return;

  await env.install();
  const db = await env.getDb();
  db.insert(notebooks)
    .values({
      id: NB_ID,
      title: 'audio overview tts',
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

afterAll(async () => {
  // Reset the env so subsequent test files in the same process
  // don't pick up our forced mac-say.
  delete process.env.TTS_PROVIDER;
  resetTtsProvider();
  await env.restore();
});

describe('audio overview + TTS (mac-say integration)', () => {
  it('produces a non-zero mp3 when /usr/bin/say + mac-say provider are available', async () => {
    if (!sayAvailable || ttsProviderId !== 'mac-say') {
      return;
    }
    env.mockOllama({
      chatText: [
        'SCRIPT: Привет, это подкаст.',
        'MIRA: Привет и тебе.',
        'SCRIPT: Поехали.',
      ].join('\n'),
    });
    const app = await env.getApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notebooks/${NB_ID}/audio-overview?stream=1`,
      payload: { style: 'short' },
    });
    expect(res.statusCode).toBe(200);

    // Fetch the artifact row and verify meta.
    const db = await env.getDb();
    const rows = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.notebookId, NB_ID))
      .all();
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.kind).toBe('audio_overview');
    const meta = JSON.parse(a.meta!) as {
      status: string;
      lineCount: number;
      audioFilename: string | null;
    };
    expect(meta.status).toBe('ready');
    expect(meta.lineCount).toBe(3);
    expect(typeof meta.audioFilename).toBe('string');
    expect(meta.audioFilename).toMatch(/\.mp3$/);

    // Verify the file actually exists and is non-empty. macSay
    // writes to apps/api/data/audio/{notebookId}/{filename}.
    const { join } = await import('node:path');
    const filePath = join(
      process.cwd(),
      'data',
      'audio',
      NB_ID,
      meta.audioFilename!,
    );
    const st = await stat(filePath);
    expect(st.size).toBeGreaterThan(0);
  }, 90_000);
});

