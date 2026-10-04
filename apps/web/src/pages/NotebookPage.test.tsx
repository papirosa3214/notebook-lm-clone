// @vitest-environment jsdom
/**
 * Regression tests for NotebookPage's render lifecycle.
 *
 * The page returns early while the notebook query is loading and on
 * error. Any hook declared *below* those returns changes the hook count
 * between renders, which makes React throw "Rendered more hooks than
 * during the previous render" and blanks the entire page. That is
 * exactly what happened when useSwipe() was added after the loading
 * branch: every notebook opened to a blank screen.
 *
 * These tests pin the loading → loaded transition, which is the render
 * sequence that exposed it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import NotebookPage from './NotebookPage';

/** jsdom ships no matchMedia; useTheme needs it to resolve a theme. */
function stubMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Route the handful of endpoints NotebookPage touches. `notebookDelay`
 *  lets a test hold the notebook query open to observe the loading
 *  render before the loaded one. */
function mockApi(opts: { notebookDelayMs?: number; notebookFails?: boolean } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/sources')) return json({ sources: [] });
    if (url.includes('/messages')) return json({ messages: [] });
    if (url.includes('/artifacts')) return json({ artifacts: [] });
    if (url.includes('/api/notebooks/')) {
      if (opts.notebookDelayMs) await new Promise((r) => setTimeout(r, opts.notebookDelayMs));
      if (opts.notebookFails) return json({ error: 'nope' }, 500);
      return json({ id: 'nb1', title: 'Тестовый ноутбук', description: '' });
    }
    return json({});
  });
}

function renderPage(path = '/notebooks/nb1') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/notebooks/:id" element={<NotebookPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
}

beforeEach(() => {
  stubMatchMedia();
  // Layout is persisted; a fresh page must not inherit another test's.
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('NotebookPage', () => {
  it('renders the loading state first, then the loaded page without a hook-order change', async () => {
    mockApi({ notebookDelayMs: 20 });
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args[0]);
    });

    renderPage();

    // Loading branch.
    expect(screen.getByText('Загрузка ноутбука…')).toBeInTheDocument();

    // Loaded branch — this transition is what used to throw
    // "Rendered more hooks than during the previous render".
    await waitFor(() => expect(screen.getByTestId('notebook-center')).toBeInTheDocument());
    expect(screen.getByText('Тестовый ноутбук')).toBeInTheDocument();

    // The mobile tab strip and its page indicator are present.
    expect(screen.getByTestId('mobile-tab-indicator')).toBeInTheDocument();

    // React must not have logged a hook-order / render error.
    const hookError = errors.find(
      (e) => typeof e === 'string' && e.includes('more hooks than during the previous render'),
    );
    expect(hookError).toBeUndefined();
    spy.mockRestore();
  });

  it('renders the error branch when the notebook fails to load', async () => {
    mockApi({ notebookFails: true });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Не удалось загрузить ноутбук')).toBeInTheDocument(),
    );
  });

  it('opens the notes panel when the viewport has room for it', async () => {
    setViewportWidth(1500);
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('notebook-center')).toBeInTheDocument());
    expect(screen.getByTestId('notes-panel')).toBeInTheDocument();
  });

  it('keeps the notes panel collapsed on a narrow viewport so the chat gets the width', async () => {
    // Two open side panels (300 + 340 px) leave a phone-width strip for
    // the chat at this size, which is what made the desktop layout read
    // as the mobile one.
    setViewportWidth(1100);
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('notebook-center')).toBeInTheDocument());
    expect(screen.queryByTestId('notes-panel')).toBeNull();
  });

  it('exposes the Deep Research entry point in the header', async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('notebook-center')).toBeInTheDocument());
    expect(screen.getByTestId('open-deep-research')).toBeInTheDocument();
  });
});
