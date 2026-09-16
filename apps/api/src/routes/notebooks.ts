import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { createDataset } from '../ragflow/client.js';

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  defaultProvider: z.enum(['anthropic', 'openai', 'ollama']).optional(),
  defaultModel: z.string().optional(),
});

export const notebookRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/notebooks', async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.format() });
    }
    const { title, defaultProvider, defaultModel } = parsed.data;

    // 1. create dataset in Ragflow (it becomes our storage + retrieval backend)
    const rag = await createDataset(title, `Notebook created at ${new Date().toISOString()}`);
    // 2. mirror in our SQLite
    const id = nanoid(12);
    const db = getDb();
    db.insert(notebooks)
      .values({
        id,
        title,
        ragflowDatasetId: rag.id,
        defaultProvider: defaultProvider ?? 'anthropic',
        defaultModel: defaultModel ?? 'claude-sonnet-4-5',
      })
      .run();

    const created = db.select().from(notebooks).where(eq(notebooks.id, id)).get();
    return reply.code(201).send(created);
  });

  app.get('/api/notebooks', async () => {
    const db = getDb();
    const rows = db
      .select({
        id: notebooks.id,
        title: notebooks.title,
        ragflowDatasetId: notebooks.ragflowDatasetId,
        defaultProvider: notebooks.defaultProvider,
        defaultModel: notebooks.defaultModel,
        createdAt: notebooks.createdAt,
        sourceCount: sql<number>`(SELECT COUNT(*) FROM ${sources} WHERE ${sources.notebookId} = ${notebooks.id})`,
        readySourceCount: sql<number>`(SELECT COUNT(*) FROM ${sources} WHERE ${sources.notebookId} = ${notebooks.id} AND ${sources.status} = 'ready')`,
      })
      .from(notebooks)
      .all();
    return { notebooks: rows };
  });

  app.get<{ Params: { id: string } }>('/api/notebooks/:id', async (req, reply) => {
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });
    return nb;
  });

  app.delete<{ Params: { id: string } }>('/api/notebooks/:id', async (req, reply) => {
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });
    // NOTE: Ragflow v0.25 does NOT expose DELETE /datasets/{id} via REST.
    // The dataset is orphaned in Ragflow and must be removed manually in the UI.
    req.log.warn(
      { notebookId: req.params.id, ragflowDatasetId: nb.ragflowDatasetId },
      'notebook deleted locally; Ragflow dataset left orphaned — clean up via UI',
    );
    db.delete(notebooks).where(eq(notebooks.id, req.params.id)).run();
    return reply.code(204).send();
  });
};
