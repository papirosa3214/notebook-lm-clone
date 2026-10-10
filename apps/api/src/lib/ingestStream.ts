import type { FastifyReply } from 'fastify';
import { IngestProgressDeltaSchema, type IngestStage } from '@notebook/shared';

/**
 * Helper to write SSE-formatted progress events for a long ingest operation.
 * Caller controls the reply object (already configured for SSE headers).
 */
export interface IngestEmitter {
  /**
   * Emit a progress event. Pass `sourceId` (the new source row's id) so the
   * client can poll `GET /sources/:id` to recover if the SSE stream dies
   * before `done`.
   */
  progress(stage: IngestStage, ratio?: number, message?: string, sourceId?: string): void;
  done(source: unknown): void;
  error(message: string): void;
}

export function makeIngestEmitter(reply: FastifyReply): IngestEmitter {
  const send = (delta: unknown) => {
    const ok = IngestProgressDeltaSchema.safeParse(delta);
    if (!ok.success) return;
    reply.raw.write(`data: ${JSON.stringify(ok.data)}\n\n`);
  };
  return {
    progress(stage, ratio, message, sourceId) {
      send({ type: 'progress', stage, ratio, message, sourceId });
    },
    done(source) {
      send({ type: 'done', source });
    },
    error(message) {
      send({ type: 'error', message });
    },
  };
}

/** Standard SSE headers for an ingest stream. */
export function writeIngestHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}