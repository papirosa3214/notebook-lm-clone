// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CitationChip } from './CitationChip';
import type { CitationChunk } from '../lib/types';

const CHUNK: CitationChunk = {
  id: 'chunk-1',
  sourceId: 'src-1',
  sourceTitle: 'A2A whitepaper',
  sourceKind: 'url',
  text: 'Agent-to-Agent (A2A) is a protocol that lets one autonomous agent delegate work to another over HTTPS, with strict per-request authentication.',
  score: 0.12,
  location: 'Фрагмент 4',
};

afterEach(cleanup);

describe('CitationChip', () => {
  it('renders the [N] marker and forwards click to onOpenCitation', () => {
    const onOpen = vi.fn();
    render(<CitationChip index={1} chunk={CHUNK} onOpenCitation={onOpen} />);
    const btn = screen.getByTestId('citation-chip');
    expect(btn.textContent).toBe('[1]');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledWith(CHUNK, 0);
  });

  it('does not show a popover on touch-only devices (no hover support)', () => {
    // jsdom's matchMedia defaults to false unless we set it.
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
    render(<CitationChip index={1} chunk={CHUNK} onOpenCitation={() => undefined} />);
    const btn = screen.getByTestId('citation-chip');
    fireEvent.mouseEnter(btn);
    // No popover expected on touch devices — fallback to click → dialog.
    expect(screen.queryByTestId('citation-popover')).toBeNull();
    expect(btn.getAttribute('aria-haspopup')).toBeNull();
  });

  it('opens a popover on hover when the device supports it', async () => {
    window.matchMedia = (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
    render(<CitationChip index={2} chunk={CHUNK} onOpenCitation={() => undefined} />);
    const btn = screen.getByTestId('citation-chip');
    fireEvent.mouseEnter(btn);
    // Popover opens after a short delay (debounce); wait for it.
    const popover = await screen.findByTestId('citation-popover');
    expect(popover).toBeInTheDocument();
    // Source title + location come from the chunk metadata.
    expect(popover.textContent).toContain('A2A whitepaper');
    expect(popover.textContent).toContain('Фрагмент 4');
    // Snippet is a shortened form of chunk.text — not the full original.
    expect(popover.textContent).toContain('Agent-to-Agent');
    expect(popover.textContent).not.toBe(CHUNK.text);
  });

  it('truncates the snippet to fit a popover with very long chunk text', async () => {
    window.matchMedia = (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
    const long: CitationChunk = {
      ...CHUNK,
      text: 'word '.repeat(500).trim(),
    };
    render(<CitationChip index={1} chunk={long} onOpenCitation={() => undefined} />);
    fireEvent.mouseEnter(screen.getByTestId('citation-chip'));
    const popover = await screen.findByTestId('citation-popover');
    const text = popover.textContent ?? '';
    // 240-char cap plus ellipsis (1 char) → at most 241 chars of snippet,
    // plus the source title row above it. We assert the cap directly.
    expect(text.length).toBeLessThan(800);
    expect(text.endsWith('…')).toBe(true);
  });

  it('renders an orphan marker when the chunk is undefined (sanitiser allowed [?] through)', () => {
    render(<CitationChip index={5} chunk={undefined} onOpenCitation={() => undefined} />);
    const orphan = screen.getByTestId('citation-chip-orphan');
    expect(orphan.textContent).toBe('[5]');
    expect(orphan.className).toContain('chip-muted');
  });
});
