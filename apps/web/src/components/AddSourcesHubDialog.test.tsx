// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AddSourcesHubDialog } from './AddSourcesHubDialog';

function renderDialog(props: Partial<Parameters<typeof AddSourcesHubDialog>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onSourceAdded = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <AddSourcesHubDialog
        notebookId="nb_test"
        onClose={onClose}
        onSourceAdded={onSourceAdded}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose, onSourceAdded };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AddSourcesHubDialog', () => {
  it('renders all tabs and defaults to files', () => {
    renderDialog();
    expect(screen.getByTestId('add-sources-hub-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('hub-tab-files')).toBeInTheDocument();
    expect(screen.getByTestId('hub-tab-url')).toBeInTheDocument();
    expect(screen.getByTestId('hub-tab-youtube')).toBeInTheDocument();
    expect(screen.getByTestId('hub-tab-deep')).toBeInTheDocument();
    expect(screen.getByTestId('hub-tab-search')).toBeInTheDocument();
    expect(screen.getByTestId('hub-tab-text')).toBeInTheDocument();

    expect(screen.getByText(/Перетащите файлы сюда/i)).toBeInTheDocument();
  });

  it('switches to URL tab and allows entering a URL', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('hub-tab-url'));
    expect(screen.getByPlaceholderText(/https:\/\/habr\.com/i)).toBeInTheDocument();
  });

  it('switches to YouTube tab and displays the Whisper ASR checkbox', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('hub-tab-youtube'));
    expect(screen.getByText(/Распознать речь через Whisper ASR/i)).toBeInTheDocument();
  });

  it('switches to Deep Research tab with settings sliders', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('hub-tab-deep'));
    expect(screen.getByPlaceholderText(/Сформулируйте задачу/i)).toBeInTheDocument();
    expect(screen.getByText(/Поисковых запросов/i)).toBeInTheDocument();
    expect(screen.getByText(/Лимит источников/i)).toBeInTheDocument();
  });

  it('switches to Text tab and allows creating a markdown note', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('hub-tab-text'));
    expect(screen.getByPlaceholderText(/Например: Тезисы встречи/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Вставьте скопированный текст/i)).toBeInTheDocument();
  });
});
