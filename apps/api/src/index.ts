import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { ping as ragflowPing, listDatasets } from './ragflow/client.js';
import { closeDb } from './db/index.js';
import { notebookRoutes } from './routes/notebooks.js';
import { sourceRoutes } from './routes/sources.js';
import { chatRoutes } from './routes/chat.js';
import { artifactRoutes } from './routes/artifacts.js';

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
    const ragflowOk = await ragflowPing();
    return {
      ok: ragflowOk,
      service: 'notebook-api',
      ragflow: ragflowOk ? 'connected' : 'unreachable',
      version: '0.1.0',
    };
  });

  // Debug: list existing Ragflow datasets (handy during MVP)
  app.get('/api/ragflow/datasets', async () => {
    const datasets = await listDatasets(1, 50);
    return { datasets };
  });

  await app.register(notebookRoutes);
  await app.register(sourceRoutes);
  await app.register(chatRoutes);
  await app.register(artifactRoutes);

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
