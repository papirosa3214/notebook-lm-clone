// All types inferred from backend responses — kept hand-written to avoid an
// extra dep on zod in the frontend bundle.

export type ProviderId = 'anthropic' | 'openai' | 'ollama';
export type SourceKind = 'url' | 'file' | 'youtube';
export type SourceStatus = 'pending' | 'parsing' | 'ready' | 'failed';

export interface Notebook {
  id: string;
  title: string;
  defaultProvider: ProviderId;
  defaultModel: string;
  createdAt: string;
  sourceCount?: number;
  readySourceCount?: number;
}

export interface Source {
  id: string;
  notebookId: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  status: SourceStatus;
  error: string | null;
  createdAt: string;
  summary: string | null;
  summaryTopics: string[] | null;
  summarizedAt: string | null;
}

export interface CitationChunk {
  id: string;
  sourceId: string;
  sourceTitle: string;
  sourceKind: SourceKind;
  text: string;
  score: number;
  location?: string;
}

export interface Artifact {
  id: string;
  notebookId: string;
  title: string;
  contentMd: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatDelta =
  | { type: 'citations'; chunks: CitationChunk[] }
  | { type: 'token'; text: string }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: CitationChunk[];
  pending?: boolean;
  error?: string;
}

// Summary (matches API's SummaryDelta discriminated union)
export type SummaryDelta =
  | { type: 'citations'; chunks: CitationChunk[] }
  | { type: 'token'; text: string }
  | { type: 'done'; summaryId: string }
  | { type: 'error'; message: string };

// Discover (matches SearchPreviewResponse / SearchAddBatchResponse)
export interface SearchPreviewResult {
  title: string;
  url: string;
  snippet: string;
}
export interface SearchPreviewResponse {
  query: string;
  results: SearchPreviewResult[];
}
export interface SearchAddBatchItem {
  id: string;
  title: string;
  url: string;
  status: string;
  error?: string;
}
export interface SearchAddBatchResponse {
  added: SearchAddBatchItem[];
}

// Ingest progress (matches API's IngestProgressDelta discriminated union)
export type IngestStage = 'fetching' | 'extracting' | 'chunking' | 'embedding' | 'storing';

export type IngestProgressDelta =
  | {
      type: 'progress';
      stage: IngestStage;
      ratio?: number;
      message?: string;
      /** Sent from the first progress event so the client can recover when
       *  the SSE stream dies before `done` (e.g. idle timeout during slow
       *  Ollama embedding). */
      sourceId?: string;
    }
  | { type: 'done'; source: Source }
  | { type: 'error'; message: string };

// Chat history (matches API's GET /api/notebooks/:id/messages)
// `citations` may be null for user rows, or empty array for assistant rows
// whose stream errored before producing any text.
export interface ChatMessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations: CitationChunk[] | null;
  provider: string | null;
  model: string | null;
  topK: number | null;
  createdAt: string;
}

export interface ChatHistoryResponse {
  messages: ChatMessageRow[];
  /** ISO created_at cursor for the next page. Null when there are no more pages. */
  nextBefore: string | null;
}
