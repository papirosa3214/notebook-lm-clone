/**
 * Роуты управления куками YouTube.
 *
 * Нужны потому, что YouTube требует живую сессию, а сессия протухает
 * сама. Раньше пользователю оставалось только гадать по тексту ошибки;
 * теперь он видит состояние файла и может починить его одной кнопкой.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  convertDevToolsTsv,
  exportFromBrowser,
  listBrowserCookieSources,
  readCookieStatus,
  writeCookieFile,
} from '../extractors/ytCookies.js';

export const youtubeCookieRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/youtube/cookies', async () => ({
    ...(await readCookieStatus()),
    browsers: await listBrowserCookieSources(),
  }));

  // Выгрузка из браузера. На macOS может запросить пароль от Keychain —
  // это разовая выдача доступа, а не ошибка.
  app.post('/api/youtube/cookies/refresh', async (req, reply) => {
    const body = z
      .object({ profilePath: z.string().min(1) })
      .safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ message: 'Не указан профиль браузера.' });
    }
    const result = await exportFromBrowser(body.data.profilePath);
    return { ...result, status: await readCookieStatus() };
  });

  // Импорт таблицы, скопированной из DevTools. Работает без Keychain.
  app.post('/api/youtube/cookies/import', async (req, reply) => {
    const body = z.object({ tsv: z.string().min(20) }).safeParse(req.body);
    if (!body.success) {
      return reply
        .status(400)
        .send({ message: 'Вставь скопированную таблицу кук из DevTools.' });
    }
    const { content, imported, skipped } = convertDevToolsTsv(body.data.tsv);
    const path = await writeCookieFile(content);
    const status = await readCookieStatus();
    return { path, imported: imported.length, skipped, status };
  });
};
