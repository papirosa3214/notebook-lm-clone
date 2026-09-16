import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import type { Source } from '../lib/types';

interface Props {
  notebookId: string;
}

export function SourcesPanel({ notebookId }: Props) {
  const qc = useQueryClient();
  const sources = useQuery({
    queryKey: ['sources', notebookId],
    queryFn: () => api.listSources(notebookId),
    refetchInterval: (q) => {
      const items = q.state.data?.sources ?? [];
      return items.some((s) => s.status === 'pending' || s.status === 'parsing') ? 3000 : false;
    },
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Источники</h2>
        <div className="flex gap-1">
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending} className="btn btn-ghost text-xs" title="Обновить статусы">
            ↻
          </button>
        </div>
      </div>
      <div className="flex gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <button className="btn btn-secondary text-xs" onClick={() => setShowAddUrl(true)}>+ URL</button>
        <button className="btn btn-secondary text-xs" onClick={() => setShowAddYt(true)}>+ YouTube</button>
        <button className="btn btn-secondary text-xs" onClick={() => setShowAddFile(true)}>+ Файл</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {sources.isLoading && <p className="text-sm text-zinc-500">Загрузка…</p>}
        {sources.data && sources.data.sources.length === 0 && (
          <p className="text-sm text-zinc-500">Нет источников. Добавь URL, YouTube или файл.</p>
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
    </div>
  );
}

function SourceItem({ source: s, onDelete }: { source: Source; onDelete: () => void }) {
  const statusBadge = {
    pending: { text: '⏳', cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' },
    parsing: { text: '⚙ парсинг', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
    ready: { text: '✓ готово', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' },
    failed: { text: '✗ ошибка', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  }[s.status];
  return (
    <li className="card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={s.title}>{s.title}</div>
          {s.url && <div className="truncate text-xs text-zinc-500" title={s.url}>{s.url}</div>}
          <div className="mt-1 flex items-center gap-2">
            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${statusBadge.cls}`}>{statusBadge.text}</span>
            <span className="text-[10px] text-zinc-400">{s.kind}</span>
          </div>
          {s.error && <div className="mt-1 truncate text-[10px] text-red-600" title={s.error}>{s.error}</div>}
        </div>
        <button onClick={onDelete} className="btn btn-ghost text-xs text-red-500" title="Удалить">×</button>
      </div>
    </li>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="btn btn-ghost">×</button>
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
          <input className="input mt-1" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </div>
        <div>
          <label className="text-xs text-zinc-500">Название (опционально)</label>
          <input className="input mt-1" placeholder="RAG Wikipedia" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        {add.isError && <p className="text-xs text-red-600">{String(add.error)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-secondary">Отмена</button>
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
          <input className="input mt-1" placeholder="https://youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </div>
        <div>
          <label className="text-xs text-zinc-500">Название (опционально)</label>
          <input className="input mt-1" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        {add.isError && <p className="text-xs text-red-600">{String(add.error)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-secondary">Отмена</button>
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
        {file && <p className="text-xs text-zinc-500">{file.name} ({Math.round(file.size / 1024)} KB)</p>}
        {upload.isError && <p className="text-xs text-red-600">{String(upload.error)}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-secondary">Отмена</button>
          <button onClick={() => upload.mutate()} className="btn btn-primary" disabled={!file || upload.isPending}>
            {upload.isPending ? 'Загружаю…' : 'Загрузить'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
