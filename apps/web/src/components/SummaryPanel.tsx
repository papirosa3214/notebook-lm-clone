import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { streamSummary } from '../lib/stream';
import type { CitationChunk } from '../lib/types';

interface Props {
  notebookId: string;
  /** Called when the user clicks a citation chip in the summary panel. */
  onOpenSource?: (chunk: CitationChunk) => void;
}

const STORAGE_KEY = (id: string) => `nb.summary.${id}`;

interface Persisted {
  content: string;
  citations: CitationChunk[];
  savedAt: string;
}

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
    /* quota or private mode — ignore */
  }
}

export function SummaryPanel({ notebookId, onOpenSource }: Props) {
  const [open, setOpen] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [content, setContent] = useState('');
  const [citations, setCitations] = useState<CitationChunk[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const abortRef = useRef<(() => void) | null>(null);

  // Load cached summary on mount / notebook change.
  useEffect(() => {
    const cached = loadPersisted(notebookId);
    if (cached) {
      setContent(cached.content);
      setCitations(cached.citations);
    } else {
      setContent('');
      setCitations([]);
    }
    setError(null);
    return () => abortRef.current?.();
  }, [notebookId]);

  // Source readiness check — only auto-suggest refresh if there are ready sources and nothing cached.
  const sources = useQuery({
    queryKey: ['sources', notebookId],
    queryFn: () => api.listSources(notebookId),
  });
  const readyCount = sources.data?.sources.filter((s) => s.status === 'ready').length ?? 0;

  function refresh(focus?: string) {
    abortRef.current?.();
    setError(null);
    setContent('');
    setCitations([]);
    setStreaming(true);
    let acc = '';
    let accCitations: CitationChunk[] = [];
    abortRef.current = streamSummary(
      { notebookId, focus },
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
          abortRef.current = null;
          if (acc.trim()) {
            savePersisted(notebookId, {
              content: acc,
              citations: accCitations,
              savedAt: new Date().toISOString(),
            });
          }
        },
        onError: (msg) => {
          setStreaming(false);
          abortRef.current = null;
          setError(msg);
        },
      },
    );
  }

  // Auto-refresh trigger when this is the first time on a notebook with sources ready.
  const didAutoRef = useRef(false);
  useEffect(() => {
    if (didAutoRef.current) return;
    if (refreshTick > 0) return;
    if (!sources.data) return;
    const cached = loadPersisted(notebookId);
    if (cached) return;
    if (readyCount === 0) return;
    didAutoRef.current = true;
    refresh();
  }, [readyCount, sources.data, notebookId, refreshTick]);

  const empty = !streaming && content.length === 0 && !error;

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="text-base" aria-hidden>✨</span>
          <span className="text-sm font-semibold">Обзор ноутбука</span>
          {streaming && (
            <span className="chip-indigo animate-pulse" title="Генерация">
              генерируется…
            </span>
          )}
          {!streaming && content && (
            <span className="text-xs text-zinc-500">
              {readyCount > 0 ? `${readyCount} источник${ruPlural(readyCount)}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!streaming) refresh();
            }}
            disabled={streaming}
            className="btn btn-ghost text-xs"
            title="Обновить обзор"
          >
            ↻ Обновить
          </button>
          <span className="text-zinc-400">{open ? '▾' : '▸'}</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          {empty && (
            <div className="space-y-2">
              <p className="text-sm text-zinc-500">
                {readyCount === 0
                  ? 'Добавьте хотя бы один источник — обзор появится автоматически.'
                  : 'Обзор ещё не сгенерирован.'}
              </p>
              {readyCount > 0 && (
                <button
                  type="button"
                  onClick={() => refresh()}
                  className="btn btn-primary text-xs"
                >
                  Сгенерировать обзор
                </button>
              )}
            </div>
          )}

          {error && (
            <p className="text-xs text-red-600">Ошибка: {error}</p>
          )}

          {(streaming || content) && (
            <div className="space-y-3">
              <div className="prose-summary animate-fade-in">
                {renderMarkdownLite(content || (streaming ? '⏳' : ''))}
              </div>

              {citations.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {citations.map((c, i) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => onOpenSource?.(c)}
                      className="chip-indigo cursor-pointer hover:brightness-95"
                      title={c.text}
                    >
                      [{i + 1}] {c.sourceTitle}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ruPlural(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'ов';
  if (last === 1) return '';
  if (last >= 2 && last <= 4) return 'а';
  return 'ов';
}

/**
 * Tiny markdown renderer: handles ## headings, **bold**, [N] citation chips,
 * and bullet lists. Keeps the bundle small — no extra dep.
 */
function renderMarkdownLite(text: string): React.ReactNode {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let bulletBuf: string[] = [];
  let key = 0;

  const flushBullets = () => {
    if (bulletBuf.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`}>
        {bulletBuf.map((line, j) => (
          <li key={j}>{renderInline(line)}</li>
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
    blocks.push(<p key={`p-${key++}`}>{renderInline(trimmed)}</p>);
  }
  flushBullets();
  return blocks;
}

function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const citeMatch = text.slice(i).match(/^\[(\d+)\]/);
    const boldMatch = text.slice(i).match(/^\*\*([^*]+)\*\*/);
    if (citeMatch) {
      parts.push(
        <span key={`c-${key++}`} className="chip-indigo !py-0 !px-1 text-[10px]">
          [{citeMatch[1]}]
        </span>,
      );
      i += citeMatch[0].length;
    } else if (boldMatch) {
      parts.push(<strong key={`b-${key++}`}>{boldMatch[1]}</strong>);
      i += boldMatch[0].length;
    } else {
      const next = text.indexOf('[', i);
      const nextBold = text.indexOf('**', i);
      const stop =
        next === -1 ? (nextBold === -1 ? text.length : nextBold) :
        nextBold === -1 ? next : Math.min(next, nextBold);
      parts.push(text.slice(i, stop));
      i = stop;
    }
  }
  return parts;
}