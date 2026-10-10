import { useCallback, useMemo, useState } from 'react';
import type { Flashcard, FlashcardSet } from '@notebook/shared';

interface Props {
  /**
   * Either a parsed FlashcardSet (preferred — comes straight from
   * the studio route) or a JSON string (legacy / shared view).
   * The component parses lazily and shows an error if the JSON
   * is invalid.
   */
  data: FlashcardSet | string;
}

/**
 * Interactive flashcard deck. One question visible at a time, the
 * answer is hidden until the user clicks the card. Track which
 * cards the user has marked as "I knew it" / "I didn't" and show
 * the running progress at the top.
 *
 * The component is keyboard-friendly: Space / Enter flips the
 * current card, ←/→ navigate. We avoid more elaborate keyboard
 * mapping (e.g. 1/2 for known/unknown) — they collide with text
 * inputs in a notebook UI.
 */
export function FlashcardDeck({ data }: Props) {
  const set = useMemo<FlashcardSet | null>(() => {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'cards' in parsed &&
          Array.isArray((parsed as { cards: unknown }).cards)
        ) {
          return parsed as FlashcardSet;
        }
        return null;
      } catch {
        return null;
      }
    }
    return data;
  }, [data]);

  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  // Per-card status: 'known' | 'unknown' | undefined.
  // Stored as a sparse record — re-renders are bounded by
  // the number of cards, not by a global counter.
  const [status, setStatus] = useState<Record<string, 'known' | 'unknown'>>({});

  if (!set || set.cards.length === 0) {
    return (
      <div className="rounded-2xl border bg-canvas p-6 text-sm text-muted"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
        data-testid="flashcard-empty"
      >
        Набор карточек пуст или повреждён.
      </div>
    );
  }

  const total = set.cards.length;
  const card: Flashcard = set.cards[index]!;
  const knownCount = Object.values(status).filter((s) => s === 'known').length;
  const unknownCount = Object.values(status).filter((s) => s === 'unknown').length;
  const reviewed = knownCount + unknownCount;

  const next = useCallback(() => {
    setFlipped(false);
    setIndex((i) => (i + 1) % total);
  }, [total]);
  const prev = useCallback(() => {
    setFlipped(false);
    setIndex((i) => (i - 1 + total) % total);
  }, [total]);
  const flip = useCallback(() => setFlipped((f) => !f), []);
  const mark = useCallback(
    (s: 'known' | 'unknown') => {
      setStatus((prev) => ({ ...prev, [card.id]: s }));
      // Auto-advance on mark so a study session flows naturally.
      setFlipped(false);
      if (index < total - 1) setIndex((i) => i + 1);
    },
    [card.id, index, total],
  );
  const reset = useCallback(() => {
    setIndex(0);
    setFlipped(false);
    setStatus({});
  }, []);

  return (
    <div
      className="space-y-4"
      data-testid="flashcard-deck"
      // Keyboard shortcuts: Space/Enter to flip, ←/→ to navigate.
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          flip();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          next();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          prev();
        }
      }}
    >
      <header className="flex items-center justify-between gap-3 text-xs text-muted">
        <span>
          {index + 1} / {total}
          {reviewed > 0 && (
            <>
              {' · '}
              <span className="text-green-600">{knownCount} знаю</span>
              {' / '}
              <span className="text-red-600">{unknownCount} не знаю</span>
            </>
          )}
        </span>
        <button
          type="button"
          onClick={reset}
          className="text-xs text-muted hover:text-ink"
          title="Сбросить прогресс"
        >
          Сбросить
        </button>
      </header>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-tint">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${total === 0 ? 0 : (reviewed / total) * 100}%` }}
          aria-label="Прогресс"
        />
      </div>

      <button
        type="button"
        onClick={flip}
        className="group block w-full rounded-2xl border bg-surface p-6 text-left transition-colors hover:border-accent/40"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
        data-testid="flashcard-card"
        data-flipped={flipped ? 'true' : 'false'}
        data-status={status[card.id] ?? 'pending'}
      >
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
          Вопрос
        </div>
        <p className="text-base font-medium text-ink">{card.question}</p>
        {flipped ? (
          <div className="mt-4 border-t pt-4" style={{ borderColor: 'rgb(var(--nb-border))' }}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
              Ответ
            </div>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{card.answer}</p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted">Нажми, чтобы увидеть ответ</p>
        )}
      </button>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={prev}
            disabled={total <= 1}
            className="btn btn-secondary"
            data-testid="flashcard-prev"
          >
            ← Назад
          </button>
          <button
            type="button"
            onClick={next}
            disabled={total <= 1}
            className="btn btn-secondary"
            data-testid="flashcard-next"
          >
            Вперёд →
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => mark('unknown')}
            className="btn btn-secondary text-red-600"
            data-testid="flashcard-unknown"
            disabled={status[card.id] === 'unknown'}
          >
            Не знаю
          </button>
          <button
            type="button"
            onClick={() => mark('known')}
            className="btn btn-secondary text-green-600"
            data-testid="flashcard-known"
            disabled={status[card.id] === 'known'}
          >
            Знаю
          </button>
        </div>
      </div>
    </div>
  );
}
