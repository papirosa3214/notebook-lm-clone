import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { ping as embeddingsPing } from './vectordb/client.js';
import { closeDb } from './db/index.js';
import { notebookRoutes } from './routes/notebooks.js';
import { sourceRoutes } from './routes/sources.js';
import { chatRoutes } from './routes/chat.js';
import { mindmapRoutes } from './routes/mindmap.js';
import { artifactRoutes } from './routes/artifacts.js';
import { searchRoutes } from './routes/search.js';
import { discoverRoutes } from './routes/discover.js';
import { summaryRoutes } from './routes/summary.js';

async function main() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
    },
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(sensible);
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  app.get('/api/health', async () => {
    const embeddingsOk = await embeddingsPing();
    return {
      ok: embeddingsOk,
      service: 'notebook-api',
      embeddings: embeddingsOk ? 'connected' : 'unreachable',
      version: '0.2.0',
    };
  });

  await app.register(notebookRoutes);
  await app.register(sourceRoutes);
  await app.register(chatRoutes);
  await app.register(artifactRoutes);
  await app.register(searchRoutes);
  await app.register(mindmapRoutes);
  await app.register(discoverRoutes);
  await app.register(summaryRoutes);

  const shutdown = async () => {
    app.log.info('shutting down');
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`API ready at http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();