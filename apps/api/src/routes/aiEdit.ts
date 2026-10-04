import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  AiEditDeltaSchema,
  AiEditRequestSchema,
  type AiEditInstruction,
} from '@notebook/shared';
import { getDb } from '../db/index.js';
import { artifacts, notebooks } from '../db/schema.js';
import { getProvider } from '../providers/index.js';

const INSTRUCTIONS: Record<AiEditInstruction, string> = {
  rewrite:
    'Перепиши выделенный фрагмент. Сохрани смысл, но улучши формулировки: ' +
    'убери канцелярит, сделай фразы короче и яснее, оставь важные термины. ' +
    'Не добавляй новых фактов и не меняй язык оригинала. ' +
    'Верни ТОЛЬКО переписанный текст, без префиксов и пояснений.',
  expand:
    'Расширь выделенный фрагмент. Добавь подробностей, примеров, ' +
    'предпосылок или следствий — что естественно вытекает из контекста. ' +
    'НЕ придумывай конкретные цифры или факты, которых нет в материалах. ' +
    'Сохрани язык и стиль оригинала. ' +
    'Верни ТОЛЬКО расширенный текст, без префиксов и пояснений.',
  shorten:
    'Сократи выделенный фрагмент. Сохрани основную мысль, ' +
    'убери второстепенные детали, повторы и вводные конструкции. ' +
    'Сохрани язык оригинала. ' +
    'Верни ТОЛЬКО сокращённый текст, без префиксов и пояснений.',
};

/**
 * POST /api/artifacts/:id/ai-edit
 *
 * Streams an LLM edit of a portion of an artifact's text. Three
 * instructions are supported out of the box: `rewrite`, `expand`,
 * `shorten`. The endpoint is auth-less (single-user notebook) and
 * validates the artifact exists; we don't enforce ownership because
 * the notebook IS the auth boundary.
 *
 * The endpoint is intentionally a *streaming* endpoint because the
 * editor UX is "type while the model writes" — without SSE the
 * first token would only arrive after the model finished a full
 * 200-word rewrite, which is a 5–15s wait.
 */
export const aiEditRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>(
    '/api/artifacts/:id/ai-edit',
    async (req, reply) => {
      const parsed = AiEditRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.format() });
      }

      const db = getDb();
      const artifact = db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, req.params.id))
        .get();
      if (!artifact) return reply.code(404).send({ error: 'artifact not found' });

      // Resolve provider / model. We default to the notebook's
      // default for consistency with the chat path.
      const nb = db
        .select({
          defaultProvider: notebooks.defaultProvider,
          defaultModel: notebooks.defaultModel,
        })
        .from(notebooks)
        .where(eq(notebooks.id, artifact.notebookId))
        .get();
      if (!nb) return reply.code(404).send({ error: 'notebook not found' });

      const providerId = (parsed.data.provider ?? nb.defaultProvider) as
        | 'ollama'
        | 'anthropic'
        | 'openai';
      const model = parsed.data.model ?? nb.defaultModel;

      // Build the prompt. The "selection" is what gets edited; the
      // "fullText" provides surrounding context. If the user didn't
      // select anything, we operate on the whole document.
      const target = parsed.data.selection.trim() || parsed.data.fullText;
      const hasSelection = parsed.data.selection.trim().length > 0;
      const systemPrompt = INSTRUCTIONS[parsed.data.instruction];

      // Wrap the selection in clearly-marked tags so the model
      // doesn't get confused about which span to edit. We then
      // ask it to return the edited span.
      const userPrompt = hasSelection
        ? [
            'Полный текст документа (для контекста):',
            '<<<',
            parsed.data.fullText,
            '>>>',
            '',
            'Отредактируй ТОЛЬКО этот фрагмент (между <<<TARGET>>> и <<<END>>>):',
            '<<<TARGET>>>',
            target,
            '<<<END>>>',
            '',
            'Верни только отредактированный фрагмент, без тегов.',
          ].join('\n')
        : [
            'Текст для редактирования:',
            '<<<',
            target,
            '>>>',
            '',
            'Верни отредактированный текст целиком, без тегов.',
          ].join('\n');

      const provider = getProvider(providerId);

      // SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (delta: unknown) => {
        const ok = AiEditDeltaSchema.safeParse(delta);
        if (!ok.success) return;
        reply.raw.write(`data: ${JSON.stringify(ok.data)}\n\n`);
      };

      let raw = '';
      try {
        for await (const ev of provider.chat({
          providerId,
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          context: [],
          temperature: 0.4,
          maxTokens: 1500,
        })) {
          if (ev.text) {
            raw += ev.text;
            send({ type: 'token', text: ev.text });
          }
          if (ev.done) break;
        }
        send({ type: 'done', output: raw.trim() });
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        reply.raw.end();
      }
    },
  );
};
