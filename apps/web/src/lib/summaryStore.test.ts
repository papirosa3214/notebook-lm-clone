// @vitest-environment jsdom
/**
 * The pinned summary used to require a manual ↻ click, and the button
 * was hidden while the card was empty — so a notebook with sources and
 * no cached summary showed nothing at all. These tests pin the
 * auto-generation path and the idempotency that makes it safe under
 * React StrictMode's double mount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSummaryStore,
  ensureSummaryStarted,
  getSummaryState,
  refreshSummary,
  subscribeSummary,
} from './summaryStore';

/** Minimal SSE body: citations, a few tokens, then done. */
function sse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const THREE_EVENTS =
  `data: ${JSON.stringify({ type: 'citations', chunks: [{ id: 'c1', sourceId: 's1', sourceTitle: 'A', sourceKind: 'url', text: 'x' }] })}\n\n` +
  `data: ${JSON.stringify({ type: 'token', text: 'Обзор ' })}\n\n` +
  `data: ${JSON.stringify({ type: 'token', text: 'готов.' })}\n\n` +
  `data: ${JSON.stringify({ type: 'done', summaryId: 'sum1' })}\n\n`;

beforeEach(() => {
  __resetSummaryStore();
  localStorage.clear();
});

afterEach(() => {
  __resetSummaryStore();
  vi.restoreAllMocks();
});

describe('summaryStore', () => {
  it('auto-generates once and exposes the streamed content', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(sse(THREE_EVENTS)));

    ensureSummaryStarted('nb1');
    await vi.waitFor(() => expect(getSummaryState('nb1').streaming).toBe(false));

    const state = getSummaryState('nb1');
    expect(state.content).toBe('Обзор готов.');
    expect(state.citations).toHaveLength(1);
    expect(state.savedAt).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Persisted for the next visit.
    expect(localStorage.getItem('nb.summary.nb1')).toBeTruthy();
  });

  it('is idempotent while a stream is in flight (StrictMode double mount)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(sse(THREE_EVENTS)));

    // Two calls in a row, as StrictMode's probe + real mount produce.
    ensureSummaryStarted('nb2');
    ensureSummaryStarted('nb2');
    await vi.waitFor(() => expect(getSummaryState('nb2').streaming).toBe(false));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not re-stream when a cached summary already exists', async () => {
    localStorage.setItem(
      'nb.summary.nb3',
      JSON.stringify({ content: 'Из кэша', citations: [], savedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    ensureSummaryStarted('nb3');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getSummaryState('nb3').content).toBe('Из кэша');
  });

  it('refreshSummary discards the cache and streams again', async () => {
    localStorage.setItem(
      'nb.summary.nb4',
      JSON.stringify({ content: 'Старое', citations: [], savedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(sse(THREE_EVENTS)));

    refreshSummary('nb4');
    await vi.waitFor(() => expect(getSummaryState('nb4').streaming).toBe(false));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(getSummaryState('nb4').content).toBe('Обзор готов.');
  });

  it('notifies subscribers and rebuilds the snapshot object each change', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(sse(THREE_EVENTS)),
    );
    const seen: string[] = [];
    const before = getSummaryState('nb5');
    subscribeSummary('nb5', () => seen.push(getSummaryState('nb5').content));

    ensureSummaryStarted('nb5');
    await vi.waitFor(() => expect(getSummaryState('nb5').streaming).toBe(false));

    expect(seen.length).toBeGreaterThan(0);
    // Identity must change, otherwise useSyncExternalStore never re-renders.
    expect(getSummaryState('nb5')).not.toBe(before);
  });

  it('surfaces a stream error instead of hanging in the loading state', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(sse(`data: ${JSON.stringify({ type: 'error', message: 'нет источников' })}\n\n`)),
    );
    ensureSummaryStarted('nb6');
    await vi.waitFor(() => expect(getSummaryState('nb6').error).toBe('нет источников'));
    expect(getSummaryState('nb6').streaming).toBe(false);
  });
});
