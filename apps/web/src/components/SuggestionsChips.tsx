import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ChatMessage } from '../lib/types';

interface Props {
  notebookId: string;
  /** The user question that produced the assistant answer — passed
   *  to the suggestions endpoint so the LLM can stay on-topic. */
  question: string;
  /** The assistant answer — same purpose. */
  answer: string;
  /** Optional recent history for context. */
  history?: ChatMessage[];
  /** Optional sourceIds to scope suggestions to the same sources
   *  the user picked in the chat source-scope selector. */
  sourceIds?: string[];
  /** Click handler — usually fills the chat input. */
  onPick: (suggestion: string) => void;
  /** When provided, replaces the "Подождите..." label. */
  emptyState?: React.ReactNode;
}

/**
 * Inline row of follow-up question suggestions rendered under an
 * assistant answer. Fetches from /api/notebooks/:id/suggestions
 * on mount. If the endpoint is disabled (503) or the LLM
 * misbehaves, we silently hide the row — suggestions are nice-to-have,
 * never a blocker.
 */
export function SuggestionsChips({
  notebookId,
  question,
  answer,
  history,
  sourceIds,
  onPick,
  emptyState,
}: Props) {
  const [items, setItems] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Server explicitly disabled the feature (503). Distinct from
  // "error" so we can render nothing rather than a stale "loading"
  // placeholder that never resolves.
  const [disabled, setDisabled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setError(null);
    setDisabled(false);

    (async () => {
      try {
        const res = await fetch(`/api/notebooks/${notebookId}/suggestions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, answer, history, sourceIds }),
          signal: controller.signal,
        });
        if (res.status === 503) {
          // Feature disabled server-side. Hide the row.
          setDisabled(true);
          return;
        }
        if (!res.ok || !res.body) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let found: string[] | null = null;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(5).trim()) as {
                type: string;
                suggestions?: string[];
                message?: string;
              };
              if (payload.type === 'suggestions' && Array.isArray(payload.suggestions)) {
                found = payload.suggestions;
              } else if (payload.type === 'error') {
                setError(payload.message ?? 'suggestions error');
                return;
              }
            } catch {
              // ignore malformed
            }
          }
        }
        if (found && found.length > 0) {
          setItems(found);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof Error) setError(err.message);
      }
    })();

    return () => controller.abort();
  }, [notebookId, question, answer, history, sourceIds]);

  if (error || disabled) {
    // Silent hide on error or feature-disabled — the chat still works.
    return null;
  }
  if (!items || items.length === 0) {
    return (
      <div className="mt-2 text-[11px] text-muted" data-testid="suggestions-loading">
        {emptyState ?? 'Подбираю follow-up вопросы…'}
      </div>
    );
  }
  return (
    <div
      className="mt-2 flex flex-wrap gap-1.5"
      data-testid="suggestions-chips"
    >
      {items.map((s, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onPick(s)}
          className="rounded-full border bg-surface-tint px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:border-accent/50 hover:text-ink"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
          data-testid="suggestion-chip"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// re-export api so callers can compose with the same import
export { api };
