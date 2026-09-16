import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { config } from './config.js';
import { ping as ragflowPing, listDatasets } from './ragflow/client.js';

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

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`API ready at http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
