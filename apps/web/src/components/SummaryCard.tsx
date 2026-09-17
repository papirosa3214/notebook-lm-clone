import { useState } from 'react';
import type { CitationChunk } from '../lib/types';
import { Dot } from './Dot';
import { RefreshIcon } from './icons/NotebookLogo';
import { streamSummary } from '../lib/stream';

/**
 * Renders a notebook summary as the first ("pinned") message inside the
 * chat panel. The summary is loaded from localStorage on mount; the user
 * can click "Обновить" to regenerate it (streams a fresh summary and
 * saves the result).
 *
 * Inline `[N]` citations inside the markdown are clickable and fire
 * `onOpenCitation` so the parent can scroll to the source chunk in the
 * SourcesPanel — same behaviour as chat bubbles.
 */
interface Props {
  notebookId: string;
  readyCount: number;
  onOpenCitation?: (chunk: CitationChunk, index: number) => void;
}

interface Persisted {
  content: string;
  citations: CitationChunk[];
  savedAt: string;
}

const STORAGE_KEY = (id: string) => `nb.summary.${id}`;

function loadPersisted(id: string): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(id));
    if (!raw) return null;
    return JSON.parse(raw) as Persisted;
  } catch {
    return null;
  }
}

function savePersisted(id: string, data: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY(id), JSON.stringify(data));
  } catch {
    /* quota / private mode — ignore */
  }
}

export function SummaryCard({ notebookId, readyCount, onOpenCitation }: Props) {
  const initial = loadPersisted(notebookId);
  const [content, setContent] = useState<string>(initial?.content ?? '');
  const [citations, setCitations] = useState<CitationChunk[]>(initial?.citations ?? []);
  const [savedAt, setSavedAt] = useState<string | null>(initial?.savedAt ?? null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    setError(null);
    setStreaming(true);
    let acc = '';
    let accCitations: CitationChunk[] = [];
    streamSummary(
      { notebookId },
      {
        onCitations: (chunks) => {
          accCitations = chunks;
          setCitations(chunks);
        },
        onToken: (t) => {
          acc += t;
          setContent(acc);
        },
        onDone: () => {
          setStreaming(false);
          if (acc.trim()) {
            const data: Persisted = {
              content: acc,
              citations: accCitations,
              savedAt: new Date().toISOString(),
            };
            savePersisted(notebookId, data);
            setSavedAt(data.savedAt);
          }
        },
        onAbort: () => setStreaming(false),
        onError: (msg) => {
          setStreaming(false);
          setError(msg);
        },
      },
    );
  }

  // Auto-refresh intentionally NOT triggered here — under React
  // Strict-Mode the probe mount races with the actual mount and ends
  // up double-streaming. The user clicks the ↻ button to generate.

  // Hide entirely until we have something to show.
  if (!streaming && content.length === 0 && !error) return null;

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
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[22px] font-semibold leading-tight tracking-tight md:text-[26px]">
            Краткое содержание
          </h3>
          {readyCount > 0 && (
            <p className="mt-1 text-xs text-muted">
              {readyCount} источник{ruPluralInline(readyCount)}
              {dateLabel ? ` · ${dateLabel}` : ''}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={streaming}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-muted transition-all hover:bg-surface-tint disabled:opacity-40"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
          title="Обновить обзор"
        >
          <RefreshIcon size={13} className={streaming ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <p className="mb-3 text-xs text-red-600">Ошибка: {error}</p>}

      <div className="prose-summary text-[15px] leading-relaxed text-ink">
        {streaming && content.length === 0 ? (
          <span className="inline-flex items-center gap-2 text-sm text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Dot delay={0} />
              <Dot delay={150} />
              <Dot delay={300} />
            </span>
            Загружаю модель…
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
