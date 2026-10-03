import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { CitationChunk } from '@notebook/shared';
import { getDb } from '../db/index.js';
import { artifacts, notebooks } from '../db/schema.js';

const CreateBody = z.object({
  title: z.string().min(1).max(300),
  contentMd: z.string().min(1),
});

const UpdateBody = z.object({
  title: z.string().min(1).max(300).optional(),
  contentMd: z.string().min(1).optional(),
});

/**
 * Build a markdown artifact from a chat Q/A + the citations used.
 * This is the default template; clients can override by passing `contentMd`
 * explicitly in the POST body.
 */
export function buildArtifactMarkdown(args: {
  question: string;
  answer: string;
  citations: CitationChunk[];
}): string {
  const { question, answer, citations } = args;
  const lines: string[] = [];
  lines.push(`# ${question.slice(0, 200)}`);
  lines.push('');
  lines.push('## Ответ');
  lines.push('');
  lines.push(answer.trim());
  if (citations.length > 0) {
    lines.push('');
    lines.push('## Источники');
    lines.push('');
    citations.forEach((c, i) => {
      const loc = c.location ? ` *(${c.location})*` : '';
      lines.push(`**[${i + 1}]** ${c.sourceTitle}${loc}`);
      const snippet = c.text.length > 400 ? c.text.slice(0, 400) + '…' : c.text;
      lines.push('');
      lines.push(snippet);
      lines.push('');
    });
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export const artifactRoutes: FastifyPluginAsync = async (app) => {
  // list artifacts for a notebook
  app.get<{ Params: { id: string } }>('/api/notebooks/:id/artifacts', async (req, reply) => {
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });
    const list = db
      .select()
      .from(artifacts)
      .where(eq(artifacts.notebookId, req.params.id))
      .all();
    return { artifacts: list };
  });

  // create
  app.post<{ Params: { id: string } }>('/api/notebooks/:id/artifacts', async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });

    const id = nanoid(12);
    db.insert(artifacts)
      .values({
        id,
        notebookId: req.params.id,
        title: parsed.data.title,
        contentMd: parsed.data.contentMd,
      })
      .run();
    const stored = db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    return reply.code(201).send(stored);
  });

  // read one
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (req, reply) => {
    const db = getDb();
    const a = db.select().from(artifacts).where(eq(artifacts.id, req.params.id)).get();
    if (!a) return reply.code(404).send({ error: 'artifact not found' });
    return a;
  });

  // update (rename / edit content)
  app.patch<{ Params: { id: string } }>('/api/artifacts/:id', async (req, reply) => {
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() });
    const db = getDb();
    const a = db.select().from(artifacts).where(eq(artifacts.id, req.params.id)).get();
    if (!a) return reply.code(404).send({ error: 'artifact not found' });

    const patch: Partial<{ title: string; contentMd: string; updatedAt: string }> = {
      updatedAt: new Date().toISOString(),
    };
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.contentMd !== undefined) patch.contentMd = parsed.data.contentMd;
    db.update(artifacts).set(patch).where(eq(artifacts.id, req.params.id)).run();
    const updated = db.select().from(artifacts).where(eq(artifacts.id, req.params.id)).get();
    return updated;
  });

  // download as .md file
  app.get<{ Params: { id: string } }>('/api/artifacts/:id/download', async (req, reply) => {
    const db = getDb();
    const a = db.select().from(artifacts).where(eq(artifacts.id, req.params.id)).get();
    if (!a) return reply.code(404).send({ error: 'artifact not found' });
    const filename = sanitizeFilename(a.title) + '.md';
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(a.contentMd);
  });

  // delete
  app.delete<{ Params: { id: string } }>('/api/artifacts/:id', async (req, reply) => {
    const db = getDb();
    const a = db.select().from(artifacts).where(eq(artifacts.id, req.params.id)).get();
    if (!a) return reply.code(404).send({ error: 'artifact not found' });
    db.delete(artifacts).where(eq(artifacts.id, req.params.id)).run();
    return reply.code(204).send();
  });
};

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'note';
}
