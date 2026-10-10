// @vitest-environment jsdom
/**
 * The Sources panel now has a single add-source field. These tests pin
 * the routing rules that decide which dialog it opens — a wrong guess
 * sends the user into the wrong flow, so the rules are worth locking
 * down.
 */
import { describe, expect, it } from 'vitest';
import { classifySourceInput, normalizeUrlInput } from './SourcesPanel';

describe('classifySourceInput', () => {
  it('routes YouTube URLs (all the usual shapes) to the YouTube flow', () => {
    expect(classifySourceInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
    expect(classifySourceInput('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
    expect(classifySourceInput('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
    expect(classifySourceInput('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
    expect(classifySourceInput('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
    expect(classifySourceInput('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('youtube');
  });

  it('treats a bare 11-character video id as YouTube', () => {
    expect(classifySourceInput('dQw4w9WgXcQ')).toBe('youtube');
    expect(classifySourceInput('  dQw4w9WgXcQ  ')).toBe('youtube');
  });

  it('routes other domains to the page-URL flow', () => {
    expect(classifySourceInput('https://example.com/article')).toBe('url');
    expect(classifySourceInput('https://arxiv.org/abs/2401.00001')).toBe('url');
    expect(classifySourceInput('sub.example.org/path')).toBe('url');
    expect(classifySourceInput('http://localhost:3000/x')).toBe('url');
  });

  it('routes free text to web search', () => {
    expect(classifySourceInput('Протокол A2A')).toBe('query');
    expect(classifySourceInput('что такое MCP?')).toBe('query');
    // A single bare word parses as a hostname but has no dot — search.
    expect(classifySourceInput('протоколы')).toBe('query');
  });

  it('treats an empty or whitespace-only value as a search', () => {
    expect(classifySourceInput('')).toBe('query');
    expect(classifySourceInput('   ')).toBe('query');
  });
});

describe('normalizeUrlInput', () => {
  it('prepends https:// so a scheme-less paste passes the API url() check', () => {
    expect(normalizeUrlInput('habr.com/ru/articles/123')).toBe('https://habr.com/ru/articles/123');
    expect(normalizeUrlInput('sub.example.org/path')).toBe('https://sub.example.org/path');
    expect(normalizeUrlInput('  example.com  ')).toBe('https://example.com');
  });

  it('leaves an already-schemed URL untouched', () => {
    expect(normalizeUrlInput('https://example.com/article')).toBe('https://example.com/article');
    expect(normalizeUrlInput('http://localhost:3000/x')).toBe('http://localhost:3000/x');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeUrlInput('')).toBe('');
    expect(normalizeUrlInput('   ')).toBe('');
  });
});
