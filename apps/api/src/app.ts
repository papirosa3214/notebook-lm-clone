import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { notebookRoutes } from './routes/notebooks.js';
import { sourceRoutes } from './routes/sources.js';
import { chatRoutes } from './routes/chat.js';
import { artifactRoutes } from './routes/artifacts.js';
import { searchRoutes } from './routes/search.js';
import { graphRoutes } from './routes/graph.js';
import { discoverRoutes } from './routes/discover.js';
import { summaryRoutes } from './routes/summary.js';
import { mindmapRoutes } from './routes/mindmap.js';
import { audioOverviewRoutes } from './routes/audioOverview.js';
import { studioRoutes } from './routes/studio.js';
import { shareRoutes } from './routes/share.js';
import { exportRoutes } from './routes/export.js';
import { suggestionRoutes } from './routes/suggestions.js';
import { aiEditRoutes } from './routes/aiEdit.js';
import { deepResearchRoutes } from './routes/deepResearch.js';

/**
 * Construct the Fastify app without binding to a port. The production
 * entrypoint (src/index.ts) calls this and then listen()s; tests call
 * this and use `app.inject()` so no real port is opened.
 *
 * Logger is silenced by default — tests don't need pino output, and
 * `pino-pretty` may not be installed in the bundle's runtime path. Pass
 * `logger: true` for verbose mode during debugging.
 */
export async function buildApp(
  opts: { logger?: FastifyServerOptions['logger'] } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(sensible);
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  // /api/health with ping lives in src/index.ts (real handler with
  // embeddingsPing). Keeping a stub here collides with Fastify 5's
  // duplicate-route detection.
  await app.register(notebookRoutes);
  await app.register(sourceRoutes);
  await app.register(chatRoutes);
  await app.register(artifactRoutes);
  await app.register(searchRoutes);
  await app.register(discoverRoutes);
  await app.register(summaryRoutes);
  await app.register(mindmapRoutes);
  await app.register(graphRoutes);
  await app.register(audioOverviewRoutes);
  await app.register(studioRoutes);
  await app.register(shareRoutes);
  await app.register(exportRoutes);
  await app.register(suggestionRoutes);
  await app.register(aiEditRoutes);
  await app.register(deepResearchRoutes);

  return app;
}
