import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { extractDocx, extractPdf, extractPlainText } from '../extractors/index.js';
import { fetchUrlToMarkdown } from '../extractors/url.js';
import { fetchYouTubeTranscript } from '../extractors/youtube.js';
import { addSourceText, removeSource } from '../vectordb/client.js';

const AddUrlBody = z.object({
  url: z.string().url(),
  title: z.string().optional(),
});

export const sourceRoutes: FastifyPluginAsync = async (app) => {
  // List sources for a notebook.
  app.get<{ Params: { id: string } }>('/api/notebooks/:id/sources', async (req, reply) => {
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });
    const list = db
      .select()
      .from(sources)
      .where(eq(sources.notebookId, req.params.id))
      .all();
    return { sources: list };
  });

  // Add a URL — fetch → markdown → chunk → embed → store. Synchronous: by the
  // time the POST returns, the source is either 'ready' or 'failed'.
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/sources/url',
    async (req, reply) => {
      const parsed = AddUrlBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.format() });
      }
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const { url, title } = parsed.data;
      const localId = nanoid(12);
      const titleFallback =
        title ?? new URL(url).hostname + ' — ' + new Date().toISOString().slice(0, 10);

      db.insert(sources)
        .values({
          id: localId,
          notebookId: req.params.id,
          kind: 'url',
          title: titleFallback,
          url,
          status: 'pending',
        })
        .run();

      try {
        const { markdown, title: fetchedTitle } = await fetchUrlToMarkdown(url);
        await addSourceText({
          notebookId: req.params.id,
          sourceId: localId,
          kind: 'url',
          title: title ?? fetchedTitle,
          url,
          content: markdown,
        });
        db.update(sources)
          .set({ title: title ?? fetchedTitle, status: 'ready' })
          .where(eq(sources.id, localId))
          .run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.update(sources)
          .set({ status: 'failed', error: msg })
          .where(eq(sources.id, localId))
          .run();
      }

      const stored = db.select().from(sources).where(eq(sources.id, localId)).get();
      return reply.code(201).send(stored);
    },
  );

  // Per-source refresh — kept as a no-op for UI compatibility (the local
  // store transitions pending → ready synchronously, so polling is unnecessary).
  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/refresh',
    async (req, reply) => {
      const db = getDb();
      const src = db.select().from(sources).where(eq(sources.id, req.params.id)).get();
      if (!src) return reply.code(404).send({ error: 'source not found' });
      return src;
    },
  );

  // Bulk refresh — same no-op contract.
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/sources/refresh',
    async (req, reply) => {
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });
      const list = db
        .select()
        .from(sources)
        .where(eq(sources.notebookId, req.params.id))
        .all();
      return { sources: list, changed: 0 };
    },
  );

  // Delete a source (metadata + chunks via FK cascade).
  app.delete<{ Params: { id: string } }>('/api/sources/:id', async (req, reply) => {
    const db = getDb();
    const src = db.select().from(sources).where(eq(sources.id, req.params.id)).get();
    if (!src) return reply.code(404).send({ error: 'source not found' });
    removeSource(req.params.id);
    db.delete(sources).where(eq(sources.id, req.params.id)).run();
    return reply.code(204).send();
  });

  // File upload (PDF/DOCX/TXT/MD).
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/sources/upload',
    async (req, reply) => {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'multipart "file" field required' });
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const buffer = await file.toBuffer();
      if (buffer.length > 50 * 1024 * 1024) {
        return reply.code(413).send({ error: 'file exceeds 50MB limit' });
      }

      const filename = sanitizeFilename(file.filename);
      const lower = filename.toLowerCase();
      const localId = nanoid(12);
      db.insert(sources)
        .values({
          id: localId,
          notebookId: req.params.id,
          kind: 'file',
          title: filename,
          url: null,
          status: 'pending',
        })
        .run();

      try {
        let text: string;
        if (lower.endsWith('.pdf')) text = await extractPdf(buffer);
        else if (lower.endsWith('.docx')) text = await extractDocx(buffer);
        else if (lower.endsWith('.md') || lower.endsWith('.markdown')) text = buffer.toString('utf-8');
        else if (lower.endsWith('.txt') || lower.endsWith('.text')) text = await extractPlainText(buffer);
        else return reply.code(415).send({ error: `unsupported file type: ${filename}` });

        await addSourceText({
          notebookId: req.params.id,
          sourceId: localId,
          kind: 'file',
          title: filename,
          url: null,
          content: text,
        });
        db.update(sources)
          .set({ status: 'ready' })
          .where(eq(sources.id, localId))
          .run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.update(sources)
          .set({ status: 'failed', error: msg })
          .where(eq(sources.id, localId))
          .run();
      }

      const stored = db.select().from(sources).where(eq(sources.id, localId)).get();
      return reply.code(201).send(stored);
    },
  );

  // YouTube transcript.
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/sources/youtube',
    async (req, reply) => {
      const parsed = z.object({ url: z.string().min(1), title: z.string().optional() }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const localId = nanoid(12);
      db.insert(sources)
        .values({
          id: localId,
          notebookId: req.params.id,
          kind: 'youtube',
          title: parsed.data.title ?? parsed.data.url,
          url: parsed.data.url,
          status: 'pending',
        })
        .run();

      try {
        const { text, title: fetchedTitle } = await fetchYouTubeTranscript(parsed.data.url);
        await addSourceText({
          notebookId: req.params.id,
          sourceId: localId,
          kind: 'youtube',
          title: parsed.data.title ?? fetchedTitle,
          url: parsed.data.url,
          content: text,
        });
        db.update(sources)
          .set({ title: parsed.data.title ?? fetchedTitle, status: 'ready' })
          .where(eq(sources.id, localId))
          .run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.update(sources)
          .set({ status: 'failed', error: msg })
          .where(eq(sources.id, localId))
          .run();
      }

      const stored = db.select().from(sources).where(eq(sources.id, localId)).get();
      return reply.code(201).send(stored);
    },
  );
};

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'upload';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'upload';
}