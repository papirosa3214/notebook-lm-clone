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
