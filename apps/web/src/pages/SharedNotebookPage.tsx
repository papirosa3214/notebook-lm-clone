import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { fetchSharedNotebook } from '../lib/api';
import type { SharedNotebook, SharedSource, SharedArtifact } from '@notebook/shared';

/**
 * Public read-only view of a notebook, served at /shared/:token.
 *
 * The page deliberately doesn't reuse NotebookPage: the public
 * snapshot has a different shape (no chat, no source-scope, no
 * Audio/Studio buttons, no add-source). Showing the full editor
 * would leak the share token's privilege into the URL bar.
 */
export default function SharedNotebookPage() {
  const { token } = useParams<{ token: string }>();
  const q = useQuery({
    queryKey: ['shared', token],
    queryFn: () => fetchSharedNotebook(token!),
    enabled: !!token,
    retry: false,
  });

  if (q.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-muted">
        Загружаю ноутбук…
      </div>
    );
  }

  if (q.error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <div className="max-w-md rounded-2xl border bg-surface p-6 text-center shadow-soft"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
        >
          <h1 className="text-lg font-semibold">Ссылка не работает</h1>
          <p className="mt-2 text-sm text-muted">
            Возможно, владелец закрыл доступ или ссылка повреждена.
          </p>
          <Link to="/" className="mt-4 inline-block text-sm text-accent hover:underline">
            На главную
          </Link>
        </div>
      </div>
    );
  }

  const snap = q.data as SharedNotebook;
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b bg-surface"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
      >
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-4 min-[640px]:px-6">
          <div>
            <h1 className="truncate text-xl font-semibold tracking-tight">{snap.title}</h1>
            <p className="mt-0.5 text-xs text-muted">
              Read-only публичная копия · создано {formatDate(snap.createdAt)}
            </p>
          </div>
          <span className="rounded-full bg-surface-tint px-2.5 py-1 text-[11px] font-medium text-muted">
            Shared · view only
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 min-[640px]:px-6">
        <SourcesSection sources={snap.sources} />
        <ArtifactsSection artifacts={snap.artifacts} />
        <footer className="pt-4 text-center text-xs text-muted">
          <Link to="/" className="hover:underline">
            Создать свой ноутбук →
          </Link>
        </footer>
      </main>
    </div>
  );
}

function SourcesSection({ sources }: { sources: SharedSource[] }) {
  if (sources.length === 0) {
    return (
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          Источники
        </h2>
        <p className="text-sm text-muted">В этом ноутбуке пока нет источников.</p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
        Источники ({sources.length})
      </h2>
      <ul className="space-y-2">
        {sources.map((s) => (
          <li
            key={s.id}
            className="rounded-2xl border bg-surface p-4"
            style={{ borderColor: 'rgb(var(--nb-border))' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-surface-tint px-2 py-0.5 text-[10px] font-semibold uppercase text-muted">
                    {labelForKind(s.kind)}
                  </span>
                  <span className="text-[11px] text-muted">
                    {s.status === 'ready' ? 'готов' : s.status}
                  </span>
                </div>
                <h3 className="mt-1 truncate text-sm font-semibold">{s.title}</h3>
                {s.url && (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-0.5 block truncate text-xs text-accent hover:underline"
                  >
                    {s.url}
                  </a>
                )}
                {s.summary && (
                  <p className="mt-2 text-sm text-muted-foreground">{s.summary}</p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArtifactsSection({ artifacts }: { artifacts: SharedArtifact[] }) {
  if (artifacts.length === 0) {
    return (
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          Артефакты
        </h2>
        <p className="text-sm text-muted">В этом ноутбуке пока нет артефактов.</p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
        Артефакты ({artifacts.length})
      </h2>
      <ul className="space-y-2">
        {artifacts.map((a) => (
          <li
            key={a.id}
            className="rounded-2xl border bg-surface p-4"
            style={{ borderColor: 'rgb(var(--nb-border))' }}
          >
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent">
                {labelForKind(a.kind)}
              </span>
              <h3 className="truncate text-sm font-semibold">{a.title}</h3>
            </div>
            <p className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
              {a.contentPreview}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function labelForKind(kind: string): string {
  switch (kind) {
    case 'url':
      return 'URL';
    case 'file':
      return 'Файл';
    case 'youtube':
      return 'YouTube';
    case 'note':
      return 'Заметка';
    case 'audio_overview':
      return 'Audio';
    case 'report':
      return 'Отчёт';
    default:
      return kind;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
