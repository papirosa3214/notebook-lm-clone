import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  DeepResearchDeltaSchema,
  DeepResearchMetaSchema,
  DeepResearchRequestSchema,
  type CitationChunk,
} from '@notebook/shared';
import { getDb } from '../db/index.js';
import { artifacts, notebooks, sources } from '../db/schema.js';
import { config } from '../config.js';
import { getProvider } from '../providers/index.js';
import { retrieveWithRerank } from '../vectordb/client.js';
import { addSourceText } from '../vectordb/client.js';
import { fetchUrlToMarkdown } from '../extractors/url.js';
import { searchWeb } from '../extractors/websearch.js';
import { parseJsonArray } from '../lib/studio/jsonArray.js';
import { mapChunk } from './chat.js';

const PLANNER_PROMPT =
  'Ты — исследовательский планировщик. По вопросу пользователя составь ' +
  'список поисковых запросов, которые вместе покроют тему с разных сторон. ' +
  'Требования: 1) строго JSON-массив строк, 2) каждый запрос — 2-6 слов, ' +
  '3) без нумерации, кавычек и пояснений, 4) разнообразь углы: определения, ' +
  'сравнения, практика, критика. Язык запросов — как у вопроса.';

const SYNTHESIS_PROMPT =
  'Ты — аналитик NotebookLM. По фрагментам источников напиши ' +
  'структурированный отчёт на русском языке в Markdown. ' +
  'Требования: 1) начни с заголовка `# ` и краткого вывода (2-3 предложения); ' +
  '2) далее 3-5 разделов `## `; 3) каждое фактическое утверждение помечай ' +
  'маркером [N], где N — номер источника из контекста; ' +
  '4) НЕ выдумывай факты, которых нет во фрагментах; ' +
  '5) в конце раздел `## Источники` со списком использованных номеров; ' +
  '6) не добавляй пояснений о процессе.';

/**
 * POST /api/notebooks/:id/deep-research
 *
 * Autonomous research agent. Four phases, streamed over SSE:
 *
 *   planning     — LLM turns the question into N search queries
 *   searching    — DuckDuckGo (no API key) for each query, deduped by URL
 *   fetching     — download + chunk + embed the top hits as real sources
 *   synthesizing — retrieve over the freshly ingested corpus and stream
 *                  a cited Markdown report
 *
 * The run persists one artifact (`kind='report'`, meta.template
 * `'deep_research'`) plus one `sources` row per ingested URL, so the
 * notebook is permanently richer after a run — the same behaviour as
 * NotebookLM's Deep Research.
 */
