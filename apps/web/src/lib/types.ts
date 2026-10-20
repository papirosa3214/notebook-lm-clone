// All types inferred from backend responses — kept hand-written to avoid an
// extra dep on zod in the frontend bundle.

export type ProviderId = 'anthropic' | 'openai' | 'ollama' | 'minimax';

/** One registered backend plus the models it advertises — what the chat
 *  header renders its provider/model pickers from. */
export interface ProviderInfo {
  id: ProviderId;
  defaultModel: string;
  models: string[];
}
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

/** One named cluster of sources, as returned by /source-groups.
 *  Source ids appear in exactly one group — the server guarantees it so
 *  the scope checkboxes stay a partition. */
export interface SourceGroup {
  title: string;
  sourceIds: string[];
}

export interface SourceGroupsResponse {
  groups: SourceGroup[];
  signature: string;
  /** 'llm' = clustered by the model, 'fallback' = grouped by shared
   *  topic chips, 'none' = not enough sources to split. */
  strategy: 'llm' | 'fallback' | 'none';
  cached: boolean;
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
  /** 'note' (default), 'audio_overview', or 'report' (Studio
   *  templates). UI uses this to pick a renderer. Older rows
   *  pre-dating the field default to 'note' server-side. */
  kind?: 'note' | 'audio_overview' | 'report';
  /** JSON-encoded metadata. For 'audio_overview' / 'report' this
   *  is the typed shape; we keep it as a free string on the
   *  client to avoid duplicating the union from shared/. */
  meta?: string | null;
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
  /** ISO time the row was persisted. Carried so the UI can stamp each
   *  answer — the API has always returned it, the client used to drop
   *  it during the history → state mapping. */
  createdAt?: string;
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

/** Hand-written mirror of `@notebook/shared` DeepResearchDelta.
 *  Only the subset the SourcesCockpit reads from the SSE stream. */
export type DeepResearchPhase =
  | 'planning'
  | 'searching'
  | 'fetching'
  | 'synthesizing'
  | 'done'
  | 'failed';

export type DeepResearchDelta =
  | { type: 'phase'; phase: DeepResearchPhase; message?: string; ratio?: number }
  | { type: 'queries'; queries: string[] }
  | { type: 'hit'; url: string; title: string; ingested: boolean; reason?: string }
  | { type: 'token'; text: string }
  | { type: 'done'; artifactId: string; sourceCount: number; citationCount: number }
  | { type: 'error'; message: string };

// YouTube cookies (mirrors API's /api/youtube/cookies*)
// The API keeps the cookie file on disk; the UI only shows its state and
// triggers a refresh from a browser profile.
export interface YoutubeCookieStatus {
  path: string;
  exists: boolean;
  updatedAt: string | null;
  total: number;
  authCookies: string[];
  missing: string[];
  /** The file exists and carries every cookie a live session needs. */
  usable: boolean;
  /** Browser profiles that can be used as a cookie source. */
  browsers: YoutubeBrowserCookieSource[];
}

export interface YoutubeBrowserCookieSource {
  label: string;
  profilePath: string;
}

export interface YoutubeCookieRefresh {
  ok: boolean;
  message: string;
  undecrypted: number | null;
  extracted: number | null;
  status: Omit<YoutubeCookieStatus, 'browsers'>;
}

export interface YoutubeCookieImport {
  path: string;
  imported: number;
  skipped: number;
  status: Omit<YoutubeCookieStatus, 'browsers'>;
}
