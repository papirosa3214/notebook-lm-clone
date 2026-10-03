import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import {
  DataTableSchema,
  FlashcardSetSchema,
  StudioDeltaSchema,
  StudioRequestSchema,
  type CitationChunk,
  type DataTable,
  type Flashcard,
  type StudioReportMeta,
} from '@notebook/shared';
import { nanoid as makeFlashcardId } from 'nanoid';
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
        //
        // For `flashcards` we additionally parse the LLM output as
        // JSON and persist a `FlashcardSet` so the client can render
        // an interactive deck without re-parsing markdown.
        const meta: StudioReportMeta = {
          template: template.id,
          citationCount: citations.length,
          createdAt: new Date().toISOString(),
        };
        let persistedBody: string;
        if (template.id === 'flashcards') {
          const cards = parseFlashcardStream(textBuf);
          const set = FlashcardSetSchema.parse({ cards });
          meta.flashcardCount = set.cards.length;
          persistedBody = JSON.stringify(set);
        } else if (template.id === 'data_table') {
          const table = parseDataTableStream(textBuf);
          // Empty-table fallback: if the model didn't emit valid
          // JSON, persist a one-column "Нет данных" row so the user
          // sees something rather than a broken renderer.
          const safe: DataTable = table ?? {
            columns: ['Результат'],
            rows: [{ Результат: 'Нет данных' }],
          };
          meta.columnCount = safe.columns.length;
          meta.rowCount = safe.rows.length;
          persistedBody = JSON.stringify(safe);
        } else {
          persistedBody = textBuf;
        }
        db.insert(artifacts)
          .values({
            id: artifactId,
            notebookId: req.params.id,
            title: `${template.title}`,
            contentMd: persistedBody,
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

/**
 * Parse the streamed LLM output as a list of {question, answer} pairs.
 *
 * The model is told to emit a raw JSON array; we tolerate a few
 * real-world failures: trailing junk after the array, ```json fences,
 * unquoted keys, and a leading "вот ваши карточки:" preamble. If the
 * first parse attempt fails we look for a `[`/`]` pair and retry
 * just that slice.
 */
export function parseFlashcardStream(text: string): Flashcard[] {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  // Fenced JSON
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) candidates.push(fence[1] ?? '');

  // First '[' to last ']' slice, if any.
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  }

  for (const candidate of candidates) {
    const cards = tryParseFlashcardArray(candidate);
    if (cards.length > 0) return cards;
  }
  return [];
}

function tryParseFlashcardArray(raw: string): Flashcard[] {
  // Strip a single C++/JS-style line comment and BOM, but otherwise
  // hand the text to JSON.parse.
  const cleaned = raw
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trimEnd())
    .filter((l) => l.length > 0)
    .join('\n');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Flashcard[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as { question?: unknown; answer?: unknown };
    if (typeof o.question !== 'string' || typeof o.answer !== 'string') continue;
    const q = o.question.trim();
    const a = o.answer.trim();
    if (!q || !a) continue;
    out.push({ id: makeFlashcardId(8), question: q, answer: a });
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * Parse the streamed LLM output as a DataTable.
 *
 * The model is told to emit a single JSON object of the form
 * {title?, columns: string[], rows: Array<Record<string,string>>}.
 * Like `parseFlashcardStream` we tolerate fence wrappers and
 * surrounding prose, then validate via the DataTable schema.
 *
 * Returns `null` on total failure (no JSON object at all) so the
 * caller can fall back to a one-row "Нет данных" placeholder
 * rather than 500-ing the user.
 */
export function parseDataTableStream(text: string): DataTable | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) candidates.push(fence[1] ?? '');

  // First '{' to last '}' slice — the typical wrapping case.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    const obj = tryParseDataTableObject(candidate);
    if (obj) return obj;
  }
  return null;
}

function tryParseDataTableObject(raw: string): DataTable | null {
  const cleaned = raw
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trimEnd())
    .filter((l) => l.length > 0)
    .join('\n');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as {
    title?: unknown;
    columns?: unknown;
    rows?: unknown;
  };
  if (typeof o.columns !== 'object' || !Array.isArray(o.columns)) return null;
  if (typeof o.rows !== 'object' || !Array.isArray(o.rows)) return null;

  // Normalize columns: trim, drop empties, dedupe (first wins), cap at 20.
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const c of o.columns) {
    if (typeof c !== 'string') continue;
    const t = c.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    columns.push(t);
    if (columns.length >= 20) break;
  }
  if (columns.length === 0) return null;

  // Normalize rows: keep only cells whose key is in `columns`, coerce
  // values to strings, drop empty rows, cap at 500.
  const rows: Array<Record<string, string>> = [];
  for (const r of o.rows) {
    if (typeof r !== 'object' || r === null) continue;
    const src = r as Record<string, unknown>;
    const out: Record<string, string> = {};
    let hasAny = false;
    for (const col of columns) {
      const v = src[col];
      if (v == null) continue;
      const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
      if (s.length > 0) {
        out[col] = s;
        hasAny = true;
      }
    }
    if (hasAny) {
      rows.push(out);
      if (rows.length >= 500) break;
    }
  }
  if (rows.length === 0) return null;

  const title = typeof o.title === 'string' ? o.title.trim().slice(0, 200) : undefined;
  return title ? { title, columns, rows } : { columns, rows };
}
