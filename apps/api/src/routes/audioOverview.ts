import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  AudioOverviewDeltaSchema,
  AudioOverviewMetaSchema,
  AudioOverviewRequestSchema,
  type AudioOverviewLine,
  type AudioOverviewMeta,
} from '@notebook/shared';
import { getDb } from '../db/index.js';
import { artifacts, notebooks, sources } from '../db/schema.js';
import { retrieveWithRerank } from '../vectordb/client.js';
import { mapChunk } from './chat.js';
import { buildScript, linesToMarkdown } from '../lib/audio/scriptBuilder.js';
import { getTtsProvider } from '../lib/audio/factory.js';
import {
  audioPath,
  deleteAudio,
  ensureAudioDir,
} from '../lib/audio/storage.js';
import { createReadStream } from 'node:fs';
import { stat as statAsync } from 'node:fs/promises';

/**
 * POST /api/notebooks/:id/audio-overview
 *
 * Streamed (SSE) two-stage flow:
 *   1. retrieve top-K chunks via the same source-scope-aware pipeline
 *      the chat uses. Failures here fail the job.
 *   2. drive the LLM script builder, emitting one `script_line` per
 *      SCRIPT:/MIRA:/STAGE: line. On the last line we persist the
 *      artifact with status='scripting' and meta=…
 *   3. TTS. With TTS_PROVIDER=noop (default) this is a no-op that
 *      leaves audioFilename=null and status='ready'. Real providers
 *      (openai / mac-say / kokoro) will land in subsequent commits;
 *      until then this route still produces a usable script artifact.
 *   4. send `done` with the artifactId.
 *
 * Failures at any stage: catch, write status='failed' + error into
 * meta, send a final `error` delta, end the stream.
 */
