import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { SearchPreviewResult, Source, SourceKind } from '../lib/types';

interface Props {
  notebookId: string;
}

const KIND_LABEL: Record<SourceKind, string> = {
  url: 'URL',
  file: 'Файл',
  youtube: 'YouTube',
};
const KIND_GLYPH: Record<SourceKind, string> = {
  url: '↗',
  file: '📄',
  youtube: '▶',
};

/** Stop auto-polling after this long — anything still pending/parsing past this
 *  point is probably stuck in Ragflow and needs the user to look at it. */
const AUTO_REFRESH_TIMEOUT_MS = 10 * 60 * 1000;
const AUTO_REFRESH_INTERVAL_MS = 5_000;

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

  // Auto-poll Ragflow and update SQLite while anything is still pending/parsing.
  // Without this, the GET /sources polling never sees the transition from
  // parsing → ready: Ragflow has the chunks, but our SQLite mirror only updates
  // when POST /sources/refresh runs (the ↻ button).
  const items = sources.data?.sources ?? [];
  const hasInFlight = items.some((s) => s.status === 'pending' || s.status === 'parsing');
  const oldestInFlight = items
    .filter((s) => s.status === 'pending' || s.status === 'parsing')
    .map((s) => +new Date(s.createdAt))
    .reduce((min, t) => (min === 0 || t < min ? t : min), 0);
  const inFlightTooLong = oldestInFlight > 0 && Date.now() - oldestInFlight > AUTO_REFRESH_TIMEOUT_MS;

  useEffect(() => {
    if (!hasInFlight || inFlightTooLong) return;
    const id = setInterval(() => {
      if (!refresh.isPending) refresh.mutate();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
    // refresh identity is stable via useMutation; only re-arm when the set of
    // pending items changes (not on every poll tick).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasInFlight, inFlightTooLong, notebookId]);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources', notebookId] }),
  });

  const [showAddUrl, setShowAddUrl] = useState(false);
  const [showAddYt, setShowAddYt] = useState(false);
  const [showAddFile, setShowAddFile] = useState(false);
  const [showAddSearch, setShowAddSearch] = useState(false);

  const readyCount = sources.data?.sources.filter((s) => s.status === 'ready').length ?? 0;
  const totalCount = sources.data?.sources.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Источники</h2>
        <div className="flex items-center gap-2">
          {hasInFlight && !inFlightTooLong && (
            <span
              className="chip-indigo animate-pulse"
              title="Автоматически опрашиваем Ragflow — статусы обновятся сами"
            >
              ⟳ авто
            </span>
          )}
          {inFlightTooLong && (
            <span
              className="inline-flex items-center rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              title="Ragflow не отвечает дольше 10 минут — нажмите ↻ чтобы форсировать"
            >
              ⚠ зависло
            </span>
          )}
          <span className="text-xs text-zinc-500">
            {readyCount}/{totalCount}
          </span>
          <button
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="btn btn-ghost text-xs"
            title="Обновить статусы из Ragflow"
          >
            ↻
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <button className="btn btn-secondary text-xs" onClick={() => setShowAddUrl(true)}>
          + URL
        </button>
        <button className="btn btn-secondary text-xs" onClick={() => setShowAddYt(true)}>
          + YouTube
        </button>
        <button className="btn btn-secondary text-xs" onClick={() => setShowAddFile(true)}>
          + Файл
        </button>
        <button
          className="btn btn-primary text-xs"
          onClick={() => setShowAddSearch(true)}
          title="Найти источники в интернете"
        >
          🔍 Discover
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {sources.isLoading && <p className="text-sm text-zinc-500">Загрузка…</p>}
        {sources.data && sources.data.sources.length === 0 && (
          <EmptyState onDiscover={() => setShowAddSearch(true)} />
        )}
        <ul className="space-y-2">
          {sources.data?.sources.map((s) => (
            <SourceItem key={s.id} source={s} onDelete={() => remove.mutate(s.id)} />
          ))}
        </ul>
      </div>

      {showAddUrl && <AddUrlDialog notebookId={notebookId} onClose={() => setShowAddUrl(false)} />}
      {showAddYt && <AddYoutubeDialog notebookId={notebookId} onClose={() => setShowAddYt(false)} />}
      {showAddFile && <AddFileDialog notebookId={notebookId} onClose={() => setShowAddFile(false)} />}
      {showAddSearch && (
        <DiscoverDialog notebookId={notebookId} onClose={() => setShowAddSearch(false)} />
      )}
    </div>
  );
}

