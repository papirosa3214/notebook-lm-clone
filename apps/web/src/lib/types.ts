// All types inferred from backend responses — kept hand-written to avoid an
// extra dep on zod in the frontend bundle.

export type ProviderId = 'anthropic' | 'openai' | 'ollama';
export type SourceKind = 'url' | 'file' | 'youtube';
export type SourceStatus = 'pending' | 'parsing' | 'ready' | 'failed';

export interface Notebook {
  id: string;
  title: string;
  ragflowDatasetId: string;
  defaultProvider: ProviderId;
  defaultModel: string;
  createdAt: string;
  sourceCount?: number;
  readySourceCount?: number;
}

export interface Source {
  id: string;
  notebookId: string;
  ragflowDocId: string | null;
  kind: SourceKind;
  title: string;
  url: string | null;
  status: SourceStatus;
  error: string | null;
  createdAt: string;
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
    }
  | { type: 'done'; source: Source }
  | { type: 'error'; message: string };
