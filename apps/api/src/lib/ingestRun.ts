import type { FastifyReply } from 'fastify';
import { makeIngestEmitter, writeIngestHeaders, type IngestEmitter } from './ingestStream.js';

interface RunOpts<T> {
  reply: FastifyReply;
  wantsStream: boolean;
  ingest: (emit: IngestEmitter) => Promise<T>;
}

/**
 * Execute an ingest operation either with SSE progress streaming or as a plain
 * JSON POST. The caller decides via `wantsStream` (typically `req.query.stream === '1'`).
 */
export async function runIngest<T>(opts: RunOpts<T>): Promise<T | undefined> {
  if (opts.wantsStream) {
    writeIngestHeaders(opts.reply);
    const emit = makeIngestEmitter(opts.reply);
    try {
      const result = await opts.ingest(emit);
      emit.done(result);
    } catch (err) {
      emit.error(err instanceof Error ? err.message : String(err));
    } finally {
      opts.reply.raw.end();
    }
    return undefined;
  }
  // JSON mode: silent emitter (no progress messages are sent).
  const silent: IngestEmitter = {
    progress() {},
    done() {},
    error() {},
  };
  return opts.ingest(silent);
}