function EmptyState({ onDiscover }: { onDiscover: () => void }) {
  return (
    <div className="card-accent mb-3 p-4">
      <p className="text-sm font-medium">Пока нет источников</p>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        Добавьте URL, YouTube-видео или файл. Или попросите NotebookLM найти источники по теме.
      </p>
      <button className="btn btn-primary mt-3 text-xs" onClick={onDiscover}>
        🔍 Найти в интернете
      </button>
    </div>
  );
}

function SourceItem({ source: s, onDelete }: { source: Source; onDelete: () => void }) {
  const statusBadge = {
    pending: { text: '⏳', cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' },
    parsing: {
      text: '⚙ парсинг',
      cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    },
    ready: {
      text: '✓ готово',
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    },
    failed: { text: '✗ ошибка', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  }[s.status];
  return (
    <li className="card p-3 transition-colors hover:border-amber-300 dark:hover:border-amber-700/50">
      <div className="flex items-start gap-2">
        <span className="kind-pill mt-0.5" title={KIND_LABEL[s.kind]}>
          {KIND_GLYPH[s.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={s.title}>
            {s.title}
          </div>
          {s.url && (
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer noopener"
              className="block truncate text-xs text-zinc-500 hover:text-amber-700 hover:underline"
              title={s.url}
            >
              {new URL(s.url).hostname}
            </a>
          )}
          <div className="mt-1 flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ${statusBadge.cls}`}
            >
              {statusBadge.text}
            </span>
            <span className="text-[10px] text-zinc-400">{KIND_LABEL[s.kind]}</span>
          </div>
          {s.error && (
            <div className="mt-1 truncate text-[10px] text-red-600" title={s.error}>
              {s.error}
            </div>
          )}
        </div>
        <button
          onClick={onDelete}
          className="btn btn-ghost text-xs text-red-500"
          title="Удалить"
        >
          ×
        </button>
      </div>
    </li>
  );
}

/**
 * NotebookLM-style Discover: two steps.
 *   1. Preview — web search returns candidate URLs, user picks which to ingest.
 *   2. Batch add — only the selected URLs are fetched and uploaded to Ragflow.
 */
function DiscoverDialog({ notebookId, onClose }: { notebookId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [stepName, setStepName] = useState<'query' | 'preview'>('query');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchPreviewResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const preview = useMutation({
    mutationFn: () => api.searchPreview(notebookId, query, 8),
    onSuccess: (data) => {
      setResults(data.results);
      setSelected(new Set(data.results.slice(0, 3).map((r) => r.url)));
      setStepName('preview');
    },
  });

  const addBatch = useMutation({
    mutationFn: () => api.searchAddBatch(notebookId, Array.from(selected)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sources', notebookId] });
      onClose();
    },
  });

  function toggle(url: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }
  function selectAll() {
    setSelected(new Set(results.map((r) => r.url)));
  }
  function selectNone() {
    setSelected(new Set());
  }

  return (
    <Dialog title="🔍 Discover — найти источники в интернете" onClose={onClose}>
      {stepName === 'query' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) preview.mutate();
          }}
          className="space-y-3"
        >
          <div>
            <label className="text-xs text-zinc-500">Тема (DuckDuckGo, без ключей)</label>
            <input
              className="input mt-1"
              placeholder="например: retrieval augmented generation для юристов"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              required
            />
          </div>
          {preview.isError && (
            <p className="text-xs text-red-600">{(preview.error as Error).message}</p>
          )}
          <p className="text-xs text-zinc-500">
            На втором шаге можно отметить, какие результаты загружать в ноутбук.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Отмена
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!query.trim() || preview.isPending}
            >
              {preview.isPending ? 'Ищу…' : 'Найти'}
            </button>
          </div>
        </form>
      )}

      {stepName === 'preview' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-zinc-500">
              Найдено {results.length} результатов · выбрано {selected.size}
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={selectAll}
                className="btn btn-ghost text-xs"
              >
                Все
              </button>
              <button
                type="button"
                onClick={selectNone}
                className="btn btn-ghost text-xs"
              >
                Снять
              </button>
            </div>
          </div>

          <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {results.map((r) => (
              <li key={r.url}>
                <label className="card flex cursor-pointer gap-2 p-2 transition-colors hover:border-amber-400 has-[:checked]:border-amber-500 has-[:checked]:bg-amber-50 dark:has-[:checked]:bg-amber-900/10">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-amber-600"
                    checked={selected.has(r.url)}
                    onChange={() => toggle(r.url)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={r.title}>
                      {r.title}
                    </div>
                    <div className="truncate text-xs text-zinc-500" title={r.url}>
                      {new URL(r.url).hostname}
                    </div>
                    {r.snippet && (
                      <div className="mt-1 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                        {r.snippet}
                      </div>
                    )}
                  </div>
                </label>
              </li>
            ))}
          </ul>

          {addBatch.isError && (
            <p className="text-xs text-red-600">{(addBatch.error as Error).message}</p>
          )}
          <p className="text-xs text-zinc-500">
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
                onClick={() => addBatch.mutate()}
                disabled={selected.size === 0 || addBatch.isPending}
                className="btn btn-primary"
              >
                {addBatch.isPending ? 'Загружаю…' : `Добавить ${selected.size}`}
              </button>
            </div>
          </div>
        </div>
      )}
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-5 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="btn btn-ghost">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddUrlDialog({ notebookId, onClose }: { notebookId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const add = useMutation({
    mutationFn: () => api.addUrlSource(notebookId, url, title || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sources', notebookId] });
      onClose();
    },
  });
  return (
    <Dialog title="Добавить URL" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url) add.mutate();
        }}
        className="space-y-3"
      >
        <div>
          <label className="text-xs text-zinc-500">URL</label>
          <input
            className="input mt-1"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="text-xs text-zinc-500">Название (опционально)</label>
          <input
            className="input mt-1"
            placeholder="RAG Wikipedia"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        {add.isError && <p className="text-xs text-red-600">{String(add.error)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={!url || add.isPending}>
            {add.isPending ? 'Добавляю…' : 'Добавить'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AddYoutubeDialog({ notebookId, onClose }: { notebookId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const add = useMutation({
    mutationFn: () => api.addYoutubeSource(notebookId, url, title || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sources', notebookId] });
      onClose();
    },
  });
  return (
    <Dialog title="Добавить YouTube" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url) add.mutate();
        }}
        className="space-y-3"
      >
        <div>
          <label className="text-xs text-zinc-500">URL или ID видео</label>
          <input
            className="input mt-1"
            placeholder="https://youtube.com/watch?v=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="text-xs text-zinc-500">Название (опционально)</label>
          <input
            className="input mt-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        {add.isError && <p className="text-xs text-red-600">{String(add.error)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={!url || add.isPending}>
            {add.isPending ? 'Добавляю…' : 'Добавить'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

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
          <p className="text-xs text-zinc-500">
            {file.name} ({Math.round(file.size / 1024)} KB)
          </p>
        )}
        {upload.isError && <p className="text-xs text-red-600">{String(upload.error)}</p>}
        <div className="flex justify-end gap-2">
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