export const audioOverviewRoutes: FastifyPluginAsync = async (app) => {
  app.post<{
    Params: { id: string };
    Querystring: { stream?: string };
  }>('/api/notebooks/:id/audio-overview', async (req, reply) => {
    const parsed = AudioOverviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.format() });
    }
    const db = getDb();
    const nb = db.select().from(notebooks).where(eq(notebooks.id, req.params.id)).get();
    if (!nb) return reply.code(404).send({ error: 'notebook not found' });

    // sourceIds validation — same contract as /chat. Empty/absent =
    // search the whole notebook; unknown ids → 400.
    const requestedSources = parsed.data.sourceIds ?? [];
    let scopedSourceIds: string[] | undefined = undefined;
    if (requestedSources.length > 0) {
      const dedup = Array.from(new Set(requestedSources));
      const found = db
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.notebookId, req.params.id), inArray(sources.id, dedup)))
        .all();
      if (found.length !== dedup.length) {
        const foundSet = new Set(found.map((r) => r.id));
        const missing = dedup.filter((id) => !foundSet.has(id));
        return reply.code(400).send({ error: `unknown sourceIds: ${missing.join(', ')}` });
      }
      scopedSourceIds = found.map((r) => r.id);
    }

    const artifactId = nanoid(12);
    const providerId = (parsed.data.provider ?? nb.defaultProvider) as
      | 'ollama'
      | 'anthropic'
      | 'openai';
    const model = parsed.data.model ?? nb.defaultModel;
    const focus = parsed.data.focus;
    const style = parsed.data.style;

    // 1. retrieve
    let citations;
    try {
      const raw = await retrieveWithRerank(req.params.id, focus ?? 'обзор материалов ноутбука', 8, {
        provider: providerId,
        model,
        sourceIds: scopedSourceIds,
      });
      citations = raw.map(mapChunk);
    } catch (err) {
      return reply.code(500).send({
        error: `retrieval failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (citations.length === 0) {
      return reply.code(400).send({
        error: 'no sources available to script an audio overview',
      });
    }

    const wantsStream = req.query.stream === '1' || req.headers.accept?.includes('text/event-stream');

    if (!wantsStream) {
      // Synchronous fallback: build the script in one go, return the
      // artifact. Used by tests and any future client that doesn't want
      // SSE.
      const built = await buildScript({
        query: focus ?? 'обзор материалов ноутбука',
        citations,
        style,
        focus,
        provider: providerId,
        model,
      });
      const meta: AudioOverviewMeta = {
        status: 'ready',
        style,
        lineCount: built.lines.length,
        durationSec: null,
        audioFilename: null,
        model,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.insert(artifacts)
        .values({
          id: artifactId,
          notebookId: req.params.id,
          title: `Audio Overview — ${style}`,
          contentMd: built.markdown,
          kind: 'audio_overview',
          meta: JSON.stringify(meta),
        })
        .run();
      const stored = db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get();
      return reply.code(201).send({ artifact: stored, meta });
    }

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (delta: unknown) => {
      const ok = AudioOverviewDeltaSchema.safeParse(delta);
      if (!ok.success) return;
      reply.raw.write(`data: ${JSON.stringify(ok.data)}\n\n`);
    };

    // Initial meta: status=pending, audioFilename=null
    const initialMeta: AudioOverviewMeta = {
      status: 'pending',
      style,
      lineCount: 0,
      durationSec: null,
      audioFilename: null,
      model,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let persisted = false;
    function persistMeta(patch: Partial<AudioOverviewMeta>): AudioOverviewMeta {
      const merged: AudioOverviewMeta = {
        ...initialMeta,
        ...patch,
        createdAt: initialMeta.createdAt,
        updatedAt: new Date().toISOString(),
      };
      if (persisted) {
        db.update(artifacts)
          .set({ meta: JSON.stringify(merged), updatedAt: merged.updatedAt })
          .where(eq(artifacts.id, artifactId))
          .run();
      } else {
        db.insert(artifacts)
          .values({
            id: artifactId,
            notebookId: req.params.id,
            title: `Audio Overview — ${style}`,
            contentMd: '', // updated at script end
            kind: 'audio_overview',
            meta: JSON.stringify(merged),
          })
          .run();
        persisted = true;
      }
      return merged;
    }

    send({ type: 'meta', meta: initialMeta });

    const lines: AudioOverviewLine[] = [];
    let scriptError: Error | null = null;
    let ttsError: Error | null = null;

    try {
      // 2. scripting
      const scriptingMeta = persistMeta({ status: 'scripting', lineCount: 0 });
      send({ type: 'meta', meta: scriptingMeta });
      send({ type: 'progress', stage: 'scripting', ratio: 0.05, message: 'Пишу сценарий…' });

      const built = await buildScript({
        query: focus ?? 'обзор материалов ноутбука',
        citations,
        style,
        focus,
        provider: providerId,
        model,
        onLine: (line) => send({ type: 'script_line', line }),
      });
      lines.push(...built.lines);
      send({ type: 'progress', stage: 'scripting', ratio: 1, message: 'Сценарий готов' });

      // Persist the script content + updated meta.
      const finalScript = linesToMarkdown(lines);
      db.update(artifacts)
        .set({ contentMd: finalScript, updatedAt: new Date().toISOString() })
        .where(eq(artifacts.id, artifactId))
        .run();
      persistMeta({ status: 'scripting', lineCount: lines.length });

      // 3. TTS (noop in the first iteration; real engines land later).
      send({ type: 'progress', stage: 'synthesizing', ratio: 0, message: 'Синтезирую аудио…' });
      const ttsMeta = persistMeta({ status: 'synthesizing', lineCount: lines.length });
      send({ type: 'meta', meta: ttsMeta });

      const ttsProvider = getTtsProvider();
      const outPath = audioPath(req.params.id, artifactId);
      await ensureAudioDir(req.params.id);
      const ttsResult = await ttsProvider
        .synthesize({
          lines: lines.map((l) => ({ speaker: l.speaker, text: l.text })),
          outputPath: outPath,
          language: 'ru',
        })
        .catch((err) => {
          ttsError = err instanceof Error ? err : new Error(String(err));
          return null;
        });

      let audioFilename: string | null = null;
      let durationSec: number | null = null;
      if (ttsResult && ttsResult.bytes > 0) {
        audioFilename = `${artifactId}.mp3`;
        durationSec = ttsResult.durationSec;
      } else {
        // TTS failed or noop: clean up the placeholder file the noop
        // provider may have touched, and keep audioFilename=null.
        await deleteAudio(req.params.id, artifactId).catch(() => undefined);
        if (ttsError) {
          app.log.warn({ err: ttsError }, 'TTS failed; persisting script-only');
        }
      }

      const readyMeta = persistMeta({
        status: 'ready',
        lineCount: lines.length,
        durationSec,
        audioFilename,
      });
      send({ type: 'meta', meta: readyMeta });
      send({ type: 'done', artifactId });
    } catch (err) {
      scriptError = err instanceof Error ? err : new Error(String(err));
      const failedMeta = persistMeta({
        status: 'failed',
        lineCount: lines.length,
        error: scriptError.message,
      });
      send({ type: 'meta', meta: failedMeta });
      send({ type: 'error', message: scriptError.message });
    } finally {
      reply.raw.end();
    }
  });

  // GET /api/audio/:notebookId/:filename — static mp3 (auth-less: audio
  // overviews aren't a privacy concern for this single-user notebook).
  app.get<{ Params: { notebookId: string; filename: string } }>(
    '/api/audio/:notebookId/:filename',
    async (req, reply) => {
      // Refuse anything that smells like path traversal. Filenames are
      // nanoid(12).mp3 by construction; reject anything else.
      if (!/^[A-Za-z0-9_-]{12}\.mp3$/.test(req.params.filename)) {
        return reply.code(400).send({ error: 'invalid audio filename' });
      }
      const artifactId = req.params.filename.split('.')[0]!;
      const path = audioPath(req.params.notebookId, artifactId);
      let st: Awaited<ReturnType<typeof statAsync>>;
      try {
        st = await statAsync(path);
      } catch {
        return reply.code(404).send({ error: 'audio not found' });
      }
      if (st.size === 0) return reply.code(404).send({ error: 'audio not rendered' });
      reply.header('Content-Type', 'audio/mpeg');
      reply.header('Content-Length', String(st.size));
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', 'private, max-age=3600');
      // createReadStream keeps memory constant for large mp3s.
      return reply.send(createReadStream(path));
    },
  );
};
