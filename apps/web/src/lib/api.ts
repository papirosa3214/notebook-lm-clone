import type {
  Artifact,
  ChatDelta,
  CitationChunk,
  IngestProgressDelta,
  Notebook,
  ProviderId,
  SearchAddBatchResponse,
  SearchPreviewResponse,
  Source,
} from './types';

class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${status}`);
  }
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // notebooks
  listNotebooks: () => http<{ notebooks: Notebook[] }>('/api/notebooks'),
  createNotebook: (title: string) =>
    http<Notebook>('/api/notebooks', { method: 'POST', body: JSON.stringify({ title }) }),
  deleteNotebook: (id: string) =>
    http<void>(`/api/notebooks/${id}`, { method: 'DELETE' }),

  /**
   * SSE-streamed ingest of a URL source. Yields progress events; caller can
   * abort() to cancel. The promise resolves with the final Source on 'done'
   * or rejects with the error message on 'error'.
   */
  ingestUrlSourceStream(
    notebookId: string,
    body: { url: string; title?: string },
    onProgress?: (delta: IngestProgressDelta) => void,
  ): { promise: Promise<Source>; abort: () => void } {
    return openIngestStream(
      `/api/notebooks/${notebookId}/sources/url?stream=1`,
      body,
      onProgress,
    );
  },
  ingestYoutubeSourceStream(
    notebookId: string,
    body: { url: string; title?: string },
    onProgress?: (delta: IngestProgressDelta) => void,
  ): { promise: Promise<Source>; abort: () => void } {
    return openIngestStream(
      `/api/notebooks/${notebookId}/sources/youtube?stream=1`,
      body,
      onProgress,
    );
  },
  ingestSearchAddBatchStream(
    notebookId: string,
    body: { urls: string[] },
    onProgress: (delta: IngestProgressDelta) => void,
  ): { promise: Promise<SearchAddBatchResponse>; abort: () => void } {
    return openIngestStream(
      `/api/notebooks/${notebookId}/search-add-batch?stream=1`,
      body,
      onProgress,
    );
  },

  // sources
  listSources: (notebookId: string) =>
    http<{ sources: Source[] }>(`/api/notebooks/${notebookId}/sources`),
  addUrlSource: (notebookId: string, url: string, title?: string) =>
    http<Source>(`/api/notebooks/${notebookId}/sources/url`, {
      method: 'POST',
      body: JSON.stringify({ url, title }),
    }),
  addYoutubeSource: (notebookId: string, url: string, title?: string) =>
    http<Source>(`/api/notebooks/${notebookId}/sources/youtube`, {
      method: 'POST',
      body: JSON.stringify({ url, title }),
    }),
  uploadFileSource: async (notebookId: string, file: File): Promise<Source> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/notebooks/${notebookId}/sources/upload`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body);
    }
    return res.json();
  },
  searchAndAdd: (notebookId: string, query: string, maxResults = 5) =>
    http<{
      query: string;
      searchResults: Array<{ title: string; url: string; snippet: string }>;
      added: Array<{ id: string; title: string; url: string; status: string; error?: string }>;
    }>(`/api/notebooks/${notebookId}/search-and-add`, {
      method: 'POST',
      body: JSON.stringify({ query, maxResults }),
    }),
  /** Step 1 of Discover: just web search, no ingest. */
  searchPreview: (notebookId: string, query: string, maxResults = 8) =>
    http<SearchPreviewResponse>(`/api/notebooks/${notebookId}/search-preview`, {
      method: 'POST',
      body: JSON.stringify({ query, maxResults }),
    }),
  /** Step 2 of Discover: ingest only the URLs the user picked. */
  searchAddBatch: (notebookId: string, urls: string[]) =>
    http<SearchAddBatchResponse>(`/api/notebooks/${notebookId}/search-add-batch`, {
      method: 'POST',
      body: JSON.stringify({ urls }),
    }),
  refreshSources: (notebookId: string) =>
    http<{ sources: Source[]; changed: number }>(
      `/api/notebooks/${notebookId}/sources/refresh`,
      { method: 'POST' },
    ),
  deleteSource: (id: string) =>
    http<void>(`/api/sources/${id}`, { method: 'DELETE' }),

  // retrieval (preview)
  retrieve: (notebookId: string, q: string, topK = 5) =>
    http<{ chunks: unknown[]; citations: CitationChunk[] }>(
      `/api/notebooks/${notebookId}/retrieve?q=${encodeURIComponent(q)}&topK=${topK}`,
    ),

  // artifacts
  listArtifacts: (notebookId: string) =>
    http<{ artifacts: Artifact[] }>(`/api/notebooks/${notebookId}/artifacts`),
  getArtifact: (id: string) => http<Artifact>(`/api/artifacts/${id}`),
  createArtifact: (notebookId: string, title: string, contentMd: string) =>
    http<Artifact>(`/api/notebooks/${notebookId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({ title, contentMd }),
    }),
  updateArtifact: (id: string, patch: { title?: string; contentMd?: string }) =>
    http<Artifact>(`/api/artifacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteArtifact: (id: string) =>
    http<void>(`/api/artifacts/${id}`, { method: 'DELETE' }),
  artifactDownloadUrl: (id: string) => `/api/artifacts/${id}/download`,

  // providers
  listProviderModels: (id: ProviderId) =>
    http<{ provider: ProviderId; default: string; models: string[] }>(`/api/providers/${id}/models`),
};

export { ApiError };
export type { ChatDelta };

// ----- SSE ingest helper -----

function openIngestStream<T>(
  url: string,
  body: unknown,
  onProgress?: (delta: IngestProgressDelta) => void,
): { promise: Promise<T>; abort: () => void } {
  const controller = new AbortController();
  const promise = (async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalSource: T | undefined;
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
          const delta = JSON.parse(json) as IngestProgressDelta;
          if (delta.type === 'progress') onProgress?.(delta);
          else if (delta.type === 'done') finalSource = delta.source as T;
          else if (delta.type === 'error') throw new Error(delta.message);
        } catch (err) {
          if (err instanceof Error) throw err;
          // ignore malformed chunk
        }
      }
    }
    if (!finalSource) throw new Error('stream closed without done event');
    return finalSource;
  })();
  return { promise, abort: () => controller.abort() };
}
