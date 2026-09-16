import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../lib/api';

export default function HomePage() {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');

  const notebooks = useQuery({
    queryKey: ['notebooks'],
    queryFn: api.listNotebooks,
  });
  const create = useMutation({
    mutationFn: (t: string) => api.createNotebook(t),
    onSuccess: () => {
      setTitle('');
      qc.invalidateQueries({ queryKey: ['notebooks'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteNotebook(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notebooks'] }),
  });

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Notebooks</h1>
        <span className="text-sm text-zinc-500">NotebookLM clone · MVP</span>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate(title.trim());
        }}
        className="card mb-8 flex gap-2 p-3"
      >
        <input
          className="input flex-1"
          placeholder="Название нового ноутбука…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!title.trim() || create.isPending}>
          {create.isPending ? '…' : 'Создать'}
        </button>
      </form>

      {create.isError && <p className="mb-4 text-sm text-red-600">{String(create.error)}</p>}

      {notebooks.isLoading && <p className="text-sm text-zinc-500">Загрузка…</p>}

      {notebooks.data && notebooks.data.notebooks.length === 0 && (
        <p className="text-sm text-zinc-500">Пока нет ноутбуков. Создай первый выше.</p>
      )}

      <ul className="space-y-2">
        {notebooks.data?.notebooks.map((n) => (
          <li key={n.id} className="card flex items-center justify-between p-4">
            <Link to={`/notebooks/${n.id}`} className="flex-1">
              <div className="font-medium">{n.title}</div>
              <div className="text-xs text-zinc-500">
                {n.defaultProvider} · {n.defaultModel} · создан {new Date(n.createdAt).toLocaleString('ru')}
              </div>
            </Link>
            <button
              onClick={() => {
                if (confirm(`Удалить «${n.title}»?`)) remove.mutate(n.id);
              }}
              className="btn btn-ghost text-red-600"
              title="Удалить ноутбук"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
