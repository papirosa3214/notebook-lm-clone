/**
 * buildSections decides how the sources panel is laid out, and the
 * checkboxes under it build the chat's context scope. A source rendered
 * in two sections would toggle inconsistently depending on which copy
 * the user clicked, so the partition guarantee is worth locking down.
 */
import { describe, expect, it } from 'vitest';
import { buildSections } from './SourcesPanel';
import type { Source } from '../lib/types';

function source(id: string, overrides: Partial<Source> = {}): Source {
  return {
    id,
    notebookId: 'nb1',
    kind: 'url',
    title: `Источник ${id}`,
    url: `https://example.com/${id}`,
    status: 'ready',
    error: null,
    createdAt: '2026-10-13T00:00:00.000Z',
    summary: null,
    summaryTopics: null,
    summarizedAt: null,
    ...overrides,
  };
}

const SOURCES = [source('a'), source('b'), source('c'), source('d')];

describe('buildSections', () => {
  it('returns nothing when the server sent no groups, so the panel stays flat', () => {
    expect(buildSections(SOURCES, [])).toEqual([]);
  });

  it('keeps the server order and the ids inside each section', () => {
    const sections = buildSections(SOURCES, [
      { title: 'Шифрование', sourceIds: ['a', 'b'] },
      { title: 'Кванты', sourceIds: ['c', 'd'] },
    ]);
    expect(sections.map((s) => s.title)).toEqual(['Шифрование', 'Кванты']);
    expect(sections[0]!.sources.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('files an unclaimed source under «Другие» instead of dropping it', () => {
    const sections = buildSections(SOURCES, [{ title: 'Шифрование', sourceIds: ['a'] }]);
    expect(sections).toHaveLength(2);
    expect(sections[1]!.title).toBe('Другие');
    expect(sections[1]!.sources.map((s) => s.id)).toEqual(['b', 'c', 'd']);
  });

  it('claims a doubled source under the first section only', () => {
    const sections = buildSections(SOURCES, [
      { title: 'Первое', sourceIds: ['a', 'b'] },
      { title: 'Второе', sourceIds: ['b', 'c'] },
    ]);
    expect(sections[0]!.sources.map((s) => s.id)).toEqual(['a', 'b']);
    expect(sections[1]!.sources.map((s) => s.id)).toEqual(['c']);
  });

  it('ignores ids the visible list does not contain (filter narrowed the list)', () => {
    const sections = buildSections([source('a')], [
      { title: 'Шифрование', sourceIds: ['a', 'b', 'c'] },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.sources.map((s) => s.id)).toEqual(['a']);
  });

  it('skips a section that matches nothing in the visible list', () => {
    const sections = buildSections([source('a')], [{ title: 'Пусто', sourceIds: ['zz'] }]);
    // Everything still has to be visible — the fallback section carries it.
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe('Другие');
    expect(sections[0]!.sources.map((s) => s.id)).toEqual(['a']);
  });

  it('always partitions the visible list, whatever the input', () => {
    const sections = buildSections(SOURCES, [
      { title: 'Одно', sourceIds: ['a'] },
      { title: 'Два', sourceIds: ['b', 'c'] },
    ]);
    const flat = sections.flatMap((s) => s.sources.map((x) => x.id));
    expect(flat.slice().sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('renders nothing for an empty source list', () => {
    expect(buildSections([], [{ title: 'Пусто', sourceIds: ['a'] }])).toEqual([]);
  });
});