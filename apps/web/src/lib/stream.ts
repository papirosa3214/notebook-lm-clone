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
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
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
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return;
      handlers.onError?.(err instanceof Error ? err.message : String(err));
    }
  })();

  return () => controller.abort();
}