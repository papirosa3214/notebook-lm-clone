import type {
  ProviderId as ProviderIdT,
  ChatMessage as ChatMessageT,
  CitationChunk as CitationChunkT,
  ChatRole as ChatRoleT,
} from './index.js';

// Re-export types so downstream code can keep importing them from '@notebook/shared/providers'.
export type ProviderId = ProviderIdT;
export type ChatMessage = ChatMessageT;
export type CitationChunk = CitationChunkT;
export type ChatRole = ChatRoleT;

/**
 * Streaming chat delta from an LLM provider.
 * Backends emit tokens; the wrapper normalizes them.
 */
export interface ChatStreamEvent {
  /** incremental assistant token (may contain partial UTF-8) */
  text?: string;
  /** finished: backend signalled end-of-stream */
  done?: boolean;
}

export interface ProviderChatRequest {
  /** retrieved chunks to ground the answer */
  context: CitationChunk[];
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  /** max tokens for the answer */
  maxTokens?: number;
  /** id of the provider, useful for log lines */
  providerId: ProviderId;
}

export interface LLMProvider {
  readonly id: ProviderId;
  /** model id used when caller asks for default */
  readonly defaultModel: string;
  /** list models advertised by the backend */
  listModels(): Promise<string[]>;
  /** stream a chat completion; must yield ChatStreamEvents */
  chat(req: ProviderChatRequest): AsyncIterable<ChatStreamEvent>;
}

/**
 * Marker that tells the model to cite sources with [N] markers.
 *
 * Strict version (verified answering): the model must refuse to invent
 * citations and must surface the special `UNSUPPORTED:` prefix when no
 * chunk answers the question. The chat route post-processes the stream
 * via `sanitizeCitations` (see below) to drop any `[N]` marker whose
 * index is out of range — the prompt just makes that vanishingly rare.
 */
export const CITATION_INSTRUCTIONS = [
  'You are a research assistant answering questions strictly from the provided sources.',
  'For every claim, append a citation marker like [1], [2] in the text.',
  'You may use at most N citations, where N is the number of provided sources. Indices are 1-based and must be within this range.',
  'If NONE of the provided sources contain enough information to answer, reply with EXACTLY one line: "UNSUPPORTED: <short reason>". Do not add [N] markers and do not invent facts.',
  'If the answer is only partially in the sources, ground the parts that are and explicitly say which parts you could not verify.',
  'Be concise. Use markdown.',
].join('\n');

/**
 * Sentinel prefix that the chat route treats as a hard refusal: the rest
 * of the answer is dropped, the assistant row is stored as-is, and the
 * UI shows it as the model's own statement rather than a system error.
 */
export const UNSUPPORTED_PREFIX = 'UNSUPPORTED:';

/**
 * Post-process a streamed assistant answer so the user never sees a
 * `[N]` marker pointing at a citation the model was never shown.
 *
 * Rules (applied in order):
 *  1. If `text` starts with `UNSUPPORTED_PREFIX`, return it as-is.
 *  2. Replace any `[N]` whose N is outside `1..citationCount` with `[?]`.
 *     Out-of-range markers are kept visible (as `[?]`) rather than
 *     silently deleted so the user notices the model tried to cite
 *     something it shouldn't have.
 *  3. If the resulting text is empty (only whitespace), return an empty
 *     string — the route then sends a single token event so the SSE
 *     still terminates normally.
 */
export function sanitizeCitations(text: string, citationCount: number): string {
  if (text.startsWith(UNSUPPORTED_PREFIX)) return text;
  return text.replace(/\[(\d+)\]/g, (match, n: string) => {
    const idx = Number.parseInt(n, 10);
    if (Number.isNaN(idx) || idx < 1 || idx > citationCount) {
      return '[?]';
    }
    return match;
  });
}

/** Format retrieved chunks for the system prompt as a numbered list. */
export function formatContextForPrompt(context: CitationChunk[]): string {
  if (context.length === 0) return 'No sources available.';
  return context
    .map((c, i) => {
      const loc = c.location ? ` (${c.location})` : '';
      return `[${i + 1}] ${c.sourceTitle}${loc}\n${c.text}`;
    })
    .join('\n\n---\n\n');
}
