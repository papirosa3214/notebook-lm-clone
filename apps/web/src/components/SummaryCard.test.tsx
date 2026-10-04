// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SummaryCard } from './SummaryCard';
import { __resetSummaryStore } from '../lib/summaryStore';

function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const STREAM =
  `data: ${JSON.stringify({ type: 'citations', chunks: [] })}\n\n` +
  `data: ${JSON.stringify({ type: 'token', text: 'Ключевые темы: A2A, MCP.' })}\n\n` +
  `data: ${JSON.stringify({ type: 'done', summaryId: 's1' })}\n\n`;

beforeEach(() => {
  __resetSummaryStore();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  __resetSummaryStore();
  vi.restoreAllMocks();
});

describe('SummaryCard', () => {
  it('renders nothing while the notebook has no ready sources', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { container } = render(<SummaryCard notebookId="nb1" readyCount={0} />);
    expect(container.firstChild).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('appears immediately and generates on its own once a source is ready', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(sse(STREAM)));

    render(<SummaryCard notebookId="nb2" readyCount={1} />);

    // Visible before the first token — the user should see it working.
    expect(screen.getByTestId('summary-card')).toBeInTheDocument();
    expect(screen.getByText(/Составляю обзор/)).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText(/Ключевые темы/)).toBeInTheDocument(),
    );
    // One request, triggered by mounting — no ↻ click needed.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('shows the cached summary without re-streaming', async () => {
    localStorage.setItem(
      'nb.summary.nb3',
      JSON.stringify({ content: 'Старый обзор', citations: [], savedAt: '2026-02-02T00:00:00.000Z' }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(<SummaryCard notebookId="nb3" readyCount={2} />);
    expect(screen.getByText('Старый обзор')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stamps when the overview was generated', async () => {
    localStorage.setItem(
      'nb.summary.nb5',
      JSON.stringify({ content: 'Обзор', citations: [], savedAt: '2026-10-04T09:30:00.000Z' }),
    );
    render(<SummaryCard notebookId="nb5" readyCount={1} />);
    // Full date *and* time, not just "1 источник" — the user asked when
    // it was said. The clock value is rendered in the local zone, so we
    // assert the shape rather than a specific hour.
    const meta = screen.getByText(/2026/);
    expect(meta.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('offers copy / download / save-as-note on the overview', () => {
    localStorage.setItem(
      'nb.summary.nb6',
      JSON.stringify({ content: 'Обзор', citations: [], savedAt: '2026-10-04T09:30:00.000Z' }),
    );
    const onSaveNote = vi.fn();
    render(<SummaryCard notebookId="nb6" readyCount={1} onSaveNote={onSaveNote} />);

    expect(screen.getByTestId('action-copy')).toBeInTheDocument();
    expect(screen.getByTestId('action-download')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('action-save-note'));
    expect(onSaveNote).toHaveBeenCalledWith('Обзор', []);
  });

  it('suggests starter questions once the overview exists', async () => {
    localStorage.setItem(
      'nb.summary.nb7',
      JSON.stringify({ content: 'Обзор протоколов', citations: [], savedAt: '2026-10-04T09:30:00.000Z' }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          `data: ${JSON.stringify({ type: 'suggestions', suggestions: ['Что такое A2A?'] })}\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    );
    const onAsk = vi.fn();
    render(<SummaryCard notebookId="nb7" readyCount={1} onAsk={onAsk} />);

    await waitFor(() => expect(screen.getByTestId('suggestions-chips')).toBeInTheDocument());
    fireEvent.click(screen.getAllByTestId('suggestion-chip')[0]!);
    expect(onAsk).toHaveBeenCalledWith('Что такое A2A?');
  });

  it('renders a stream error instead of spinning forever', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(sse(`data: ${JSON.stringify({ type: 'error', message: 'нет источников' })}\n\n`)),
    );
    render(<SummaryCard notebookId="nb4" readyCount={1} />);
    await waitFor(() => expect(screen.getByTestId('summary-error')).toBeInTheDocument());
    expect(screen.getByTestId('summary-error').textContent).toContain('нет источников');
  });
});
