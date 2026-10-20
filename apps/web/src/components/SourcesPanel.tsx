import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import type {
  IngestProgressDelta,
  IngestStage,
  Source,
  SourceGroup,
  SourceKind,
} from '../lib/types';
import { SourceDetailSheet } from './SourceDetailSheet';
import { useSourceScopeContext } from '../lib/sourceScopeContext';
import { isSourceInScope } from '../lib/useSourceScope';
import { AddSourcesHubDialog, type HubTab } from './AddSourcesHubDialog';
import {
  SourceIcon,
  PlusIcon,
  SearchIcon,
  RefreshIcon,
  SendIcon,
  CloseIcon,
  ChevronDownIcon,
  TrashIcon,
} from './icons/NotebookLogo';

interface Props {
  notebookId: string;
}

const KIND_LABEL: Record<SourceKind, string> = {
  url: 'URL',
  file: 'Файл',
  youtube: 'YouTube',
};

const STAGE_ORDER: IngestStage[] = [
  'fetching',
  'extracting',
  'chunking',
  'embedding',
  'storing',
];

const STAGE_LABEL: Record<IngestStage, string> = {
  fetching: 'Загружаю страницу',
  extracting: 'Извлекаю текст',
  chunking: 'Разбиваю на чанки',
  embedding: 'Создаю embeddings',
  storing: 'Сохраняю',
};

