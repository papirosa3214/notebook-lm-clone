import type { CitationChunk, StudioTemplate } from '@notebook/shared';
import { nanoid } from 'nanoid';

/**
 * One Studio report template. Each template owns:
 *  - its own system-prompt instructions (in Russian, with [N]-marker
 *    discipline baked in)
 *  - a per-template default topK for retrieval
 *  - a UI title (Russian) and short description
 *
 * The runtime side: `apps/api/src/routes/studio.ts` calls
 * `getTemplate(id).systemPrompt` and `getTemplate(id).userPrompt(args)`
 * with the retrieved citations, then streams the LLM answer.
 */
export interface StudioTemplateDef {
  id: StudioTemplate;
  /** UI title (Russian). */
  title: string;
  /** One-line description, shown in the Studio dialog. */
  blurb: string;
  /** Default retrieval depth for this template. */
  defaultTopK: number;
  /** System instructions sent as the chat system message. */
  systemInstructions: string;
  /**
   * Build the user prompt for this template. Receives the
   * already-formatted numbered source list so the prompt stays
   * short and focused on the task.
   */
  userPrompt: (args: { focus?: string; sourcesBlock: string }) => string;
}

/**
 * Common preamble shared by every template. The model is told to
 * write in Russian, use [N] markers, and stay grounded in the
 * provided sources — the same discipline as the chat route's
 * CITATION_INSTRUCTIONS but tightened (the Studio context lets us
 * be stricter because we control the output structure).
 */
const STUDIO_PREAMBLE = [
  'Ты — аналитик, который превращает набор источников в структурированный отчёт.',
  'Пиши на русском, используй markdown.',
  'Каждый факт сопровождай маркером [N], где N — номер источника в списке ниже.',
  'Если в источниках нет ответа — пиши "Нет данных" в соответствующей секции, не выдумывай.',
  'Не добавляй секции, которых нет в шаблоне.',
  'Не пиши вводных фраз вида "вот ваш отчёт" — сразу начинай с контента.',
].join('\n');

