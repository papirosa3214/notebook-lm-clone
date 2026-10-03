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
  // 'note' (default — pure markdown), 'audio_overview' (script + audio),
  // or 'report' (Studio template). UI uses kind to decide between
  // markdown preview, audio player, or report card.
  kind: z.enum(['note', 'audio_overview', 'report']).default('note'),
  // JSON-encoded metadata. For 'note' it stays null; for 'audio_overview'
  // it carries AudioOverviewMeta; for 'report' it carries
  // StudioReportMeta. Left as a free string so future artifact kinds
  // (table, flashcards, …) can add their own metadata without a schema
  // migration.
  meta: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// === Audio Overview ======================================================
// Audio Overview is a two-host podcast dialogue generated from notebook
// sources. The flow is: (1) LLM writes a script as alternating SCRIPT: /
// MIRA: lines, persisted as an artifact with kind='audio_overview';
// (2) a TTS provider renders the script to an mp3; (3) the artifact
// carries metadata so the UI can show progress, duration, and the audio
// player without re-fetching the source.

export const AudioOverviewStyleSchema = z.enum(['deep_dive', 'short', 'critique']);
export type AudioOverviewStyle = z.infer<typeof AudioOverviewStyleSchema>;

export const AudioOverviewStatusSchema = z.enum([
  'pending',     // job accepted, script not started
  'scripting',   // LLM is writing the script
  'synthesizing',// TTS in progress
  'ready',       // mp3 on disk, playable
  'failed',      // see error field
]);
export type AudioOverviewStatus = z.infer<typeof AudioOverviewStatusSchema>;

/**
 * One line of an Audio Overview script. Either a host turn (SCRIPT/MIRA)
 * or a stage direction (PAUSE, MUSIC) — stage directions let the script
 * model break up the dialogue for natural pacing.
 */
export const AudioOverviewLineSchema = z.object({
  speaker: z.enum(['SCRIPT', 'MIRA', 'STAGE']),
  text: z.string().min(1),
});
export type AudioOverviewLine = z.infer<typeof AudioOverviewLineSchema>;

export const AudioOverviewRequestSchema = z.object({
  /** "deep_dive" (default) ≈ 1500-2000 words, "short" ≈ 500, "critique" adversarial. */
  style: AudioOverviewStyleSchema.default('deep_dive'),
  /** Optional user instruction appended to the system prompt. */
  focus: z.string().max(500).optional(),
  /** Restrict the script to these sources (same validation as chat sourceIds). */
  sourceIds: z.array(z.string().min(1)).max(50).optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
});
export type AudioOverviewRequest = z.infer<typeof AudioOverviewRequestSchema>;

/** Persisted shape of an Audio Overview artifact's metadata. */
export const AudioOverviewMetaSchema = z.object({
  status: AudioOverviewStatusSchema,
  style: AudioOverviewStyleSchema,
  /** Number of SCRIPT:/MIRA: lines actually generated. */
  lineCount: z.number().int().min(0),
  /** Seconds of synthesised audio, null until status='ready'. */
  durationSec: z.number().min(0).nullable(),
  /** Filename of the mp3 inside data/audio/{notebookId}/, null if not rendered yet. */
  audioFilename: z.string().nullable(),
  /** Model id used for the script (and TTS, if known). */
  model: z.string().nullable(),
  /** Set when status='failed'. */
  error: z.string().nullable(),
  /** ISO timestamps for status transitions. */
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AudioOverviewMeta = z.infer<typeof AudioOverviewMetaSchema>;

/** Discriminated SSE delta. Mirrors the chat pattern. */
export const AudioOverviewDeltaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meta'), meta: AudioOverviewMetaSchema }),
  z.object({ type: z.literal('script_line'), line: AudioOverviewLineSchema }),
  z.object({ type: z.literal('progress'), stage: z.enum(['scripting', 'synthesizing']), ratio: z.number().min(0).max(1), message: z.string().optional() }),
  z.object({ type: z.literal('done'), artifactId: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type AudioOverviewDelta = z.infer<typeof AudioOverviewDeltaSchema>;

// === Studio Reports =====================================================
// "Studio" is NotebookLM's term for templated LLM outputs that go
// beyond a free-form chat answer: FAQ, executive summary, timeline of
// events, contradiction report, etc. We persist each as an Artifact
// with kind='report' and a meta JSON that records the template id.

/** Template identifiers. Add a new one by extending the registry in
 *  apps/api/src/lib/studio/templates.ts — the schema here is the
 *  source of truth. */
export const StudioTemplateSchema = z.enum([
  'faq',
  'executive_summary',
  'timeline',
  'contradictions',
]);
export type StudioTemplate = z.infer<typeof StudioTemplateSchema>;

export const StudioRequestSchema = z.object({
  template: StudioTemplateSchema,
  /** Optional user-supplied extra direction appended to the system prompt. */
  focus: z.string().max(500).optional(),
  /** Restrict the report to these sources (same validation as chat sourceIds). */
  sourceIds: z.array(z.string().min(1)).max(50).optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  /** Retrieval depth for the template prompt. Each template has a
   *  sensible default in the registry; clients can override. */
  topK: z.number().int().min(2).max(30).optional(),
});
export type StudioRequest = z.infer<typeof StudioRequestSchema>;

/** Persisted shape of a Studio artifact's metadata. Mirrors the
 *  AudioOverviewMeta pattern so the Artifacts panel can render
 *  different artifact kinds uniformly. */
export const StudioReportMetaSchema = z.object({
  template: StudioTemplateSchema,
  /** Total citation chunks the template was grounded on. */
  citationCount: z.number().int().min(0),
  /** When the artifact was first created (ISO). */
  createdAt: z.string(),
});
export type StudioReportMeta = z.infer<typeof StudioReportMetaSchema>;

/** SSE delta. Mirrors chat and audio overview patterns so the client
 *  stream helper is reusable. */
export const StudioDeltaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('citations'), chunks: z.array(CitationChunkSchema) }),
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({ type: z.literal('done'), artifactId: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type StudioDelta = z.infer<typeof StudioDeltaSchema>;

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
  /**
   * Optional source filter. Absent or empty array = all sources in the
   * notebook. The API validates every id belongs to :notebookId and
   * rejects the request with 400 otherwise (no silent fallback to "all"
   * — that would let a stale id leak across notebooks).
   */
  sourceIds: z.array(z.string().min(1)).max(50).optional(),
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