export function SourcesPanel({ notebookId }: Props) {
  const qc = useQueryClient();
  const sources = useQuery({
    queryKey: ['sources', notebookId],
    queryFn: () => api.listSources(notebookId),
  });

  const [openSource, setOpenSource] = useState<Source | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Source | null>(null);

  // Hub Modal state
  const [showHub, setShowHub] = useState(false);
  const [hubTab, setHubTab] = useState<HubTab>('files');
  const [hubValue, setHubValue] = useState('');

  // Local filter for sources list
  const [filterQuery, setFilterQuery] = useState('');

  const refresh = useMutation({
    mutationFn: () => api.refreshSources(notebookId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources', notebookId] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources', notebookId] }),
  });

  const readyCount = sources.data?.sources.filter((s) => s.status === 'ready').length ?? 0;
  const totalCount = sources.data?.sources.length ?? 0;

  // Thematic sections. The server clusters the sources once and caches
  // the split by source-set signature, so this query is a cheap read on
  // every panel mount and an LLM call only when the source set changed.
  const groups = useQuery({
    queryKey: ['source-groups', notebookId],
    queryFn: () => api.getSourceGroups(notebookId),
  });
  const regroup = useMutation({
    mutationFn: () => api.getSourceGroups(notebookId, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['source-groups', notebookId] }),
  });
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  let scope: ReturnType<typeof useSourceScopeContext> | null = null;
  try {
    scope = useSourceScopeContext();
  } catch {
    scope = null;
  }
  const selectedIds = scope?.selectedIds ?? [];
  const isScoped = scope?.isScoped ?? false;

  const filteredSources = (sources.data?.sources ?? []).filter((s) => {
    if (!filterQuery.trim()) return true;
    const q = filterQuery.toLowerCase();
    return (
      s.title.toLowerCase().includes(q) ||
      (s.url && s.url.toLowerCase().includes(q)) ||
      (s.summary && s.summary.toLowerCase().includes(q))
    );
  });

  const sections = buildSections(filteredSources, groups.data?.groups ?? []);
  const sectioned = sections.length > 0;
  // While the query is in flight we render the flat list, so a notebook
  // with three sources never flashes section headers in and back out.
  const canRegroup = totalCount >= 4;

  const toggleSection = (title: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-[13px] font-semibold tracking-tight text-ink flex items-center gap-1.5">
          <span>Источники</span>
          {totalCount > 0 && (
            <span className="text-xs font-normal text-muted">
              {isScoped
                ? `(${selectedIds.length} из ${readyCount})`
                : `(${readyCount}/${totalCount})`}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1">
          {scope && scope.hasReady && isScoped && (
            <button
              type="button"
              onClick={() => scope.selectAll()}
              className="rounded-full px-2 py-1 text-[11px] font-medium text-muted hover:text-ink hover:bg-surface-tint"
              title="Сбросить выбор — выбрать все готовые источники"
            >
              Все
            </button>
          )}
          {canRegroup && (
            <button
              type="button"
              onClick={() => regroup.mutate()}
              disabled={regroup.isPending}
              className="rounded-full px-2 py-1 text-[11px] font-medium text-muted hover:text-ink hover:bg-surface-tint disabled:opacity-50"
              title="Пересобрать тематические разделы по источникам"
              data-testid="regroup-sources"
            >
              {regroup.isPending ? 'Разделяю…' : 'Перегруппировать'}
            </button>
          )}
          <button
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="btn-icon"
            title="Обновить список"
          >
            <RefreshIcon size={14} className={refresh.isPending ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Main Add Sources Button */}
      <div className="px-4 pt-1 pb-2.5">
        <button
          type="button"
          onClick={() => {
            setHubTab('files');
            setHubValue('');
            setShowHub(true);
          }}
          className="btn btn-primary w-full shadow-sm flex items-center justify-center gap-2 py-2.5 text-xs font-semibold"
          data-testid="open-add-sources-hub"
        >
          <PlusIcon size={15} />
          <span>Добавить источники</span>
        </button>
      </div>

      {/* Unified Quick Input Bar */}
      <div className="px-4 pb-3">
        <QuickSourceBar
          notebookId={notebookId}
          onSourceAdded={() => qc.invalidateQueries({ queryKey: ['sources', notebookId] })}
          onOpenSearchHub={(q) => {
            setHubTab('search');
            setHubValue(q);
            setShowHub(true);
          }}
          filterQuery={filterQuery}
          onFilterChange={setFilterQuery}
        />
      </div>

      {/* Sources list */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {sources.isLoading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="shimmer h-16 rounded-2xl" />
            ))}
          </div>
        )}

        {sources.data && sources.data.sources.length === 0 && (
          <EmptyState onOpenHub={() => setShowHub(true)} />
        )}

        {sources.data && sources.data.sources.length > 0 && filteredSources.length === 0 && (
          <div className="p-4 text-center text-xs text-muted">
            Ничего не найдено по запросу «{filterQuery}»
          </div>
        )}

        {sectioned ? (
          <div className="space-y-4">
            {sections.map((section) => {
              const collapsed = collapsedSections.has(section.title);
              return (
                <section key={section.title} data-testid="source-section">
                  <button
                    type="button"
                    onClick={() => toggleSection(section.title)}
                    className="mb-1.5 flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-surface-tint/60"
                    aria-expanded={!collapsed}
                  >
                    <ChevronDownIcon
                      size={12}
                      className={`shrink-0 text-muted transition-transform ${collapsed ? '-rotate-90' : ''}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-muted">
                      {section.title}
                    </span>
                    <span className="shrink-0 rounded-full bg-surface-tint px-1.5 py-0.5 text-[10px] font-medium text-muted">
                      {section.sources.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <ul className="space-y-2">
                      {section.sources.map((s) => (
                        <SourceItem
                          key={s.id}
                          source={s}
                          onSelect={() => setOpenSource(s)}
                          onDelete={() => setPendingDelete(s)}
                          selected={
                            scope
                              ? isSourceInScope(s.id, scope.selectedIds, scope.readyIds)
                              : true
                          }
                          onToggle={
                            scope && s.status === 'ready'
                              ? () => scope.toggle(s.id)
                              : undefined
                          }
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <ul className="space-y-2">
            {filteredSources.map((s) => (
              <SourceItem
                key={s.id}
                source={s}
                onSelect={() => setOpenSource(s)}
                onDelete={() => setPendingDelete(s)}
                selected={
                  scope
                    ? isSourceInScope(s.id, scope.selectedIds, scope.readyIds)
                    : true
                }
                onToggle={
                  scope && s.status === 'ready'
                    ? () => scope.toggle(s.id)
                    : undefined
                }
              />
            ))}
          </ul>
        )}
      </div>

      {/* Add Sources Center Hub Modal */}
      {showHub && (
        <AddSourcesHubDialog
          notebookId={notebookId}
          initialTab={hubTab}
          initialValue={hubValue}
          onClose={() => setShowHub(false)}
          onSourceAdded={() => qc.invalidateQueries({ queryKey: ['sources', notebookId] })}
        />
      )}

      {/* Delete confirmation */}
      {pendingDelete && (
        <ConfirmDialog
          title="Удалить источник?"
          message={`«${pendingDelete.title}» исчезнет из ноутбука вместе со всеми чанками и ссылками из ответов чата.`}
          confirmLabel="Удалить"
          danger
          onConfirm={() => {
            remove.mutate(pendingDelete.id);
            setPendingDelete(null);
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}

      {/* Detail sheet */}
      {openSource && (
        <SourceDetailSheet
          source={openSource}
          onClose={() => setOpenSource(null)}
        />
      )}
    </div>
  );
}

/**
 * Turn the flat source list into sections.
 *
 * Exported for tests: the grouping must stay a partition of the visible
 * list, because the checkboxes the user clicks while reading section by
 * section build the chat's context scope — a source rendered twice would
 * toggle inconsistently depending on which copy was clicked.
 *
 * Two defensive moves, since the client shouldn't trust the cache blob
 * blindly: ids are claimed by the first section that mentions them, and
 * anything the server's split missed lands in «Другие» rather than
 * vanishing. Returns [] when there's nothing to group, which the panel
 * renders as the plain list it has always shown.
 */
export function buildSections(
  sources: Source[],
  groups: SourceGroup[],
): Array<{ title: string; sources: Source[] }> {
  if (groups.length === 0) return [];

  const byId = new Map(sources.map((s) => [s.id, s]));
  const claimed = new Set<string>();
  const sections: Array<{ title: string; sources: Source[] }> = [];

  for (const group of groups) {
    const items = group.sourceIds
      .filter((id) => !claimed.has(id))
      .map((id) => byId.get(id))
      .filter((s): s is Source => Boolean(s));
    if (items.length === 0) continue;
    items.forEach((s) => claimed.add(s.id));
    sections.push({ title: group.title, sources: items });
  }

  const rest = sources.filter((s) => !claimed.has(s.id));
  if (rest.length > 0) sections.push({ title: 'Другие', sources: rest });

  return sections;
}

/** What the single add-source input looks like it contains. */
export type SourceInputKind = 'youtube' | 'url' | 'query';

/**
 * Route one piece of user input to the right add-source flow.
 */
export function classifySourceInput(raw: string): SourceInputKind {
  const v = raw.trim();
  if (!v) return 'query';
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return 'youtube';

  let host: string;
  const hasScheme = /^https?:\/\//i.test(v);
  try {
    const u = new URL(hasScheme ? v : `https://${v}`);
    host = u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'query';
  }
  if (
    host === 'youtu.be' ||
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com'
  ) {
    return 'youtube';
  }
  if (hasScheme) return 'url';
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'url';
  if (!host.includes('.')) return 'query';
  return 'url';
}

export function normalizeUrlInput(raw: string): string {
  const v = raw.trim();
  if (!v) return v;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}

/**
 * Unified smart input bar: auto-detects URL, YouTube or Search query.
 */
function QuickSourceBar({
  notebookId,
  onSourceAdded,
  onOpenSearchHub,
  filterQuery,
  onFilterChange,
}: {
  notebookId: string;
  onSourceAdded: () => void;
  onOpenSearchHub: (q: string) => void;
  filterQuery: string;
  onFilterChange: (q: string) => void;
}) {
  const [value, setValue] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);

  const kind = classifySourceInput(value);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v || running) return;

    if (kind === 'query') {
      onOpenSearchHub(v);
      return;
    }

    // It's a URL or YouTube link -> direct fast ingest
    setRunning(true);
    setProgress(INITIAL_PROGRESS);

    const stream =
      kind === 'youtube'
        ? api.ingestYoutubeSourceStream(notebookId, { url: v }, (delta) =>
            setProgress((prev) => progressFromDelta(delta, prev)),
          )
        : api.ingestUrlSourceStream(
            notebookId,
            { url: normalizeUrlInput(v) },
            (delta) => setProgress((prev) => progressFromDelta(delta, prev)),
          );

    stream.promise
      .then(() => {
        setValue('');
        onFilterChange('');
        onSourceAdded();
        setTimeout(() => {
          setRunning(false);
          setProgress(INITIAL_PROGRESS);
        }, 1200);
      })
      .catch((err: Error) => {
        setRunning(false);
        setProgress((p) => ({ ...p, error: err.message }));
      });
  };

  return (
    <div className="space-y-2">
      <form onSubmit={handleSubmit}>
        <div
          className="flex items-center gap-1.5 rounded-2xl border bg-surface px-3 py-1 transition-all focus-within:border-accent focus-within:shadow-sm"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
        >
          <span className="shrink-0 text-muted" aria-hidden>
            {kind === 'youtube' ? '📺' : kind === 'url' ? '🔗' : '🔍'}
          </span>
          <input
            className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-ink outline-none placeholder:text-muted"
            placeholder="Вставьте ссылку или поисковый запрос…"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              // Only filter list if user is typing text search, not a URL
              if (classifySourceInput(e.target.value) === 'query') {
                onFilterChange(e.target.value);
              } else {
                onFilterChange('');
              }
            }}
            disabled={running}
            data-testid="add-source-input"
            aria-label="Вставьте ссылку или поисковый запрос"
          />
          {value.trim() && (
            <button
              type="button"
              onClick={() => {
                setValue('');
                onFilterChange('');
              }}
              className="rounded-full p-1 text-muted hover:text-ink"
              title="Очистить"
            >
              <CloseIcon size={12} />
            </button>
          )}
          <button
            type="submit"
            disabled={!value.trim() || running}
            className="shrink-0 rounded-full p-1.5 text-accent transition-colors hover:bg-surface-tint disabled:opacity-40"
            title={kind === 'query' ? 'Искать в вебе' : 'Добавить ссылку'}
            data-testid="add-source-submit"
          >
            {kind === 'query' ? <SearchIcon size={14} /> : <SendIcon size={14} />}
          </button>
        </div>
      </form>

      {/* Live compact progress if URL is being ingested directly */}
      {(running || progress.error || (progress.stage && progress.ratio < 1)) && (
        <div
          className="rounded-xl border p-2.5 text-xs bg-surface-tint/50 space-y-1.5 animate-fade-in"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
        >
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span className="truncate font-medium text-ink">
              {progress.error ? '✗ Ошибка' : progress.message || 'Импорт…'}
            </span>
            {!progress.error && (
              <span className="font-semibold text-accent">{Math.round(progress.ratio * 100)}%</span>
            )}
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-surface">
            <div
              className={`h-full transition-all duration-300 ${
                progress.error ? 'bg-red-500' : 'bg-accent'
              }`}
              style={{ width: `${Math.round(progress.ratio * 100)}%` }}
            />
          </div>
          {progress.error && (
            <p className="text-[10px] text-red-600 mt-1">{progress.error}</p>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onOpenHub }: { onOpenHub: () => void }) {
  return (
    <div className="mt-8 px-4 text-center">
      <span className="text-3xl mb-2 inline-block opacity-80" aria-hidden>
        📚
      </span>
      <p className="text-sm font-semibold text-ink">Пока нет источников</p>
      <p className="max-w-xs mx-auto text-xs text-muted mt-1.5 leading-relaxed">
        Вставьте ссылку в поле выше или нажмите кнопку «Добавить источники», чтобы загрузить файлы, видео или провести исследование.
      </p>
      <button
        type="button"
        onClick={onOpenHub}
        className="btn btn-secondary text-xs mt-4"
      >
        <PlusIcon size={13} />
        Открыть центр источников
      </button>
    </div>
  );
}

function SourceItem({
  source: s,
  onSelect,
  onDelete,
  selected,
  onToggle,
}: {
  source: Source;
  onSelect: () => void;
  onDelete: () => void;
  selected: boolean;
  onToggle?: () => void;
}) {
  const statusBadge = {
    pending: { text: '⏳', cls: 'bg-surface-tint text-muted' },
    parsing: {
      text: 'обработка',
      cls: 'bg-[#FEF3C7] text-[#92400E] dark:bg-[#78350F]/40 dark:text-[#FBBF24]',
    },
    ready: {
      text: 'готово',
      cls: 'bg-[#D1FAE5] text-[#065F46] dark:bg-[#064E3B]/50 dark:text-[#6EE7B7]',
    },
    failed: {
      text: 'ошибка',
      cls: 'bg-[#FEE2E2] text-[#991B1B] dark:bg-[#7F1D1D]/40 dark:text-[#FCA5A5]',
    },
  }[s.status];

  return (
    <li className="group flex items-center gap-2 p-2 rounded-xl transition-all hover:bg-surface-tint/60">
      {onToggle ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
          style={{
            backgroundColor: selected ? 'rgb(var(--nb-accent))' : 'transparent',
            borderColor: selected ? 'rgb(var(--nb-accent))' : 'rgb(var(--nb-border))',
            color: 'white',
          }}
          aria-label={selected ? 'Исключить из контекста чата' : 'Включить в контекст чата'}
          title={selected ? 'Исключить из контекста чата' : 'Включить в контекст чата'}
        >
          {selected && (
            <svg width="10" height="10" viewBox="0 0 11 11" fill="none" aria-hidden="true">
              <path
                d="M2 5.5L4.5 8L9 3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      ) : (
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-dashed text-[9px] text-muted"
          title="Этот источник ещё не готов"
        >
          —
        </span>
      )}

      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        title="Открыть краткое содержание"
      >
        <span className="kind-pill shrink-0" title={KIND_LABEL[s.kind]}>
          <SourceIcon kind={s.kind} size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-ink" title={s.title}>
            {s.title}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-medium ${statusBadge.cls}`}
            >
              {statusBadge.text}
            </span>
            {s.url && (
              <span className="truncate text-[10px] text-muted" title={s.url}>
                {prettyHost(s.url)}
              </span>
            )}
          </div>
          {s.summary && (
            <div className="mt-0.5 line-clamp-1 text-[10px] leading-snug text-muted">
              {s.summary}
            </div>
          )}
          {s.error && (
            <div className="mt-0.5 truncate text-[10px] text-red-600" title={s.error}>
              {s.error}
            </div>
          )}
        </div>
      </button>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="btn-icon opacity-0 transition-opacity group-hover:opacity-100 shrink-0"
        title="Удалить источник"
        style={{ color: 'rgb(var(--nb-muted))' }}
        type="button"
      >
        <TrashIcon size={13} />
      </button>
    </li>
  );
}

function prettyHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

interface ProgressState {
  stage: IngestStage | null;
  ratio: number;
  message: string;
  error?: string;
}

const INITIAL_PROGRESS: ProgressState = {
  stage: null,
  ratio: 0,
  message: '',
};

function progressFromDelta(delta: IngestProgressDelta, prev: ProgressState): ProgressState {
  if (delta.type === 'progress') {
    const stageIdx = STAGE_ORDER.indexOf(delta.stage);
    const base = stageIdx >= 0 ? stageIdx / STAGE_ORDER.length : 0;
    const intra = delta.ratio ?? 0.5;
    const ratio = Math.min(0.99, base + intra / STAGE_ORDER.length);
    return {
      stage: delta.stage,
      ratio,
      message: delta.message ?? STAGE_LABEL[delta.stage],
    };
  }
  if (delta.type === 'error') {
    return { ...prev, error: delta.message, ratio: prev.ratio };
  }
  return { stage: prev.stage, ratio: 1, message: 'Готово' };
}

function ConfirmDialog({
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Отмена',
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop animate-fade-in" onClick={onClose}>
      <div
        className="card-pop w-full max-w-md p-6 animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <button onClick={onClose} className="btn-icon" title="Закрыть">
            <CloseIcon size={14} />
          </button>
        </div>
        <p className="text-xs text-muted leading-relaxed">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`btn text-xs ${
              danger ? '!bg-[#DC2626] !text-white hover:!bg-[#B91C1C]' : 'btn-primary'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}