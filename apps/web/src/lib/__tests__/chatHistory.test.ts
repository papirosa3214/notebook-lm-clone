/**
 * Unit tests for buildChatHistory — the function that picks the right
 * rows out of the in-memory messages array before sending them back to
 * the LLM. Tested in isolation so the rules are explicit and easy to
 * audit (this is the only piece of logic the Source Workspace v1 plan
 * requires for chat continuity, and the trim rules are the easy thing
 * to get wrong).
 */

import { describe, expect, it } from 'vitest';
import { buildChatHistory } from '../chatHistory';
import type { ChatMessage } from '../types';

function m(
  over: { role?: 'user' | 'assistant' | 'system'; content: string } & {
    pending?: boolean;
    error?: string;
  },
): ChatMessage {
  // Tests synthesise rows with arbitrary role (incl. 'system' for the
  // "drop system messages" assertion). The chat pipeline only emits
  // user/assistant rows, but buildChatHistory must drop 'system' rows
  // defensively. We widen through unknown because ChatMessage's role
  // union doesn't include 'system' — that's the whole point of the
  // "drop system" assertion.
  return over as unknown as ChatMessage;
}

describe('buildChatHistory', () => {
  it('returns an empty array for empty input', () => {
    expect(buildChatHistory([])).toEqual([]);
  });

  it('drops system messages', () => {
    const msgs = [
      m({ role: 'system', content: 'hidden' }),
      m({ role: 'user', content: 'hi' }),
    ];
    expect(buildChatHistory(msgs)).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops empty / error / pending rows', () => {
    const msgs: ChatMessage[] = [
      m({ role: 'user', content: 'real question' }),
      m({ role: 'assistant', content: '', pending: true }),
      m({ role: 'assistant', content: 'real answer' }),
      m({ role: 'assistant', content: 'broken', error: 'oops' }),
    ];
    expect(buildChatHistory(msgs)).toEqual([
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: 'real answer' },
    ]);
  });

  it('keeps at most maxTurns tail rows', () => {
    const msgs: ChatMessage[] = Array.from({ length: 20 }, (_, i) =>
      m({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` }),
    );
    const out = buildChatHistory(msgs, { maxTurns: 4 });
    expect(out).toHaveLength(4);
    expect(out.map((m) => m.content)).toEqual(['turn 16', 'turn 17', 'turn 18', 'turn 19']);
  });

  it('drops oldest turns when total content exceeds maxChars', () => {
    const longA = 'a'.repeat(2000);
    const longB = 'b'.repeat(2000);
    const longC = 'c'.repeat(2000);
    const msgs: ChatMessage[] = [
      m({ role: 'user', content: longA }),
      m({ role: 'assistant', content: longB }),
      m({ role: 'user', content: longC }),
    ];
    // budget = 4500 chars: can hold B+C (4000) but not A+B+C (6000)
    const out = buildChatHistory(msgs, { maxChars: 4500 });
    expect(out.map((m) => m.content)).toEqual([longB, longC]);
  });

  it('preserves chronological order', () => {
    const msgs: ChatMessage[] = [
      m({ role: 'user', content: '1' }),
      m({ role: 'assistant', content: '2' }),
      m({ role: 'user', content: '3' }),
    ];
    expect(buildChatHistory(msgs).map((m) => m.content)).toEqual(['1', '2', '3']);
  });
});
