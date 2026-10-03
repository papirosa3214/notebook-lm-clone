import { createRequire } from 'node:module';
import { eq, asc } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { artifacts, chunks, messages, notebooks, sources } from '../db/schema.js';
import { sanitizeFilename } from './artifacts.js';

// Archiver is a CommonJS module that exports named classes
// (Archiver, ZipArchive, …), not a default function. The bundled
// @types/archiver typings don't declare a default either, so we load
// the runtime via createRequire and use the ZipArchive class
// directly. The shape we rely on (append / pipe / finalize / on) is
// stable across recent major versions.
const require_ = createRequire(import.meta.url);
const { ZipArchive } = require_('archiver') as {
  ZipArchive: new (opts?: { zlib?: { level?: number } }) => {
    append(data: string | Buffer, opts?: { name?: string }): void;
    pipe(dest: NodeJS.WritableStream): void;
    finalize(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
};

const MAX_CHUNK_BYTES_PER_SOURCE = 4 * 1024 * 1024; // 4 MB safety cap

/**
 * GET /api/notebooks/:id/export.zip
 *
 * Bundles a notebook into a single zip for offline archiving:
 *   - README.md         — human-readable top-of-tree index
 *   - metadata.json     — machine-readable notebook summary
 *   - sources/<id>.md   — one markdown file per source (front-matter
 *                         with kind/url/summary, then concatenated
 *                         chunk bodies in ordinal order)
 *   - artifacts/<id>.md — one file per artifact (its `contentMd`
 *                         directly, regardless of kind)
 *   - chat.md           — flattened user/assistant turns (no chunk
 *                         text, so the file stays small)
 *
 * The zip is streamed (no temp file, no buffering of the whole
 * archive in memory) so a notebook with 100+ sources and 50+ MB
 * of chunks still responds quickly and uses bounded memory.
 */
export const exportRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>(
    '/api/notebooks/:id/export.zip',
    async (req, reply) => {
      const db = getDb();
      const nb = db
        .select()
        .from(notebooks)
        .where(eq(notebooks.id, req.params.id))
        .get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const sourceRows = db
        .select()
        .from(sources)
        .where(eq(sources.notebookId, nb.id))
        .all();
      const artifactRows = db
        .select()
        .from(artifacts)
        .where(eq(artifacts.notebookId, nb.id))
        .all();
      const chatRows = db
        .select()
        .from(messages)
        .where(eq(messages.notebookId, nb.id))
        .orderBy(asc(messages.createdAt))
        .all();

      const zip = new ZipArchive({ zlib: { level: 6 } });
      reply.raw.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${sanitizeFilename(nb.title)}.zip"`,
        'Cache-Control': 'no-store',
      });
      zip.pipe(reply.raw);

      zip.append(buildReadme(nb.title, nb.createdAt, sourceRows, artifactRows), {
        name: 'README.md',
      });

      const meta = {
        id: nb.id,
        title: nb.title,
        defaultProvider: nb.defaultProvider,
        defaultModel: nb.defaultModel,
        createdAt: nb.createdAt,
        exportedAt: new Date().toISOString(),
        sourceCount: sourceRows.length,
        artifactCount: artifactRows.length,
        chatMessageCount: chatRows.length,
      };
      zip.append(JSON.stringify(meta, null, 2), { name: 'metadata.json' });

      for (const s of sourceRows) {
        const body = buildSourceMarkdown(s, db);
        zip.append(body, { name: `sources/${sanitizeFilename(s.id)}.md` });
      }

      for (const a of artifactRows) {
        zip.append(a.contentMd, { name: `artifacts/${sanitizeFilename(a.id)}.md` });
      }

      zip.append(buildChatMarkdown(chatRows), { name: 'chat.md' });

      zip.finalize().catch((err: unknown) => {
        app.log.error({ err }, 'archiver finalize failed');
        try {
          reply.raw.end();
        } catch {
          // socket may already be closed
        }
      });
      return reply;
    },
  );
};

function buildReadme(
  title: string,
  createdAt: string,
  sourceRows: Array<{ id: string; title: string; kind: string; status: string }>,
  artifactRows: Array<{ id: string; title: string; kind: string }>,
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`Экспорт ноутбука. Создан: ${createdAt}.`);
  lines.push(`Дата экспорта: ${new Date().toISOString()}.`);
  lines.push('');
  lines.push('## Структура архива');
  lines.push('');
  lines.push('- `metadata.json` — машинно-читаемая сводка ноутбука.');
  lines.push('- `sources/<id>.md` — по файлу на каждый источник; фронт-маттер с kind/url/summary, затем тело чанков.');
  lines.push('- `artifacts/<id>.md` — по файлу на каждый артефакт (note / report / audio_overview script).');
  lines.push('- `chat.md` — сплошная история диалога (без chunk-текста, только роли + контент).');
  lines.push('');
  if (sourceRows.length > 0) {
    lines.push('## Источники');
    lines.push('');
    for (const s of sourceRows) {
      lines.push(
        `- **${s.title}** (\`${s.kind}\`, \`${s.status}\`) — \`sources/${sanitizeFilename(s.id)}.md\``,
      );
    }
    lines.push('');
  }
  if (artifactRows.length > 0) {
    lines.push('## Артефакты');
    lines.push('');
    for (const a of artifactRows) {
      lines.push(`- **${a.title}** (\`${a.kind}\`) — \`artifacts/${sanitizeFilename(a.id)}.md\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function buildSourceMarkdown(
  s: { id: string; kind: string; title: string; url: string | null; status: string; summary: string | null },
  db: ReturnType<typeof getDb>,
): string {
  const chunkRows = db
    .select({ ordinal: chunks.ordinal, content: chunks.content })
    .from(chunks)
    .where(eq(chunks.sourceId, s.id))
    .orderBy(asc(chunks.ordinal))
    .all();

  const bodyParts: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const c of chunkRows) {
    if (bytes + c.content.length > MAX_CHUNK_BYTES_PER_SOURCE) {
      truncated = true;
      break;
    }
    bodyParts.push(c.content);
    bytes += c.content.length;
  }
  const body = bodyParts.join('\n\n');

  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: ${s.id}`);
  lines.push(`title: ${JSON.stringify(s.title)}`);
  lines.push(`kind: ${s.kind}`);
  lines.push(`status: ${s.status}`);
  if (s.url) lines.push(`url: ${s.url}`);
  lines.push('---');
  lines.push('');
  if (s.summary) {
    lines.push('> ' + s.summary);
    lines.push('');
  }
  if (s.url) {
    lines.push(`Источник: <${s.url}>`);
    lines.push('');
  }
  if (body.length === 0) {
    lines.push('_(содержимое не извлечено — пустые чанки)_');
  } else {
    lines.push(body);
  }
  if (truncated) {
    lines.push('');
    lines.push(
      `_(содержимое обрезано на ${MAX_CHUNK_BYTES_PER_SOURCE} байт — оригинал больше)_`,
    );
  }
  return lines.join('\n');
}

function buildChatMarkdown(
  rows: Array<{ role: string; content: string; createdAt: string }>,
): string {
  if (rows.length === 0) {
    return '_Чат ещё пуст._\n';
  }
  const lines: string[] = [];
  lines.push('# История чата');
  lines.push('');
  for (const r of rows) {
    const role =
      r.role === 'user'
        ? '## Ты'
        : r.role === 'assistant'
          ? '## Ассистент'
          : `## ${r.role}`;
    lines.push(role);
    lines.push(`_${r.createdAt}_`);
    lines.push('');
    lines.push(r.content);
    lines.push('');
  }
  return lines.join('\n');
}
