import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { notebooks, sources } from '../db/schema.js';
import { ensureCoverSpec } from '../lib/coverArt.js';

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  defaultProvider: z.enum(['anthropic', 'openai', 'ollama', 'minimax']).optional(),
  defaultModel: z.string().optional(),
});

/** Pull just the signature out of a stored cover recipe. */
function signatureOfCoverSpec(raw: string): string | null {
  try {
    const obj = JSON.parse(raw) as { signature?: unknown };
    return typeof obj.signature === 'string' ? obj.signature : null;
  } catch {
    return null;
  }
}

export const notebookRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/notebooks', async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.format() });
    }
    const { title, defaultProvider, defaultModel } = parsed.data;

    const id = nanoid(12);
    const db = getDb();
    const provider = defaultProvider ?? 'minimax';
    const model = defaultModel ?? 'MiniMax-M3';
    db.insert(notebooks)
      .values({
        id,
        title,
        // По умолчанию — MiniMax-M3 через прокси https://api.minimax.io/anthropic.
        // Ключ задаётся в env как MINIMAX_API_KEY. Если ключ не задан, провайдер
        // бросит ошибку при первом чате — пользователь увидит её явно.
        defaultProvider: provider,
        defaultModel: model,
      })
      .run();

    const created = db.select().from(notebooks).where(eq(notebooks.id, id)).get();

    // Обложка рисуется по теме ноутбука сразу, но ответ клиенту не
    // ждёт LLM: карточка отдаёт детерминированную обложку по title,
    // а модель через секунду-две дописывает свои цвета, мотив и
    // подпись. Фоновая задача не должна ронять создание ноутбука,
    // поэтому ошибки только логируются.
    void ensureCoverSpec(id, { provider, model })
      .then(({ changed }) => {
        if (changed) app.log.info({ notebookId: id }, 'cover generated');
      })
      .catch((err) => app.log.warn({ err, notebookId: id }, 'cover generation failed'));

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
        coverSpec: notebooks.coverSpec,
        // Qualify both sides with their table name. Drizzle renders a bare
        // `${sources.notebookId}` as `"notebook_id"` with no table, so
        // SQLite reads `notebook_id = id` as a self-join inside `sources`
        // and every notebook reported "0 источников" forever.
        sourceCount: sql<number>`(SELECT COUNT(*) FROM ${sources} WHERE ${sources}.notebook_id = ${notebooks}.id)`,
        readySourceCount: sql<number>`(SELECT COUNT(*) FROM ${sources} WHERE ${sources}.notebook_id = ${notebooks}.id AND ${sources}.status = 'ready')`,
      })
      .from(notebooks)
      .orderBy(desc(notebooks.createdAt))
      .all();

    // coverSpec stays server-side (it's a whole render recipe); the client
    // only needs its signature, to bust the browser's image cache when
    // the art changes.
    return {
      notebooks: rows.map(({ coverSpec, ...rest }) => ({
        ...rest,
        coverSignature: coverSpec ? signatureOfCoverSpec(coverSpec) : null,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/notebooks/:id', async (req, reply) => {
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });
    // Same split as the list endpoint: the render recipe stays server-side,
    // the client gets the signature to bust the cover image cache.
    const { coverSpec, ...rest } = nb;
    return { ...rest, coverSignature: coverSpec ? signatureOfCoverSpec(coverSpec) : null };
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