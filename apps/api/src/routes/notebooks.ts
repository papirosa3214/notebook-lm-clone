import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';

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

    const id = nanoid(12);
    const db = getDb();
    db.insert(notebooks)
      .values({
        id,
        title,
        // Local Ollama + qwen3.6-27b-iq4-16k by default — same model
        // Mnemosyne uses (MNEMOSYNE_LLM_MODEL), so chat behaviour is
        // consistent across apps. 110 has no outbound network and can't
        // pull new models, so we stay with what's actually installed.
        defaultProvider: defaultProvider ?? 'ollama',
        defaultModel: defaultModel ?? 'qwen3.6-27b-iq4-16k:latest',
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
    // Chunks are removed by ON DELETE CASCADE on chunks.notebook_id.
    db.delete(notebooks).where(eq(notebooks.id, req.params.id)).run();
    return reply.code(204).send();
  });
};