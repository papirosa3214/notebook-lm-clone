import { useState } from 'react';

interface Props {
  /** Direct URL to the audio (mp3). The parent owns the URL
   *  construction so the component stays generic. */
  src: string;
  /** Suggested filename for the download button. The component
   *  uses it as `download` attribute, which browsers honour
   *  when the file is same-origin. */
  downloadName: string;
  /** Optional title for the player block. Rendered above the
   *  controls as a small heading. */
  title?: string;
  /** Optional right-aligned meta row (e.g. "00:42 · 3 реплики").
   *  Rendered as a small `<span>` next to the title. */
  meta?: string;
  /** Optional error fallback shown if the audio fails to load.
   *  We surface the message instead of letting the browser show
   *  a generic one — the user has no context for "MEDIA_ERR". */
  onErrorHint?: string;
  /** Optional inline styling on the outer container. Useful for
   *  embedding into a dialog without re-creating the wrapper. */
  className?: string;
  /** Forwarded to the outer wrapper. Mostly for tests that need
   *  a stable hook into the rendered subtree. */
  'data-testid'?: string;
}

/**
 * Minimal `<audio controls>` wrapper used for Audio Overview
 * playback. The native HTML5 player is enough — we don't need a
 * custom waveform or progress scrubber for the first iteration.
 *
 * On click, the browser may show "this audio file is corrupt"
 * if the server returns 404. We catch that with the
 * `onError` listener and render `onErrorHint` so the dialog
 * stays useful (the transcript is still readable below).
 *
 * Touch-target safe: native controls handle their own sizing
 * on mobile and the download button uses the global `.btn`
 * (36 px min height via the styles.css update in milestone E1).
 */
export function AudioPlayer({
  src,
  downloadName,
  title,
  meta,
  onErrorHint,
  className = '',
  ...rest
}: Props) {
  const [errored, setErrored] = useState(false);
  return (
    <div
      className={`rounded-2xl border bg-surface px-3 py-2.5 ${className}`}
      style={{ borderColor: 'rgb(var(--nb-border) / 0.6)' }}
      data-testid={rest['data-testid'] ?? 'audio-player'}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        {title ? (
          <span className="font-medium text-ink" data-testid="audio-player-title">
            {title}
          </span>
        ) : (
          <span />
        )}
        {meta ? (
          <span className="text-muted" data-testid="audio-player-meta">
            {meta}
          </span>
        ) : null}
      </div>
      {errored ? (
        <p className="text-xs text-red-600" data-testid="audio-player-error">
          {onErrorHint ?? 'Не удалось загрузить аудио. Файл мог быть удалён или ещё рендерится.'}
        </p>
      ) : (
        <audio
          controls
          preload="metadata"
          src={src}
          onError={() => setErrored(true)}
          data-testid="audio-player-element"
          className="w-full"
        >
          Ваш браузер не поддерживает <code>audio</code>.
        </audio>
      )}
      <div className="mt-2 flex justify-end">
        <a
          href={src}
          download={downloadName}
          className="btn btn-secondary text-xs"
          data-testid="audio-player-download"
        >
          Скачать .mp3
        </a>
      </div>
    </div>
  );
}
