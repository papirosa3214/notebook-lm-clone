// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DeepResearchDialog } from './DeepResearchDialog';

function sseResponse(events: Array<Record<string, unknown>>) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function renderDialog(onClose = vi.fn(), onCreated = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DeepResearchDialog notebookId="nb1" onClose={onClose} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return { onClose, onCreated };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DeepResearchDialog', () => {
  it('shows the question form with the start button disabled until a question is typed', () => {
    renderDialog();
    const start = screen.getByTestId('deep-research-start') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('deep-research-question'), {
      target: { value: 'Что такое A2A?' },
    });
    expect(start.disabled).toBe(false);
  });

  it('renders all four phases once the run starts', () => {
    // Never-resolving fetch keeps the dialog in the running phase.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
    renderDialog();
    fireEvent.change(screen.getByTestId('deep-research-question'), {
      target: { value: 'q' },
    });
    fireEvent.click(screen.getByTestId('deep-research-start'));

    expect(screen.getByTestId('deep-research-phase-planning')).toBeInTheDocument();
    expect(screen.getByTestId('deep-research-phase-searching')).toBeInTheDocument();
    expect(screen.getByTestId('deep-research-phase-fetching')).toBeInTheDocument();
    expect(screen.getByTestId('deep-research-phase-synthesizing')).toBeInTheDocument();
  });

  it('walks the phase checklist, renders queries/hits/report and finishes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          { type: 'phase', phase: 'planning', ratio: 0.05, message: 'Планирую…' },
          { type: 'queries', queries: ['q1', 'q2'] },
          { type: 'phase', phase: 'searching', ratio: 0.2 },
          { type: 'phase', phase: 'fetching', ratio: 0.4 },
          { type: 'hit', url: 'https://a.example', title: 'A', ingested: true },
          { type: 'hit', url: 'https://b.example', title: 'B', ingested: false, reason: '404' },
          { type: 'phase', phase: 'synthesizing', ratio: 0.78 },
          { type: 'token', text: '# Отчёт\n' },
          { type: 'token', text: 'Вывод [1].' },
          { type: 'done', artifactId: 'art42', sourceCount: 1, citationCount: 3 },
        ]),
      ),
    );
    const { onCreated } = renderDialog();
    fireEvent.change(screen.getByTestId('deep-research-question'), {
      target: { value: 'Что такое A2A?' },
    });
    fireEvent.click(screen.getByTestId('deep-research-start'));

    await waitFor(() => expect(screen.getByTestId('deep-research-queries')).toBeInTheDocument());
    expect(screen.getByTestId('deep-research-queries').textContent).toContain('q1');
    expect(screen.getByTestId('deep-research-queries').textContent).toContain('q2');

    const hits = screen.getByTestId('deep-research-hits');
    expect(hits.textContent).toContain('A');
    expect(hits.textContent).toContain('B');

    await waitFor(() => expect(screen.getByTestId('deep-research-report')).toBeInTheDocument());
    expect(screen.getByTestId('deep-research-report').textContent).toContain('Вывод [1].');

    await waitFor(() => expect(screen.getByTestId('deep-research-done')).toBeInTheDocument());
    expect(screen.getByTestId('deep-research-done').textContent).toContain('заметках');
    expect(onCreated).toHaveBeenCalledWith('art42');
  });

  it('surfaces an SSE error event', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          { type: 'phase', phase: 'planning', ratio: 0.05 },
          { type: 'error', message: 'поиск не вернул результатов' },
        ]),
      ),
    );
    renderDialog();
    fireEvent.change(screen.getByTestId('deep-research-question'), {
      target: { value: 'q' },
    });
    fireEvent.click(screen.getByTestId('deep-research-start'));

    await waitFor(() => expect(screen.getByTestId('deep-research-error')).toBeInTheDocument());
    expect(screen.getByTestId('deep-research-error').textContent).toContain(
      'поиск не вернул результатов',
    );
  });

  it('sends the question and the two caps in the request body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() =>
        Promise.resolve(sseResponse([{ type: 'error', message: 'stop' }])),
      );
    renderDialog();
    fireEvent.change(screen.getByTestId('deep-research-question'), {
      target: { value: 'исследуй это' },
    });
    fireEvent.change(screen.getByTestId('deep-research-max-queries'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByTestId('deep-research-max-sources'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByTestId('deep-research-start'));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notebooks/nb1/deep-research');
    const body = JSON.parse(init.body as string) as {
      question: string;
      maxQueries: number;
      maxSources: number;
    };
    expect(body.question).toBe('исследуй это');
    expect(body.maxQueries).toBe(2);
    expect(body.maxSources).toBe(7);
  });
});
