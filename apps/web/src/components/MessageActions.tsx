import { useState } from 'react';
import { copyToClipboard, downloadText, formatTime } from '../lib/download';

interface Props {
  /** ISO timestamp of the answer. Rendered as HH:MM. */
  createdAt?: string;
  /** Markdown that "Копировать" and "Скачать .md" operate on. */
  markdown: string;
  /** Filename stem for the download. */
  filename?: string;
  /** Creates a note artifact. Omitted → the button is hidden. */
  onSaveNote?: () => void;
  /** Extra label for the timestamp, e.g. "обзор". */
  kindLabel?: string;
}

/**
 * The action row under an answer (and under the summary card):
 * timestamp · copy · download · save as note.
 *
 * "Copy" and "Download" are pure client-side operations, so they work
 * for anything the model produced. "В заметки" goes through the parent
 * because only it knows about the artifacts panel.
 */
export function MessageActions({
  createdAt,
  markdown,
  filename = 'answer',
  onSaveNote,
  kindLabel,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const time = formatTime(createdAt);

  async function onCopy() {
    const ok = await copyToClipboard(markdown);
    setCopied(ok);
    setFailed(!ok);
    if (ok) setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1 text-[11px] text-muted"
      data-testid="message-actions"
    >
      {(time || kindLabel) && (
        <span className="mr-0.5 text-subtle" data-testid="message-timestamp">
          {[kindLabel, time].filter(Boolean).join(' · ')}
        </span>
      )}
      <button
        type="button"
        onClick={() => void onCopy()}
        className="rounded-full px-2 py-0.5 transition-colors hover:bg-surface-tint hover:text-ink"
        title="Скопировать в буфер обмена"
        data-testid="action-copy"
      >
        {failed ? '✕ не удалось' : copied ? '✓ скопировано' : 'Копировать'}
      </button>
      <span aria-hidden className="text-subtle">
        ·
      </span>
      <button
        type="button"
        onClick={() => downloadText(`${filename}.md`, markdown)}
        className="rounded-full px-2 py-0.5 transition-colors hover:bg-surface-tint hover:text-ink"
        title="Скачать как Markdown"
        data-testid="action-download"
      >
        Скачать .md
      </button>
      {onSaveNote && (
        <>
          <span aria-hidden className="text-subtle">
            ·
          </span>
          <button
            type="button"
            onClick={onSaveNote}
            className="rounded-full px-2 py-0.5 transition-colors hover:bg-surface-tint hover:text-ink"
            title="Сохранить в заметки"
            data-testid="action-save-note"
          >
            В заметки
          </button>
        </>
      )}
    </div>
  );
}
