// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SuggestionsChips } from './SuggestionsChips';

function sseResponse(events: Array<{ type: string; suggestions?: string[]; message?: string }>) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // Default fetch mock: the tests below override per-case.
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(sseResponse([{ type: 'suggestions', suggestions: ['q1', 'q2', 'q3'] }])),
  );
});

describe('SuggestionsChips', () => {
  it('shows a loading placeholder until the suggestions arrive', () => {
    // Block the fetch so loading state is visible.
    let resolveFetch: ((v: Response) => void) | null = null;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    render(
      <SuggestionsChips
        notebookId="nb1"
        question="q"
        answer="a"
        onPick={() => undefined}
      />,
    );
    expect(screen.getByTestId('suggestions-loading')).toBeInTheDocument();
    if (resolveFetch) resolveFetch(sseResponse([{ type: 'suggestions', suggestions: ['q1'] }]));
  });

  it('renders one chip per suggestion once the SSE delivers the list', async () => {
    render(
      <SuggestionsChips
        notebookId="nb1"
        question="q"
        answer="a"
        onPick={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('suggestions-chips')).toBeInTheDocument());
    const chips = screen.getAllByTestId('suggestion-chip');
    expect(chips).toHaveLength(3);
    expect(chips[0]!.textContent).toBe('q1');
    expect(chips[1]!.textContent).toBe('q2');
    expect(chips[2]!.textContent).toBe('q3');
  });

  it('fires onPick with the chip text when clicked', async () => {
    const onPick = vi.fn();
    render(
      <SuggestionsChips
        notebookId="nb1"
        question="q"
        answer="a"
        onPick={onPick}
      />,
    );
    await waitFor(() => screen.getByTestId('suggestions-chips'));
    fireEvent.click(screen.getAllByTestId('suggestion-chip')[1]!);
    expect(onPick).toHaveBeenCalledWith('q2');
  });

  it('hides the row when the server returns 503 (feature disabled)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'disabled' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { container } = render(
      <SuggestionsChips
        notebookId="nb1"
        question="q"
        answer="a"
        onPick={() => undefined}
      />,
    );
    await waitFor(() => {
      // No chips, no loading — component is null.
      expect(container.firstChild).toBeNull();
    });
  });

  it('sends an error event through the SSE → hides the row', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([{ type: 'error', message: 'parseable JSON expected' }]),
      ),
    );
    const { container } = render(
      <SuggestionsChips
        notebookId="nb1"
        question="q"
        answer="a"
        onPick={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('aborts the in-flight fetch on unmount', async () => {
    const abortSpy = vi.fn();
    const originalAbortController = globalThis.AbortController;
    const wrappedController = class {
      controller: AbortController;
      constructor() {
        this.controller = new originalAbortController();
      }
      get signal() {
        return this.controller.signal;
      }
      abort() {
        abortSpy();
        this.controller.abort();
      }
    };
    // Patch AbortController globally so the component picks it up.
    (globalThis as { AbortController: typeof AbortController }).AbortController =
      wrappedController as unknown as typeof AbortController;
    const { unmount } = render(
      <SuggestionsChips
        notebookId="nb1"
        question="q"
        answer="a"
        onPick={() => undefined}
      />,
    );
    unmount();
    (globalThis as { AbortController: typeof AbortController }).AbortController =
      originalAbortController;
    expect(abortSpy).toHaveBeenCalled();
  });
});
