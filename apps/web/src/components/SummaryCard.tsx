import { useEffect, useSyncExternalStore } from 'react';
import type { CitationChunk } from '../lib/types';
import { Dot } from './Dot';
import { RefreshIcon } from './icons/NotebookLogo';
import {
  ensureSummaryStarted,
  getSummaryState,
  refreshSummary,
  subscribeSummary,
} from '../lib/summaryStore';

/**
 * Renders the notebook summary as the first ("pinned") message inside
 * the chat panel.
 *
 * The stream itself lives in `summaryStore` (see the comment there for
 * why), so all this component does is subscribe and render. It
 * auto-generates on mount as soon as at least one source is ready —
 * previously nothing appeared until the user found the ↻ button, which
 * was itself hidden while the card had no content.
 */
interface Props {
  notebookId: string;
  readyCount: number;
  onOpenCitation?: (chunk: CitationChunk, index: number) => void;
}

export function SummaryCard({ notebookId, readyCount, onOpenCitation }: Props) {
  const state = useSyncExternalStore(
    (fn) => subscribeSummary(notebookId, fn),
    () => getSummaryState(notebookId),
    () => getSummaryState(notebookId),
  );

  // Generate the overview as soon as there is something to summarise.
  // `ensureSummaryStarted` is idempotent, so StrictMode's double mount
  // joins the in-flight stream instead of starting a second one.
  useEffect(() => {
    if (readyCount > 0) ensureSummaryStarted(notebookId);
  }, [notebookId, readyCount]);

  // No sources → nothing to summarise. With sources we render the card
  // immediately, even while empty, so the user sees it working.
  if (readyCount === 0) return null;

  const { content, citations, savedAt, streaming, error } = state;

  const dateLabel = savedAt
    ? new Date(savedAt).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : '';

  return (
    <div
      className="rounded-2xl border bg-surface px-5 py-5 shadow-soft animate-fade-in"
      style={{ borderColor: 'rgb(var(--nb-border) / 0.6)' }}
      data-testid="summary-card"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[22px] font-semibold leading-tight tracking-tight md:text-[26px]">
            Краткое содержание
          </h3>
          <p className="mt-1 text-xs text-muted">
            {readyCount} источник{ruPluralInline(readyCount)}
            {dateLabel ? ` · ${dateLabel}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => refreshSummary(notebookId)}
          disabled={streaming}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-muted transition-all hover:bg-surface-tint disabled:opacity-40"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
          title="Обновить обзор"
          data-testid="summary-refresh"
        >
          <RefreshIcon size={13} className={streaming ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <p className="mb-3 text-xs text-red-600" data-testid="summary-error">
          Ошибка: {error}
        </p>
      )}

      <div className="prose-summary text-[15px] leading-relaxed text-ink">
        {content.length === 0 ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Dot delay={0} />
              <Dot delay={150} />
              <Dot delay={300} />
            </span>
            Составляю обзор по источникам…
          </span>
        ) : (
          renderMarkdownWithCitations(content, citations, onOpenCitation)
        )}
      </div>
    </div>
  );
}

// ruPlural inline so we don't add an export surface just for one helper.
function ruPluralInline(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return '';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'а';
  return 'ов';
}

/**
 * Render markdown with clickable `[N]` citation markers. Reused the
 * shape of `renderMarkdownLite` from SummaryPanel so visual output
 * matches, but swaps citation chips for buttons.
 */
function renderMarkdownWithCitations(
  text: string,
  citations: CitationChunk[],
  onOpenCitation?: (chunk: CitationChunk, index: number) => void,
): React.ReactNode {
  if (!onOpenCitation || citations.length === 0) return renderMarkdownLite(text);
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let bulletBuf: string[] = [];
  let key = 0;
  const flushBullets = () => {
    if (bulletBuf.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`}>
        {bulletBuf.map((line, j) => (
          <li key={j}>{renderInlineCitations(line, citations, onOpenCitation)}</li>
        ))}
      </ul>,
    );
    bulletBuf = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      continue;
    }
    if (trimmed.startsWith('## ')) {
      flushBullets();
      blocks.push(<h2 key={`h-${key++}`}>{trimmed.slice(3)}</h2>);
      continue;
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      bulletBuf.push(trimmed.slice(2));
      continue;
    }
    flushBullets();
    blocks.push(
      <p key={`p-${key++}`}>
        {renderInlineCitations(trimmed, citations, onOpenCitation)}
      </p>,
    );
  }
  flushBullets();
  return blocks;
}

function renderInlineCitations(
  text: string,
  citations: CitationChunk[],
  onOpenCitation: (chunk: CitationChunk, index: number) => void,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const len = text.length;
  const ITER_CAP = 200_000;
  let iter = 0;
  while (i < len) {
    if (++iter > ITER_CAP) {
      parts.push(text.slice(i));
      break;
    }
    const citeMatch = text.slice(i).match(/^\[(\d+)\]/);
    const boldMatch = text.slice(i).match(/^\*\*([^*]+)\*\*/);
    if (citeMatch) {
      const idx = parseInt(citeMatch[1] ?? '0', 10);
      const chunk = citations[idx - 1];
      if (chunk) {
        parts.push(
          <button
            key={`c-${key++}`}
            type="button"
            onClick={() => onOpenCitation(chunk, idx)}
            className="chip-indigo align-baseline cursor-pointer transition-all hover:brightness-95"
            title={chunk.text}
          >
            [{idx}]
          </button>,
        );
      } else {
        parts.push(
          <span key={`c-${key++}`} className="chip-indigo align-baseline">
            [{idx}]
          </span>,
        );
      }
      i += citeMatch[0].length;
    } else if (boldMatch) {
      parts.push(<strong key={`b-${key++}`}>{boldMatch[1]}</strong>);
      i += boldMatch[0].length;
    } else {
      const next = text.indexOf('[', i);
      const nextBold = text.indexOf('**', i);
      const stop =
        next === -1
          ? nextBold === -1
            ? len
            : nextBold
          : nextBold === -1
            ? next
            : Math.min(next, nextBold);
      parts.push(text.slice(i, stop));
      i = stop;
    }
  }
  return parts;
}

// Plain-text fallback when citations aren't available.
function renderMarkdownLite(text: string): React.ReactNode {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let bulletBuf: string[] = [];
  let key = 0;
  const flushBullets = () => {
    if (bulletBuf.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`}>
        {bulletBuf.map((line, j) => (
          <li key={j}>{line}</li>
        ))}
      </ul>,
    );
    bulletBuf = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      continue;
    }
    if (trimmed.startsWith('## ')) {
      flushBullets();
      blocks.push(<h2 key={`h-${key++}`}>{trimmed.slice(3)}</h2>);
      continue;
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      bulletBuf.push(trimmed.slice(2));
      continue;
    }
    flushBullets();
    blocks.push(<p key={`p-${key++}`}>{trimmed}</p>);
  }
  flushBullets();
  return blocks;
}
