import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export type AiEditInstruction = 'rewrite' | 'expand' | 'shorten';

interface Props {
  /** The full text of the textarea. Required so the LLM has
   *  context for ambiguous selections (e.g. one word). */
  fullText: string;
  /** The currently selected text. Empty means "operate on the whole doc". */
  selection: string;
  /** 0-based offsets in `fullText`. */
  selectionStart: number;
  selectionEnd: number;
  /** The artifact id — used to build the streaming URL. */
  artifactId: string;
  /** Called when the streamed output is ready. The host is
   *  responsible for replacing the selection in its textarea
   *  and tracking dirty state. */
  onReplace: (newText: string) => void;
  /** Called when the user clicks the X to dismiss the menu. */
  onDismiss: () => void;
  /** Called when the stream errors out. */
  onError: (message: string) => void;
  /** Test seam: the parent can opt to render the menu in a
   *  fixed position instead of anchored to the selection. */
  anchor?: { x: number; y: number } | null;
}

const INSTRUCTIONS: Array<{ id: AiEditInstruction; label: string; icon: string }> = [
  { id: 'rewrite', label: 'Переписать', icon: '✍️' },
  { id: 'expand', label: 'Расширить', icon: '➕' },
  { id: 'shorten', label: 'Сократить', icon: '✂️' },
];

/**
 * Floating popover that appears next to a non-empty selection in
 * the markdown editor. Clicking an instruction triggers an SSE
 * call to /api/artifacts/:id/ai-edit and streams tokens back. On
 * `done`, the host replaces the selection with the LLM output.
 *
 * The component intentionally doesn't render inside the textarea
 * (which can't host popovers). It positions itself via a fixed
 * coordinate the host computes from `selectionStart/End`. When
 * `anchor` is null, the menu hides.
 *
 * The streaming state is local: we keep a single `busy` flag and
 * a `progress` text so the menu can show a "✶ Печатает…" hint
 * while the model writes. The host can show its own indicator
 * via `onError` for anything we can't surface here.
 */
export function AiEditMenu({
  fullText,
  selection,
  selectionStart,
  selectionEnd,
  artifactId,
  onReplace,
  onDismiss,
  onError,
  anchor,
}: Props) {
  const [busy, setBusy] = useState<AiEditInstruction | null>(null);
  const [progress, setProgress] = useState('');
  const handleRef = useRef<{ abort: () => void } | null>(null);

  // Abort the stream if the menu unmounts mid-flight (the user
  // clicked away, navigated, etc.).
  useEffect(() => {
    return () => {
      handleRef.current?.abort();
    };
  }, []);

  if (!anchor) return null;

  async function run(instruction: AiEditInstruction) {
    if (busy) return;
    setBusy(instruction);
    setProgress('');
    try {
      const handle = api.aiEditStream(
        artifactId,
        { instruction, selection, fullText },
        (delta) => {
          if (delta.type === 'token') {
            setProgress((p) => p + delta.text);
          } else if (delta.type === 'error') {
            onError(delta.message);
            setBusy(null);
            setProgress('');
          }
        },
      );
      handleRef.current = handle;
      const { output } = await handle.promise;
      handleRef.current = null;
      // If the user cleared the selection while we were streaming,
      // the offsets no longer make sense. We still splice the
      // output into the original position; the host's onReplace
      // implementation can decide whether to drop the change.
      void selectionStart;
      void selectionEnd;
      onReplace(output);
      setBusy(null);
      setProgress('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onError(msg);
      setBusy(null);
      setProgress('');
    }
  }

  return (
    <div
      className="fixed z-40 flex items-center gap-1 rounded-full border bg-surface px-1.5 py-1 shadow-soft"
      style={{ left: anchor.x, top: anchor.y }}
      data-testid="ai-edit-menu"
      role="toolbar"
      aria-label="AI-ассистент для редактирования"
    >
      {INSTRUCTIONS.map((ins) => {
        const isBusy = busy === ins.id;
        const isDisabled = busy !== null;
        return (
          <button
            key={ins.id}
            type="button"
            disabled={isDisabled}
            onClick={() => void run(ins.id)}
            className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-ink transition-colors enabled:hover:bg-surface-tint disabled:opacity-50"
            data-testid={`ai-edit-${ins.id}`}
            aria-busy={isBusy}
          >
            <span aria-hidden>{isBusy ? '✶' : ins.icon}</span>
            <span>{ins.label}</span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-full px-2 py-1 text-[11px] text-muted transition-colors hover:bg-surface-tint"
        title="Закрыть"
        aria-label="Закрыть меню AI-ассистента"
        data-testid="ai-edit-dismiss"
      >
        ✕
      </button>
      {busy && (
        <span
          className="ml-1 max-w-[180px] truncate text-[10px] text-muted"
          data-testid="ai-edit-progress"
        >
          {progress || '✶ Печатает…'}
        </span>
      )}
    </div>
  );
}
