/**
 * Per-notebook source scope state for the chat.
 *
 * The user picks which sources to talk to; the chat panel passes the
 * resulting ids as `sourceIds` on /api/notebooks/:id/chat. The actual
 * retrieval happens server-side, so the hook only owns the SELECTION
 * state. Persistence is localStorage (keyed per notebook) — survives
 * reloads and tab switches without needing a backend round-trip.
 *
 * Rules (from the Source Workspace v1 plan):
 *  - empty selection == "all ready sources" (preserves the pre-
 *    feature behaviour; no scary "select at least one" modal)
 *  - selected ids that no longer exist (deleted source) are dropped
 *    automatically on every render — stale ids cannot leak through
 *  - pending/failed sources are NOT selectable; their status badge
 *    stays visible but the checkbox is disabled
 *  - the returned `selectedIds` array is empty when the user wants
 *    "all"; callers pass `sourceIds?: selectedIds.length > 0 ? ids : undefined`
 *    to api.chat
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Source } from './types';

const STORAGE_PREFIX = 'notebook-scope:';

function loadInitial(notebookId: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + notebookId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function persist(notebookId: string, ids: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + notebookId, JSON.stringify(ids));
  } catch {
    // localStorage quota / private mode — best-effort, selection still
    // works for the current session.
  }
}

export interface UseSourceScopeResult {
  /** Currently selected ready-source ids. Empty array means "all". */
  selectedIds: string[];
  /** All ready source ids in the notebook, sorted for stable rendering. */
  readyIds: string[];
  /**
   * `true` when the user has explicitly narrowed the scope. Empty
   * selection with no ready sources also returns false (nothing to
   * narrow to).
   */
  isScoped: boolean;
  /** True when there's at least one ready source in the notebook. */
  hasReady: boolean;
  /** Toggle a single ready source on/off. */
  toggle: (id: string) => void;
  /** Select all ready sources (effectively removes the scope filter). */
  selectAll: () => void;
  /** Empty the selection (== "all ready sources" in our rules). */
  clear: () => void;
  /** Keep only currently ready ids; called automatically too. */
  prune: () => void;
}

export function useSourceScope(
  notebookId: string,
  sources: Source[] | undefined,
): UseSourceScopeResult {
  const [selected, setSelected] = useState<string[]>(() => loadInitial(notebookId));

  const readyIds = useMemo(
    () =>
      (sources ?? [])
        .filter((s) => s.status === 'ready')
        .map((s) => s.id)
        .sort(),
    [sources],
  );

  // Drop any selected ids that no longer exist or are no longer ready
  // (deleted source, status flipped back to parsing/pending, etc).
  useEffect(() => {
    if (sources === undefined) return;
    setSelected((prev) => {
      const readySet = new Set(readyIds);
      const pruned = prev.filter((id) => readySet.has(id));
      if (pruned.length === prev.length) return prev;
      persist(notebookId, pruned);
      return pruned;
    });
  }, [readyIds, sources, notebookId]);

  const toggle = useCallback(
    (id: string) => {
      setSelected((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
        persist(notebookId, next);
        return next;
      });
    },
    [notebookId],
  );

  const selectAll = useCallback(() => {
    setSelected(() => {
      persist(notebookId, readyIds);
      return readyIds;
    });
  }, [notebookId, readyIds]);

  const clear = useCallback(() => {
    setSelected(() => {
      persist(notebookId, []);
      return [];
    });
  }, [notebookId]);

  const prune = useCallback(() => {
    setSelected((prev) => {
      const readySet = new Set(readyIds);
      const pruned = prev.filter((id) => readySet.has(id));
      if (pruned.length === prev.length) return prev;
      persist(notebookId, pruned);
      return pruned;
    });
  }, [readyIds, notebookId]);

  const hasReady = readyIds.length > 0;
  const isScoped = selected.length > 0 && selected.length < readyIds.length;

  return {
    selectedIds: selected,
    readyIds,
    isScoped,
    hasReady,
    toggle,
    selectAll,
    clear,
    prune,
  };
}

/**
 * Translate `selectedIds` (possibly empty) into the value we send to
 * the chat API. Empty == "all ready" == undefined so the backend
 * uses its no-filter code path.
 */
export function scopeToSourceIds(
  selectedIds: string[],
  readyIds: string[],
): string[] | undefined {
  if (selectedIds.length === 0) return undefined;
  if (selectedIds.length === readyIds.length) return undefined;
  return selectedIds;
}

/**
 * Return the checkbox state for one ready source. The persisted empty array
 * means "all ready sources", so it must render as checked rather than as an
 * apparently empty chat scope.
 */
export function isSourceInScope(
  sourceId: string,
  selectedIds: string[],
  readyIds: string[],
): boolean {
  if (selectedIds.length === 0 || selectedIds.length === readyIds.length) {
    return readyIds.includes(sourceId);
  }
  return selectedIds.includes(sourceId);
}
