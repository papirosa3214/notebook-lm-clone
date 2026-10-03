import type {
  Artifact,
  ChatDelta,
  ChatHistoryResponse,
  CitationChunk,
  IngestProgressDelta,
  Notebook,
  ProviderId,
  SearchAddBatchResponse,
  SearchPreviewResponse,
  Source,
} from './types';
import type { AudioOverviewDelta, AudioOverviewLine, AudioOverviewMeta } from '@notebook/shared';

class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${status}`);
  }
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Only set Content-Type: application/json when we actually have a body.
  // Fastify rejects empty bodies sent with that Content-Type
  // (FST_ERR_CTP_EMPTY_JSON_BODY → 400), so DELETE /api/sources/:id and
  // DELETE /api/notebooks/:id never reached the route handler at all.
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
  // 204 No Content (DELETE responses) has an empty body — `res.json()` would
  // throw "Unexpected end of JSON input" and the mutation would reject, so
  // TanStack Query's onSuccess never runs and the UI doesn't refetch.
  if (res.status === 204) return undefined as T;
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
      notebookId,
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
      notebookId,
      onProgress,
    );
  },
  ingestYoutubeAsrSourceStream(
    notebookId: string,
    body: { url: string; title?: string },
    onProgress?: (delta: IngestProgressDelta) => void,
  ): { promise: Promise<Source>; abort: () => void } {
    return openIngestStream(
      `/api/notebooks/${notebookId}/sources/youtube-asr?stream=1`,
      body,
      notebookId,
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
      notebookId,
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

  // Chat history — replaces the local-only ChatMessage[] on the front-end
  // when a notebook is opened. Empty array if no messages persisted yet.
  // `before` is created_at cursor (ISO string) for pagination.
  getMessages: (notebookId: string, opts: { limit?: number; before?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.before) params.set('before', opts.before);
    const qs = params.toString();
    return http<ChatHistoryResponse>(
      `/api/notebooks/${notebookId}/messages${qs ? `?${qs}` : ''}`,
    );
  },
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

  // per-source summary (server-side cache; backend generates on demand if empty)
  getSourceSummary: (id: string) =>
    http<{ summary: string; topics: string[]; generatedAt: string }>(
      `/api/sources/${id}/summary`,
    ),
  regenerateSourceSummary: (id: string) =>
    http<{ summary: string; topics: string[]; generatedAt: string }>(
      `/api/sources/${id}/summary/refresh`,
      { method: 'POST' },
    ),

  // Body of a source for the reader. Endpoint used:
  // GET /api/notebooks/:id/sources/:sourceId?include=chunks&limit=200
  getSourceChunks: (notebookId: string, sourceId: string, limit = 200) =>
    http<{
      id: string;
      notebookId: string;
      chunks: Array<{ id: number; ordinal: number; content: string; contentLen: number }>;
      chunksReturned: number;
    }>(`/api/notebooks/${notebookId}/sources/${sourceId}?include=chunks&limit=${limit}`),

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
  /** Generate a mind-map of the notebook's concepts. Backend persists it
   *  as a regular artifact (contentMd is an inline SVG) and returns the
   *  parsed graph alongside the artifact row. */
  createMindmap: (notebookId: string, focus?: string) =>
    http<{ artifact: Artifact; mindmap: { title: string; nodes: { id: string; label: string }[]; edges: { from: string; to: string }[] } }>(
      `/api/notebooks/${notebookId}/mindmap`,
      {
        method: 'POST',
        body: JSON.stringify(focus ? { focus } : {}),
      },
    ),
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

  // Audio Overview — kicks off the SSE script-generation job and
  // streams the lines back. The promise resolves with the final
  // `{ artifact, meta }` so the caller can navigate to the new
  // artifact without polling.
  ingestAudioOverviewStream(
    notebookId: string,
    body: { style?: 'deep_dive' | 'short' | 'critique'; focus?: string; sourceIds?: string[] },
    onDelta: (delta: AudioOverviewDelta) => void,
  ): { promise: Promise<{ artifact: Artifact; meta: AudioOverviewMeta }>; abort: () => void } {
    const controller = new AbortController();
    const promise = (async () => {
      const res = await fetch(
        `/api/notebooks/${notebookId}/audio-overview?stream=1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let meta: AudioOverviewMeta | null = null;
      let artifactId: string | null = null;
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
            const delta = JSON.parse(json) as AudioOverviewDelta;
            if (delta.type === 'meta') meta = delta.meta;
            if (delta.type === 'done') artifactId = delta.artifactId;
            onDelta(delta);
            if (delta.type === 'error') {
              throw new Error(delta.message);
            }
          } catch (err) {
            if (err instanceof Error) throw err;
            // ignore malformed chunk
          }
        }
      }
      if (!meta || !artifactId) {
        throw new Error('stream closed without done event');
      }
      // Re-fetch the artifact by id so the client gets the full row
      // (including the persisted contentMd) in one place.
      const artifact = await http<Artifact>(`/api/artifacts/${artifactId}`);
      return { artifact, meta };
    })();
    return { promise, abort: () => controller.abort() };
  },

  audioUrl: (notebookId: string, artifactId: string) =>
    `/api/audio/${notebookId}/${artifactId}.mp3`,
};

export { ApiError };
export type { ChatDelta };

// ----- SSE ingest helper -----

function openIngestStream<T>(
  url: string,
  body: unknown,
  notebookId: string,
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
    let sourceId: string | undefined;
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
          if (delta.type === 'progress') {
            // Capture sourceId from the first event so we can recover if the
            // SSE stream dies before sending `done` (e.g. idle timeout during
            // a slow Ollama embedding pass).
            if (delta.sourceId && !sourceId) sourceId = delta.sourceId;
            onProgress?.(delta);
          } else if (delta.type === 'done') {
            finalSource = delta.source as T;
          } else if (delta.type === 'error') {
            throw new Error(delta.message);
          }
        } catch (err) {
          if (err instanceof Error) throw err;
          // ignore malformed chunk
        }
      }
    }
    if (!finalSource && sourceId) {
      // Stream died before `done` — recover by polling the source's actual state.
      try {
        const fetched = await http<unknown>(
          `/api/notebooks/${notebookId}/sources/${sourceId}`,
        );
        // Only treat as the expected response if it looks like a Source row;
        // batch endpoints return a different shape and we should not lie.
        if (
          typeof fetched === 'object' &&
          fetched !== null &&
          'id' in fetched &&
          'status' in fetched
        ) {
          return fetched as T;
        }
      } catch {
        // Fall through to the original error below.
      }
    }
    if (!finalSource) throw new Error('stream closed without done event');
    return finalSource;
  })();
  return { promise, abort: () => controller.abort() };
}
