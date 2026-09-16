import type { ChatMessage, CitationChunk, ProviderId } from './index.js';

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

/** Marker that tells the model to cite sources with [N] markers. */
export const CITATION_INSTRUCTIONS = [
  'You are a research assistant answering questions strictly from the provided sources.',
  'For every claim, append a citation marker like [1], [2] in the text.',
  'If the answer is not in the sources, say so plainly.',
  'Be concise. Use markdown.',
].join('\n');

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
