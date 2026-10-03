import { useEffect, useId, useRef, useState } from 'react';
import type { CitationChunk } from '../lib/types';

/**
 * Inline `[N]` chip used inside the chat answer.
 *
 * Behaviour:
 *  - On devices that support hover (desktop, large tablets): hovering
 *    or focusing the chip opens a small popover with the source title,
 *    the `chunk.text` snippet, and a "Open source" button. The popover
 *    is the same information NotebookLM shows next to a chip — no need
 *    to scroll to the citation dialog.
 *  - On touch-only devices (phones, narrow windows where matchMedia
 *    `(hover: hover)` is false): the popover is suppressed and the
 *    click goes straight to the existing `onOpenCitation` callback,
 *    which opens the full `CitationDialog`. That keeps the popover from
 *    fighting with the OS-level tap-and-hold context menu.
 *  - The popover closes on `mouseleave`, `blur`, `Escape`, or when the
 *    user clicks outside. A 120 ms `closeTimer` keeps the popover open
 *    long enough for the user to move the cursor into it (otherwise
 *    the chip would flicker when the user pauses between chip and
 *    popover).
 */
interface Props {
  index: number;          // 1-based marker the LLM emitted
  chunk: CitationChunk | undefined;
  onOpenCitation?: (chunk: CitationChunk, index: number) => void;
}

const POPOVER_OPEN_DELAY_MS = 80;
const POPOVER_CLOSE_DELAY_MS = 120;
/** Snippet length in the popover body. Long enough to be useful, short
 *  enough to fit in a 320-px popover without scrolling. */
const SNIPPET_MAX_CHARS = 240;

function snippetFor(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SNIPPET_MAX_CHARS) return collapsed;
  return collapsed.slice(0, SNIPPET_MAX_CHARS - 1).trimEnd() + '…';
}

export function CitationChip({ index, chunk, onOpenCitation }: Props) {
  const [open, setOpen] = useState(false);
  const [hoverCapable, setHoverCapable] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverId = useId();

  // Detect whether the device supports hover. On touch-only devices we
  // skip the popover entirely and let the click go straight to the
  // existing citation dialog (see header comment).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(hover: hover)');
    setHoverCapable(mq.matches);
    const handler = (ev: MediaQueryListEvent) => setHoverCapable(ev.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Clear any pending timers on unmount so we don't setState on a
  // dead component.
  useEffect(() => {
    return () => {
      if (openTimer.current) clearTimeout(openTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  function scheduleOpen() {
    if (!hoverCapable || !chunk) return;
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, POPOVER_OPEN_DELAY_MS);
  }

  function scheduleClose() {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, POPOVER_CLOSE_DELAY_MS);
  }

  function handleClick() {
    if (chunk && onOpenCitation) onOpenCitation(chunk, index - 1);
  }

  if (!chunk) {
    // No corresponding citation. Render the marker as a plain span so
    // the user can see the model tried to cite something it wasn't
    // given. The popover is not shown because there's nothing to show.
    return (
      <span
        className="chip-muted mx-0.5 align-baseline"
        data-testid="citation-chip-orphan"
        title="Цитата без источника"
      >
        [{index}]
      </span>
    );
  }

  return (
    <span
      className="relative inline-block align-baseline"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        onClick={handleClick}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
        aria-haspopup={hoverCapable ? 'dialog' : undefined}
        aria-describedby={open ? popoverId : undefined}
        className="chip-indigo mx-0.5 cursor-pointer align-baseline transition-all hover:brightness-95"
        data-testid="citation-chip"
        data-citation-index={index}
      >
        [{index}]
      </button>
      {open && hoverCapable && (
        <span
          id={popoverId}
          role="dialog"
          aria-label={`Цитата ${index}: ${chunk.sourceTitle}`}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
          className="absolute left-0 top-full z-50 mt-1.5 w-80 max-w-[80vw] rounded-lg border bg-surface p-3 text-left text-sm shadow-soft"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
          data-testid="citation-popover"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted">
              {chunk.sourceTitle}
              {chunk.location ? ` · ${chunk.location}` : ''}
            </span>
            <button
              type="button"
              onClick={handleClick}
              className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium text-accent hover:underline"
            >
              Открыть
            </button>
          </div>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
            {snippetFor(chunk.text)}
          </p>
        </span>
      )}
    </span>
  );
}
