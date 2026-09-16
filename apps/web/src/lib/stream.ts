import type { ChatDelta } from './types';

export interface ChatStreamOptions {
  notebookId: string;
  message: string;
  provider?: string;
  model?: string;
  topK?: number;
  signal?: AbortSignal;
}

export interface ChatStreamHandlers {
  onCitations?: (chunks: ChatDelta extends { type: 'citations'; chunks: infer C } ? C : never) => void;
  onToken?: (text: string) => void;
  onDone?: (messageId: string) => void;
  onError?: (msg: string) => void;
}

/**
 * Open an SSE connection and dispatch parsed ChatDelta events.
 * Returns a cancel function.
 */
export function streamChat(opts: ChatStreamOptions, handlers: ChatStreamHandlers): () => void {
  const controller = new AbortController();
  if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort());

  void (async () => {
    try {
      const res = await fetch(`/api/notebooks/${opts.notebookId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          message: opts.message,
          provider: opts.provider,
          model: opts.model,
          topK: opts.topK,
        }),
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
          const line = block
            .split('\n')
            .find((l) => l.startsWith('data:'));
          if (!line) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          try {
            const delta = JSON.parse(json) as ChatDelta;
            if (delta.type === 'citations') handlers.onCitations?.(delta.chunks as never);
            else if (delta.type === 'token') handlers.onToken?.(delta.text);
            else if (delta.type === 'done') handlers.onDone?.(delta.messageId);
            else if (delta.type === 'error') handlers.onError?.(delta.message);
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
