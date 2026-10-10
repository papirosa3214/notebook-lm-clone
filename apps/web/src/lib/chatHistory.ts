/**
 * Build the `history` payload for streamChat from the in-memory
 * `messages` array.
 *
 * Rules (from the Source Workspace v1 plan):
 *  - take the last N rows where role is 'user' or 'assistant' (skip
 *    any synthetic system messages — there shouldn't be any but we
 *    defend against it)
 *  - skip rows that are empty or marked as `error` (the assistant
 *    "blinked" but recovered — we don't want to send those to the LLM)
 *  - apply a character budget so retrieval context stays the
 *    priority; once we exceed it, drop the oldest turns (FIFO) until
 *    the remaining turns fit
 *
 * Returns the array in chronological order (oldest first) so the LLM
 * sees the conversation in the right direction.
 */

import type { ChatMessage } from './types';

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_CHARS = 6000;

export function buildChatHistory(
  messages: ChatMessage[],
  opts: { maxTurns?: number; maxChars?: number } = {},
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  // Filter to valid, non-empty, non-error turns.
  const valid = messages
    .filter(
      (m): m is ChatMessage & { role: 'user' | 'assistant'; content: string } =>
        (m.role === 'user' || m.role === 'assistant') &&
        !m.error &&
        !m.pending &&
        typeof m.content === 'string' &&
        m.content.length > 0,
    )
    // Already in chronological order in our store; take the tail.
    .slice(-maxTurns);

  // Apply the character budget by dropping oldest first.
  let totalChars = valid.reduce((sum, m) => sum + m.content.length, 0);
  let start = 0;
  while (totalChars > maxChars && start < valid.length - 1) {
    totalChars -= valid[start]!.content.length;
    start += 1;
  }
  const trimmed = valid.slice(start);

  // Strip the `ChatMessage`-only fields (pending/error/etc.) so the
  // payload matches ChatStreamOptions['history'] shape exactly.
  return trimmed.map((m) => ({ role: m.role, content: m.content }));
}
