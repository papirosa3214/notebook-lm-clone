import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import {
  fetchUrlToMarkdown,
  listDocuments,
  parseDocuments,
  uploadDocumentFile,
  type DocumentInfo,
} from '../ragflow/client.js';

const AddUrlBody = z.object({
  url: z.string().url(),
  title: z.string().optional(),
});

function mapRagflowStatus(doc: DocumentInfo): 'pending' | 'parsing' | 'ready' | 'failed' {
  if (doc.run === 'FAIL') return 'failed';
  if (doc.run === 'DONE') return 'ready';
  if (doc.run === 'UNSTART' || doc.run === 'RUNNING') return doc.chunk_count > 0 ? 'ready' : 'parsing';
  return 'parsing';
}

async function findDoc(
  datasetId: string,
  docId: string,
): Promise<DocumentInfo | null> {
  const all = await listDocuments(datasetId);
  return all.find((d) => d.id === docId) ?? null;
}

export const sourceRoutes: FastifyPluginAsync = async (app) => {
  // list sources for a notebook
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

  // add a URL source (Ragflow will fetch, parse, embed)
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
        // 1. fetch + convert HTML → Markdown ourselves
        const { markdown, title: fetchedTitle } = await fetchUrlToMarkdown(url);
        // 2. upload the markdown into the Ragflow dataset (extension .md picks markdown parser)
        const safeName =
          (title ?? fetchedTitle)
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .slice(0, 80) || `web-${Date.now()}`;
        const doc = await uploadDocumentFile(nb.ragflowDatasetId, {
          buffer: Buffer.from(markdown, 'utf-8'),
          filename: `${safeName}.md`,
        });
        // 3. kick the parser (Ragflow v0.25 leaves run=UNSTART without this)
        try {
          await parseDocuments(nb.ragflowDatasetId, [doc.id]);
        } catch (kickErr) {
          req.log.warn({ err: kickErr, docId: doc.id }, 'parseDocuments kick failed; will retry on refresh');
        }
        // 4. update our mirror with the ragflow doc id + initial status
        db.update(sources)
          .set({
            ragflowDocId: doc.id,
            title: title ?? fetchedTitle,
            status: mapRagflowStatus(doc),
          })
          .where(eq(sources.id, localId))
          .run();
      } catch (err) {
        db.update(sources)
          .set({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
          .where(eq(sources.id, localId))
          .run();
      }

      const stored = db.select().from(sources).where(eq(sources.id, localId)).get();
      return reply.code(201).send(stored);
    },
  );

  // poll Ragflow to refresh status of a single source
  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/refresh',
    async (req, reply) => {
      const db = getDb();
      const src = db.select().from(sources).where(eq(sources.id, req.params.id)).get();
      if (!src) return reply.code(404).send({ error: 'source not found' });
      if (!src.ragflowDocId) return reply.code(409).send({ error: 'source has no ragflow doc yet' });
      const nb = db.select().from(notebooks).where(eq(notebooks.id, src.notebookId)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const doc = await findDoc(nb.ragflowDatasetId, src.ragflowDocId);
      if (!doc) return reply.code(404).send({ error: 'ragflow doc not found in dataset' });
      db.update(sources)
        .set({ status: mapRagflowStatus(doc) })
        .where(eq(sources.id, req.params.id))
        .run();
      const updated = db.select().from(sources).where(eq(sources.id, req.params.id)).get();
      return updated;
    },
  );

  // bulk refresh all sources of a notebook (cheap polling)
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/sources/refresh',
    async (req, reply) => {
      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });
      const list = db
        .select()
        .from(sources)
        .where(and(eq(sources.notebookId, req.params.id)))
        .all();
      const updates: Array<typeof sources.$inferSelect> = [];
      for (const s of list) {
        if (!s.ragflowDocId) continue;
        if (s.status === 'ready' || s.status === 'failed') continue;
        try {
          const doc = await findDoc(nb.ragflowDatasetId, s.ragflowDocId);
          if (!doc) continue;
          const next = mapRagflowStatus(doc);
          if (next !== s.status) {
            db.update(sources)
              .set({ status: next })
              .where(eq(sources.id, s.id))
              .run();
            updates.push({ ...s, status: next });
          }
        } catch (err) {
          db.update(sources)
            .set({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
            .where(eq(sources.id, s.id))
            .run();
        }
      }
      const fresh = db
        .select()
        .from(sources)
        .where(eq(sources.notebookId, req.params.id))
        .all();
      return { sources: fresh, changed: updates.length };
    },
  );

  // delete a source (local + Ragflow)
  app.delete<{ Params: { id: string } }>('/api/sources/:id', async (req, reply) => {
    const db = getDb();
    const src = db.select().from(sources).where(eq(sources.id, req.params.id)).get();
    if (!src) return reply.code(404).send({ error: 'source not found' });
    // NB: Ragflow document deletion is not called here in MVP — would need
    // DELETE /api/v1/datasets/{dataset_id}/documents/{doc_id}
    db.delete(sources).where(eq(sources.id, req.params.id)).run();
    return reply.code(204).send();
  });
};