const TEMPLATES: Record<StudioTemplate, StudioTemplateDef> = {
  faq: {
    id: 'faq',
    title: 'FAQ',
    blurb: '8-12 вопросов с короткими ответами по материалам ноутбука.',
    defaultTopK: 12,
    systemInstructions: STUDIO_PREAMBLE,
    userPrompt: ({ focus, sourcesBlock }) => {
      const extra = focus ? `\n\nДоп. акцент: ${focus}` : '';
      return [
        'Сгенерируй FAQ из 8-12 вопросов по этим источникам.',
        'Каждый вопрос — отдельный пункт `## Q: …`, ответ — 2-4 предложения с [N]-маркерами.',
        'Вопросы должны покрывать разные аспекты: что это, как работает, зачем, ограничения, практика.',
        'Не повторяйся между вопросами. Сортируй от фундаментальных к частным.',
        '## Источники',
        sourcesBlock,
      ].join('\n') + extra;
    },
  },

  executive_summary: {
    id: 'executive_summary',
    title: 'Executive Summary',
    blurb: 'TL;DR на 1 страницу: тезисы, выводы, риски.',
    defaultTopK: 10,
    systemInstructions: STUDIO_PREAMBLE,
    userPrompt: ({ focus, sourcesBlock }) => {
      const extra = focus ? `\n\nДоп. акцент: ${focus}` : '';
      return [
        'Сгенерируй Executive Summary — TL;DR для занятых людей.',
        'Структура:',
        '  ## TL;DR — 3-5 предложений, о чём этот материал и почему это важно.',
        '  ## Ключевые тезисы — 5-7 пунктов, каждый с [N]-маркером.',
        '  ## Что это значит на практике — 2-3 предложения.',
        '  ## Риски и неизвестное — что может пойти не так или что источники НЕ покрывают.',
        'Пиши плотно, без воды, как для совета директоров.',
        '## Источники',
        sourcesBlock,
      ].join('\n') + extra;
    },
  },

  timeline: {
    id: 'timeline',
    title: 'Timeline',
    blurb: 'Хронология ключевых событий с датами и источниками.',
    defaultTopK: 14,
    systemInstructions: STUDIO_PREAMBLE,
    userPrompt: ({ focus, sourcesBlock }) => {
      const extra = focus ? `\n\nДоп. акцент: ${focus}` : '';
      return [
        'Извлеки из источников хронологию ключевых событий.',
        'Каждый пункт: `## ГГГГ-ММ-ДД — Заголовок события` (если точной даты нет — `## ~ГГГГ — …` или `## Период — …`).',
        'Под заголовком — 1-3 предложения описания с [N]-маркерами.',
        'Сортируй по дате. Если источники дают разные даты одного события — укажи обе.',
        'Если в источниках вообще нет датированных событий — верни секцию `## События` с текстом "В источниках не удалось выделить датированные события".',
        '## Источники',
        sourcesBlock,
      ].join('\n') + extra;
    },
  },

  contradictions: {
    id: 'contradictions',
    title: 'Противоречия',
    blurb: 'Где источники расходятся — с цитатами по обеим сторонам.',
    defaultTopK: 16,
    systemInstructions: STUDIO_PREAMBLE,
    userPrompt: ({ focus, sourcesBlock }) => {
      const extra = focus ? `\n\nДоп. акцент: ${focus}` : '';
      return [
        'Найди в источниках противоречия, расхождения и несогласованные утверждения.',
        'Каждый пункт:',
        '  ## Тема расхождения — короткий заголовок',
        '  - **Позиция A:** что говорит источник [N], с короткой цитатой или пересказом.',
        '  - **Позиция B:** что говорит источник [M] (M ≠ N), с короткой цитатой или пересказом.',
        '  - **Контекст:** почему это расхождение может быть — разные методологии, даты, определения, etc.',
        'Если противоречий нет — единственная секция `## Итог` с текстом "Источники согласованы по ключевым вопросам".',
        '## Источники',
        sourcesBlock,
      ].join('\n') + extra;
    },
  },

  flashcards: {
    id: 'flashcards',
    title: 'Flashcards',
    blurb: '10-20 пар вопрос-ответ для интервального повторения.',
    defaultTopK: 12,
    systemInstructions: STUDIO_PREAMBLE,
    // The flashcards template is special: the LLM must emit
    // machine-parseable JSON instead of free-form markdown, because
    // the client renders the result as a flip-card deck. The studio
    // route post-processes the streamed text by extracting the first
    // JSON array (tolerating ```json fences and trailing junk) and
    // re-renders it as FlashcardSet JSON for `artifact.contentMd`.
    userPrompt: ({ focus, sourcesBlock }) => {
      const extra = focus ? `\n\nДоп. акцент: ${focus}` : '';
      return [
        'Сгенерируй 10-20 пар вопрос-ответ для самопроверки по этим источникам.',
        'Пиши СТРОГО в JSON-массиве, без пояснений и без markdown-обёрток. Каждый элемент:',
        '  {"question": "...короткий вопрос (1 предложение)...", "answer": "...короткий ответ (1-3 предложения)..."}',
        'Можно ссылаться на источники в ответе через [N]-маркеры.',
        'Избегай trivially-obvious вопросов ("что такое X" когда ответ тоже "X").',
        'Сортируй от фундаментальных к частным.',
        '## Источники',
        sourcesBlock,
      ].join('\n') + extra;
    },
  },

  data_table: {
    id: 'data_table',
    title: 'Data Table',
    blurb: 'Сравнительная таблица: сущности × атрибуты, с сортировкой и фильтром.',
    defaultTopK: 14,
    systemInstructions: STUDIO_PREAMBLE,
    // The data_table template is also machine-parseable: the route
    // extracts the first JSON object of the form {title, columns, rows}
    // and persists it as a DataTable. The user prompt is strict
    // about the JSON shape because the client renders a real table
    // (not markdown) and bad JSON is the #1 way the model can
    // break this feature.
    userPrompt: ({ focus, sourcesBlock }) => {
      const extra = focus ? `\n\nДоп. акцент: ${focus}` : '';
      return [
        'Извлеки из источников сравнительную таблицу.',
        'Пиши СТРОГО один JSON-объект без пояснений и без markdown. Структура:',
        '  {"title": "...короткий заголовок таблицы...",',
        '   "columns": ["Колонка 1", "Колонка 2", ...],',
        '   "rows": [{"Колонка 1": "...", "Колонка 2": "..."}, ...]}',
        'Требования:',
        '  - 3-7 колонок, понятные названия без жаргона',
        '  - 5-30 строк; пропусти единичные записи, для которых нет данных в источниках',
        '  - значения в ячейках — короткие строки (до ~200 символов), без переносов',
        '  - первая колонка обычно содержит имя/название, остальные — атрибуты',
        '  - в любой ячейке можно ссылаться на источники через [N]-маркеры',
        'Если источники не дают структурируемого материала — верни одну строку с пометкой "Нет данных".',
        '## Источники',
        sourcesBlock,
      ].join('\n') + extra;
    },
  },
};

export function getTemplate(id: StudioTemplate): StudioTemplateDef {
  return TEMPLATES[id];
}

export function listTemplates(): StudioTemplateDef[] {
  return Object.values(TEMPLATES);
}

/**
 * Build a numbered source list for the prompt. Mirrors the chat
 * route's `formatContextForPrompt` but accepts CitationChunk[] —
 * the route's helper takes the shared `context` field from
 * ProviderChatRequest which has the same shape.
 */
export function formatSourcesForPrompt(chunks: CitationChunk[]): string {
  if (chunks.length === 0) return 'No sources available.';
  return chunks
    .map((c, i) => {
      const loc = c.location ? ` (${c.location})` : '';
      return `[${i + 1}] ${c.sourceTitle}${loc}\n${c.text}`;
    })
    .join('\n\n---\n\n');
}
