import { z } from 'zod';

// === Primitives (defined here, used internally; re-exported for downstream packages) ===

export const SourceKindSchema = z.enum(['url', 'file', 'youtube']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const ProviderIdSchema = z.enum(['anthropic', 'openai', 'ollama', 'minimax']);
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
  'flashcards',
  'data_table',
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
 *  different artifact kinds uniformly.
 *
 *  - For free-form reports (faq / executive_summary / timeline /
 *    contradictions) the body is markdown in `artifact.contentMd`.
 *  - For `flashcards` the body is JSON in `artifact.contentMd`
 *    (a `FlashcardSet` serialised as JSON) and `flashcardCount`
 *    is duplicated for fast list rendering. */
export const StudioReportMetaSchema = z.object({
  template: StudioTemplateSchema,
  /** Total citation chunks the template was grounded on. */
  citationCount: z.number().int().min(0),
  /** When the artifact was first created (ISO). */
  createdAt: z.string(),
  /** Only set when template='flashcards'. Mirrors the parsed count
   *  so the Artifacts panel can render the count without parsing
   *  the JSON body. */
  flashcardCount: z.number().int().min(0).optional(),
  /** Only set when template='data_table'. Mirrors the parsed
   *  column/row counts. */
  columnCount: z.number().int().min(0).optional(),
  rowCount: z.number().int().min(0).optional(),
});
export type StudioReportMeta = z.infer<typeof StudioReportMetaSchema>;

/** A single Q/A card. Short question, short answer (1-3 sentences),
 *  optional [N] markers in either field. */
export const FlashcardSchema = z.object({
  id: z.string(),
  question: z.string().min(1).max(500),
  answer: z.string().min(1).max(1500),
});
export type Flashcard = z.infer<typeof FlashcardSchema>;

/** Persisted as JSON in `artifact.contentMd` when the artifact
 *  kind is 'flashcards'. Order is the natural study order (the
 *  order the model produced). */
export const FlashcardSetSchema = z.object({
  cards: z.array(FlashcardSchema).min(1).max(60),
});
export type FlashcardSet = z.infer<typeof FlashcardSetSchema>;

/** Persisted as JSON in `artifact.contentMd` when the artifact
 *  kind is 'report' and meta.template is 'data_table'.
 *
 *  - `columns` is the ordered header list. Each row's keys must
 *    be a subset of this list (extra keys are dropped, missing
 *    cells become '').
 *  - `rows` are plain objects keyed by column name. Values are
 *    short strings — the model is told to keep them under ~200
 *    chars so the table renders without horizontal scroll.
 *  - `title` is optional and shown above the table when set. */
export const DataTableSchema = z.object({
  title: z.string().max(200).optional(),
  columns: z.array(z.string().min(1).max(80)).min(1).max(20),
  rows: z
    .array(z.record(z.string(), z.string()))
    .min(1)
    .max(500),
});
export type DataTable = z.infer<typeof DataTableSchema>;

/** SSE delta. Mirrors chat and audio overview patterns so the client
 *  stream helper is reusable. */
export const StudioDeltaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('citations'), chunks: z.array(CitationChunkSchema) }),
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({ type: z.literal('done'), artifactId: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type StudioDelta = z.infer<typeof StudioDeltaSchema>;

// === Suggested follow-up questions ========================================
// Streamed after each chat answer. The LLM is asked to produce
// 3 short Russian questions that would naturally extend the
// current thread, grounded in the same sources.

export const SuggestionsRequestSchema = z.object({
  /** The last user question. Required. */
  question: z.string().min(1),
  /** The assistant's last answer. Required. */
  answer: z.string().min(1),
  /** Optional chat history (user/assistant turns) to give the LLM
   *  context about the running conversation. */
  history: z.array(ChatMessageSchema).max(20).optional(),
  /** Source scope (mirrors /chat). When set, the LLM is told which
   *  sources the previous answer used so suggestions stay on-topic. */
  sourceIds: z.array(z.string().min(1)).max(50).optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  /** How many suggestions to ask for. 1-5, default 3. */
  count: z.number().int().min(1).max(5).default(3),
});
export type SuggestionsRequest = z.infer<typeof SuggestionsRequestSchema>;

/**
 * SSE delta for the suggestions endpoint. The model streams the
 * raw text of the JSON array; the client (and the test suite) parses
 * the same way we already do for flashcards/data_table.
 */
export const SuggestionsDeltaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }),
  /** Final list, parsed on the server after the stream ends so
   *  clients don't need to JSON-parse. */
  z.object({ type: z.literal('suggestions'), suggestions: z.array(z.string().min(1)) }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('done') }),
]);
export type SuggestionsDelta = z.infer<typeof SuggestionsDeltaSchema>;

// === Sharing =============================================================
// Read-only public link to a notebook. Single-user assumption: the
// share token is a long random nanoid that the holder can use to
// view a stripped-down snapshot of the notebook (no chat, no source
// management, no add-source). The token lives in the notebook row
// and can be revoked by setting it to null.

/** Public, read-only view of a notebook. Returned by
 *  `GET /api/shared/:token`. */
export const SharedSourceSchema = z.object({
  id: z.string(),
  kind: SourceKindSchema,
  title: z.string(),
  url: z.string().nullable(),
  status: SourceStatusSchema,
  /** Per-source summary if summariseSource() has run. */
  summary: z.string().nullable(),
});
export type SharedSource = z.infer<typeof SharedSourceSchema>;

