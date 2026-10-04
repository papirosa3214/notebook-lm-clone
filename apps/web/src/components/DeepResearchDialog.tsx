import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { DeepResearchDelta, DeepResearchPhase } from '@notebook/shared';

interface Props {
  notebookId: string;
  onClose: () => void;
  /** Called once the run persisted its report artifact. */
  onCreated?: (artifactId: string) => void;
}

type UiPhase = 'idle' | 'running' | 'done' | 'error';

interface Hit {
  url: string;
  title: string;
  ingested: boolean;
  reason?: string;
}

const PHASE_ORDER: DeepResearchPhase[] = ['planning', 'searching', 'fetching', 'synthesizing'];

const PHASE_LABEL: Record<DeepResearchPhase, string> = {
  planning: 'Планирование',
  searching: 'Поиск',
  fetching: 'Загрузка источников',
  synthesizing: 'Синтез отчёта',
  done: 'Готово',
  failed: 'Ошибка',
};

/**
 * Deep Research dialog.
 *
 * One text input (the research question) plus two sliders that cap the
 * run cost: how many queries the planner may emit and how many web
 * results we actually ingest. Progress is driven entirely by the SSE
 * stream — each `phase` event moves the checklist, `hit` events fill
 * the source list, `token` events build the report preview.
 */
