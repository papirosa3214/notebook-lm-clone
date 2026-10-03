import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import {
  StudioDeltaSchema,
  StudioRequestSchema,
  type CitationChunk,
  type StudioReportMeta,
} from '@notebook/shared';
import { getDb } from '../db/index.js';
import { artifacts, notebooks, sources } from '../db/schema.js';
import { retrieveWithRerank, type RetrievalChunk } from '../vectordb/client.js';
import { mapChunk } from './chat.js';
import {
  formatSourcesForPrompt,
  getTemplate,
  listTemplates,
} from '../lib/studio/templates.js';
import { getProvider } from '../providers/index.js';

/**
 * Studio Reports — templated LLM outputs persisted as artifacts.
 *
 *   POST /api/notebooks/:id/artifacts/studio     — generate a report
 *   GET  /api/notebooks/:id/studio/templates     — list available templates
 *
 * The route reuses the same sourceIds validation contract as /chat
 * (no silent fallback to "all sources" on stale ids) and the same
 * retrieval pipeline (RRF + rerank). Output is streamed via SSE in
 * the chat's familiar `citations → token* → done` shape so the
 * client side stays uniform.
 */
export const studioRoutes: FastifyPluginAsync = async (app) => {
  // List available templates — used by the Studio dialog to render
  // the picker without baking template metadata into the client.
  app.get('/api/notebooks/:id/studio/templates', async (_req, reply) => {
    return reply.send({
      templates: listTemplates().map((t) => ({
        id: t.id,
        title: t.title,
        blurb: t.blurb,
        defaultTopK: t.defaultTopK,
      })),
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/artifacts/studio',
    async (req, reply) => {
      const parsed = StudioRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.format() });
      }
      const db = getDb();
      const nb = db
        .select()
        .from(notebooks)
        .where(eq(notebooks.id, req.params.id))
        .get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      // sourceIds validation — same contract as /chat and /audio-overview.
      const requestedSources = parsed.data.sourceIds ?? [];
      let scopedSourceIds: string[] | undefined = undefined;
      if (requestedSources.length > 0) {
        const dedup = Array.from(new Set(requestedSources));
        const found = db
          .select({ id: sources.id })
          .from(sources)
          .where(
            and(eq(sources.notebookId, req.params.id), inArray(sources.id, dedup)),
          )
          .all();
        if (found.length !== dedup.length) {
          const foundSet = new Set(found.map((r) => r.id));
          const missing = dedup.filter((id) => !foundSet.has(id));
          return reply
            .code(400)
            .send({ error: `unknown sourceIds: ${missing.join(', ')}` });
        }
        scopedSourceIds = found.map((r) => r.id);
      }

      const readyCount = db
        .select()
        .from(sources)
        .where(eq(sources.notebookId, req.params.id))
        .all()
        .filter((s) => s.status === 'ready').length;
      if (readyCount === 0) {
        return reply.code(400).send({
          error: 'Нет готовых источников. Добавьте хотя бы один перед генерацией отчёта.',
        });
      }

      const template = getTemplate(parsed.data.template);
      const providerId = (parsed.data.provider ?? nb.defaultProvider) as
        | 'ollama'
        | 'anthropic'
        | 'openai';
      const model = parsed.data.model ?? nb.defaultModel;
      const topK = parsed.data.topK ?? template.defaultTopK;
      const focus = parsed.data.focus;

      // Retrieve
      let citations: CitationChunk[] = [];
      try {
        const raw = await retrieveWithRerank(
          req.params.id,
          focus ?? template.title,
          topK,
          { provider: providerId, model, sourceIds: scopedSourceIds },
        );
        citations = raw.map(mapChunk);
      } catch (err) {
        req.log.warn({ err }, 'studio retrieval failed; continuing with empty context');
      }
      if (citations.length === 0) {
        return reply.code(400).send({
          error: 'Retrieval не нашёл релевантных чанков — попробуй сменить focus или убрать sourceIds.',
        });
      }

      // SSE headers — same pattern as /chat and /summary.
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-along',
        'X-Accel-Buffering': 'no',
      });
      const send = (delta: unknown) => {
        const ok = StudioDeltaSchema.safeParse(delta);
        if (!ok.success) return;
        reply.raw.write(`data: ${JSON.stringify(ok.data)}\n\n`);
      };

      // Citations first.
      send({ type: 'citations', chunks: citations });

      const systemPrompt = [
        template.systemInstructions,
        '',
        '## Источники',
        formatSourcesForPrompt(citations),
      ].join('\n');
      const userPrompt = template.userPrompt({
        focus,
        sourcesBlock: formatSourcesForPrompt(citations),
      });
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userPrompt },
      ];

      const provider = getProvider(providerId);
      const artifactId = nanoid(12);
      let textBuf = '';

      try {
        for await (const ev of provider.chat({
          providerId,
          model,
          messages,
          context: citations,
          temperature: 0.3,
          maxTokens: 2400,
        })) {
          if (ev.text) {
            textBuf += ev.text;
            send({ type: 'token', text: ev.text });
          }
          if (ev.done) break;
        }
        // Persist the artifact. We don't apply the chat-route
        // sanitiser here: the Studio context is structured (FAQ / TL;DR
        // / Timeline / Contradictions), not free-form chat, and a
        // stray [N] is the model's responsibility per the template's
        // strict instructions. If you change that, the same
        // sanitizeCitations helper from shared/providers applies.
        const meta: StudioReportMeta = {
          template: template.id,
          citationCount: citations.length,
          createdAt: new Date().toISOString(),
        };
        db.insert(artifacts)
          .values({
            id: artifactId,
            notebookId: req.params.id,
            title: `${template.title}`,
            contentMd: textBuf,
            kind: 'report',
            meta: JSON.stringify(meta),
          })
          .run();
        send({ type: 'done', artifactId });
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        reply.raw.end();
      }
    },
  );
};

// Helper re-export so the test suite can verify retrieval → citation
// mapping without going through the chat route.
export const _mapChunk = mapChunk;
export type { RetrievalChunk };
