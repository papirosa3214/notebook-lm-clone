// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AiEditMenu } from './AiEditMenu';

function sseResponse(events: Array<{ type: string; text?: string; output?: string; message?: string }>) {
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
  // Default fetch returns a no-op stream; per-test overrides
  // install their own.
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(sseResponse([{ type: 'token', text: 'x' }, { type: 'done', output: 'x' }])),
  );
});

describe('AiEditMenu', () => {
  it('renders nothing when anchor is null', () => {
    const { container } = render(
      <AiEditMenu
        fullText="hello world"
        selection="hello"
        selectionStart={0}
        selectionEnd={5}
        artifactId="art1"
        onReplace={() => undefined}
        onDismiss={() => undefined}
        onError={() => undefined}
        anchor={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders three instruction buttons + dismiss when anchor is provided', () => {
    render(
      <AiEditMenu
        fullText="hello world"
        selection="hello"
        selectionStart={0}
        selectionEnd={5}
        artifactId="art1"
        onReplace={() => undefined}
        onDismiss={() => undefined}
        onError={() => undefined}
        anchor={{ x: 100, y: 200 }}
      />,
    );
    expect(screen.getByTestId('ai-edit-rewrite')).toBeInTheDocument();
    expect(screen.getByTestId('ai-edit-expand')).toBeInTheDocument();
    expect(screen.getByTestId('ai-edit-shorten')).toBeInTheDocument();
    expect(screen.getByTestId('ai-edit-dismiss')).toBeInTheDocument();
  });

  it('calls onReplace with the streamed output when rewrite finishes', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          { type: 'token', text: 'Hi ' },
          { type: 'token', text: 'there.' },
          { type: 'done', output: 'Hi there.' },
        ]),
      ),
    );
    const onReplace = vi.fn();
    const onError = vi.fn();
    render(
      <AiEditMenu
        fullText="hello"
        selection="hello"
        selectionStart={0}
        selectionEnd={5}
        artifactId="art1"
        onReplace={onReplace}
        onDismiss={() => undefined}
        onError={onError}
        anchor={{ x: 100, y: 200 }}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-edit-rewrite'));
    await waitFor(() => expect(onReplace).toHaveBeenCalledWith('Hi there.'));
    expect(onError).not.toHaveBeenCalled();
  });

  it('forwards the instruction name to the fetch body', async () => {
    const fetchSpy = (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        Promise.resolve(
          sseResponse([{ type: 'token', text: 'expanded' }, { type: 'done', output: 'expanded' }]),
        ),
    );
    render(
      <AiEditMenu
        fullText="x"
        selection="x"
        selectionStart={0}
        selectionEnd={1}
        artifactId="art1"
        onReplace={() => undefined}
        onDismiss={() => undefined}
        onError={() => undefined}
        anchor={{ x: 0, y: 0 }}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-edit-expand'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const callArgs = (fetchSpy.mock.calls[0] as [string, RequestInit])[1];
    const body = JSON.parse(callArgs.body as string) as { instruction: string; fullText: string };
    expect(body.instruction).toBe('expand');
    expect(body.fullText).toBe('x');
  });

  it('calls onError when the SSE stream emits an error event', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([{ type: 'error', message: 'model exploded' }]),
      ),
    );
    const onError = vi.fn();
    const onReplace = vi.fn();
    render(
      <AiEditMenu
        fullText="x"
        selection="x"
        selectionStart={0}
        selectionEnd={1}
        artifactId="art1"
        onReplace={onReplace}
        onDismiss={() => undefined}
        onError={onError}
        anchor={{ x: 0, y: 0 }}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-edit-shorten'));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('model exploded'));
    expect(onReplace).not.toHaveBeenCalled();
  });

  it('calls onError when fetch rejects', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.reject(new Error('network down')),
    );
    const onError = vi.fn();
    render(
      <AiEditMenu
        fullText="x"
        selection="x"
        selectionStart={0}
        selectionEnd={1}
        artifactId="art1"
        onReplace={() => undefined}
        onDismiss={() => undefined}
        onError={onError}
        anchor={{ x: 0, y: 0 }}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-edit-rewrite'));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('network down'));
  });

  it('invokes onDismiss when the close button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <AiEditMenu
        fullText="x"
        selection="x"
        selectionStart={0}
        selectionEnd={1}
        artifactId="art1"
        onReplace={() => undefined}
        onDismiss={onDismiss}
        onError={() => undefined}
        anchor={{ x: 0, y: 0 }}
      />,
    );
    fireEvent.click(screen.getByTestId('ai-edit-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
