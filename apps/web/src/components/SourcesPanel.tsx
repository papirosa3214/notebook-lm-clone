import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import type {
  IngestProgressDelta,
  IngestStage,
  SearchPreviewResult,
  Source,
  SourceKind,
} from '../lib/types';
import {
  SourceIcon,
  PlusIcon,
  SearchIcon,
  RefreshIcon,
  CloseIcon,
  TrashIcon,
  SparkleIcon,
  ChevronDownIcon,
} from './icons/NotebookLogo';

interface Props {
  notebookId: string;
}

const KIND_LABEL: Record<SourceKind, string> = {
  url: 'URL',
  file: 'Файл',
  youtube: 'YouTube',
};

const STAGE_LABEL: Record<IngestStage, string> = {
  fetching: 'Загружаю страницу',
  extracting: 'Извлекаю текст',
  chunking: 'Разбиваю на чанки',
  embedding: 'Создаю embeddings',
  storing: 'Сохраняю',
};

const STAGE_ORDER: IngestStage[] = [
  'fetching',
  'extracting',
  'chunking',
  'embedding',
  'storing',
];

export function SourcesPanel({ notebookId }: Props) {
  const qc = useQueryClient();
  const sources = useQuery({
    queryKey: ['sources', notebookId],
    queryFn: () => api.listSources(notebookId),
  });

  const refresh = useMutation({
    mutationFn: () => api.refreshSources(notebookId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources', notebookId] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources', notebookId] }),
  });

  const [showAddUrl, setShowAddUrl] = useState(false);
  const [showAddYt, setShowAddYt] = useState(false);
  const [showAddFile, setShowAddFile] = useState(false);
  const [showAddSearch, setShowAddSearch] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Source | null>(null);

  const readyCount = sources.data?.sources.filter((s) => s.status === 'ready').length ?? 0;
  const totalCount = sources.data?.sources.length ?? 0;

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-[13px] font-semibold tracking-tight text-ink">
          Источники
          {totalCount > 0 && (
            <span className="ml-1.5 text-xs font-normal text-muted">
              {readyCount}/{totalCount}
            </span>
          )}
        </h2>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="btn-icon"
          title="Обновить список"
        >
          <RefreshIcon size={14} className={refresh.isPending ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Add source — 4 circular buttons in a row, like NotebookLM */}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <AddCircle label="URL" onClick={() => setShowAddUrl(true)} kind="url" />
        <AddCircle label="YouTube" onClick={() => setShowAddYt(true)} kind="youtube" />
        <AddCircle label="Файл" onClick={() => setShowAddFile(true)} kind="file" />
        <AddCircle
          label="Discover"
          onClick={() => setShowAddSearch(true)}
          kind="discover"
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
          <EmptyState onDiscover={() => setShowAddSearch(true)} />
        )}
        <ul className="space-y-2">
          {sources.data?.sources.map((s) => (
            <SourceItem key={s.id} source={s} onDelete={() => setPendingDelete(s)} />
          ))}
        </ul>
      </div>

      {showAddUrl && <AddUrlDialog notebookId={notebookId} onClose={() => setShowAddUrl(false)} />}
      {showAddYt && <AddYoutubeDialog notebookId={notebookId} onClose={() => setShowAddYt(false)} />}
      {showAddFile && <AddFileDialog notebookId={notebookId} onClose={() => setShowAddFile(false)} />}
      {showAddSearch && (
        <DiscoverDialog notebookId={notebookId} onClose={() => setShowAddSearch(false)} />
      )}
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
    </div>
  );
}

function AddCircle({
  label,
  onClick,
  kind,
}: {
  label: string;
  onClick: () => void;
  kind: SourceKind | 'discover';
}) {
  const isDiscover = kind === 'discover';
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-1.5 rounded-full border bg-surface py-1.5 pl-1.5 pr-3.5 text-xs font-medium transition-all hover:-translate-y-0.5 hover:shadow-soft"
      style={{
        borderColor: 'rgb(var(--nb-border))',
        color: 'rgb(var(--nb-ink))',
      }}
      title={`Добавить ${label.toLowerCase()}`}
    >
      <span
        className="flex h-6 w-6 items-center justify-center rounded-full text-white"
        style={{
          backgroundColor: isDiscover ? 'rgb(var(--nb-ai-glow))' : 'rgb(var(--nb-accent))',
        }}
      >
        {isDiscover ? (
          <SparkleIcon size={11} />
        ) : (
          <SourceIcon kind={kind as SourceKind} size={12} />
        )}
      </span>
      <span className="leading-none">{label}</span>
    </button>
  );
}

