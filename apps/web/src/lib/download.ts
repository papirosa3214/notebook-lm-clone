/**
 * Small helpers for the copy / export / note actions on chat content.
 * Kept together so the three call sites (summary card, assistant
 * message, whole conversation) behave identically.
 */

/** Trigger a client-side download of a generated text file. */
export function downloadText(filename: string, text: string, mime = 'text/markdown'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Copy to the clipboard. Resolves false instead of throwing when the
 * API is unavailable (http:// origins, Safari without a user gesture)
 * so callers can show a plain "не удалось" state.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

const DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const TIME_ONLY = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

/** "4 октября 2026 г., 12:34" — falls back to the raw string when the
 *  value isn't a parseable date (legacy rows). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return DATE_TIME.format(d);
}

/** "12:34" — for the inline stamp on a chat answer. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return TIME_ONLY.format(d);
}

/** `notebook-2026-10-04-1234.md`-ish, safe for a download filename. */
export function slugifyFilename(title: string, fallback = 'notebook'): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/**
 * Turn one Q/A turn into standalone Markdown, with the cited sources
 * appended. Shared by "Скачать .md", "Копировать" and the notebook
 * artifact created by "В заметки", so all three produce the same text.
 */
export function answerAsMarkdown(
  question: string | undefined,
  answer: string,
  citations: Array<{ sourceTitle: string; text: string }> = [],
): string {
  const lines: string[] = [];
  if (question) lines.push(`# ${question.length > 80 ? question.slice(0, 77) + '…' : question}`, '');
  lines.push(answer.trim(), '');
  if (citations.length > 0) {
    lines.push('## Источники', '');
    citations.forEach((c, i) => {
      lines.push(`**[${i + 1}]** ${c.sourceTitle}`);
      const snippet = c.text.length > 400 ? c.text.slice(0, 400) + '…' : c.text;
      lines.push('', snippet, '');
    });
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * A chat → a real note document, not a transcript dump.
 *
 * The previous version rendered each turn as `## Вопрос · 04.10.2026,
 * 12:34` followed by `## Ответ · 04.10.2026, 12:35`, which read as raw
 * log noise rather than a usable artifact. The note now opens with a
 * title, a date, and a short index; each user question becomes its own
 * section with the model's full reply underneath, and every cited
 * source is listed once at the end so the reader can cross-reference.
 *
 * Turns without an assistant reply (the model is still streaming, the
 * user typed something and never sent it, etc.) are dropped — saving
 * "Вопрос: ..." with nothing under it would just be noise.
 */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  citations?: Array<{ sourceTitle: string; text: string }>;
}

const MAX_TITLE = 80;
function titleCase(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length === 0 ? '' : t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1) + '…' : t;
}

export function conversationAsMarkdown(
  title: string,
  turns: ConversationTurn[],
): string {
  const lines: string[] = [];
  // First user question is the best natural title when no explicit
  // notebook title was supplied.
  const firstQuestion = turns.find((t) => t.role === 'user');
  const heading = (title && titleCase(title)) || (firstQuestion ? titleCase(firstQuestion.content) : 'Заметки из чата');
  const createdAt = new Date().toISOString();

  lines.push(`# ${heading}`, '');
  lines.push(`*Создано: ${formatDateTime(createdAt)}*`, '');

  // Group turns into Q → A pairs so each pair can be its own section.
  const pairs: Array<{ question: ConversationTurn; answers: ConversationTurn[] }> = [];
  let current: { question: ConversationTurn; answers: ConversationTurn[] } | null = null;
  for (const t of turns) {
    if (t.role === 'user') {
      if (current) pairs.push(current);
      current = { question: t, answers: [] };
    } else if (current) {
      current.answers.push(t);
    }
  }
  if (current) pairs.push(current);

  // Drop pairs whose assistant reply is missing or empty — saving a
  // question without its answer would just be noise.
  const complete = pairs.filter((p) => p.answers.some((a) => a.content.trim().length > 0));
  const dropped = pairs.length - complete.length;

  // Inline index for skimming — references section numbers below.
  if (complete.length > 1) {
    lines.push('## Содержание', '');
    complete.forEach((p, i) => {
      lines.push(`${i + 1}. ${titleCase(p.question.content) || '(без заголовка)'}`);
    });
    lines.push('');
  }

  // Body — each Q/A pair is its own section.
  const seenSources = new Map<string, { sourceTitle: string; text: string }>();
  complete.forEach((p, idx) => {
    const sectionNumber = idx + 1;
    lines.push(`## ${sectionNumber}. ${titleCase(p.question.content) || '(без заголовка)'}`, '');
    for (const a of p.answers) {
      if (!a.content.trim()) continue;
      lines.push(a.content.trim(), '');
      if (a.citations && a.citations.length > 0) {
        lines.push('**Цитаты:**', '');
        a.citations.forEach((c, i) => {
          const key = `${c.sourceTitle}::${i}`;
          if (!seenSources.has(key)) seenSources.set(key, c);
          const n = seenSources.size;
          lines.push(`- [${n}] **${c.sourceTitle}**`);
          const snippet = c.text.length > 400 ? c.text.slice(0, 400) + '…' : c.text;
          lines.push(`  > ${snippet}`);
        });
        lines.push('');
      }
    }
  });

  if (complete.length === 0) {
    lines.push('_В этом разговоре пока нет завершённых ответов модели._', '');
  }

  if (seenSources.size > 0) {
    lines.push('## Источники', '');
    let i = 1;
    for (const c of seenSources.values()) {
      lines.push(`${i}. **${c.sourceTitle}**`);
      const snippet = c.text.length > 400 ? c.text.slice(0, 400) + '…' : c.text;
      lines.push(`   > ${snippet}`);
      i++;
    }
    lines.push('');
  }

  if (dropped > 0) {
    lines.push(
      `> _${dropped} ${pluralRu(dropped, 'вопрос', 'вопроса', 'вопросов')} без ответа ${pluralRu(dropped, 'пропущен', 'пропущено', 'пропущено')}._`,
      '',
    );
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