export function DeepResearchDialog({ notebookId, onClose, onCreated }: Props) {
  const qc = useQueryClient();
  const [question, setQuestion] = useState('');
  const [maxQueries, setMaxQueries] = useState(3);
  const [maxSources, setMaxSources] = useState(5);
  const [phase, setPhase] = useState<UiPhase>('idle');
  const [serverPhase, setServerPhase] = useState<DeepResearchPhase | null>(null);
  const [ratio, setRatio] = useState(0);
  const [message, setMessage] = useState('');
  const [queries, setQueries] = useState<string[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [report, setReport] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  // Abort an in-flight run if the dialog unmounts.
  useEffect(() => {
    return () => abortRef.current?.();
  }, []);

  function start() {
    if (!question.trim()) return;
    setPhase('running');
    setServerPhase('planning');
    setRatio(0);
    setMessage('');
    setQueries([]);
    setHits([]);
    setReport('');
    setError(null);
    setArtifactId(null);

    let acc = '';
    const handle = api.deepResearchStream(
      notebookId,
      { question: question.trim(), maxQueries, maxSources },
      (delta: DeepResearchDelta) => {
        switch (delta.type) {
          case 'phase':
            setServerPhase(delta.phase);
            if (typeof delta.ratio === 'number') setRatio(delta.ratio);
            if (delta.message) setMessage(delta.message);
            break;
          case 'queries':
            setQueries(delta.queries);
            break;
          case 'hit':
            setHits((prev) => [
              ...prev,
              {
                url: delta.url,
                title: delta.title,
                ingested: delta.ingested,
                reason: delta.reason,
              },
            ]);
            break;
          case 'token':
            acc += delta.text;
            setReport(acc);
            break;
          case 'error':
            setError(delta.message);
            setPhase('error');
            break;
          default:
            break;
        }
      },
    );
    abortRef.current = handle.abort;
    handle.promise
      .then(({ artifactId: id, sourceCount, citationCount }) => {
        abortRef.current = null;
        setArtifactId(id);
        setRatio(1);
        setServerPhase('done');
        setMessage(`Готово: ${sourceCount} источников, ${citationCount} цитат`);
        setPhase('done');
        void qc.invalidateQueries({ queryKey: ['artifacts', notebookId] });
        void qc.invalidateQueries({ queryKey: ['sources', notebookId] });
        onCreated?.(id);
      })
      .catch((err: unknown) => {
        abortRef.current = null;
        // An abort is not an error worth surfacing.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      });
  }

  const running = phase === 'running';
  const activeIdx = serverPhase ? PHASE_ORDER.indexOf(serverPhase) : -1;

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-[8vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl rounded-3xl border bg-surface shadow-soft"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
        data-testid="deep-research-dialog"
      >
        <header className="flex items-center justify-between gap-3 border-b px-5 py-3"
          style={{ borderColor: 'rgb(var(--nb-border))' }}>
          <h2 className="text-base font-semibold">🔎 Deep Research</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="btn btn-ghost text-xs"
            data-testid="deep-research-close"
          >
            {running ? 'Свернуть' : 'Закрыть'}
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
            <p className="text-sm text-muted">
              Агент сам спланирует запросы, найдёт страницы в вебе, добавит их
              в ноутбук как источники и напишет отчёт со ссылками.
            </p>
            <div>
              <label className="section-label mb-1.5 block">Вопрос</label>
              <textarea
                className="textarea text-sm"
                rows={3}
                placeholder="Что нужно исследовать?"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                data-testid="deep-research-question"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="section-label mb-1.5 block">
                  Поисковых запросов: {maxQueries}
                </label>
                <input
                  type="range"
                  min={1}
                  max={6}
                  value={maxQueries}
                  onChange={(e) => setMaxQueries(Number(e.target.value))}
                  className="w-full"
                  data-testid="deep-research-max-queries"
                />
              </div>
              <div>
                <label className="section-label mb-1.5 block">
                  Источников: {maxSources}
                </label>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={maxSources}
                  onChange={(e) => setMaxSources(Number(e.target.value))}
                  className="w-full"
                  data-testid="deep-research-max-sources"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className="btn btn-secondary">
                Отмена
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!question.trim()}
                data-testid="deep-research-start"
              >
                Исследовать
              </button>
            </div>
          </form>
        )}

        {phase !== 'idle' && (
          <div className="space-y-4 px-5 py-4">
            {/* Phase checklist */}
            <ol className="space-y-1.5" data-testid="deep-research-phases">
              {PHASE_ORDER.map((p, i) => {
                const done = phase === 'done' || (activeIdx >= 0 && i < activeIdx);
                const active = running && i === activeIdx;
                const failed = phase === 'error' && i === activeIdx;
                const mark = failed ? '✕' : done ? '✓' : active ? '●' : '○';
                const color = failed
                  ? 'text-red-600'
                  : done
                    ? 'text-green-600'
                    : active
                      ? 'text-accent'
                      : 'text-muted';
                return (
                  <li
                    key={p}
                    className={`flex items-center justify-between text-xs ${color}`}
                    data-testid={`deep-research-phase-${p}`}
                  >
                    <span>
                      <span className="mr-1.5 font-semibold">{mark}</span>
                      {PHASE_LABEL[p]}
                    </span>
                    {active && message && (
                      <span className="truncate pl-2 text-muted">{message}</span>
                    )}
                  </li>
                );
              })}
            </ol>

            {running && (
              <div className="h-1 w-full overflow-hidden rounded-full bg-surface-tint">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                  data-testid="deep-research-progress"
                />
              </div>
            )}

            {queries.length > 0 && (
              <div>
                <p className="section-label mb-1">Запросы</p>
                <div className="flex flex-wrap gap-1.5" data-testid="deep-research-queries">
                  {queries.map((q, i) => (
                    <span key={i} className="chip-indigo text-[11px]">
                      {q}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {hits.length > 0 && (
              <div>
                <p className="section-label mb-1">
                  Найденные страницы ({hits.filter((h) => h.ingested).length} из {hits.length} добавлено)
                </p>
                <ul className="max-h-32 space-y-1 overflow-y-auto text-xs" data-testid="deep-research-hits">
                  {hits.map((h, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className={h.ingested ? 'text-green-600' : 'text-muted'}>
                        {h.ingested ? '✓' : '–'}
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={h.url}>
                        {h.title || h.url}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report && (
              <div
                className="prose-summary max-h-72 overflow-y-auto rounded-lg border bg-canvas p-3"
                data-testid="deep-research-report"
              >
                <pre className="whitespace-pre-wrap font-sans text-sm">{report}</pre>
              </div>
            )}

            {error && (
              <p className="text-sm text-red-600" data-testid="deep-research-error">
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              {phase === 'done' && artifactId && (
                <span className="self-center text-xs text-muted" data-testid="deep-research-done">
                  Отчёт сохранён в заметках.
                </span>
              )}
              {phase === 'done' && (
                <button
                  type="button"
                  onClick={() => {
                    setPhase('idle');
                    setQuestion('');
                    setQueries([]);
                    setHits([]);
                    setReport('');
                    setArtifactId(null);
                  }}
                  className="btn btn-secondary text-xs"
                  data-testid="deep-research-again"
                >
                  Ещё исследование
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                disabled={running}
                className="btn btn-primary text-xs"
              >
                {running ? 'Идёт исследование…' : 'Закрыть'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
