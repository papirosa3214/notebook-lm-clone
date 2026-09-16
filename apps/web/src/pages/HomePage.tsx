import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../lib/api';
import { useTheme } from '../hooks/useTheme';

export default function HomePage() {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const { theme, toggle } = useTheme();

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
        <div className="flex items-center gap-3">
          <span className="text-2xl" aria-hidden>
            📓
          </span>
          <h1 className="text-2xl font-semibold">Notebooks</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">NotebookLM clone</span>
          <button
            onClick={toggle}
            className="btn btn-ghost text-base"
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
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
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!title.trim() || create.isPending}
        >
          {create.isPending ? '…' : 'Создать'}
        </button>
      </form>

      {create.isError && (
        <p className="mb-4 text-sm text-red-600">{String(create.error)}</p>
      )}

      {notebooks.isLoading && (
        <p className="text-sm text-zinc-500">Загрузка…</p>
      )}

      {notebooks.data && notebooks.data.notebooks.length === 0 && (
        <div className="card-accent p-6 text-center">
          <p className="text-sm font-medium">Пока нет ноутбуков</p>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Создай первый выше и добавь в него источники — здесь появится обзор и чат.
          </p>
        </div>
      )}

      <ul className="grid gap-3">
        {notebooks.data?.notebooks.map((n) => (
          <li
            key={n.id}
            className="card flex items-center justify-between gap-3 p-4 transition-colors hover:border-amber-400"
          >
            <Link to={`/notebooks/${n.id}`} className="flex-1 min-w-0">
              <div className="truncate font-medium">{n.title}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                <span>
                  {(n.readySourceCount ?? 0)}/{n.sourceCount ?? 0} источник
                  {pluralFor((n.sourceCount ?? 0))}
                </span>
                <span className="opacity-50">·</span>
                <span>{n.defaultProvider}</span>
                <span className="opacity-50">·</span>
                <span>создан {new Date(n.createdAt).toLocaleDateString('ru')}</span>
              </div>
            </Link>
            <button
              onClick={() => {
                if (confirm(`Удалить «${n.title}»?`)) remove.mutate(n.id);
              }}
              className="btn btn-ghost text-red-500"
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

function pluralFor(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'ов';
  if (last === 1) return '';
  if (last >= 2 && last <= 4) return 'а';
  return 'ов';
}