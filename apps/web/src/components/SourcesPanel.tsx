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
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Источники</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">
            {readyCount}/{totalCount}
          </span>
          <button
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="btn btn-ghost text-xs"
            title="Обновить список"
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
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>{progress.error ? '✗ ошибка' : progress.message || 'Готовлюсь…'}</span>
        {!progress.error && <span>{Math.round(progress.ratio * 100)}%</span>}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className={`h-full transition-all duration-300 ${
            progress.error ? 'bg-red-500' : 'bg-amber-500'
          }`}
          style={{ width: `${Math.round(progress.ratio * 100)}%` }}
        />
      </div>
      <ol className="space-y-1 text-xs">
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
                    ? 'font-medium text-amber-700 dark:text-amber-300'
                    : 'text-zinc-400'
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
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">
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
      <p className="text-sm text-zinc-600 dark:text-zinc-300">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="btn btn-secondary">
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={danger ? 'btn bg-red-600 text-white hover:bg-red-700' : 'btn btn-primary'}
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
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Отмена
            </button>
            <button type="submit" className="btn btn-primary" disabled={!url}>
              Добавить
            </button>
          </div>
        </form>
      )}
      {(running || progress.error) && <ProgressStepper progress={progress} />}
      {progress.error && (
        <div className="mt-3 flex justify-end">
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
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Отмена
            </button>
            <button type="submit" className="btn btn-primary" disabled={!url}>
              Добавить
            </button>
          </div>
        </form>
      )}
      {(running || progress.error) && <ProgressStepper progress={progress} />}
      {progress.error && (
        <div className="mt-3 flex justify-end">
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
    <Dialog title="🔍 Discover — найти источники в интернете" onClose={onClose}>
      {stepName === 'query' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) previewMutation.mutate();
          }}
          className="space-y-3"
        >
          <div>
            <label className="text-xs text-zinc-500">Тема (DuckDuckGo, без ключей)</label>
            <input
              className="input mt-1"
              placeholder="например: retrieval augmented generation"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
              required
            />
          </div>
          {previewMutation.isError && (
            <p className="text-xs text-red-600">
              {(previewMutation.error as Error).message}
            </p>
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
            <div className="text-xs text-zinc-500">
              Найдено {results.length} результатов · выбрано {selected.size}
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