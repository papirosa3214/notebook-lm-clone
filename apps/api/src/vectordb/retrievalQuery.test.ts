import { describe, expect, it } from 'vitest';
import { buildFtsQuery } from './client.js';

describe('buildFtsQuery', () => {
  it('uses OR for meaningful words in a natural-language Russian question', () => {
    expect(
      buildFtsQuery('Как правильно настроить взаимодействие между агентами?'),
    ).toBe('правильно OR настроить OR взаимодействие OR агентами');
  });

  it('returns null when the question contains only stop words', () => {
    expect(buildFtsQuery('как и в')).toBeNull();
  });

  it('keeps alphanumeric technical terms searchable', () => {
    expect(buildFtsQuery('Что такое A2A?')).toBe('a2a');
  });
});