function EmptyState({ onDiscover }: { onDiscover: () => void }) {
  return (
    <div className="empty-card mt-2">
      <span className="text-3xl" aria-hidden>
        📚
      </span>
      <p className="text-sm font-medium">Пока нет источников</p>
      <p className="max-w-xs text-xs text-muted">
        Добавьте URL, YouTube-видео или файл. Или попросите Notebook найти источники по теме.
      </p>
      <button className="btn btn-primary mt-2 text-xs" onClick={onDiscover}>
        <SearchIcon size={12} />
        Discover
      </button>
    </div>
  );
}

function SourceItem({ source: s, onDelete }: { source: Source; onDelete: () => void }) {
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
    failed: { text: 'ошибка', cls: 'bg-[#FEE2E2] text-[#991B1B] dark:bg-[#7F1D1D]/40 dark:text-[#FCA5A5]' },
  }[s.status];
  return (
    <li className="source-pill group">
      <span className="kind-pill" title={KIND_LABEL[s.kind]}>
        <SourceIcon kind={s.kind} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={s.title}>
          {s.title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusBadge.cls}`}
          >
            {statusBadge.text}
          </span>
          {s.url && (
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate text-[10px] text-muted hover:text-accent hover:underline"
              title={s.url}
            >
              {prettyHost(s.url)}
            </a>
          )}
        </div>
        {s.error && (
          <div className="mt-1 truncate text-[10px] text-red-600" title={s.error}>
            {s.error}
          </div>
        )}
      </div>
      <button
        onClick={onDelete}
        className="btn-icon opacity-0 transition-opacity group-hover:opacity-100"
        title="Удалить источник"
        style={{ color: 'rgb(var(--nb-muted))' }}
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

// ============================================================
// ProgressStepper — shared UI for live ingest progress
// ============================================================

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

function ProgressStepper({ progress }: { progress: ProgressState }) {
  const currentIndex = progress.stage
    ? STAGE_ORDER.indexOf(progress.stage)
    : -1;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{progress.error ? '✗ ошибка' : progress.message || 'Готовлюсь…'}</span>
        {!progress.error && <span className="font-semibold">{Math.round(progress.ratio * 100)}%</span>}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-tint">
        <div
          className={`h-full transition-all duration-300 ${
            progress.error ? 'bg-red-500' : ''
          }`}
          style={{
            width: `${Math.round(progress.ratio * 100)}%`,
            backgroundColor: progress.error ? undefined : 'rgb(var(--nb-accent))',
          }}
        />
      </div>
      <ol className="space-y-1.5 text-xs">
        {STAGE_ORDER.map((stage, i) => {
          const done = currentIndex > i || progress.ratio >= 1;
          const active = currentIndex === i && !progress.error;
          return (
            <li
              key={stage}
              className={`flex items-center gap-2 ${
                done
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : active
                    ? 'font-medium text-accent'
                    : 'text-subtle'
              }`}
            >
              <span className="w-4 text-center">
                {done ? '✓' : active ? '●' : '○'}
              </span>
              <span>{STAGE_LABEL[stage]}</span>
            </li>
          );
        })}
      </ol>
      {progress.error && (
        <p className="rounded-xl border bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300"
          style={{ borderColor: 'rgb(252 165 165 / 0.5)' }}>
          {progress.error}
        </p>
      )}
    </div>
  );
}

function progressFromDelta(delta: IngestProgressDelta, prev: ProgressState): ProgressState {
  if (delta.type === 'progress') {
    const stageIdx = STAGE_ORDER.indexOf(delta.stage);
    const base = stageIdx >= 0 ? stageIdx / STAGE_ORDER.length : 0;
    const intra = delta.ratio ?? 0.5;
    const ratio = Math.min(0.99, base + (intra / STAGE_ORDER.length));
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

// ============================================================
// Confirm dialog (generic)
// ============================================================

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
    <Dialog title={title} onClose={onClose}>
      <p className="text-sm text-muted">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="btn btn-secondary">
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={danger ? 'btn !bg-[#DC2626] !text-white hover:!bg-[#B91C1C]' : 'btn btn-primary'}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

// ============================================================
// Add URL — streams progress
// ============================================================

function AddUrlDialog({ notebookId, onClose }: { notebookId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);
  const [running, setRunning] = useState(false);

  function start() {
    if (!url || running) return;
    setRunning(true);
    setProgress(INITIAL_PROGRESS);
    const stream = api.ingestUrlSourceStream(
      notebookId,
      { url, title: title || undefined },
      (delta) => setProgress((prev) => progressFromDelta(delta, prev)),
    );
    stream.promise
      .then(() => {
        qc.invalidateQueries({ queryKey: ['sources', notebookId] });
        onClose();
      })
      .catch((err: Error) => setProgress((p) => ({ ...p, error: err.message })))
      .finally(() => setRunning(false));
  }

  return (
    <Dialog title="Добавить URL" onClose={onClose}>
      {!running && progress.error === undefined && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
          className="space-y-3"
        >
          <div>
            <label className="section-label mb-1.5 block">URL</label>
            <input
              className="input"
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div>
            <label className="section-label mb-1.5 block">Название (опционально)</label>
            <input
              className="input"
              placeholder="Например: RAG Wikipedia"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Отмена
            </button>
            <button type="submit" className="btn btn-primary" disabled={!url}>
              <PlusIcon size={13} />
              Добавить
            </button>
          </div>
        </form>
      )}
      {(running || progress.error) && <ProgressStepper progress={progress} />}
      {progress.error && (
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Закрыть
          </button>
        </div>
      )}
    </Dialog>
  );
}

// ============================================================
// Add YouTube — streams progress
// ============================================================

function AddYoutubeDialog({ notebookId, onClose }: { notebookId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);
  const [running, setRunning] = useState(false);

  function start() {
    if (!url || running) return;
    setRunning(true);
    setProgress(INITIAL_PROGRESS);
    const stream = api.ingestYoutubeSourceStream(
      notebookId,
      { url, title: title || undefined },
      (delta) => setProgress((prev) => progressFromDelta(delta, prev)),
    );
    stream.promise
      .then(() => {
        qc.invalidateQueries({ queryKey: ['sources', notebookId] });
        onClose();
      })
      .catch((err: Error) => setProgress((p) => ({ ...p, error: err.message })))
      .finally(() => setRunning(false));
  }

  return (
    <Dialog title="Добавить YouTube" onClose={onClose}>
      {!running && !progress.error && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
          className="space-y-3"
        >
          <div>
            <label className="section-label mb-1.5 block">URL или ID видео</label>
            <input
              className="input"
              placeholder="https://youtube.com/watch?v=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div>
            <label className="section-label mb-1.5 block">Название (опционально)</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Отмена
            </button>
            <button type="submit" className="btn btn-primary" disabled={!url}>
              <PlusIcon size={13} />
              Добавить
            </button>
          </div>
        </form>
      )}
      {(running || progress.error) && <ProgressStepper progress={progress} />}
      {progress.error && (
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Закрыть
          </button>
        </div>
      )}
    </Dialog>
  );
}

// ============================================================
// Discover — streams progress per URL
// ============================================================

function DiscoverDialog({ notebookId, onClose }: { notebookId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [stepName, setStepName] = useState<'query' | 'preview' | 'ingest'>('query');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchPreviewResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);

  const previewMutation = useMutation({
    mutationFn: () => api.searchPreview(notebookId, query, 8),
    onSuccess: (data) => {
      setResults(data.results);
      setSelected(new Set(data.results.slice(0, 3).map((r) => r.url)));
      setStepName('preview');
    },
  });

  function startIngest() {
    if (selected.size === 0) return;
    setStepName('ingest');
    setProgress(INITIAL_PROGRESS);
    const stream = api.ingestSearchAddBatchStream(
      notebookId,
      { urls: Array.from(selected) },
      (delta) => setProgress((prev) => progressFromDelta(delta, prev)),
    );
    stream.promise
      .then(() => {
        qc.invalidateQueries({ queryKey: ['sources', notebookId] });
        onClose();
      })
      .catch((err: Error) => setProgress((p) => ({ ...p, error: err.message })));
  }

  function toggle(url: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  return (
    <Dialog title="Discover — найти источники" onClose={onClose}>
      {stepName === 'query' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) previewMutation.mutate();
          }}
          className="space-y-3"
        >
          <div>
            <label className="section-label mb-1.5 block">Тема</label>
            <input
              className="input"
              placeholder="например: retrieval augmented generation"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              required
            />
            <p className="mt-1.5 text-xs text-subtle">
              Поиск через DuckDuckGo, без ключей. На втором шаге можно выбрать результаты.
            </p>
          </div>
          {previewMutation.isError && (
            <p className="text-xs text-red-600">
              {(previewMutation.error as Error).message}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Отмена
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!query.trim() || previewMutation.isPending}
            >
              {previewMutation.isPending ? 'Ищу…' : 'Найти'}
            </button>
          </div>
        </form>
      )}

      {stepName === 'preview' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted">
              Найдено {results.length} · выбрано {selected.size}
            </div>
            <div className="flex gap-1">
              <button type="button" onClick={() => setSelected(new Set(results.map((r) => r.url)))} className="btn btn-ghost text-xs">
                Все
              </button>
              <button type="button" onClick={() => setSelected(new Set())} className="btn btn-ghost text-xs">
                Снять
              </button>
            </div>
          </div>

          <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {results.map((r) => (
              <li key={r.url}>
                <label
                  className={`flex cursor-pointer gap-3 rounded-2xl border bg-surface p-3 transition-all ${
                    selected.has(r.url) ? 'border-accent bg-accent-soft/40' : ''
                  }`}
                  style={{
                    borderColor: selected.has(r.url)
                      ? 'rgb(var(--nb-accent))'
                      : 'rgb(var(--nb-border))',
                  }}
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0"
                    style={{ accentColor: 'rgb(var(--nb-accent))' }}
                    checked={selected.has(r.url)}
                    onChange={() => toggle(r.url)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={r.title}>
                      {r.title}
                    </div>
                    <div className="truncate text-xs text-muted" title={r.url}>
                      {prettyHost(r.url)}
                    </div>
                    {r.snippet && (
                      <div className="mt-1 line-clamp-2 text-xs text-muted">
                        {r.snippet}
                      </div>
                    )}
                  </div>
                </label>
              </li>
            ))}
          </ul>

          <p className="text-xs text-muted">
            Будет загружено {selected.size} источник{russianPlural(selected.size)}. Это займёт
            ~{selected.size * 4} сек.
          </p>
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setStepName('query');
                setResults([]);
                setSelected(new Set());
              }}
              className="btn btn-secondary"
            >
              ← Назад
            </button>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="btn btn-secondary">
                Отмена
              </button>
              <button
                type="button"
                onClick={startIngest}
                disabled={selected.size === 0}
                className="btn btn-primary"
              >
                Добавить {selected.size}
              </button>
            </div>
          </div>
        </div>
      )}

      {stepName === 'ingest' && (
        <div className="space-y-3">
          <ProgressStepper progress={progress} />
          {progress.error && (
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="btn btn-secondary">
                Закрыть
              </button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ============================================================
// Add file — multipart doesn't stream; show a flat spinner
// ============================================================

function AddFileDialog({ notebookId, onClose }: { notebookId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('no file');
      return api.uploadFileSource(notebookId, file);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sources', notebookId] });
      onClose();
    },
  });
  return (
    <Dialog title="Загрузить файл" onClose={onClose}>
      <div className="space-y-3">
        <input
          type="file"
          accept=".pdf,.docx,.txt,.md,.markdown,.text"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm"
        />
        {file && (
          <p className="text-xs text-muted">
            {file.name} ({Math.round(file.size / 1024)} KB)
          </p>
        )}
        {upload.isError && <p className="text-xs text-red-600">{String(upload.error)}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn btn-secondary">
            Отмена
          </button>
          <button
            onClick={() => upload.mutate()}
            className="btn btn-primary"
            disabled={!file || upload.isPending}
          >
            {upload.isPending ? 'Загружаю…' : 'Загрузить'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function russianPlural(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'ов';
  if (last === 1) return '';
  if (last >= 2 && last <= 4) return 'а';
  return 'ов';
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop animate-fade-in" onClick={onClose}>
      <div
        className="card-pop w-full max-w-lg p-6 animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="btn-icon" title="Закрыть">
            <CloseIcon size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}