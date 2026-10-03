/**
 * Tests for the flashcard stream parser.
 *
 * The parser is the only piece of business logic in the flashcards
 * template that's worth unit-testing on its own. The route-level
 * smoke covers the end-to-end (see studio.smoke.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { parseFlashcardStream } from '../../../routes/studio.js';

describe('parseFlashcardStream', () => {
  it('parses a clean JSON array', () => {
    const text = JSON.stringify([
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2?', answer: 'A2.' },
    ]);
    const cards = parseFlashcardStream(text);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.question).toBe('Q1');
    expect(cards[1]!.answer).toBe('A2.');
    // Each card gets a stable id.
    expect(typeof cards[0]!.id).toBe('string');
    expect(cards[0]!.id.length).toBeGreaterThan(4);
  });

  it('tolerates ```json fences around the array', () => {
    const text = 'Вот ваши карточки:\n```json\n[{"question":"q","answer":"a"}]\n```\nУдачи!';
    const cards = parseFlashcardStream(text);
    expect(cards).toEqual([
      expect.objectContaining({ question: 'q', answer: 'a' }),
    ]);
  });

  it('extracts the JSON array even when surrounded by prose', () => {
    const text = 'Вот ответы:\n[{"question":"q1","answer":"a1"},{"question":"q2","answer":"a2"}]\nГотово.';
    const cards = parseFlashcardStream(text);
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.question)).toEqual(['q1', 'q2']);
  });

  it('strips // line comments before parsing', () => {
    const text = `[
      // first question
      {"question":"q1","answer":"a1"},
      // second question
      {"question":"q2","answer":"a2"}
    ]`;
    const cards = parseFlashcardStream(text);
    expect(cards).toHaveLength(2);
  });

  it('returns an empty array for garbage input', () => {
    expect(parseFlashcardStream('Привет, как дела?')).toEqual([]);
    expect(parseFlashcardStream('not json at all')).toEqual([]);
  });

  it('returns an empty array for an empty array input', () => {
    // The parser bails when the resulting list has length 0 — a
    // valid empty JSON array is treated as "no cards" because the
    // schema requires min(1).
    expect(parseFlashcardStream('[]')).toEqual([]);
  });

  it('skips entries that are missing question or answer', () => {
    const text = JSON.stringify([
      { question: 'q1', answer: 'a1' },
      { question: 'q2' }, // missing answer
      { answer: 'a3' }, // missing question
      { question: '', answer: 'a4' }, // empty question
      { question: 'q5', answer: 'a5' },
    ]);
    const cards = parseFlashcardStream(text);
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.question)).toEqual(['q1', 'q5']);
  });

  it('caps the result at 60 cards (UI sanity)', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      question: `q${i}`,
      answer: `a${i}`,
    }));
    const cards = parseFlashcardStream(JSON.stringify(many));
    expect(cards).toHaveLength(60);
  });
});
