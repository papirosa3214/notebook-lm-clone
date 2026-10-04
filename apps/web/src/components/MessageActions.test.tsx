// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageActions } from './MessageActions';

let createdUrls: number;

beforeEach(() => {
  createdUrls = 0;
  // jsdom ships no createObjectURL at all, so it has to be defined
  // rather than spied on.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: () => {
      createdUrls++;
      return 'blob:mock';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MessageActions', () => {
  it('shows the time the answer was given', () => {
    render(<MessageActions createdAt="2026-10-04T09:30:00.000Z" markdown="x" />);
    const stamp = screen.getByTestId('message-timestamp');
    expect(stamp.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('shows a kind label next to the time when provided', () => {
    render(<MessageActions createdAt="2026-10-04T09:30:00.000Z" markdown="x" kindLabel="обзор" />);
    expect(screen.getByTestId('message-timestamp').textContent).toContain('обзор');
  });

  it('copies the markdown and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<MessageActions markdown={'# Ответ\n\nтекст'} />);

    fireEvent.click(screen.getByTestId('action-copy'));
    await waitFor(() => expect(screen.getByTestId('action-copy').textContent).toContain('скопировано'));
    expect(writeText).toHaveBeenCalledWith('# Ответ\n\nтекст');
  });

  it('reports a clipboard failure instead of silently doing nothing', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    // execCommand fallback also unavailable
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });

    render(<MessageActions markdown="x" />);
    fireEvent.click(screen.getByTestId('action-copy'));
    await waitFor(() => expect(screen.getByTestId('action-copy').textContent).toContain('не удалось'));
  });

  it('downloads the markdown as a .md file', () => {
    render(<MessageActions markdown="# Заголовок" filename="ответ-a2a" />);
    fireEvent.click(screen.getByTestId('action-download'));
    expect(createdUrls).toBe(1);
  });

  it('offers "В заметки" only when a handler is supplied', () => {
    const { rerender } = render(<MessageActions markdown="x" />);
    expect(screen.queryByTestId('action-save-note')).toBeNull();

    const onSaveNote = vi.fn();
    rerender(<MessageActions markdown="x" onSaveNote={onSaveNote} />);
    fireEvent.click(screen.getByTestId('action-save-note'));
    expect(onSaveNote).toHaveBeenCalledTimes(1);
  });
});
