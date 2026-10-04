import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { AudioPlayer } from './AudioPlayer';
import type {
  AudioOverviewDelta,
  AudioOverviewLine,
  AudioOverviewMeta,
} from '@notebook/shared';

interface Props {
  notebookId: string;
  onClose: () => void;
  onCreated?: (artifactId: string) => void;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

/**
 * Audio Overview generation dialog.
 *
 * Drives the SSE script-generation stream and surfaces live progress
 * plus the parsed dialogue. When the server has rendered an mp3
 * (`meta.audioFilename !== null`), the dialog shows an inline
 * `<audio>` player with download + a small meta row (style,
 * lineCount, durationSec). When the artifact is script-only
 * (TTS_PROVIDER=noop), the player is hidden and the existing
 * "audio not rendered" hint is shown instead.
 */
export function AudioOverviewDialog({ notebookId, onClose, onCreated }: Props) {
  const qc = useQueryClient();
  const [style, setStyle] = useState<'deep_dive' | 'short' | 'critique'>('deep_dive');
  const [focus, setFocus] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<AudioOverviewLine[]>([]);
  const [meta, setMeta] = useState<AudioOverviewMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  function start() {
    if (phase === 'running') return;
    setPhase('running');
    setLines([]);
    setMeta(null);
    setError(null);
    const stream = api.ingestAudioOverviewStream(
      notebookId,
      { style, focus: focus.trim() || undefined },
      (delta: AudioOverviewDelta) => {
        if (delta.type === 'script_line') {
          setLines((prev) => [...prev, delta.line]);
        } else if (delta.type === 'meta') {
          setMeta(delta.meta);
        } else if (delta.type === 'error') {
          setError(delta.message);
        }
      },
    );
    stream.promise
      .then((res) => {
        setPhase('done');
        setMeta(res.meta);
        // Refresh artifacts list so the new row shows up immediately.
        qc.invalidateQueries({ queryKey: ['artifacts', notebookId] });
        onCreated?.(res.artifact.id);
      })
      .catch((err: Error) => {
        setError(err.message);
        setPhase('error');
      });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label="Audio Overview"
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border bg-surface shadow-soft"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
      >
        <header className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
        >
          <div>
            <h2 className="text-base font-semibold">Audio Overview</h2>
            <p className="text-xs text-muted">
              Двухголосый подкаст по материалам ноутбука.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-icon"
            title="Закрыть"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </header>

        {phase === 'idle' && (
          <form
            className="space-y-4 px-5 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              start();
            }}
          >
            <div>
              <span className="section-label mb-1.5 block">Стиль</span>
              <div className="flex flex-wrap gap-2">
                {(['deep_dive', 'short', 'critique'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStyle(s)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      style === s
                        ? 'bg-accent text-white'
                        : 'bg-surface-tint text-muted hover:text-ink'
                    }`}
                  >
                    {s === 'deep_dive'
                      ? 'Глубокий разбор (~10 мин)'
                      : s === 'short'
                        ? 'Коротко (~3 мин)'
                        : 'Критика / скептик'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="section-label mb-1.5 block">
                Фокус (опционально)
              </label>
              <input
                className="input"
                placeholder="на что обратить внимание в скрипте"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between gap-2 pt-2">
              <p className="text-xs text-muted">
                Сценарий строится по источникам ноутбука. Если на сервере
                включён TTS-провайдер (например <code>mac-say</code>), в
                артефакт будет добавлен mp3; иначе — только текст.
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="btn btn-secondary">
                  Отмена
                </button>
                <button type="submit" className="btn btn-primary">
                  Сгенерировать
                </button>
              </div>
            </div>
          </form>
        )}

        {(phase === 'running' || phase === 'done' || phase === 'error') && (
          <div className="space-y-3 px-5 py-4">
            <ProgressBar meta={meta} phase={phase} />
            {phase === 'done' && meta?.audioFilename && (
              <AudioPlayer
                src={api.audioUrlByFilename(notebookId, meta.audioFilename)}
                downloadName={meta.audioFilename}
                title="Готовый подкаст"
                meta={
                  [
                    meta.style,
                    `${meta.lineCount} реплик`,
                    meta.durationSec
                      ? `${Math.floor(meta.durationSec / 60)}:${String(meta.durationSec % 60).padStart(2, '0')}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined
                }
                onErrorHint="Не удалось загрузить mp3. Файл мог быть удалён или TTS не отрисовал аудио."
                data-testid="audio-overview-player"
              />
            )}
            <div className="max-h-72 overflow-y-auto rounded-lg border bg-canvas p-3 text-sm"
              style={{ borderColor: 'rgb(var(--nb-border))' }}
              data-testid="audio-overview-transcript"
            >
              {lines.length === 0 && phase === 'running' && (
                <p className="text-muted">Готовлю сценарий…</p>
              )}
              {lines.map((line, i) => (
                <p
                  key={i}
                  className={
                    line.speaker === 'STAGE'
                      ? 'italic text-muted'
                      : line.speaker === 'SCRIPT'
                        ? 'mb-1.5'
                        : 'mb-1.5 pl-4 text-muted-foreground'
                  }
                >
                  {line.speaker === 'STAGE' ? null : (
                    <span className="mr-1 font-semibold">{line.speaker}:</span>
                  )}
                  {line.text}
                </p>
              ))}
            </div>
            {phase === 'error' && error && (
              <p className="text-sm text-red-600">{error}</p>
            )}
            <div className="flex justify-end gap-2">
              {phase === 'done' && meta && meta.audioFilename === null && (
                <span className="self-center text-xs text-muted">
                  Аудио не отрисовано (TTS_PROVIDER=noop) — артефакт содержит
                  только сценарий.
                </span>
              )}
              <button type="button" onClick={onClose} className="btn btn-secondary">
                {phase === 'running' ? 'Свернуть' : 'Закрыть'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressBar({
  meta,
  phase,
}: {
  meta: AudioOverviewMeta | null;
  phase: Phase;
}) {
  // Two-step progress: scripting (0..1) and synthesizing (0..1).
  // We don't get a precise ratio from the server, so we approximate
  // by lineCount or status. When status flips to 'synthesizing',
  // the scripting bar is full and the synthesizing bar starts.
  const scriptingDone =
    phase === 'done' || (meta?.status === 'scripting' && (meta.lineCount ?? 0) > 0);
  const synthesizingDone = phase === 'done';
  const failed = phase === 'error';

  return (
    <div className="space-y-1.5">
      <Step
        label="Сценарий"
        done={scriptingDone}
        active={meta?.status === 'scripting'}
        failed={failed}
        detail={meta ? `${meta.lineCount} реплик` : ''}
      />
      <Step
        label="Озвучка"
        done={synthesizingDone}
        active={meta?.status === 'synthesizing'}
        failed={failed}
        detail={meta?.audioFilename ? 'готов mp3' : 'noop (только скрипт)'}
      />
    </div>
  );
}

function Step({
  label,
  done,
  active,
  failed,
  detail,
}: {
  label: string;
  done: boolean;
  active: boolean;
  failed: boolean;
  detail: string;
}) {
  const dot = failed ? '✕' : done ? '✓' : active ? '●' : '○';
  const color = failed
    ? 'text-red-600'
    : done
      ? 'text-green-600'
      : active
        ? 'text-accent'
        : 'text-muted';
  return (
    <div className="flex items-center justify-between text-xs">
      <span className={color}>
        <span className="mr-1.5 font-semibold">{dot}</span>
        {label}
      </span>
      <span className="text-muted">{detail}</span>
    </div>
  );
}
