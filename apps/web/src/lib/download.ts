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

/** Whole conversation as one Markdown document. */
export function conversationAsMarkdown(
  title: string,
  turns: Array<{ role: 'user' | 'assistant'; content: string; createdAt?: string }>,
): string {
  const lines = [`# ${title}`, ''];
  for (const t of turns) {
    const stamp = t.createdAt ? ` · ${formatDateTime(t.createdAt)}` : '';
    lines.push(`## ${t.role === 'user' ? 'Вопрос' : 'Ответ'}${stamp}`, '', t.content.trim(), '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
