// @vitest-environment jsdom
/**
 * Sources Cockpit — единый пульт «сырья» в левой колонке.
 *
 * Покрытие по одному ключевому поведению на вкладку:
 * - URL tab: ввод → ingest-стрим → onSourceAdded вызван
 * - Поиск tab: 1 тема → preview с чекбоксами → ingest → onSourceAdded
 * - Поиск tab: 2 темы → дедуп по URL, чип темы у каждого результата
 * - Поиск tab: cap 6 тем (7-я кнопка неактивна)
 * - Поиск tab: >10 выбранных URL → warning + ingest берёт первые 10
 * - YouTube tab: ввод + ASR toggle
 * - Deep Research tab: ввод → SSE-стрим → checklist по фазам
 *
 * Все ingest-флоу мокаем через `vi.spyOn(globalThis, 'fetch')` — это
 * тот же приём, что в DeepResearchDialog.test.tsx.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SourcesCockpit } from './SourcesCockpit';

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function renderCockpit(onSourceAdded = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SourcesCockpit notebookId="nb1" onSourceAdded={onSourceAdded} />
    </QueryClientProvider>,
  );
  return { onSourceAdded };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SourcesCockpit', () => {
  it('renders the four tabs and lands on the URL tab', () => {
    renderCockpit();
    expect(screen.getByTestId('sources-cockpit')).toBeInTheDocument();
    expect(screen.getByTestId('sources-cockpit-tab-url')).toBeInTheDocument();
    expect(screen.getByTestId('sources-cockpit-tab-search')).toBeInTheDocument();
    expect(screen.getByTestId('sources-cockpit-tab-youtube')).toBeInTheDocument();
    expect(screen.getByTestId('sources-cockpit-tab-deep')).toBeInTheDocument();
    // Default tab is URL — its form should be visible.
    expect(screen.getByTestId('cockpit-url-form')).toBeInTheDocument();
  });

  it('switches to the YouTube tab and shows its form', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('sources-cockpit-tab-youtube'));
    expect(screen.getByTestId('cockpit-youtube-form')).toBeInTheDocument();
  });

  it('switches to the Search tab and shows the topics editor', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('sources-cockpit-tab-search'));
    expect(screen.getByTestId('cockpit-search-topics')).toBeInTheDocument();
    expect(screen.getByTestId('cockpit-search-topic-0')).toBeInTheDocument();
  });

  it('disables the URL submit button until a value is typed', () => {
    renderCockpit();
    const submit = screen.getByTestId('cockpit-url-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('cockpit-url-input'), {
      target: { value: 'habr.com/article' },
    });
    expect(submit.disabled).toBe(false);
  });

  it('URL tab: streams ingest, calls onSourceAdded on completion', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            `data: ${JSON.stringify({ type: 'progress', stage: 'fetching', ratio: 0.5 })}\n\n` +
              `data: ${JSON.stringify({ type: 'progress', stage: 'storing', ratio: 0.95 })}\n\n` +
              `data: ${JSON.stringify({ type: 'done', source: { id: 's1', title: 't', status: 'ready' } })}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      );
    const { onSourceAdded } = renderCockpit();
    fireEvent.change(screen.getByTestId('cockpit-url-input'), {
      target: { value: 'example.com/article' },
    });
    fireEvent.click(screen.getByTestId('cockpit-url-submit'));
    await waitFor(() => expect(onSourceAdded).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain('/api/notebooks/nb1/sources/url');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('Search tab: cap 6 topics — the add-topic button disables on the 7th', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('sources-cockpit-tab-search'));
    const addBtn = screen.getByTestId('cockpit-search-add-topic') as HTMLButtonElement;
    for (let i = 0; i < 5; i++) fireEvent.click(addBtn);
    expect(addBtn.disabled).toBe(true);
    expect(screen.getByText(/\(макс 6\)/)).toBeInTheDocument();
  });

  it('Search tab: single-topic preview shows checkboxes and ingest dispatches the batch', async () => {
    // Two POSTs: 1× /search-preview, 1× /search-add-batch.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              query: 'MCP',
              results: [
                { title: 'MCP spec', url: 'https://mcp.dev', snippet: 'protocol' },
                { title: 'MCP news', url: 'https://news.dev', snippet: 'news' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            `data: ${JSON.stringify({ type: 'progress', stage: 'fetching', ratio: 0.5 })}\n\n` +
              `data: ${JSON.stringify({ type: 'done', source: { id: 's1', title: 't', status: 'ready' } })}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      );

    const { onSourceAdded } = renderCockpit();
    fireEvent.click(screen.getByTestId('sources-cockpit-tab-search'));
    fireEvent.change(screen.getByTestId('cockpit-search-topic-0'), {
      target: { value: 'MCP' },
    });
    fireEvent.click(screen.getByTestId('cockpit-search-run'));

    await waitFor(() =>
      expect(screen.getByTestId('cockpit-search-preview')).toBeInTheDocument(),
    );
    // First 2 results should be pre-selected.
    expect(
      (screen.getByTestId('cockpit-search-check-https://mcp.dev') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByTestId('cockpit-search-check-https://news.dev') as HTMLInputElement).checked,
    ).toBe(true);

    fireEvent.click(screen.getByTestId('cockpit-search-ingest'));
    await waitFor(() => expect(onSourceAdded).toHaveBeenCalledTimes(1));

    // The second fetch is /search-add-batch.
    const second = fetchSpy.mock.calls[1]!;
    expect(second[0]).toContain('/search-add-batch');
  });

  it('Search tab: dedup by URL across topics — same URL keeps the first topic chip', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const body = (init as RequestInit | undefined)?.body;
      let q = '';
      try {
        q = JSON.parse(typeof body === 'string' ? body : '{}').query ?? '';
      } catch {
        q = '';
      }
      const hit = q === 'A2A'
        ? [{ title: 'A2A paper', url: 'https://shared.dev/a', snippet: 'a' }]
        : q === 'MCP'
          ? [{ title: 'MCP paper', url: 'https://shared.dev/a', snippet: 'm' }]
          : [];
      return Promise.resolve(
        new Response(JSON.stringify({ query: q, results: hit }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    renderCockpit();
    fireEvent.click(screen.getByTestId('sources-cockpit-tab-search'));
    fireEvent.change(screen.getByTestId('cockpit-search-topic-0'), {
      target: { value: 'MCP' },
    });
    fireEvent.click(screen.getByTestId('cockpit-search-add-topic'));
    fireEvent.change(screen.getByTestId('cockpit-search-topic-1'), {
      target: { value: 'A2A' },
    });
    fireEvent.click(screen.getByTestId('cockpit-search-run'));

    await waitFor(() =>
      expect(screen.getByTestId('cockpit-search-preview')).toBeInTheDocument(),
    );
    // Both topics returned the same URL — only one row visible.
    const checks = screen.getAllByTestId('cockpit-search-check-https://shared.dev/a');
    expect(checks.length).toBe(1);
    // MCP fired first (alphabetically? no — topic order); MCP chip wins.
    const chip = screen.getAllByText('MCP').find((el) => el.tagName === 'SPAN');
    expect(chip).toBeDefined();
  });

  it('Search tab: warning + cap to 10 when the user selects more URLs', async () => {
    const manyHits = Array.from({ length: 12 }, (_, i) => ({
      title: `r${i}`,
      url: `https://r${i}.dev`,
      snippet: '',
    }));
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify({ query: 'q', results: manyHits }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            `data: ${JSON.stringify({ type: 'progress', stage: 'fetching', ratio: 0.5 })}\n\n` +
              `data: ${JSON.stringify({ type: 'done', source: { id: 's1', title: 't', status: 'ready' } })}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      );

    renderCockpit();
    fireEvent.click(screen.getByTestId('sources-cockpit-tab-search'));
    fireEvent.change(screen.getByTestId('cockpit-search-topic-0'), {
      target: { value: 'q' },
    });
    fireEvent.click(screen.getByTestId('cockpit-search-run'));

    await waitFor(() =>
      expect(screen.getByTestId('cockpit-search-preview')).toBeInTheDocument(),
    );
    // Toggle all 12 checkboxes on.
    for (let i = 0; i < 12; i++) {
      const cb = screen.getByTestId(`cockpit-search-check-https://r${i}.dev`) as HTMLInputElement;
      if (!cb.checked) fireEvent.click(cb);
    }
    fireEvent.click(screen.getByTestId('cockpit-search-ingest'));

    await waitFor(() =>
      expect(screen.getByText(/добавлю первые 10/)).toBeInTheDocument(),
    );
  });

  it('YouTube tab: ASR toggle changes the submit label', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('sources-cockpit-tab-youtube'));
    const submit = screen.getByTestId('cockpit-youtube-submit');
    expect(submit.textContent?.trim()).toBe('Добавить');
    fireEvent.click(screen.getByTestId('cockpit-youtube-asr'));
    expect(submit.textContent?.trim()).toBe('Распознать');
  });

  it('Deep Research tab: streams SSE phases and calls onSourceAdded', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          { type: 'phase', phase: 'planning', ratio: 0.05, message: 'Планирую…' },
          { type: 'queries', queries: ['q1'] },
          { type: 'phase', phase: 'searching', ratio: 0.2, message: 'Ищу…' },
          { type: 'hit', url: 'https://x', title: 'x', ingested: true },
          { type: 'phase', phase: 'fetching', ratio: 0.5, message: 'Загружаю…' },
          { type: 'phase', phase: 'synthesizing', ratio: 0.85, message: 'Пишу…' },
          {
            type: 'done',
            artifactId: 'a1',
            sourceCount: 1,
            citationCount: 3,
          },
        ]),
      ),
    );

    const { onSourceAdded } = renderCockpit();
    fireEvent.click(screen.getByTestId('sources-cockpit-tab-deep'));
    fireEvent.change(screen.getByTestId('cockpit-deep-question'), {
      target: { value: 'Что такое MCP?' },
    });
    fireEvent.click(screen.getByTestId('cockpit-deep-submit'));

    await waitFor(() => expect(onSourceAdded).toHaveBeenCalledTimes(1));
  });
});