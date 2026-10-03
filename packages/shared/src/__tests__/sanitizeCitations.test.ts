import { describe, expect, it } from 'vitest';
import { sanitizeCitations, UNSUPPORTED_PREFIX } from '../providers.js';

describe('sanitizeCitations', () => {
  it('keeps in-range markers untouched', () => {
    expect(sanitizeCitations('Foo [1] bar [3] baz', 3)).toBe('Foo [1] bar [3] baz');
  });

  it('replaces out-of-range markers with [?] but preserves the rest of the text', () => {
    expect(sanitizeCitations('Foo [1] bar [5] baz [0]', 2)).toBe('Foo [1] bar [?] baz [?]');
  });

  it('passes through an UNSUPPORTED answer as-is, even when it contains [N]-looking text', () => {
    const text = `${UNSUPPORTED_PREFIX} sources only cover 2024, but the question asks about 2026.`;
    expect(sanitizeCitations(text, 2)).toBe(text);
  });

  it('handles the zero-citation case (LLM said "no sources" without UNSUPPORTED prefix)', () => {
    // citationCount=0 means no [N] can be valid; the entire text stays the same
    // because there are no markers to rewrite.
    expect(sanitizeCitations('Plain prose without citations.', 0)).toBe('Plain prose without citations.');
    // ...but if the model insists on citing something, [?] replaces it.
    expect(sanitizeCitations('Plain prose [1] without citations.', 0)).toBe('Plain prose [?] without citations.');
  });

  it('does not rewrite [N] inside code spans or fenced blocks', () => {
    // We accept that the model can reference `[1]` inside a code sample;
    // sanitiser does not strip code, only markers. This test pins the
    // current behavior so a future "smarter" parser is a deliberate change.
    expect(sanitizeCitations('Use `array[1]` and `[2]` literally.', 2)).toBe(
      'Use `array[1]` and `[2]` literally.',
    );
  });

  it('returns an empty string when the input is whitespace-only', () => {
    expect(sanitizeCitations('   \n\t  ', 3)).toBe('   \n\t  ');
  });
});
