import { describe, expect, it } from 'vitest';
import { containsUncitedNoSourceAnswer } from './ChatPanel';
import type { ChatMessage } from '../lib/types';

const uncitedNoSource: ChatMessage = {
  role: 'assistant',
  content: 'Нет, в предоставленных данных указано: «No sources available».',
  citations: [],
};

describe('containsUncitedNoSourceAnswer', () => {
  it('flags an old no-source reply once sources are ready', () => {
    expect(containsUncitedNoSourceAnswer([uncitedNoSource], 6)).toBe(true);
  });

  it('does not flag a no-source reply while the notebook still has no ready source', () => {
    expect(containsUncitedNoSourceAnswer([uncitedNoSource], 0)).toBe(false);
  });

  it('does not flag a grounded response', () => {
    const grounded: ChatMessage = {
      role: 'assistant',
      content: 'A2A connects agents [1].',
      citations: [
        {
          id: 'c1',
          sourceId: 's1',
          sourceTitle: 'Source',
          sourceKind: 'url',
          text: 'A2A connects agents.',
          score: 0.9,
        },
      ],
    };
    expect(containsUncitedNoSourceAnswer([grounded], 6)).toBe(false);
  });
});
