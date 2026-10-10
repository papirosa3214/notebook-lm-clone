// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AudioPlayer } from './AudioPlayer';

afterEach(cleanup);

describe('AudioPlayer', () => {
  it('renders the audio element with the given src and a download link', () => {
    render(
      <AudioPlayer
        src="/api/audio/nb1/abc.mp3"
        downloadName="abc.mp3"
        title="Подкаст"
        meta="short · 4 реплики"
      />,
    );
    const audio = screen.getByTestId('audio-player-element') as HTMLAudioElement;
    expect(audio.src).toContain('/api/audio/nb1/abc.mp3');
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(audio.getAttribute('preload')).toBe('metadata');

    const link = screen.getByTestId('audio-player-download') as HTMLAnchorElement;
    expect(link.getAttribute('download')).toBe('abc.mp3');
    expect(link.getAttribute('href')).toContain('/api/audio/nb1/abc.mp3');

    expect(screen.getByTestId('audio-player-title').textContent).toBe('Подкаст');
    expect(screen.getByTestId('audio-player-meta').textContent).toBe('short · 4 реплики');
  });

  it('omits the title and meta blocks when not provided', () => {
    render(<AudioPlayer src="/x.mp3" downloadName="x.mp3" />);
    expect(screen.queryByTestId('audio-player-title')).toBeNull();
    expect(screen.queryByTestId('audio-player-meta')).toBeNull();
  });

  it('renders the error hint when the audio element fires onError', () => {
    render(
      <AudioPlayer
        src="/missing.mp3"
        downloadName="missing.mp3"
        onErrorHint="Файл не найден"
      />,
    );
    const audio = screen.getByTestId('audio-player-element');
    fireEvent.error(audio);
    expect(screen.getByTestId('audio-player-error').textContent).toBe('Файл не найден');
    expect(screen.queryByTestId('audio-player-element')).toBeNull();
  });

  it('uses a default error hint when the prop is not provided', () => {
    render(<AudioPlayer src="/missing.mp3" downloadName="missing.mp3" />);
    fireEvent.error(screen.getByTestId('audio-player-element'));
    const err = screen.getByTestId('audio-player-error');
    expect(err.textContent).toMatch(/Не удалось загрузить/);
  });

  it('forwards data-testid to the outer wrapper', () => {
    render(
      <AudioPlayer
        src="/x.mp3"
        downloadName="x.mp3"
        data-testid="custom-player"
      />,
    );
    expect(screen.getByTestId('custom-player')).toBeInTheDocument();
  });
});
