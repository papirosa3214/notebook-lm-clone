import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../lib/api';
import { useTheme } from '../hooks/useTheme';
import {
  NotebookLogoMark,
  PlusIcon,
  MoonIcon,
  SunIcon,
  TrashIcon,
} from '../components/icons/NotebookLogo';

export default function HomePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const { theme, toggle } = useTheme();

  const notebooks = useQuery({
    queryKey: ['notebooks'],
    queryFn: api.listNotebooks,
  });
  const create = useMutation({
    mutationFn: (t: string) => api.createNotebook(t),
    onSuccess: (newNotebook) => {
      setTitle('');
      qc.invalidateQueries({ queryKey: ['notebooks'] });
      if (newNotebook?.id) {
        navigate(`/notebooks/${newNotebook.id}`);
      }
    },
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8 md:py-12">
      {/* ---- Top bar ---- */}
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <NotebookLogoMark size={32} />
          <span className="text-[15px] font-medium tracking-tight">
            Notebooks
          </span>
        </div>
        <button
          onClick={toggle}
          className="btn-icon"
          title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        >
          {theme === 'dark' ? <SunIcon size={18} /> : <MoonIcon size={18} />}
        </button>
      </header>

      {/* ---- Hero / create card ---- */}
      <div className="card-pop mb-10 flex flex-col gap-5 p-6 md:flex-row md:items-center md:justify-between md:p-8">
        <div className="max-w-xl">
          <h1 className="mb-1 text-2xl font-semibold tracking-tight md:text-[28px]">
            Создайте новый ноутбук
          </h1>
          <p className="text-sm text-muted">
            Загрузите источники — статьи, видео, PDF — и обсудите их с ассистентом.
            Все ответы со ссылками на оригинал.
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate(title.trim());
          }}
          className="flex w-full items-center gap-2 md:w-auto"
        >
          <input
            className="input md:w-72"
            placeholder="Название ноутбука…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!title.trim() || create.isPending}
          >
            <PlusIcon size={14} />
            Создать
          </button>
        </form>
      </div>

      {create.isError && (
        <p className="mb-4 text-sm text-red-600">{String(create.error)}</p>
      )}

      {/* ---- Notebooks grid ---- */}
      {notebooks.isLoading && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="shimmer h-40 rounded-2xl border"
              style={{ borderColor: 'rgb(var(--nb-border))' }}
            />
          ))}
        </div>
      )}

      {notebooks.data && notebooks.data.notebooks.length === 0 && (
        <div className="empty-card">
          <NotebookLogoMark size={56} />
          <p className="text-sm font-medium">Пока нет ноутбуков</p>
          <p className="max-w-sm text-xs text-muted">
            Создайте первый выше — затем добавьте в него ссылки, PDF или
            YouTube-видео, и обзор появится автоматически.
          </p>
        </div>
      )}

      {notebooks.data && notebooks.data.notebooks.length > 0 && (
        <section>
          <h2 className="section-label mb-3">Все ноутбуки</h2>
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {notebooks.data.notebooks.map((n) => (
              <NotebookCard key={n.id} notebook={n} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

type NotebookSummary = {
  id: string;
  title: string;
  sourceCount?: number;
  readySourceCount?: number;
  defaultProvider?: string;
  createdAt: string;
};

function NotebookCard({ notebook: n }: { notebook: NotebookSummary }) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteNotebook(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notebooks'] }),
  });
  const ready = n.readySourceCount ?? 0;
  const total = n.sourceCount ?? 0;
  const pct = total > 0 ? Math.round((ready / total) * 100) : 0;

  return (
    <li className="card group relative flex flex-col gap-3 p-5 transition-all hover:-translate-y-0.5 hover:shadow-pop">
      <div className="flex items-start justify-between gap-3">
        <Link
          to={`/notebooks/${n.id}`}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl"
          style={{ backgroundColor: 'rgb(var(--nb-accent-soft))' }}
          aria-hidden
        >
          <NotebookLogoMark size={28} />
        </Link>
        <button
          onClick={(e) => {
            e.preventDefault();
            if (confirm(`Удалить «${n.title}»?`)) remove.mutate(n.id);
          }}
          className="btn-icon opacity-0 transition-opacity group-hover:opacity-100"
          title="Удалить ноутбук"
        >
          <TrashIcon size={15} />
        </button>
      </div>
      <Link to={`/notebooks/${n.id}`} className="block">
        <h3 className="line-clamp-2 text-[17px] font-semibold leading-snug">
          {n.title}
        </h3>
      </Link>
      <div className="mt-1 space-y-2">
        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            {total === 0
              ? 'Нет источников'
              : `${ready} из ${total} готовы`}
          </span>
          {total > 0 && <span className="font-medium">{pct}%</span>}
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full"
          style={{ backgroundColor: 'rgb(var(--nb-surface-tint))' }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${pct}%`,
              backgroundColor:
                pct === 100
                  ? 'rgb(var(--nb-success))'
                  : 'rgb(var(--nb-accent))',
            }}
          />
        </div>
        <div className="flex items-center justify-between pt-1 text-[11px] text-subtle">
          <span className="capitalize">{n.defaultProvider ?? 'ollama'}</span>
          <span>{new Date(n.createdAt).toLocaleDateString('ru')}</span>
        </div>
      </div>
    </li>
  );
}