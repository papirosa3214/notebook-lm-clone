import { config } from './config.js';
import { ping as embeddingsPing } from './vectordb/client.js';
import { closeDb } from './db/index.js';
import { buildApp } from './app.js';

async function main() {
  const app = await buildApp({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
    },
  });

  // Override the minimal /api/health from buildApp() with the real one
  // that pings the embedding server. We can't register a second route
  // on the same path, so we close+re-open is not an option either; the
  // simplest correct fix is to wire the real handler here before
  // listen().
  app.get('/api/health', async () => {
    const embeddingsOk = await embeddingsPing();
    return {
      ok: embeddingsOk,
      service: 'notebook-api',
      embeddings: embeddingsOk ? 'connected' : 'unreachable',
      version: '0.2.0',
    };
  });

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
