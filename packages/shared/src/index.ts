import { z } from 'zod';

// === Primitives (defined here, used internally; re-exported for downstream packages) ===

export const SourceKindSchema = z.enum(['url', 'file', 'youtube']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const ProviderIdSchema = z.enum(['anthropic', 'openai', 'ollama']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const CitationChunkSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceTitle: z.string(),
  sourceKind: SourceKindSchema,
  text: z.string(),
  score: z.number(),
  location: z.string().optional(),
});
export type CitationChunk = z.infer<typeof CitationChunkSchema>;

// === Domain entities ===

export const NotebookSchema = z.object({
  id: z.string(),
  title: z.string(),
  defaultProvider: ProviderIdSchema,
  defaultModel: z.string(),
  createdAt: z.string(),        // ISO
});
export type Notebook = z.infer<typeof NotebookSchema>;

export const SourceStatusSchema = z.enum(['pending', 'parsing', 'ready', 'failed']);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const SourceSchema = z.object({
  id: z.string(),
  notebookId: z.string(),
  kind: SourceKindSchema,
  title: z.string(),
  url: z.string().nullable(),
  status: SourceStatusSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type Source = z.infer<typeof SourceSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  notebookId: z.string(),
  title: z.string(),
  contentMd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// === Chat history row (server-side persistence) ===
// Each row is one turn of a chat conversation. Used by the API to return
// `GET /api/notebooks/:id/messages` to the web client and by the front-end
// to render the persistent history on mount. `citations` may be null for user
// rows or empty for assistant rows whose stream errored before producing text.

export const ChatMessageRowSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  citations: z.array(CitationChunkSchema).nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  topK: z.number().nullable(),
  createdAt: z.string(),
});
export type ChatMessageRow = z.infer<typeof ChatMessageRowSchema>;

export const ChatHistoryResponseSchema = z.object({
  messages: z.array(ChatMessageRowSchema),
  nextBefore: z.string().nullable(),
});
export type ChatHistoryResponse = z.infer<typeof ChatHistoryResponseSchema>;

// === Chat (ChatMessage already defined above for internal use) ===

export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  history: z.array(ChatMessageSchema).max(40).optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  topK: z.number().int().min(1).max(20).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// SSE delta types streamed from API
export const ChatDeltaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('citations'), chunks: z.array(CitationChunkSchema) }),
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({ type: z.literal('done'), messageId: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ChatDelta = z.infer<typeof ChatDeltaSchema>;

// === Summary (auto-overview of all sources in a notebook) ===

export const SummaryRequestSchema = z.object({
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  topK: z.number().int().min(4).max(30).optional(),
  /** Provide additional instruction to the summary prompt (optional) */
  focus: z.string().max(300).optional(),
});
export type SummaryRequest = z.infer<typeof SummaryRequestSchema>;

export const SummaryDeltaSchema = z.discriminatedUnion('type', [
  /** Sent once at the start with the citation chunks used as context */
  z.object({ type: z.literal('citations'), chunks: z.array(CitationChunkSchema) }),
  /** Incremental summary token */
  z.object({ type: z.literal('token'), text: z.string() }),
  /** Stream finished; summaryId is stable per stream so the UI can dedupe */
  z.object({ type: z.literal('done'), summaryId: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type SummaryDelta = z.infer<typeof SummaryDeltaSchema>;

// === Discover / search-and-add batch ===

export const SearchPreviewRequestSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(15).default(8),
});
export type SearchPreviewRequest = z.infer<typeof SearchPreviewRequestSchema>;

export const SearchPreviewResponseSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
    }),
  ),
});
export type SearchPreviewResponse = z.infer<typeof SearchPreviewResponseSchema>;

export const SearchAddBatchRequestSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(10),
});
export type SearchAddBatchRequest = z.infer<typeof SearchAddBatchRequestSchema>;

export const SearchAddBatchResponseSchema = z.object({
  added: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      url: z.string(),
      status: z.string(),
      error: z.string().optional(),
    }),
  ),
});
export type SearchAddBatchResponse = z.infer<typeof SearchAddBatchResponseSchema>;

// === Ingest progress (SSE) ===

export type IngestStage =
  | 'fetching'
  | 'extracting'
  | 'chunking'
  | 'embedding'
  | 'storing'
  | 'done';

export const IngestProgressDeltaSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    stage: z.enum(['fetching', 'extracting', 'chunking', 'embedding', 'storing']),
    /** 0..1 for the current stage (1 = complete). For stages with sub-steps (embedding N chunks), the value updates per chunk. */
    ratio: z.number().min(0).max(1).optional(),
    message: z.string().optional(),
    /** Set on the first event of an ingest so the client can recover by polling
     *  the source row even if the SSE stream dies before sending `done`. */
    sourceId: z.string().optional(),
  }),
  // `source` is permissive — single-source ingest endpoints send a Source row,
  // batch endpoints (e.g. /search-add-batch) send {added: [...]}. Either shape
  // (or absence) must round-trip or the client sees "stream closed without
  // done event" because the emitter silently drops mismatched deltas.
  z.object({ type: z.literal('done'), source: z.unknown().optional() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type IngestProgressDelta = z.infer<typeof IngestProgressDeltaSchema>;
