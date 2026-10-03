import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Artifact } from '../lib/types';
import { FlashcardDeck } from './FlashcardDeck';
import {
  PlusIcon,
  CloseIcon,
  ArrowLeftIcon,
  DownloadIcon,
  TrashIcon,
} from './icons/NotebookLogo';

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
  const mindmap = useMutation({
    mutationFn: () => api.createMindmap(notebookId),
    onSuccess: ({ artifact }) => {
      qc.invalidateQueries({ queryKey: ['artifacts', notebookId] });
      setSelectedId(artifact.id);
    },
  });

  const selected = artifacts.data?.artifacts.find((a) => a.id === selectedId);

  // Drain prefilled content from the chat "save as artifact" button into a
  // real POST. Guarded by a ref so a single prefilled value fires exactly once
  // even if the effect re-runs (e.g. on artifacts query refetch).
  const lastPrefilledRef = useRef<typeof prefilled>(null);
  useEffect(() => {
    if (!prefilled || create.isPending) return;
    if (lastPrefilledRef.current === prefilled) return;
    lastPrefilledRef.current = prefilled;
    create.mutate(prefilled);
  }, [prefilled, create.isPending]); // create.mutate is stable per react-query

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-[13px] font-semibold tracking-tight text-ink">
          Заметки
          {artifacts.data && artifacts.data.artifacts.length > 0 && (
            <span className="ml-1.5 text-xs font-normal text-muted">
              {artifacts.data.artifacts.length}
            </span>
          )}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => mindmap.mutate()}
            disabled={mindmap.isPending}
            className="flex h-8 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium text-muted transition-all hover:bg-surface-tint disabled:opacity-40"
            style={{ borderColor: 'rgb(var(--nb-border))' }}
            title="Сгенерировать майнд-карту ключевых концепций"
          >
            🧠 Майнд-карта
          </button>
          <button
            onClick={() =>
              create.mutate({
                title: `Заметка ${new Date().toLocaleString('ru')}`,
                contentMd: '# Новая заметка\n\n',
              })
            }
            className="flex h-8 w-8 items-center justify-center rounded-full text-white transition-all hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: 'rgb(var(--nb-accent))' }}
            disabled={create.isPending}
            title="Создать заметку"
          >
            <PlusIcon size={14} />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {artifacts.isLoading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="shimmer h-16 rounded-2xl" />
            ))}
          </div>
        )}
        {artifacts.data && artifacts.data.artifacts.length === 0 && (
          <div className="empty-card mt-2 py-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl"
              style={{ backgroundColor: 'rgb(var(--nb-accent-soft))' }}>
              <span className="text-base">📝</span>
            </div>
              <p className="text-sm font-medium">Пока нет заметок</p>
              <p className="max-w-xs text-xs text-muted">
                Сохраните ответ ассистента или создайте новую заметку.
              </p>
          </div>
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
                className="source-pill group cursor-pointer"
                onClick={() => setSelectedId(a.id)}
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base"
                  style={{
                    backgroundColor: 'rgb(var(--nb-accent-soft))',
                  }}
                >
                  📝
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.title}</div>
                  <div className="truncate text-xs text-muted">
                    {a.contentMd.slice(0, 80).replace(/\n/g, ' ')}
                  </div>
                  <div className="mt-0.5 text-[10px] text-subtle">
                    {new Date(a.updatedAt).toLocaleString('ru')}
                  </div>
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
  // Detect flashcards by inspecting the artifact meta. We could
  // also use `artifact.kind === 'report' && meta.template === 'flashcards'`
  // but the meta might be missing for legacy rows — the safe path
  // is to try parsing the body and fall through to the markdown
  // editor on failure.
  const isFlashcards = isFlashcardArtifact(artifact);

  const [title, setTitle] = useState(artifact.title);
  const [contentMd, setContentMd] = useState(artifact.contentMd);
  const [dirty, setDirty] = useState(false);
  const save = useMutation({
    mutationFn: () => api.updateArtifact(artifact.id, { title, contentMd }),
    onSuccess: () => setDirty(false),
  });

  return (
    <div className="flex h-full flex-col animate-fade-up">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button onClick={onClose} className="btn btn-ghost text-xs">
          <ArrowLeftIcon size={13} />
          К списку
        </button>
        <div className="flex gap-1">
          <a
            href={api.artifactDownloadUrl(artifact.id)}
            download
            className="btn btn-secondary text-xs"
            title="Скачать .md"
          >
            <DownloadIcon size={12} />
            .md
          </a>
          <button
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending || isFlashcards}
            className="btn btn-primary text-xs"
            title={isFlashcards ? 'Заголовок редактируется отдельно; карточки неизменяемы' : undefined}
          >
            {save.isPending ? '…' : 'Сохранить'}
          </button>
          <button onClick={onDelete} className="btn btn-ghost text-xs" title="Удалить">
            <TrashIcon size={12} />
          </button>
        </div>
      </div>
      <input
        className="input mb-2 text-base font-semibold"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setDirty(true);
        }}
        placeholder="Заголовок заметки"
      />
      {isFlashcards ? (
        <div className="flex-1 overflow-y-auto">
          <FlashcardDeck data={artifact.contentMd} />
        </div>
      ) : (
        <>
          <textarea
            className="textarea min-h-0 flex-1 font-mono text-[13px] leading-relaxed"
            value={contentMd}
            onChange={(e) => {
              setContentMd(e.target.value);
              setDirty(true);
            }}
            placeholder="Текст заметки в Markdown…"
          />
          {dirty && (
            <p className="mt-2 text-center text-[11px] font-medium text-accent">
              ● Не сохранено
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** True when the artifact is a Studio-generated flashcard set.
 *  Detection: meta.template === 'flashcards' (preferred) OR the
 *  body parses as a FlashcardSet JSON. The fallback lets the
 *  shared/legacy paths still render the deck. */
function isFlashcardArtifact(artifact: Artifact): boolean {
  if (artifact.meta) {
    try {
      const meta = JSON.parse(artifact.meta) as { template?: string };
      if (meta.template === 'flashcards') return true;
    } catch {
      // fall through to body-based detection
    }
  }
  try {
    const parsed = JSON.parse(artifact.contentMd) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'cards' in parsed &&
      Array.isArray((parsed as { cards: unknown }).cards)
    ) {
      return true;
    }
  } catch {
    // not a flashcard artifact
  }
  return false;
}