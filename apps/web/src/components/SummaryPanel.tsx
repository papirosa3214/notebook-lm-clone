import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { streamSummary } from '../lib/stream';
import { ruPlural } from '../lib/ruPlural';
import type { CitationChunk } from '../lib/types';
import { Dot } from './Dot';
import {
  SparkleIcon,
  RefreshIcon,
  NotebookLogoMark,
} from './icons/NotebookLogo';

interface Props {
  notebookId: string;
  /** Called when the user clicks a citation chip in the summary panel.
   *  `index` is the 1-based display number (the `[N]` marker). */
  onOpenSource?: (chunk: CitationChunk, index: number) => void;
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
        onAbort: () => {
          // Newer refresh / Strict-Mode double-mount superseded us — reset
          // state so the loader stops spinning even though no done/error
          // event arrived.
          setStreaming(false);
          abortRef.current = null;
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
    <div className="ai-surface relative p-6 md:p-7">
      {/* Decorative sparkles */}
      <SparkleIcon
        size={18}
        className="absolute right-5 top-5 text-white/50 animate-sparkle"
      />
      <SparkleIcon
        size={10}
        className="absolute right-12 top-12 text-white/30"
      />

      <div className="relative z-10 mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
          <NotebookLogoMark size={22} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight text-white">
              Краткий обзор
            </h2>
            {streaming && (
              <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-medium text-white">
                генерируется…
              </span>
            )}
          </div>
          {!streaming && content && readyCount > 0 && (
            <p className="text-xs text-white/70">
              по {readyCount} источник{ruPlural(readyCount)}
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => !streaming && refresh()}
            disabled={streaming}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white transition-all hover:bg-white/20 disabled:opacity-40"
            title="Обновить обзор"
          >
            <RefreshIcon size={13} className={streaming ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Content area — use a white rounded card inside the AI surface */}
      <div className="relative z-10 rounded-2xl bg-surface p-5 text-ink shadow-soft">
        {empty && (
          <div className="space-y-2 py-2">
            <p className="text-sm text-muted">
              {readyCount === 0
                ? 'Добавьте хотя бы один источник — обзор появится автоматически.'
                : 'Обзор ещё не сгенерирован.'}
            </p>
            {readyCount > 0 && (
              <button
                type="button"
                onClick={() => refresh()}
                className="btn btn-primary mt-2 text-xs"
              >
                <SparkleIcon size={12} />
                Сгенерировать обзор
              </button>
            )}
          </div>
        )}

        {error && (
          <p className="text-xs text-red-600">Ошибка: {error}</p>
        )}

        {(streaming || content) && (
          <div className="space-y-4">
            <div className="prose-summary animate-fade-in">
              {streaming && !content ? (
                <span className="inline-flex items-center gap-2 text-sm text-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <Dot delay={0} />
                    <Dot delay={150} />
                    <Dot delay={300} />
                  </span>
                  Загружаю модель…
                </span>
              ) : (
                renderMarkdownLite(content)
              )}
            </div>

            {citations.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t pt-3"
                style={{ borderColor: 'rgb(var(--nb-border))' }}>
                {citations.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onOpenSource?.(c, i + 1)}
                    className="chip-indigo cursor-pointer transition-all hover:brightness-95"
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
    </div>
  );
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
        <span key={`c-${key++}`} className="chip-indigo align-baseline">
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