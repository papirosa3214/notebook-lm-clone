/**
 * Real end-to-end integration test for the audio overview route
 * with `TTS_PROVIDER=mac-say`.
 *
 * Exercises the full pipeline: a real running Fastify server on
 * an ephemeral port, a real `fetch` against the SSE endpoint, the
 * mocked Ollama chat, and the real `say` + `ffmpeg` pipeline
 * writing a real MP3 to disk.
 *
 * Skipped when `/usr/bin/say` is not available (non-macOS hosts,
 * CI containers).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { withApiTestEnv } from './helpers.js';
import { artifacts, notebooks, sources } from '../db/schema.js';
import { config } from '../config.js';
import { getTtsProvider, resetTtsProvider } from '../lib/audio/factory.js';

const env = withApiTestEnv();
const NB_ID = `nb_aov_tts_${nanoid(6)}`;
const SRC_A = `src_aov_tts_a_${nanoid(6)}`;
const SRC_B = `src_aov_tts_b_${nanoid(6)}`;

let sayAvailable = false;
let ttsProviderId: string | null = null;
let originalProvider: 'noop' | 'mac-say' | 'openai' | 'kokoro' = 'noop';
let originalOllamaUrl: string | undefined;
let originalEmbeddingUrl: string | undefined;

beforeAll(async () => {
  try {
    await access('/usr/bin/say');
    sayAvailable = true;
  } catch {
    sayAvailable = false;
  }
  originalProvider = config.TTS_PROVIDER;
  originalOllamaUrl = config.OLLAMA_BASE_URL;
  originalEmbeddingUrl = config.EMBEDDING_BASE_URL;
  (config as { TTS_PROVIDER: 'noop' | 'mac-say' | 'openai' | 'kokoro' }).TTS_PROVIDER = 'mac-say';
  // The config object is loaded once at module init; mutating
  // process.env after that point doesn't re-parse. We mutate
  // config directly so the providers see the same override the
  // mock fetch expects (127.0.0.1:11434).
  (config as { OLLAMA_BASE_URL: string }).OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
  (config as { EMBEDDING_BASE_URL: string }).EMBEDDING_BASE_URL = 'http://127.0.0.1:11434';
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
  (config as { TTS_PROVIDER: 'noop' | 'mac-say' | 'openai' | 'kokoro' }).TTS_PROVIDER = originalProvider;
  if (originalOllamaUrl) (config as { OLLAMA_BASE_URL: string }).OLLAMA_BASE_URL = originalOllamaUrl;
  if (originalEmbeddingUrl) (config as { EMBEDDING_BASE_URL: string }).EMBEDDING_BASE_URL = originalEmbeddingUrl;
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
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr !== 'object') {
      await app.close();
      throw new Error('listen failed');
    }
    const url = `http://127.0.0.1:${addr.port}/api/notebooks/${NB_ID}/audio-overview?stream=1`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ style: 'short' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const events: Array<{
      type: string;
      meta?: { status: string; audioFilename: string | null; lineCount: number };
    }> = [];
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
      if (events.some((e) => e.type === 'done')) break;
    }
    await app.close();

    const finalMeta = events
      .filter((e) => e.type === 'meta' && e.meta)
      .map((e) => e.meta!)
      .at(-1);
    expect(finalMeta).toBeDefined();
    expect(finalMeta!.status).toBe('ready');
    expect(typeof finalMeta!.audioFilename).toBe('string');
    expect(finalMeta!.audioFilename).toMatch(/\.mp3$/);

    const filePath = join(process.cwd(), 'data', 'audio', NB_ID, finalMeta!.audioFilename!);
    const st = await stat(filePath);
    expect(st.size).toBeGreaterThan(0);

    const db = await env.getDb();
    const rows = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.notebookId, NB_ID))
      .all();
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0]!.meta!) as { status: string; lineCount: number };
    expect(meta.status).toBe('ready');
    expect(meta.lineCount).toBe(3);
  }, 60_000);
});
