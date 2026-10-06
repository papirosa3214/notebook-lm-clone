/**
 * Sources Cockpit — единый пульт «сырья» в левой колонке.
 *
 * Четыре вкладки, каждая вызывает существующий серверный flow без
 * модального окна: URL ingest, web-search (single + multi-topic),
 * YouTube ingest (с опциональным ASR), Deep Research. Файл остаётся
 * отдельной модалкой (`AddFileDialog` в `SourcesPanel.tsx`) —
 * системный file picker нормально работает только оттуда.
 *
 * SourcesCockpit не делает invalidateQueries — он зовёт `onSourceAdded`,
 * а родительский `SourcesPanel` уже знает свой `notebookId` и
 * синхронизирует свой TanStack Query cache.
 *
 * Progress-stepper общий на все вкладки: один из под-компонентов
 * стримит SSE, прогресс пишется в cockpit-state, stepper рендерится
 * один раз.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type {
  DeepResearchDelta,
  IngestProgressDelta,
  IngestStage,
  SearchPreviewResult,
} from '../lib/types';

type CockpitTab = 'url' | 'search' | 'youtube' | 'deep';

interface Props {
  notebookId: string;
  onSourceAdded: () => void;
}

interface ProgressState {
  stage: IngestStage | null;
  ratio: number;
  message: string;
  error?: string;
}

const INITIAL_PROGRESS: ProgressState = {
  stage: null,
  ratio: 0,
  message: '',
};

const STAGE_ORDER: IngestStage[] = [
  'fetching',
  'extracting',
  'chunking',
  'embedding',
  'storing',
];

const STAGE_LABEL: Record<IngestStage, string> = {
  fetching: 'Загружаю страницу',
  extracting: 'Извлекаю текст',
  chunking: 'Разбиваю на чанки',
  embedding: 'Создаю embeddings',
  storing: 'Сохраняю',
};

const TABS: Array<{ id: CockpitTab; label: string; icon: string }> = [
  { id: 'url', label: 'URL', icon: '🔗' },
  { id: 'search', label: 'Поиск', icon: '🔎' },
  { id: 'youtube', label: 'YouTube', icon: '📺' },
  { id: 'deep', label: 'Deep Research', icon: '🚀' },
];

export function SourcesCockpit({ notebookId, onSourceAdded }: Props) {
  const [tab, setTab] = useState<CockpitTab>('url');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);

  // Любой под-компонент начинает стрим — зовёт register(). Кокпит
  // показывает общий stepper и блокирует переключение вкладок, пока
  // стрим не закончится (один ingest за раз — дешевле и понятнее).
  const beginRun = (first: IngestProgressDelta) => {
    setRunning(true);
    setProgress(progressFromDelta(first, INITIAL_PROGRESS));
  };

  const updateProgress = (delta: IngestProgressDelta) => {
    setProgress((prev) => progressFromDelta(delta, prev));
  };

  const endRun = () => {
    setRunning(false);
    onSourceAdded();
    // Показываем «Готово» ~1.5 c, потом сбрасываем stepper.
    window.setTimeout(() => setProgress(INITIAL_PROGRESS), 1500);
  };

  const failRun = (msg: string) => {
    setRunning(false);
    setProgress((prev) => ({ ...prev, error: msg }));
  };

  return (
    <div
      className="border-b px-2 pt-2 pb-3"
      style={{ borderColor: 'rgb(var(--nb-border))' }}
      data-testid="sources-cockpit"
    >
      <nav role="tablist" className="flex gap-1" data-testid="sources-cockpit-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            disabled={running && tab !== t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-xl px-2 py-1.5 text-[11px] font-medium transition-colors ${
              tab === t.id
                ? 'bg-accent text-white'
                : running
                  ? 'text-subtle'
                  : 'text-muted hover:text-ink hover:bg-surface-tint'
            }`}
            data-testid={`sources-cockpit-tab-${t.id}`}
          >
            <span className="mr-1" aria-hidden>
              {t.icon}
            </span>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="mt-3 px-2">
        {tab === 'url' && (
          <CockpitUrl
            notebookId={notebookId}
            running={running}
            beginRun={beginRun}
            updateProgress={updateProgress}
            endRun={endRun}
            failRun={failRun}
          />
        )}
        {tab === 'search' && (
          <CockpitSearch
            notebookId={notebookId}
            running={running}
            beginRun={beginRun}
            updateProgress={updateProgress}
            endRun={endRun}
            failRun={failRun}
          />
        )}
        {tab === 'youtube' && (
          <CockpitYoutube
            notebookId={notebookId}
            running={running}
            beginRun={beginRun}
            updateProgress={updateProgress}
            endRun={endRun}
            failRun={failRun}
          />
        )}
        {tab === 'deep' && (
          <CockpitDeep
            notebookId={notebookId}
            running={running}
            beginRun={beginRun}
            updateProgress={updateProgress}
            endRun={endRun}
            failRun={failRun}
          />
        )}
        {(running || progress.error) && (
          <div className="mt-3">
            <ProgressStepper progress={progress} />
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Shared stepper
// ============================================================

function ProgressStepper({ progress }: { progress: ProgressState }) {
  const currentIndex = progress.stage ? STAGE_ORDER.indexOf(progress.stage) : -1;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{progress.error ? '✗ ошибка' : progress.message || 'Готовлюсь…'}</span>
        {!progress.error && (
          <span className="font-semibold">{Math.round(progress.ratio * 100)}%</span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-tint">
        <div
          className={`h-full transition-all duration-300 ${
            progress.error ? 'bg-red-500' : ''
          }`}
          style={{
            width: `${Math.round(progress.ratio * 100)}%`,
            backgroundColor: progress.error ? undefined : 'rgb(var(--nb-accent))',
          }}
        />
      </div>
      <ol className="space-y-1.5 text-xs">
        {STAGE_ORDER.map((stage, i) => {
          const done = currentIndex > i || progress.ratio >= 1;
          const active = currentIndex === i && !progress.error;
          return (
            <li
              key={stage}
              className={`flex items-center gap-2 ${
                done
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : active
                    ? 'font-medium text-accent'
                    : 'text-subtle'
              }`}
            >
              <span className="w-4 text-center">{done ? '✓' : active ? '●' : '○'}</span>
              <span>{STAGE_LABEL[stage]}</span>
            </li>
          );
        })}
      </ol>
      {progress.error && (
        <p
          className="rounded-xl border bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300"
          style={{ borderColor: 'rgb(252 165 165 / 0.5)' }}
        >
          {progress.error}
        </p>
      )}
    </div>
  );
}

function progressFromDelta(delta: IngestProgressDelta, prev: ProgressState): ProgressState {
  if (delta.type === 'progress') {
    const stageIdx = STAGE_ORDER.indexOf(delta.stage);
    const base = stageIdx >= 0 ? stageIdx / STAGE_ORDER.length : 0;
    const intra = delta.ratio ?? 0.5;
    const ratio = Math.min(0.99, base + intra / STAGE_ORDER.length);
    return {
      stage: delta.stage,
      ratio,
      message: delta.message ?? STAGE_LABEL[delta.stage],
    };
  }
  if (delta.type === 'error') {
    return { ...prev, error: delta.message, ratio: prev.ratio };
  }
  return { stage: prev.stage, ratio: 1, message: 'Готово' };
}

// ============================================================
// CockpitUrl
// ============================================================

interface CockpitRunProps {
  notebookId: string;
  running: boolean;
  beginRun: (first: IngestProgressDelta) => void;
  updateProgress: (delta: IngestProgressDelta) => void;
  endRun: () => void;
  failRun: (msg: string) => void;
}

function CockpitUrl({
  notebookId,
  running,
  beginRun,
  updateProgress,
  endRun,
  failRun,
}: CockpitRunProps) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const normalize = (raw: string): string => {
    const v = raw.trim();
    if (!v) return v;
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  };
  const submit = () => {
    if (!url.trim() || running) return;
    const stream = api.ingestUrlSourceStream(
      notebookId,
      { url: normalize(url), title: title || undefined },
      (delta) => updateProgress(delta),
    );
    // Stream emits the first progress event as 'starting' (not in STAGE_ORDER);
    // ensure stepper shows something by initialising on first progress.
    stream.promise
      .then(() => endRun())
      .catch((err: Error) => failRun(err.message));
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="cockpit-url-form"
    >
      <input
        className="input text-sm"
        placeholder="https://…"
        value={url}
        disabled={running}
        onChange={(e) => setUrl(e.target.value)}
        data-testid="cockpit-url-input"
      />
      <input
        className="input text-sm"
        placeholder="Название (опционально)"
        value={title}
        disabled={running}
        onChange={(e) => setTitle(e.target.value)}
        data-testid="cockpit-url-title"
      />
      <div className="flex justify-end">
        <button
          type="submit"
          className="btn btn-primary text-xs"
          disabled={!url.trim() || running}
          data-testid="cockpit-url-submit"
        >
          Добавить
        </button>
      </div>
    </form>
  );
}

// ============================================================
// CockpitSearch — multi-topic
// ============================================================

type SearchMode = 'idle' | 'searching' | 'preview' | 'ingest';

const PRE_SELECT_LIMIT = 10;
const MAX_TOPICS = 6;

function CockpitSearch({
  notebookId,
  running,
  beginRun,
  updateProgress,
  endRun,
  failRun,
}: CockpitRunProps) {
  const [topics, setTopics] = useState<string[]>(['']);
  const [perQueryLimit, setPerQueryLimit] = useState(5);
  const [mode, setMode] = useState<SearchMode>('idle');
  const [resultsByTopic, setResultsByTopic] = useState<Record<string, SearchPreviewResult[]>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [warning, setWarning] = useState<string | null>(null);

  const resetToTopics = () => {
    setResultsByTopic({});
    setSelected(new Set());
    setWarning(null);
    setMode('idle');
  };

  const updateTopic = (i: number, v: string) => {
    setTopics((prev) => prev.map((t, idx) => (idx === i ? v : t)));
  };

  const removeTopic = (i: number) => {
    if (topics.length <= 1) return;
    setTopics((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addTopic = () => {
    if (topics.length >= MAX_TOPICS) return;
    setTopics((prev) => [...prev, '']);
  };

  const allFilled = topics.every((t) => t.trim().length > 0);

  const runSearch = async () => {
    if (!allFilled || running) return;
    setMode('searching');
    setResultsByTopic({});
    setSelected(new Set());
    setWarning(null);
    const queries = topics.map((t) => t.trim());
    const settled = await Promise.all(
      queries.map(async (q) => {
        try {
          const res = await api.searchPreview(notebookId, q, perQueryLimit);
          return { q, results: res.results };
        } catch {
          return { q, results: [] as SearchPreviewResult[] };
        }
      }),
    );
    const next: Record<string, SearchPreviewResult[]> = {};
    for (const { q, results } of settled) next[q] = results;
    setResultsByTopic(next);

    // Build deduped flat list + remember first topic per URL.
    const topicOfUrl = new Map<string, string>();
    const flat: Array<{ url: string; topic: string }> = [];
    for (const q of queries) {
      for (const r of next[q] ?? []) {
        if (!topicOfUrl.has(r.url)) {
          topicOfUrl.set(r.url, q);
          flat.push({ url: r.url, topic: q });
        }
      }
    }
    const preSelected = new Set(flat.slice(0, PRE_SELECT_LIMIT).map((f) => f.url));
    setSelected(preSelected);
    setMode('preview');
  };

  const startIngest = () => {
    if (selected.size === 0 || running) return;
    const urls = Array.from(selected);
    const capped = urls.slice(0, PRE_SELECT_LIMIT);
    if (urls.length > PRE_SELECT_LIMIT) {
      setWarning(`Выбрано ${urls.length} — добавлю первые ${PRE_SELECT_LIMIT}`);
    }
    setMode('ingest');
    // Mock first delta so stepper lights up immediately.
    beginRun({
      type: 'progress',
      stage: 'fetching',
      ratio: 0,
      message: 'Готовлюсь…',
    });
    const stream = api.ingestSearchAddBatchStream(
      notebookId,
      { urls: capped },
      (delta) => updateProgress(delta),
    );
    stream.promise
      .then(() => endRun())
      .catch((err: Error) => failRun(err.message));
  };

  // When transitioning out of ingest, ensure the next state is idle.
  useEffect(() => {
    if (running) return;
    if (mode === 'ingest') setMode('preview');
  }, [running, mode]);

  const flatHits = useMemo(() => {
    const map = new Map<string, { url: string; title: string; snippet: string; topic: string }>();
    for (const t of topics) {
      const results = resultsByTopic[t] ?? [];
      for (const r of results) {
        if (!map.has(r.url)) {
          map.set(r.url, { url: r.url, title: r.title, snippet: r.snippet, topic: t });
        }
      }
    }
    return Array.from(map.values());
  }, [topics, resultsByTopic]);

  const topicSummary = useMemo(() => {
    return topics.map((t) => ({
      topic: t,
      count: resultsByTopic[t]?.length ?? 0,
      blocked: mode === 'preview' && (resultsByTopic[t]?.length ?? 0) === 0,
    }));
  }, [topics, resultsByTopic, mode]);

  if (mode === 'preview' || mode === 'ingest') {
    return (
      <div className="space-y-2" data-testid="cockpit-search-preview">
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {topicSummary.map((s) => (
            <span
              key={s.topic}
              className={`chip-indigo ${s.blocked ? 'opacity-60' : ''}`}
              data-testid={`cockpit-search-topic-summary-${s.topic}`}
            >
              {s.topic}: {s.count} {s.blocked ? '(пусто)' : ''}
            </span>
          ))}
        </div>
        {warning && <p className="text-[11px] text-amber-600">{warning}</p>}
        <div className="max-h-44 space-y-1 overflow-y-auto">
          {flatHits.map((h) => {
            const isSel = selected.has(h.url);
            return (
              <label
                key={h.url}
                className="flex cursor-pointer items-start gap-2 rounded-xl border px-2 py-1.5 text-xs"
                style={{ borderColor: 'rgb(var(--nb-border))' }}
              >
                <input
                  type="checkbox"
                  checked={isSel}
                  onChange={() => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(h.url)) next.delete(h.url);
                      else next.add(h.url);
                      return next;
                    });
                  }}
                  data-testid={`cockpit-search-check-${h.url}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{h.title}</span>
                  <span className="block truncate text-muted">{h.url}</span>
                  <span
                    className="mt-0.5 inline-flex rounded-full px-1.5 py-0.5 text-[10px]"
                    style={{
                      backgroundColor: 'rgb(var(--nb-accent-soft))',
                      color: 'rgb(var(--nb-accent))',
                    }}
                  >
                    {h.topic}
                  </span>
                </span>
              </label>
            );
          })}
          {flatHits.length === 0 && (
            <p className="text-xs text-muted">Ничего не нашлось. Попробуйте другие темы.</p>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={resetToTopics}
            data-testid="cockpit-search-back"
          >
            ← Назад к темам
          </button>
          <button
            type="button"
            className="btn btn-primary text-xs"
            disabled={selected.size === 0 || mode === 'ingest'}
            onClick={startIngest}
            data-testid="cockpit-search-ingest"
          >
            Добавить выбранное ({selected.size})
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="cockpit-search-topics">
      {topics.map((t, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            className="input text-sm"
            placeholder={`Тема ${i + 1}`}
            value={t}
            disabled={running || mode === 'searching'}
            onChange={(e) => updateTopic(i, e.target.value)}
            data-testid={`cockpit-search-topic-${i}`}
          />
          {topics.length > 1 && (
            <button
              type="button"
              className="btn btn-ghost px-2 text-xs"
              onClick={() => removeTopic(i)}
              disabled={running || mode === 'searching'}
              data-testid={`cockpit-search-topic-remove-${i}`}
              aria-label="Удалить тему"
            >
              ×
            </button>
          )}
        </div>
      ))}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="btn btn-ghost text-xs"
          onClick={addTopic}
          disabled={topics.length >= MAX_TOPICS || running || mode === 'searching'}
          data-testid="cockpit-search-add-topic"
        >
          + ещё тему {topics.length >= MAX_TOPICS ? '(макс 6)' : ''}
        </button>
        <button
          type="button"
          className="btn btn-primary text-xs"
          onClick={runSearch}
          disabled={!allFilled || running || mode === 'searching'}
          data-testid="cockpit-search-run"
        >
          {mode === 'searching' ? 'Ищу…' : 'Найти'}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// CockpitYoutube
// ============================================================

function CockpitYoutube({
  notebookId,
  running,
  updateProgress,
  endRun,
  failRun,
}: CockpitRunProps) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [asr, setAsr] = useState(false);
  const submit = () => {
    if (!url.trim() || running) return;
    const body = { url, title: title || undefined };
    const stream = asr
      ? api.ingestYoutubeAsrSourceStream(notebookId, body, (delta) => updateProgress(delta))
      : api.ingestYoutubeSourceStream(notebookId, body, (delta) => updateProgress(delta));
    stream.promise
      .then(() => endRun())
      .catch((err: Error) => failRun(err.message));
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="cockpit-youtube-form"
    >
      <input
        className="input text-sm"
        placeholder="URL или ID видео"
        value={url}
        disabled={running}
        onChange={(e) => setUrl(e.target.value)}
        data-testid="cockpit-youtube-input"
      />
      <input
        className="input text-sm"
        placeholder="Название (опционально)"
        value={title}
        disabled={running}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label
        className="flex cursor-pointer items-start gap-2 rounded-xl border p-2 text-xs"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
      >
        <input
          type="checkbox"
          checked={asr}
          onChange={(e) => setAsr(e.target.checked)}
          className="mt-0.5"
          data-testid="cockpit-youtube-asr"
          disabled={running}
        />
        <span>
          <span className="font-medium text-ink">Распознать речь (Whisper ASR)</span>
          <span className="mt-0.5 block text-muted">
            Через yt-dlp + локальный Whisper на 127.0.0.1:8000. Медленнее, но работает там,
            где YouTube не отдаёт субтитры.
          </span>
        </span>
      </label>
      <div className="flex justify-end">
        <button
          type="submit"
          className="btn btn-primary text-xs"
          disabled={!url.trim() || running}
          data-testid="cockpit-youtube-submit"
        >
          {asr ? 'Распознать' : 'Добавить'}
        </button>
      </div>
    </form>
  );
}

// ============================================================
// CockpitDeep
// ============================================================

const DEEP_PHASES: Array<{ id: 'planning' | 'searching' | 'fetching' | 'synthesizing'; label: string }> = [
  { id: 'planning', label: 'Планирование' },
  { id: 'searching', label: 'Поиск' },
  { id: 'fetching', label: 'Загрузка источников' },
  { id: 'synthesizing', label: 'Синтез отчёта' },
];

function CockpitDeep({
  notebookId,
  running,
  beginRun,
  updateProgress,
  endRun,
  failRun,
}: CockpitRunProps) {
  const [question, setQuestion] = useState('');
  const [maxQueries, setMaxQueries] = useState(3);
  const [maxSources, setMaxSources] = useState(5);
  const [phase, setPhase] = useState<string | null>(null);
  const [queries, setQueries] = useState<string[]>([]);
  const [hits, setHits] = useState<Array<{ url: string; title: string; ingested: boolean }>>([]);
  const [report, setReport] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => abortRef.current?.();
  }, []);

  const submit = () => {
    if (!question.trim() || running) return;
    setPhase('planning');
    setQueries([]);
    setHits([]);
    setReport('');
    setError(null);
    let acc = '';
    const handle = api.deepResearchStream(
      notebookId,
      { question: question.trim(), maxQueries, maxSources },
      (delta: DeepResearchDelta) => {
        switch (delta.type) {
          case 'phase':
            setPhase(delta.phase);
            // Map server phase ratio into our IngestProgress shape.
            beginRun({
              type: 'progress',
              stage: phaseToStage(delta.phase),
              ratio: delta.ratio ?? 0,
              message: delta.message ?? 'Идёт исследование…',
            });
            break;
          case 'queries':
            setQueries(delta.queries);
            break;
          case 'hit':
            setHits((prev) => [
              ...prev,
              { url: delta.url, title: delta.title, ingested: delta.ingested },
            ]);
            break;
          case 'token':
            acc += delta.text;
            setReport(acc);
            break;
          case 'error':
            setError(delta.message);
            break;
          default:
            break;
        }
      },
    );
    abortRef.current = handle.abort;
    handle.promise
      .then(() => endRun())
      .catch((err: Error) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err.message);
        failRun(err.message);
      });
  };

  return (
    <div className="space-y-2" data-testid="cockpit-deep">
      <textarea
        className="textarea text-sm"
        rows={2}
        value={question}
        disabled={running}
        placeholder="Что нужно исследовать?"
        onChange={(e) => setQuestion(e.target.value)}
        data-testid="cockpit-deep-question"
      />
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <label className="flex flex-col gap-1">
          <span className="text-muted">Запросов: {maxQueries}</span>
          <input
            type="range"
            min={1}
            max={6}
            value={maxQueries}
            onChange={(e) => setMaxQueries(Number(e.target.value))}
            disabled={running}
            data-testid="cockpit-deep-max-queries"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Источников: {maxSources}</span>
          <input
            type="range"
            min={1}
            max={10}
            value={maxSources}
            onChange={(e) => setMaxSources(Number(e.target.value))}
            disabled={running}
            data-testid="cockpit-deep-max-sources"
          />
        </label>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">{phase ? `Фаза: ${phase}` : ''}</span>
        <button
          type="button"
          className="btn btn-primary text-xs"
          onClick={submit}
          disabled={!question.trim() || running}
          data-testid="cockpit-deep-submit"
        >
          Исследовать
        </button>
      </div>
      {(queries.length > 0 || hits.length > 0 || report || error) && !running && (
        <details className="text-[11px]" data-testid="cockpit-deep-detail">
          <summary className="cursor-pointer text-muted">Подробности последнего прогона</summary>
          <div className="mt-2 space-y-2">
            {queries.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {queries.map((q, i) => (
                  <span key={i} className="chip-indigo">
                    {q}
                  </span>
                ))}
              </div>
            )}
            {hits.length > 0 && (
              <ul className="space-y-0.5">
                {hits.map((h, i) => (
                  <li key={i} className="truncate">
                    {h.ingested ? '✓' : '–'} {h.title || h.url}
                  </li>
                ))}
              </ul>
            )}
            {report && (
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border p-2 text-[11px]">
                {report}
              </pre>
            )}
            {error && <p className="text-red-600">{error}</p>}
          </div>
        </details>
      )}
    </div>
  );
}

/** Server-side deep-research phase → our IngestStage proxy.
 *  Used only to make the shared ProgressStepper light up during run. */
function phaseToStage(phase: string): IngestStage {
  if (phase === 'fetching') return 'fetching';
  if (phase === 'searching') return 'fetching';
  if (phase === 'synthesizing') return 'embedding';
  return 'fetching';
}