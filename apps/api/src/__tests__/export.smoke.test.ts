/**
 * End-to-end smoke for the notebook export route.
 *
 * The route streams a real .zip via archiver. We pull the response
 * body through `app.inject().raw` (the raw Node IncomingMessage) and
 * parse it with fflate (sync unzip). Then we assert the standard
 * layout: README, metadata.json, one markdown file per source and
 * per artifact, and chat.md (or the empty-state placeholder).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { unzipSync, strFromU8 } from 'fflate';
import { withApiTestEnv } from './helpers.js';
import { artifacts, messages, notebooks, sources } from '../db/schema.js';

const env = withApiTestEnv();
const NB_ID = `nb_export_${nanoid(6)}`;
const SRC_A = `src_export_a_${nanoid(6)}`;
const SRC_B = `src_export_b_${nanoid(6)}`;
const ART_ID = `art_export_${nanoid(6)}`;

beforeAll(async () => {
  await env.install();
  const db = await env.getDb();
  db.insert(notebooks)
    .values({
      id: NB_ID,
      title: 'export smoke',
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
        summary: 'Саммари источника для экспорта.',
      })
      .run();
  }

  // Two chunks per source in known ordinal order so we can assert
  // the joined body in the export.
  const raw = await env.getRawSqlite();
  const insVec = raw.prepare(`INSERT INTO vec_chunks (embedding) VALUES (?)`);
  const insChunk = raw.prepare(
    `INSERT INTO chunks (vec_rowid, notebook_id, source_id, kind, title, url, content, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const dummyVec = Buffer.from(
    new Float32Array(Array.from({ length: 1024 }, (_, i) => 0.01 + (i % 7) * 0.001)).buffer,
  );
  for (const [srcIdx, sourceId] of [SRC_A, SRC_B].entries()) {
    for (let ord = 0; ord < 2; ord++) {
      const vecInfo = insVec.run(dummyVec);
      const vecRowid = Number(vecInfo.lastInsertRowid);
      insChunk.run(
        vecRowid,
        NB_ID,
        sourceId,
        'url',
        sourceId,
        `https://example.com/${sourceId}`,
        `chunk-${ord} of ${sourceId} with marker ${ord === 0 ? 'first' : 'second'}`,
        ord,
      );
    }
  }

  // One artifact and one chat message.
  db.insert(artifacts)
    .values({
      id: ART_ID,
      notebookId: NB_ID,
      title: 'Тестовая заметка',
      contentMd: '## Содержимое\n\nЭто тело артефакта для экспорта.',
      kind: 'note',
    })
    .run();
  db.insert(messages)
    .values({
      id: `msg_${nanoid(6)}`,
      notebookId: NB_ID,
      role: 'user',
      content: 'Привет, мир',
      citations: null,
      provider: 'ollama',
      model: 'qwen-test',
      topK: null,
    })
    .run();
});

afterAll(async () => {
  await env.restore();
});

describe('GET /api/notebooks/:id/export.zip', () => {
  it('returns a 200 with application/zip and a sanitisable filename', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${NB_ID}/export.zip`,
    });
    if (res.statusCode !== 200) {
      // Surface the actual error so failures are debuggable.
      throw new Error(`status=${res.statusCode} body=${res.body.slice(0, 500)}`);
    }
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename=".*\.zip"$/,
    );
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('contains README + metadata.json + sources + artifacts + chat', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${NB_ID}/export.zip`,
    });
    const entries = unzipSync(new Uint8Array(res.rawPayload));
    // Required top-level files
    expect(entries['README.md']).toBeDefined();
    expect(entries['metadata.json']).toBeDefined();
    expect(entries['chat.md']).toBeDefined();
    // One markdown per source
    expect(entries[`sources/${SRC_A}.md`]).toBeDefined();
    expect(entries[`sources/${SRC_B}.md`]).toBeDefined();
    // One markdown per artifact
    expect(entries[`artifacts/${ART_ID}.md`]).toBeDefined();
  });

  it('source markdown includes front-matter and chunked body in ordinal order', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${NB_ID}/export.zip`,
    });
    const entries = unzipSync(new Uint8Array(res.rawPayload));
    const srcBody = strFromU8(entries[`sources/${SRC_A}.md`]!);
    // Front-matter present
    expect(srcBody).toContain(`id: ${SRC_A}`);
    expect(srcBody).toContain(`kind: url`);
    expect(srcBody).toContain(`status: ready`);
    expect(srcBody).toContain('url: https://example.com/');
    // Summary blockquote
    expect(srcBody).toContain('> Саммари источника для экспорта.');
    // Both chunks present; ordinal 0 before ordinal 1
    const firstAt = srcBody.indexOf('chunk-0 of');
    const secondAt = srcBody.indexOf('chunk-1 of');
    expect(firstAt).toBeGreaterThan(0);
    expect(secondAt).toBeGreaterThan(firstAt);
    expect(srcBody).toContain('first');
    expect(srcBody).toContain('second');
  });

  it('artifact markdown equals the original contentMd', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${NB_ID}/export.zip`,
    });
    const entries = unzipSync(new Uint8Array(res.rawPayload));
    const artBody = strFromU8(entries[`artifacts/${ART_ID}.md`]!);
    expect(artBody).toContain('## Содержимое');
    expect(artBody).toContain('Это тело артефакта для экспорта.');
  });

  it('chat.md contains the user message and the empty-state label when no history', async () => {
    // First check the populated case: we have 1 message in this test.
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${NB_ID}/export.zip`,
    });
    const entries = unzipSync(new Uint8Array(res.rawPayload));
    const chatBody = strFromU8(entries['chat.md']!);
    expect(chatBody).toContain('## Ты');
    expect(chatBody).toContain('Привет, мир');

    // Empty case: a fresh notebook without any messages.
    const emptyId = `nb_export_empty_${nanoid(6)}`;
    const db = await env.getDb();
    db.insert(notebooks)
      .values({
        id: emptyId,
        title: 'empty chat',
        defaultProvider: 'ollama',
        defaultModel: 'qwen-test',
      })
      .run();
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${emptyId}/export.zip`,
    });
    const entries2 = unzipSync(new Uint8Array(res2.rawPayload));
    const emptyChat = strFromU8(entries2['chat.md']!);
    expect(emptyChat).toContain('Чат ещё пуст');
  });

  it('metadata.json reports the right counts', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/${NB_ID}/export.zip`,
    });
    const entries = unzipSync(new Uint8Array(res.rawPayload));
    const meta = JSON.parse(strFromU8(entries['metadata.json']!)) as {
      id: string;
      title: string;
      sourceCount: number;
      artifactCount: number;
      chatMessageCount: number;
    };
    expect(meta.id).toBe(NB_ID);
    expect(meta.title).toBe('export smoke');
    expect(meta.sourceCount).toBe(2);
    expect(meta.artifactCount).toBe(1);
    expect(meta.chatMessageCount).toBe(1);
  });

  it('returns 404 for unknown notebook', async () => {
    const app = await env.getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/notebooks/nb_does_not_exist_${nanoid(6)}/export.zip`,
    });
    expect(res.statusCode).toBe(404);
  });
});
