import type { ChatDelta, CitationChunk, SummaryDelta } from './types';

export interface ChatStreamOptions {
  notebookId: string;
  message: string;
  provider?: string;
  model?: string;
  topK?: number;
  signal?: AbortSignal;
}

export interface ChatStreamHandlers {
  onCitations?: (chunks: CitationChunk[]) => void;
  onToken?: (text: string) => void;
  onDone?: (messageId: string) => void;
  onError?: (msg: string) => void;
  /**
   * Fires when the stream is aborted by us (refresh / unmount / Strict-Mode
   * double-mount). Distinct from onError so the UI can reset `streaming` and
   * clear `abortRef` without showing the user a scary "aborted" message.
   */
  onAbort?: () => void;
}

/**
 * Open an SSE connection and dispatch parsed ChatDelta events.
 * Returns a cancel function.
 */
export function streamChat(opts: ChatStreamOptions, handlers: ChatStreamHandlers): () => void {
  return openSse(
    `/api/notebooks/${opts.notebookId}/chat`,
    {
      message: opts.message,
      provider: opts.provider,
      model: opts.model,
      topK: opts.topK,
    },
    opts.signal,
    handlers,
  );
}

export interface SummaryStreamOptions {
  notebookId: string;
  provider?: string;
  model?: string;
  topK?: number;
  focus?: string;
  signal?: AbortSignal;
}

export interface SummaryStreamHandlers {
  onCitations?: (chunks: CitationChunk[]) => void;
  onToken?: (text: string) => void;
  onDone?: (summaryId: string) => void;
  onError?: (msg: string) => void;
  /**
   * Fires when the stream is aborted by us (refresh / unmount / Strict-Mode
   * double-mount). Distinct from onError so the UI can reset `streaming` and
   * clear `abortRef` without showing the user a scary "aborted" message.
   */
  onAbort?: () => void;
}

export function streamSummary(opts: SummaryStreamOptions, handlers: SummaryStreamHandlers): () => void {
  return openSse(
    `/api/notebooks/${opts.notebookId}/summary`,
    {
      provider: opts.provider,
      model: opts.model,
      topK: opts.topK,
      focus: opts.focus,
    },
    opts.signal,
    handlers,
  );
}

interface ParsedHandlers {
  onCitations?: (chunks: CitationChunk[]) => void;
  onToken?: (text: string) => void;
  onDone?: (id: string) => void;
  onError?: (msg: string) => void;
  onAbort?: () => void;
}

/** Internal: shared SSE reader for chat + summary. */
function openSse(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  handlers: ParsedHandlers,
): () => void {
  const controller = new AbortController();
  if (signal) signal.addEventListener('abort', () => controller.abort());

  void (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        handlers.onError?.(`HTTP ${res.status}: ${text}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      /** Dispatch a parsed SSE event. */
      const dispatch = (json: string) => {
        if (!json) return;
        try {
          const delta = JSON.parse(json) as ChatDelta | SummaryDelta;
          if (delta.type === 'citations') handlers.onCitations?.(delta.chunks);
          else if (delta.type === 'token') handlers.onToken?.(delta.text);
          else if (delta.type === 'done') {
            const id = 'messageId' in delta ? delta.messageId : delta.summaryId;
            handlers.onDone?.(id);
          } else if (delta.type === 'error') handlers.onError?.(delta.message);
        } catch {
          // ignore malformed chunk
        }
      };
      /** Try to flush one complete `\n\n`-terminated block from `buf`. */
      const flushBlock = (): boolean => {
        const nl = buf.indexOf('\n\n');
        if (nl === -1) return false;
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = block.split('\n').find((l) => l.startsWith('data:'));
        if (!line) return true;
        dispatch(line.slice(5).trim());
        return true;
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        while (flushBlock()) {
          /* drain all complete blocks */
        }
      }
      // Server closed the stream. If `buf` has anything left over (no
      // trailing `\n\n`), treat it as one final block. This is the common
      // case for our backend which omits the blank line after `done`.
      // Without this, the terminal event silently disappears and any
      // `onDone`/`onError` handler in the panel never fires — so things
      // like `savePersisted` (SummaryPanel) never run.
      const trailing = buf.trim();
      if (trailing) {
        buf = '';
        const line = trailing.split('\n').find((l) => l.startsWith('data:'));
        if (line) dispatch(line.slice(5).trim());
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        // Abort is not an error from the user's perspective — it just means
        // a new request superseded this one (Strict-Mode double-mount,
        // refresh button, notebook switch). Reset state without surfacing
        // an error message.
        handlers.onAbort?.();
        return;
      }
      handlers.onError?.(err instanceof Error ? err.message : String(err));
    }
  })();

  return () => controller.abort();
}