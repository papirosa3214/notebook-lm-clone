import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import type {
  CitationChunk,
  StudioDelta,
  StudioTemplate,
} from '@notebook/shared';

interface Props {
  notebookId: string;
  onClose: () => void;
  onCreated?: (artifactId: string) => void;
}

interface TemplateInfo {
  id: StudioTemplate;
  title: string;
  blurb: string;
  defaultTopK: number;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

/**
 * Studio Reports dialog. Mirrors AudioOverviewDialog in shape:
 * idle → running (live token stream) → done | error.
 *
 * The user picks a template (fetched from the server so the client
 * doesn't bake template metadata into its bundle), optionally narrows
 * the focus, and the LLM writes the report straight into an Artifact.
 */
export function StudioReportDialog({ notebookId, onClose, onCreated }: Props) {
  const qc = useQueryClient();
  const templatesQ = useQuery({
    queryKey: ['studio-templates', notebookId],
    queryFn: () =>
      api.get<{ templates: TemplateInfo[] }>(
        `/api/notebooks/${notebookId}/studio/templates`,
      ),
  });
  const [template, setTemplate] = useState<StudioTemplate | null>(null);
  const [focus, setFocus] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [citations, setCitations] = useState<CitationChunk[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);

  function start() {
    if (!template || phase === 'running') return;
    setPhase('running');
    setText('');
    setCitations([]);
    setError(null);
    setArtifactId(null);

    const controller = new AbortController();
    const run = async () => {
      const res = await fetch(
        `/api/notebooks/${notebookId}/artifacts/studio`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            template,
            focus: focus.trim() || undefined,
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const json = dataLine.slice(5).trim();
          if (!json) continue;
          try {
            const delta = JSON.parse(json) as StudioDelta;
            if (delta.type === 'citations') setCitations(delta.chunks);
            else if (delta.type === 'token') {
              setText((prev) => prev + delta.text);
            } else if (delta.type === 'done') {
              setArtifactId(delta.artifactId);
            } else if (delta.type === 'error') {
              throw new Error(delta.message);
            }
          } catch (err) {
            if (err instanceof Error) throw err;
            // ignore malformed chunk
          }
        }
      }
    };

    run()
      .then(() => {
        setPhase('done');
        qc.invalidateQueries({ queryKey: ['artifacts', notebookId] });
        if (artifactId) onCreated?.(artifactId);
      })
      .catch((err: Error) => {
        setError(err.message);
        setPhase('error');
      });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label="Studio"
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-2xl border bg-surface shadow-soft"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
      >
        <header
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
        >
          <div>
            <h2 className="text-base font-semibold">Studio</h2>
            <p className="text-xs text-muted">
              Структурированный отчёт по материалам ноутбука.
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
          <div className="space-y-4 px-5 py-4">
            <div>
              <span className="section-label mb-1.5 block">Шаблон</span>
              {templatesQ.isLoading && (
                <p className="text-sm text-muted">Загружаю шаблоны…</p>
              )}
              {templatesQ.data && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {templatesQ.data.templates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTemplate(t.id)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        template === t.id
                          ? 'border-accent bg-accent/5'
                          : 'border-border bg-canvas hover:border-accent/50'
                      }`}
                      style={{ borderColor: 'rgb(var(--nb-border))' }}
                    >
                      <div className="text-sm font-semibold">{t.title}</div>
                      <div className="mt-0.5 text-xs text-muted">{t.blurb}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="section-label mb-1.5 block">
                Фокус (опционально)
              </label>
              <input
                className="input"
                placeholder="на что обратить внимание в отчёте"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="btn btn-secondary">
                Отмена
              </button>
              <button
                type="button"
                onClick={start}
                disabled={!template}
                className="btn btn-primary disabled:opacity-50"
              >
                Сгенерировать
              </button>
            </div>
          </div>
        )}

        {(phase === 'running' || phase === 'done' || phase === 'error') && (
          <div className="space-y-3 px-5 py-4">
            {citations.length > 0 && (
              <p className="text-xs text-muted">
                Основано на {citations.length} цитат
                {citations.length === 1 ? 'е' : citations.length < 5 ? 'ах' : 'ах'}.
              </p>
            )}
            <div
              className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-canvas p-3 text-sm"
              style={{ borderColor: 'rgb(var(--nb-border))' }}
              data-testid="studio-report-body"
            >
              {text || (phase === 'running' ? 'Готовлю отчёт…' : '')}
            </div>
            {phase === 'error' && error && (
              <p className="text-sm text-red-600">{error}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-secondary"
              >
                {phase === 'running' ? 'Свернуть' : 'Закрыть'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