export const SharedArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['note', 'audio_overview', 'report']),
  /** Truncated preview (~300 chars) to keep the snapshot small. */
  contentPreview: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SharedArtifact = z.infer<typeof SharedArtifactSchema>;

export const SharedNotebookSchema = z.object({
  title: z.string(),
  createdAt: z.string(),
  sources: z.array(SharedSourceSchema),
  artifacts: z.array(SharedArtifactSchema),
});
export type SharedNotebook = z.infer<typeof SharedNotebookSchema>;

/** Response to POST/GET /api/notebooks/:id/share. */
export const NotebookShareSchema = z.object({
  /** True if sharing is currently active. False after a revoke. */
  enabled: z.boolean(),
  /** Stable URL-safe token. Null when sharing is disabled. */
  shareToken: z.string().nullable(),
  /** Convenience: full URL the UI can copy. Null when disabled. */
  shareUrl: z.string().nullable(),
  /** ISO timestamp of when sharing was last enabled, null if never. */
  shareEnabledAt: z.string().nullable(),
});
export type NotebookShare = z.infer<typeof NotebookShareSchema>;

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

// === Inline AI note assist ================================================
// Streaming edit endpoint. The LLM is asked to rewrite / expand / shorten
// a chunk of text (either the user's selection or the whole document).
// The streamed tokens replace the selection in the editor on completion.

export const AiEditInstructionSchema = z.enum(['rewrite', 'expand', 'shorten']);
export type AiEditInstruction = z.infer<typeof AiEditInstructionSchema>;

export const AiEditRequestSchema = z.object({
  /** What the model should do with the input. */
  instruction: AiEditInstructionSchema,
  /** The selected range. When empty the model operates on `fullText`. */
  selection: z.string().default(''),
  /** Full document text — used as context for "rewrite" when the
   *  selection alone would be ambiguous. */
  fullText: z.string().min(1),
  /** Optional override for the LLM provider / model. */
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
});
export type AiEditRequest = z.infer<typeof AiEditRequestSchema>;

/** SSE delta for the AI edit endpoint. Mirrors the chat pattern. */
export const AiEditDeltaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }),
  /** Final event when the stream ends. `output` is the full edited
   *  text — clients that didn't want to reassemble tokens can
   *  take this verbatim. */
  z.object({ type: z.literal('done'), output: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type AiEditDelta = z.infer<typeof AiEditDeltaSchema>;

// === Deep Research =========================================================
// Autonomous multi-step research: plan queries → web search → fetch &
// ingest the best hits as sources → synthesise a cited report. Streamed
// over SSE so the UI can show each phase as it happens.

export const DeepResearchRequestSchema = z.object({
  /** The research question. */
  question: z.string().min(1),
  /** How many search queries the planner should produce (1-6). */
  maxQueries: z.number().int().min(1).max(6).default(3),
  /** How many web results to actually ingest as sources (1-10). */
  maxSources: z.number().int().min(1).max(10).default(5),
  /** Search results to look at per query before deduping. */
  resultsPerQuery: z.number().int().min(1).max(10).default(5),
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
});
export type DeepResearchRequest = z.infer<typeof DeepResearchRequestSchema>;

export const DeepResearchPhaseSchema = z.enum([
  'planning',
  'searching',
  'fetching',
  'synthesizing',
  'done',
  'failed',
]);
export type DeepResearchPhase = z.infer<typeof DeepResearchPhaseSchema>;

export const DeepResearchDeltaSchema = z.discriminatedUnion('type', [
  /** Coarse progress. ratio is 0..1 for the whole run. */
  z.object({
    type: z.literal('phase'),
    phase: DeepResearchPhaseSchema,
    message: z.string().optional(),
    ratio: z.number().min(0).max(1).optional(),
  }),
  /** Planner output: the queries the agent will run. */
  z.object({ type: z.literal('queries'), queries: z.array(z.string().min(1)) }),
  /** A web hit the agent considered. `ingested` is set once we've
   *  written it into the vector store (or skipped it). */
  z.object({
    type: z.literal('hit'),
    url: z.string(),
    title: z.string(),
    ingested: z.boolean(),
    reason: z.string().optional(),
  }),
  /** Synthesis tokens (the report body). */
  z.object({ type: z.literal('token'), text: z.string() }),
  /** Terminal success. */
  z.object({
    type: z.literal('done'),
    artifactId: z.string(),
    sourceCount: z.number().int().min(0),
    citationCount: z.number().int().min(0),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type DeepResearchDelta = z.infer<typeof DeepResearchDeltaSchema>;

/** Meta persisted on a Deep Research artifact (`kind='report'`,
 *  `meta.template='deep_research'`). Distinct from StudioReportMeta
 *  because it also records the planner output and how many sources
 *  the run actually ingested. */
export const DeepResearchMetaSchema = z.object({
  template: z.literal('deep_research'),
  status: z.enum(['running', 'ready', 'failed']),
  question: z.string(),
  /** Queries the planner produced. */
  queries: z.array(z.string()),
  /** Sources this run ingested (ids + titles) so the UI can show
   *  what was added without re-querying. */
  ingestedSources: z.array(
    z.object({ id: z.string(), title: z.string(), url: z.string() }),
  ),
  sourceCount: z.number().int().min(0),
  citationCount: z.number().int().min(0),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DeepResearchMeta = z.infer<typeof DeepResearchMetaSchema>;
