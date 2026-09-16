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
  ragflowDatasetId: z.string(), // foreign id in Ragflow
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
  ragflowDocId: z.string().nullable(),
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
