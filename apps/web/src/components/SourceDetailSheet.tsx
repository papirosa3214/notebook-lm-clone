import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Source } from '../lib/types';
import { Dot } from './Dot';
import {
  CloseIcon,
  RefreshIcon,
  SourceIcon,
} from './icons/NotebookLogo';

interface Props {
  source: Source;
  onClose: () => void;
}

/**
 * Source-detail modal. Shows the per-source summary + topics, with a
 * "Перегенерировать" button that calls the backend's refresh route
 * (forces re-LLM even when a cached summary already exists).
 *
 * Closing: Esc, click on backdrop, click on × button.
 */
export function SourceDetailSheet({ source: sourceProp, onClose }: Props) {
  const qc = useQueryClient();

  // Esc closes the sheet.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Pull a fresh source row so the summary shown matches what's in DB
  // after fire-and-forget ingest summarization.
  const sources = qc.getQueryData<{ sources: Source[] }>(['sources', sourceProp.notebookId]);
  const source = sources?.sources.find((s) => s.id === sourceProp.id) ?? sourceProp;

  const summaryQuery = useQuery({
    queryKey: ['source-summary', source.id],
    queryFn: () => api.getSourceSummary(source.id),
    enabled: source.status === 'ready',
    // The cached summary travels with the source row, so we only need
    // this fetch to *generate* the summary the first time.
    retry: (count, err) => {
      const status = (err as { status?: number } | null)?.status;
      // 425 means the source isn't ready yet — keep polling.
      if (status === 425) return count < 60;
      return count < 2;
    },
    retryDelay: 2_000,
    staleTime: 60_000,
  });

  const refresh = useMutation({
    mutationFn: () => api.regenerateSourceSummary(source.id),
    onSuccess: (data) => {
      qc.setQueryData(['source-summary', source.id], data);
      // Update the source row's summary fields so the list-row preview
      // and any other consumers stay in sync.
      qc.setQueryData<{ sources: Source[] }>(
        ['sources', source.notebookId],
        (old) => {
          if (!old) return old;
          return {
            sources: old.sources.map((s) =>
              s.id === source.id
                ? {
                    ...s,
                    summary: data.summary,
                    summaryTopics: data.topics,
                    summarizedAt: data.generatedAt,
                  }
                : s,
            ),
          };
        },
      );
    },
  });

  // While the first generation is in flight the source row may still
  // carry summary=null. Render the placeholder until the API returns.
  const summaryText = summaryQuery.data?.summary ?? source.summary ?? '';
  const topics = summaryQuery.data?.topics ?? source.summaryTopics ?? [];
  const isLoading =
    (source.status === 'ready' && !summaryText && summaryQuery.isPending) ||
    summaryQuery.isFetching;

  return (
    <div className="modal-backdrop animate-fade-in" onClick={onClose}>
      <div
        className="card-pop w-full max-w-2xl p-6 animate-fade-up"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-subtle">
              <span className="kind-pill">
                <SourceIcon kind={source.kind} size={12} />
              </span>
              {sourceKindLabel(source.kind)}
            </div>
            <h3 className="truncate text-base font-semibold" title={source.title}>
              {source.title}
            </h3>
            {source.url && (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 inline-block truncate text-xs text-muted hover:text-accent hover:underline"
              >
                {source.url}
              </a>
            )}
          </div>
          <button
            onClick={onClose}
            className="btn-icon"
            title="Закрыть"
            type="button"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="mb-3 flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium">Краткое содержание</h4>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || source.status !== 'ready'}
            className="flex h-7 w-7 items-center justify-center rounded-full border text-muted transition-all hover:bg-surface-tint disabled:opacity-40"
            style={{ borderColor: 'rgb(var(--nb-border))' }}
            title="Перегенерировать"
          >
            <RefreshIcon size={12} className={refresh.isPending ? 'animate-spin' : ''} />
          </button>
        </div>

        {source.status !== 'ready' ? (
          <p className="rounded-xl bg-surface-tint px-4 py-3 text-xs text-muted">
            Источник ещё обрабатывается. Краткое содержание появится
            автоматически, как только статус станет «готово».
          </p>
        ) : isLoading ? (
          <div className="flex items-center gap-2 rounded-xl bg-surface-tint px-4 py-3 text-sm text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Dot delay={0} />
              <Dot delay={150} />
              <Dot delay={300} />
            </span>
            Генерирую краткое содержание…
          </div>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-ink">
              {summaryText || (
                <span className="text-muted">
                  Не удалось сгенерировать содержание — попробуй «Перегенерировать».
                </span>
              )}
            </p>
            {topics.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {topics.map((t, i) => (
                  <span
                    key={i}
                    className="chip-indigo cursor-default"
                    title={t}
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        {refresh.isError && (
          <p className="mt-3 text-xs text-red-600">
            Не удалось перегенерировать: {(refresh.error as Error)?.message ?? 'unknown'}
          </p>
        )}
      </div>
    </div>
  );
}

function sourceKindLabel(kind: Source['kind']): string {
  switch (kind) {
    case 'url':
      return 'URL';
    case 'youtube':
      return 'YouTube';
    case 'file':
      return 'Файл';
  }
}
