import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Source } from '../lib/types';
import { SourceDetailSheet } from './SourceDetailSheet';
import {
  PlusIcon,
  SourceIcon,
  PanelRightIcon,
  TrashIcon,
} from './icons/NotebookLogo';

interface Props {
  notebookId: string;
  /** Click handler for the gear icon — opens the summary drawer. */
  onOpenSummary?: () => void;
}

/**
 * Horizontal pill-strip used in the NotebookLM-style layout.
 * Each source is a small chip with kind icon + truncated title + a
 * hover-revealed delete button. Clicking the chip body opens the
 * detail sheet (same one used in threeColumn mode).
 *
 * The strip is intentionally lightweight — no inline dialogs, no
 * per-source status indicators. The "+" pill on the left opens the
 * existing AddUrlDialog via `onAdd*` callbacks the parent provides.
 */
export function SourcesStrip({ notebookId, onOpenSummary }: Props) {
  const qc = useQueryClient();
  const sources = useQuery({
    queryKey: ['sources', notebookId],
    queryFn: () => api.listSources(notebookId),
  });
  const [openSource, setOpenSource] = useState<Source | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Source | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSource(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources', notebookId] }),
  });

  const list = sources.data?.sources ?? [];

  return (
    <div className="border-b bg-canvas"
      style={{ borderColor: 'rgb(var(--nb-border))' }}>
      <div className="flex items-center gap-2 overflow-x-auto px-4 py-2 md:px-6">
        <button
          type="button"
          className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-dashed px-2.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
          title="Добавить источник"
        >
          <PlusIcon size={12} />
          <span>Добавить</span>
        </button>
        {list.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setOpenSource(s)}
            className="group flex h-7 shrink-0 items-center gap-1.5 rounded-full border bg-surface px-2.5 text-xs transition-colors hover:border-accent"
            style={{ borderColor: 'rgb(var(--nb-border))' }}
            title={s.title}
          >
            <span className="shrink-0">
              <SourceIcon kind={s.kind} size={12} />
            </span>
            <span className="max-w-[180px] truncate">{s.title}</span>
            <span
              role="button"
              tabIndex={-1}
              aria-label="Удалить источник"
              onClick={(e) => {
                e.stopPropagation();
                setPendingDelete(s);
              }}
              className="ml-1 hidden h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-red-100 hover:text-red-700 group-hover:flex"
              style={{ display: 'inline-flex' }}
            >
              <TrashIcon size={10} />
            </span>
          </button>
        ))}
        {list.length === 0 && (
          <span className="text-xs text-muted">Нет источников — добавьте URL, YouTube или файл.</span>
        )}
        {onOpenSummary && (
          <button
            type="button"
            onClick={onOpenSummary}
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-muted transition-all hover:bg-surface-tint"
            style={{ borderColor: 'rgb(var(--nb-border))' }}
            title="Краткое содержание ноутбука"
          >
            <PanelRightIcon size={13} />
          </button>
        )}
      </div>

      {openSource && (
        <SourceDetailSheet
          source={openSource}
          onClose={() => setOpenSource(null)}
        />
      )}
      {pendingDelete && (
        <div className="modal-backdrop animate-fade-in" onClick={() => setPendingDelete(null)}>
          <div
            className="card-pop w-full max-w-md p-6 animate-fade-up"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">Удалить источник?</h3>
            <p className="mt-2 text-sm text-muted">
              «{pendingDelete.title}» исчезнет из ноутбука вместе со всеми
              чанками и ссылками из ответов чата.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="btn btn-ghost"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  remove.mutate(pendingDelete.id);
                  setPendingDelete(null);
                }}
                className="btn btn-danger"
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
