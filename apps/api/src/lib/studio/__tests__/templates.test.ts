/**
 * Tests for the Studio template registry.
 *
 * The registry is the source of truth for /api/notebooks/:id/studio/templates
 * and the prompt body used by /api/notebooks/:id/artifacts/studio.
 * These tests pin the contract: every template has a non-empty system
 * prompt, a user-prompt factory that returns a string with the
 * numbered sources block, and a default topK in a sensible range.
 */
import { describe, expect, it } from 'vitest';
import {
  formatSourcesForPrompt,
  getTemplate,
  listTemplates,
} from '../templates.js';
import type { CitationChunk } from '@notebook/shared';

const SAMPLE_CITATIONS: CitationChunk[] = [
  {
    id: 'c1',
    sourceId: 's1',
    sourceTitle: 'A2A protocol',
    sourceKind: 'url',
    text: 'A2A is a protocol for agent delegation.',
    score: 0.1,
    location: 'Фрагмент 1',
  },
  {
    id: 'c2',
    sourceId: 's2',
    sourceTitle: 'MCP servers',
    sourceKind: 'url',
    text: 'MCP is a standard for tool access.',
    score: 0.2,
    location: 'Фрагмент 1',
  },
];

describe('studio templates', () => {
  it('exposes the documented templates', () => {
    const ids = listTemplates().map((t) => t.id).sort();
    expect(ids).toEqual([
      'contradictions',
      'data_table',
      'executive_summary',
      'faq',
      'flashcards',
      'timeline',
    ]);
  });

  it('every template has a non-empty title, blurb, system instructions, and userPrompt', () => {
    for (const tpl of listTemplates()) {
      expect(tpl.title.length, `${tpl.id} title`).toBeGreaterThan(0);
      expect(tpl.blurb.length, `${tpl.id} blurb`).toBeGreaterThan(0);
      expect(tpl.systemInstructions.length, `${tpl.id} system`).toBeGreaterThan(50);
      // userPrompt must be a function that takes focus + sourcesBlock.
      const out = tpl.userPrompt({ sourcesBlock: '## Источники\n[1] A' });
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(20);
    }
  });

  it('defaultTopK is between 4 and 30 (sane retrieval range)', () => {
    for (const tpl of listTemplates()) {
      expect(tpl.defaultTopK, `${tpl.id} topK`).toBeGreaterThanOrEqual(4);
      expect(tpl.defaultTopK, `${tpl.id} topK`).toBeLessThanOrEqual(30);
    }
  });

  it('userPrompt appends the user focus when provided', () => {
    const tpl = getTemplate('faq');
    const out = tpl.userPrompt({ focus: 'про безопасность', sourcesBlock: 'X' });
    expect(out).toContain('про безопасность');
  });

  it('userPrompt omits the focus section when not provided', () => {
    const tpl = getTemplate('timeline');
    const out = tpl.userPrompt({ sourcesBlock: 'X' });
    expect(out).not.toContain('Доп. акцент');
  });

  it('formatSourcesForPrompt renders numbered list with title + location', () => {
    const out = formatSourcesForPrompt(SAMPLE_CITATIONS);
    expect(out).toContain('[1] A2A protocol (Фрагмент 1)');
    expect(out).toContain('[2] MCP servers (Фрагмент 1)');
    expect(out).toContain('A2A is a protocol for agent delegation.');
  });

  it('formatSourcesForPrompt returns a helpful message for an empty list', () => {
    expect(formatSourcesForPrompt([])).toBe('No sources available.');
  });

  it('template userPrompt emits a citations block even when sources is empty', () => {
    const tpl = getTemplate('executive_summary');
    const out = tpl.userPrompt({ sourcesBlock: formatSourcesForPrompt([]) });
    // The downstream route guards against empty citations, but the
    // template should still produce a coherent prompt if asked.
    expect(out).toContain('No sources available.');
  });
});
