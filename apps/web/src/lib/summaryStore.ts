import type { CitationChunk } from './types';
import { streamSummary } from './stream';

/**
 * Notebook summary store.
 *
 * The pinned "Краткое содержание" card used to own its stream inside
 * the component, which is why it never auto-generated: under React
 * StrictMode the probe mount starts a stream, unmounts (aborting it),
 * and the real mount starts another — so any effect-based trigger
 * raced and double-streamed, and the author left it manual. Nothing
 * then appeared until the user found the ↻ button, which was itself
 * hidden while the card was empty.
 *
 * Owning the stream here instead means:
 *   - `ensureStarted(id)` is idempotent, so a double mount joins the
 *     stream already in flight rather than starting a second one;
 *   - unmounting the card does not abort the stream, so navigating away
 *     and back keeps (or completes) the same summary;
 *   - the first subscriber gets the cached value from localStorage
 *     immediately, with no flash of empty state.
 */

export interface SummaryState {
  content: string;
  citations: CitationChunk[];
  savedAt: string | null;
  streaming: boolean;
  error: string | null;
}

const STORAGE_KEY = (id: string) => `nb.summary.${id}`;

const EMPTY: SummaryState = {
  content: '',
  citations: [],
  savedAt: null,
  streaming: false,
  error: null,
};

const states = new Map<string, SummaryState>();
const listeners = new Map<string, Set<() => void>>();
const inFlight = new Set<string>();
const aborters = new Map<string, () => void>();

function loadPersisted(id: string): SummaryState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      content?: string;
      citations?: CitationChunk[];
      savedAt?: string;
    };
    if (!parsed.content) return null;
    return {
      content: parsed.content,
      citations: parsed.citations ?? [],
      savedAt: parsed.savedAt ?? null,
      streaming: false,
      error: null,
    };
  } catch {
    return null;
  }
}

function persist(id: string, state: SummaryState) {
  if (!state.content.trim()) return;
  try {
    localStorage.setItem(
      STORAGE_KEY(id),
      JSON.stringify({
        content: state.content,
        citations: state.citations,
        savedAt: state.savedAt ?? new Date().toISOString(),
      }),
    );
  } catch {
    /* quota / private mode — ignore */
  }
}

function emit(id: string) {
  const set = listeners.get(id);
  if (!set) return;
  for (const fn of set) fn();
}

function setState(id: string, patch: Partial<SummaryState>) {
  // Always replace the object: useSyncExternalStore compares snapshots
  // by identity, so mutating in place would never re-render.
  const next = { ...(states.get(id) ?? loadPersisted(id) ?? EMPTY), ...patch };
  states.set(id, next);
  emit(id);
}

export function getSummaryState(id: string): SummaryState {
  const existing = states.get(id);
  if (existing) return existing;
  const loaded = loadPersisted(id) ?? EMPTY;
  states.set(id, loaded);
  return loaded;
}

export function subscribeSummary(id: string, fn: () => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(id);
  };
}

/**
 * Start a summary stream for `id` unless one is already running. Safe
 * to call from an effect on every mount.
 */
export function ensureSummaryStarted(id: string): void {
  if (inFlight.has(id)) return;
  const state = getSummaryState(id);
  if (state.content.trim()) return; // already cached
  startStream(id);
}

/** Force a fresh summary, discarding the cached one (the ↻ button). */
export function refreshSummary(id: string): void {
  aborters.get(id)?.();
  inFlight.delete(id);
  setState(id, { content: '', citations: [], savedAt: null, error: null, streaming: false });
  try {
    localStorage.removeItem(STORAGE_KEY(id));
  } catch {
    /* ignore */
  }
  startStream(id);
}

function startStream(id: string) {
  inFlight.add(id);
  setState(id, { streaming: true, error: null });

  let acc = '';
  let accCitations: CitationChunk[] = [];

  const abort = streamSummary(
    { notebookId: id },
    {
      onCitations: (chunks) => {
        accCitations = chunks;
        setState(id, { citations: chunks });
      },
      onToken: (t) => {
        acc += t;
        setState(id, { content: acc });
      },
      onDone: () => {
        inFlight.delete(id);
        aborters.delete(id);
        const savedAt = new Date().toISOString();
        const next: SummaryState = {
          content: acc,
          citations: accCitations,
          savedAt,
          streaming: false,
          error: null,
        };
        states.set(id, next);
        persist(id, next);
        emit(id);
      },
      onAbort: () => {
        inFlight.delete(id);
        aborters.delete(id);
        setState(id, { streaming: false });
      },
      onError: (msg) => {
        inFlight.delete(id);
        aborters.delete(id);
        setState(id, { streaming: false, error: msg });
      },
    },
  );
  aborters.set(id, abort);
}

/** Test seam: drop all in-memory state. */
export function __resetSummaryStore(): void {
  for (const abort of aborters.values()) abort();
  states.clear();
  listeners.clear();
  inFlight.clear();
  aborters.clear();
}