export const deepResearchRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>(
    '/api/notebooks/:id/deep-research',
    async (req, reply) => {
      if (!config.DEEP_RESEARCH_ENABLED) {
        return reply.code(503).send({
          error: 'deep research disabled (DEEP_RESEARCH_ENABLED=false)',
        });
      }

      const parsed = DeepResearchRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.format() });
      }

      const db = getDb();
      const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const { question, maxQueries, maxSources, resultsPerQuery } = parsed.data;
      const providerId = (parsed.data.provider ?? nb.defaultProvider) as
        | 'ollama'
        | 'anthropic'
        | 'openai';
      const model = parsed.data.model ?? nb.defaultModel;
      const provider = getProvider(providerId);

      // SSE headers.
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (delta: unknown) => {
        const ok = DeepResearchDeltaSchema.safeParse(delta);
        if (!ok.success) return;
        reply.raw.write(`data: ${JSON.stringify(ok.data)}\n\n`);
      };

      const artifactId = nanoid(12);
      const ingested: Array<{ id: string; title: string; url: string }> = [];
      let queries: string[] = [];
      let citations: CitationChunk[] = [];

      try {
        // ---- Phase 1: planning -------------------------------------
        send({ type: 'phase', phase: 'planning', ratio: 0.05, message: 'Планирую запросы…' });
        let plannerRaw = '';
        for await (const ev of provider.chat({
          providerId,
          model,
          messages: [
            { role: 'system', content: PLANNER_PROMPT },
            { role: 'user', content: `Вопрос: ${question}\n\nВерни JSON-массив из ${maxQueries} запросов.` },
          ],
          context: [],
          temperature: 0.5,
          maxTokens: 300,
        })) {
          if (ev.text) plannerRaw += ev.text;
          if (ev.done) break;
        }
        queries = parseJsonArray(plannerRaw, maxQueries)
          .map((q) => (typeof q === 'string' ? q.trim() : ''))
          .filter((q) => q.length > 0)
          .slice(0, maxQueries);
        // Fallback: if the planner produced nothing usable, search the
        // raw question — a degraded run beats a failed one.
        if (queries.length === 0) queries = [question];
        send({ type: 'queries', queries });

        // ---- Phase 2: searching ------------------------------------
        send({ type: 'phase', phase: 'searching', ratio: 0.2, message: 'Ищу в вебе…' });
        const seen = new Set<string>();
        const candidates: Array<{ url: string; title: string }> = [];
        for (const q of queries) {
          let hits: Array<{ url: string; title: string }> = [];
          try {
            hits = await searchWeb(q, resultsPerQuery);
          } catch {
            // A single failed query shouldn't kill the run.
            continue;
          }
          for (const h of hits) {
            if (seen.has(h.url)) continue;
            seen.add(h.url);
            candidates.push({ url: h.url, title: h.title });
          }
          if (candidates.length >= maxSources) break;
        }
        const toFetch = candidates.slice(0, maxSources);
        if (toFetch.length === 0) {
          send({ type: 'error', message: 'поиск не вернул результатов' });
          reply.raw.end();
          return;
        }

        // ---- Phase 3: fetching + ingesting -------------------------
        send({
          type: 'phase',
          phase: 'fetching',
          ratio: 0.4,
          message: `Загружаю ${toFetch.length} источников…`,
        });
        for (let i = 0; i < toFetch.length; i++) {
          const c = toFetch[i]!;
          const sourceId = nanoid(12);
          try {
            const { markdown, title } = await fetchUrlToMarkdown(c.url);
            db.insert(sources)
              .values({
                id: sourceId,
                notebookId: req.params.id,
                kind: 'url',
                title,
                url: c.url,
                status: 'ready',
              })
              .run();
            await addSourceText({
              notebookId: req.params.id,
              sourceId,
              kind: 'url',
              title,
              url: c.url,
              content: markdown,
            });
            ingested.push({ id: sourceId, title, url: c.url });
            send({ type: 'hit', url: c.url, title, ingested: true });
          } catch (err) {
            send({
              type: 'hit',
              url: c.url,
              title: c.title,
              ingested: false,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
          send({
            type: 'phase',
            phase: 'fetching',
            ratio: 0.4 + (0.35 * (i + 1)) / toFetch.length,
            message: `(${i + 1}/${toFetch.length}) ${new URL(c.url).hostname}`,
          });
        }

        if (ingested.length === 0) {
          send({ type: 'error', message: 'не удалось загрузить ни одного источника' });
          reply.raw.end();
          return;
        }

        // ---- Phase 4: synthesizing ---------------------------------
        send({ type: 'phase', phase: 'synthesizing', ratio: 0.78, message: 'Пишу отчёт…' });
        const raw = await retrieveWithRerank(req.params.id, question, 10, {
          provider: providerId,
          model,
        });
        citations = raw.map(mapChunk);

        const contextBlock = citations
          .map((c, i) => `[${i + 1}] ${c.sourceTitle}\n${c.text}`)
          .join('\n\n');

        let body = '';
        for await (const ev of provider.chat({
          providerId,
          model,
          messages: [
            { role: 'system', content: SYNTHESIS_PROMPT },
            {
              role: 'user',
              content: `Вопрос: ${question}\n\nФрагменты источников:\n${contextBlock}`,
            },
          ],
          context: [],
          temperature: 0.4,
          maxTokens: 2000,
        })) {
          if (ev.text) {
            body += ev.text;
            send({ type: 'token', text: ev.text });
          }
          if (ev.done) break;
        }

        const now = new Date().toISOString();
        const meta = DeepResearchMetaSchema.parse({
          template: 'deep_research',
          status: 'ready',
          question,
          queries,
          ingestedSources: ingested,
          sourceCount: ingested.length,
          citationCount: citations.length,
          model,
          error: null,
          createdAt: now,
          updatedAt: now,
        });
        db.insert(artifacts)
          .values({
            id: artifactId,
            notebookId: req.params.id,
            title: `Deep Research — ${question.slice(0, 60)}`,
            contentMd: body.trim(),
            kind: 'report',
            meta: JSON.stringify(meta),
          })
          .run();

        send({
          type: 'done',
          artifactId,
          sourceCount: ingested.length,
          citationCount: citations.length,
        });
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
