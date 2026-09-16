import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import type { Artifact } from '../lib/types';

interface Props {
  notebookId: string;
  // default content for a new artifact (from "save as artifact" button)
  prefilled?: { title: string; contentMd: string } | null;
  onConsumedPrefilled?: () => void;
}

export function ArtifactsPanel({ notebookId, prefilled, onConsumedPrefilled }: Props) {
  const qc = useQueryClient();
  const artifacts = useQuery({
    queryKey: ['artifacts', notebookId],
    queryFn: () => api.listArtifacts(notebookId),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: ({ title, contentMd }: { title: string; contentMd: string }) =>
      api.createArtifact(notebookId, title, contentMd),
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ['artifacts', notebookId] });
      setSelectedId(a.id);
      onConsumedPrefilled?.();
    },
  });

  const selected = artifacts.data?.artifacts.find((a) => a.id === selectedId);

  // handle prefilled from outside (chat save button)
  if (prefilled && !create.isPending) {
    // fire-and-forget; useEffect would be cleaner but for MVP this is fine
    create.mutate(prefilled);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Заметки</h2>
        <button
          onClick={() =>
            create.mutate({ title: `Заметка ${new Date().toLocaleString('ru')}`, contentMd: '# Новая заметка\n\n' })
          }
          className="btn btn-secondary text-xs"
          disabled={create.isPending}
        >
          + Новая
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {artifacts.isLoading && <p className="text-sm text-zinc-500">Загрузка…</p>}
        {artifacts.data && artifacts.data.artifacts.length === 0 && (
          <p className="text-sm text-zinc-500">Пока нет заметок. Сохрани ответ ассистента или создай новую.</p>
        )}
        {selected ? (
          <ArtifactEditor
            key={selected.id}
            artifact={selected}
            onClose={() => setSelectedId(null)}
            onDelete={() => {
              if (confirm(`Удалить «${selected.title}»?`)) {
                void api.deleteArtifact(selected.id).then(() => {
                  setSelectedId(null);
                  qc.invalidateQueries({ queryKey: ['artifacts', notebookId] });
                });
              }
            }}
          />
        ) : (
          <ul className="space-y-2">
            {artifacts.data?.artifacts.map((a) => (
              <li
                key={a.id}
                className="card cursor-pointer p-3 hover:border-blue-400"
                onClick={() => setSelectedId(a.id)}
              >
                <div className="truncate text-sm font-medium">{a.title}</div>
                <div className="truncate text-xs text-zinc-500">
                  {a.contentMd.slice(0, 80).replace(/\n/g, ' ')}…
                </div>
                <div className="mt-1 text-[10px] text-zinc-400">
                  {new Date(a.updatedAt).toLocaleString('ru')}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ArtifactEditor({
  artifact,
  onClose,
  onDelete,
}: {
  artifact: Artifact;
  onClose: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(artifact.title);
  const [contentMd, setContentMd] = useState(artifact.contentMd);
  const [dirty, setDirty] = useState(false);
  const save = useMutation({
    mutationFn: () => api.updateArtifact(artifact.id, { title, contentMd }),
    onSuccess: () => setDirty(false),
  });

  return (
    <div className="card flex h-full flex-col p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button onClick={onClose} className="btn btn-ghost text-xs">← К списку</button>
        <div className="flex gap-1">
          <a
            href={api.artifactDownloadUrl(artifact.id)}
            download
            className="btn btn-secondary text-xs"
          >
            ⬇ .md
          </a>
          <button
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
            className="btn btn-primary text-xs"
          >
            {save.isPending ? '…' : 'Сохранить'}
          </button>
          <button onClick={onDelete} className="btn btn-ghost text-xs text-red-600">×</button>
        </div>
      </div>
      <input
        className="input mb-2"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setDirty(true);
        }}
      />
      <textarea
        className="input min-h-0 flex-1 resize-none font-mono text-xs"
        value={contentMd}
        onChange={(e) => {
          setContentMd(e.target.value);
          setDirty(true);
        }}
      />
      {dirty && <p className="mt-1 text-[10px] text-amber-600">не сохранено</p>}
    </div>
  );
}
