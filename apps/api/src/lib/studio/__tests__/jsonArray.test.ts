/**
 * Unit tests for the shared parseJsonArray helper. The same parser
 * is used by flashcards and (lightly extended) by data_table. We
 * pin the contract here so future changes to the studio template
 * parsers have a single source of truth to look at.
 */
import { describe, expect, it } from 'vitest';
import { parseJsonArray } from '../jsonArray.js';

describe('parseJsonArray', () => {
  it('parses a clean array', () => {
    expect(parseJsonArray('["a","b"]')).toEqual(['a', 'b']);
  });

  it('extracts the array from prose wrapping', () => {
    expect(parseJsonArray('Перед слова.\n["x","y"]\nПосле слов.')).toEqual(['x', 'y']);
  });

  it('tolerates ```json fences', () => {
    expect(parseJsonArray('```json\n[1, 2, 3]\n```')).toEqual([1, 2, 3]);
  });

  it('strips // line comments before parse', () => {
    expect(parseJsonArray('[\n // foo\n "a"\n]')).toEqual(['a']);
  });

  it('returns an empty array for garbage input', () => {
    expect(parseJsonArray('Привет, мир')).toEqual([]);
    expect(parseJsonArray('')).toEqual([]);
    expect(parseJsonArray('{"a":1}')).toEqual([]); // object, not array
  });

  it('respects the limit argument', () => {
    expect(parseJsonArray('["a","b","c","d","e"]', 3)).toEqual(['a', 'b', 'c']);
  });
});
