// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  answerAsMarkdown,
  conversationAsMarkdown,
  formatDateTime,
  formatTime,
  slugifyFilename,
} from './download';

describe('answerAsMarkdown', () => {
  it('includes the question, the answer and the cited sources', () => {
    const md = answerAsMarkdown('Что такое A2A?', 'Протокол межагентного взаимодействия [1].', [
      { sourceTitle: 'Статья про A2A', text: 'A2A — это протокол.' },
    ]);
    expect(md).toContain('# Что такое A2A?');
    expect(md).toContain('Протокол межагентного взаимодействия [1].');
    expect(md).toContain('## Источники');
    expect(md).toContain('**[1]** Статья про A2A');
  });

  it('works without a question (summary card)', () => {
    const md = answerAsMarkdown(undefined, 'Ключевые темы: A2A, MCP.');
    expect(md).toBe('Ключевые темы: A2A, MCP.\n');
  });

  it('truncates a very long question in the heading', () => {
    const md = answerAsMarkdown('я'.repeat(200), 'ответ');
    expect(md.split('\n')[0]!.length).toBeLessThanOrEqual(82);
    expect(md.split('\n')[0]).toContain('…');
  });

  it('truncates long source snippets', () => {
    const md = answerAsMarkdown('q', 'a', [{ sourceTitle: 'S', text: 'x'.repeat(900) }]);
    expect(md).toContain('…');
    expect(md.length).toBeLessThan(900);
  });

  it('collapses runs of blank lines', () => {
    const md = answerAsMarkdown('q', 'a\n\n\n\nb', []);
    expect(md).not.toMatch(/\n{3}/);
  });
});

describe('conversationAsMarkdown', () => {
  it('renders each turn with its role and timestamp', () => {
    const md = conversationAsMarkdown('Разговор', [
      { role: 'user', content: 'Вопрос', createdAt: '2026-10-04T09:30:00.000Z' },
      { role: 'assistant', content: 'Ответ', createdAt: '2026-10-04T09:31:00.000Z' },
    ]);
    expect(md).toContain('# Разговор');
    expect(md).toContain('## Вопрос');
    expect(md).toContain('## Ответ');
    expect(md).toContain('Вопрос');
    expect(md).toContain('Ответ');
  });

  it('omits the stamp when a turn has no timestamp', () => {
    const md = conversationAsMarkdown('R', [{ role: 'user', content: 'x' }]);
    expect(md).toContain('## Вопрос\n');
  });
});

describe('formatTime / formatDateTime', () => {
  it('renders a time and a full stamp', () => {
    expect(formatTime('2026-10-04T09:30:00.000Z')).toMatch(/\d{1,2}:\d{2}/);
    expect(formatDateTime('2026-10-04T09:30:00.000Z')).toMatch(/2026/);
  });

  it('returns an empty string for missing or invalid values', () => {
    expect(formatTime(null)).toBe('');
    expect(formatTime(undefined)).toBe('');
    expect(formatTime('not a date')).toBe('');
    expect(formatDateTime('')).toBe('');
  });
});

describe('slugifyFilename', () => {
  it('keeps letters and digits, collapses the rest to single dashes', () => {
    expect(slugifyFilename('Что такое A2A?')).toBe('что-такое-a2a');
    expect(slugifyFilename('  A / B  ')).toBe('a-b');
  });

  it('falls back when nothing usable remains', () => {
    expect(slugifyFilename('!!!', 'answer')).toBe('answer');
    expect(slugifyFilename('', 'answer')).toBe('answer');
  });

  it('caps the length', () => {
    expect(slugifyFilename('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});
