/**
 * Tests for parseDataTableStream.
 */
import { describe, expect, it } from 'vitest';
import { parseDataTableStream } from '../../../routes/studio.js';

describe('parseDataTableStream', () => {
  it('parses a clean JSON object', () => {
    const text = JSON.stringify({
      title: 'Сравнение',
      columns: ['Name', 'Role'],
      rows: [
        { Name: 'A2A', Role: 'agent protocol' },
        { Name: 'MCP', Role: 'tool protocol' },
      ],
    });
    const t = parseDataTableStream(text);
    expect(t).not.toBeNull();
    expect(t!.columns).toEqual(['Name', 'Role']);
    expect(t!.rows).toHaveLength(2);
    expect(t!.rows[0]!.Name).toBe('A2A');
    expect(t!.title).toBe('Сравнение');
  });

  it('tolerates ```json fences', () => {
    const text = 'Вот таблица:\n```json\n{"columns":["A"],"rows":[{"A":"v1"}]}\n```\n';
    const t = parseDataTableStream(text);
    expect(t).toEqual({ columns: ['A'], rows: [{ A: 'v1' }] });
  });

  it('extracts the JSON object even when surrounded by prose', () => {
    const text = 'Перед таблицей слова.\n{"columns":["C"],"rows":[{"C":"x"}]}\nПосле таблицы.';
    const t = parseDataTableStream(text);
    expect(t).toEqual({ columns: ['C'], rows: [{ C: 'x' }] });
  });

  it('drops rows whose cells are all empty', () => {
    const text = JSON.stringify({
      columns: ['A', 'B'],
      rows: [
        { A: 'v1', B: 'v2' },
        { A: '', B: '' },
        { A: 'v3' }, // missing B → keeps with B absent
      ],
    });
    const t = parseDataTableStream(text)!;
    // The empty row is dropped; the partial row is kept.
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]!.A).toBe('v1');
    expect(t.rows[1]!.A).toBe('v3');
  });

  it('drops cells with keys not in columns (extra keys are not added to columns)', () => {
    const text = JSON.stringify({
      columns: ['A'],
      rows: [{ A: 'keep', B: 'drop' }],
    });
    const t = parseDataTableStream(text)!;
    expect(t.rows[0]!.A).toBe('keep');
    expect((t.rows[0]! as Record<string, unknown>).B).toBeUndefined();
  });

  it('coerces non-string cell values to strings (numbers, booleans)', () => {
    const text = JSON.stringify({
      columns: ['A', 'B'],
      rows: [{ A: 42, B: true }],
    });
    const t = parseDataTableStream(text)!;
    expect(t.rows[0]!.A).toBe('42');
    expect(t.rows[0]!.B).toBe('true');
  });

  it('drops empty columns and de-duplicates by first occurrence', () => {
    const text = JSON.stringify({
      columns: ['A', '', 'A', '  ', 'B'],
      rows: [{ A: 'v', B: 'w' }],
    });
    const t = parseDataTableStream(text)!;
    expect(t.columns).toEqual(['A', 'B']);
  });

  it('returns null when no JSON object is found', () => {
    expect(parseDataTableStream('Привет, мир')).toBeNull();
    expect(parseDataTableStream('')).toBeNull();
  });

  it('returns null when columns is empty or missing', () => {
    expect(parseDataTableStream('{"columns":[],"rows":[{"A":"v"}]}')).toBeNull();
    expect(parseDataTableStream('{"rows":[{"A":"v"}]}')).toBeNull();
  });

  it('returns null when no rows survive the empty-cell filter', () => {
    const text = JSON.stringify({
      columns: ['A', 'B'],
      rows: [
        { A: '', B: '' },
        { A: '', B: '' },
      ],
    });
    expect(parseDataTableStream(text)).toBeNull();
  });

  it('caps rows at 500 (UI safety)', () => {
    const many = Array.from({ length: 800 }, (_, i) => ({ A: `v${i}` }));
    const text = JSON.stringify({ columns: ['A'], rows: many });
    const t = parseDataTableStream(text)!;
    expect(t.rows).toHaveLength(500);
  });
});
