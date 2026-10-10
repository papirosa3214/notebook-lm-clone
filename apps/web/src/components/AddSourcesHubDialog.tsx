import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type {
  DeepResearchDelta,
  DeepResearchPhase,
  IngestProgressDelta,
  IngestStage,
  SearchPreviewResult,
} from '../lib/types';
import { normalizeUrlInput } from './SourcesPanel';
import {
  CloseIcon,
  PlusIcon,
  SearchIcon,
  SparkleIcon,
} from './icons/NotebookLogo';

export type HubTab = 'files' | 'url' | 'youtube' | 'deep' | 'search' | 'text';

interface Props {
  notebookId: string;
  initialTab?: HubTab;
  initialValue?: string;
  onClose: () => void;
  onSourceAdded?: () => void;
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

export function AddSourcesHubDialog({
  notebookId,
  initialTab = 'files',
  initialValue = '',
  onClose,
  onSourceAdded,
}: Props) {
  const [activeTab, setActiveTab] = useState<HubTab>(initialTab);
  const [isProcessing, setIsProcessing] = useState(false);

  const notifyAdded = () => {
    onSourceAdded?.();
  };

  const tabs: Array<{ id: HubTab; label: string; icon: string; desc: string }> = [
    { id: 'files', label: 'Файлы', icon: '📄', desc: 'PDF, DOCX, TXT, Markdown' },
    { id: 'url', label: 'Ссылка / URL', icon: '🔗', desc: 'Веб-страницы, статьи, документация' },
    { id: 'youtube', label: 'YouTube', icon: '📺', desc: 'Видео, субтитры или Whisper ASR' },
    { id: 'deep', label: 'Deep Research', icon: '🚀', desc: 'Глубокое исследование темы с отчётом' },
    { id: 'search', label: 'Веб-поиск', icon: '🔎', desc: 'Поиск и пакетный выбор источников' },
    { id: 'text', label: 'Текст / Заметка', icon: '📝', desc: 'Прямая вставка текста или кода' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6 backdrop-blur-sm animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isProcessing) {
          onClose();
        }
      }}
    >
      <div
        className="flex h-full max-h-[640px] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border bg-surface shadow-2xl animate-fade-up md:flex-row"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
        data-testid="add-sources-hub-dialog"
      >
        {/* Left tabs column */}
        <div
          className="flex shrink-0 flex-row overflow-x-auto border-b bg-surface-tint/60 p-2 md:w-64 md:flex-col md:border-b-0 md:border-r md:p-3"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
        >
          <div className="hidden px-3 py-2.5 md:block">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Добавить источник
            </h3>
            <p className="mt-0.5 text-[11px] text-subtle">Выберите подходящий способ</p>
          </div>

          <nav className="flex flex-row gap-1 md:flex-col md:gap-1.5">
            {tabs.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  disabled={isProcessing && !active}
                  className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-xs font-medium transition-all ${
                    active
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-muted hover:bg-surface-tint hover:text-ink disabled:opacity-40'
                  }`}
                  data-testid={`hub-tab-${tab.id}`}
                >
                  <span className="text-base leading-none" aria-hidden>
                    {tab.icon}
                  </span>
                  <div className="hidden min-w-0 flex-1 md:block">
                    <div className="truncate font-medium">{tab.label}</div>
                    <div
                      className={`truncate text-[10px] ${
                        active ? 'text-white/80' : 'text-subtle'
                      }`}
                    >
                      {tab.desc}
                    </div>
                  </div>
                  <span className="md:hidden whitespace-nowrap">{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right content area */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden bg-surface">
          {/* Dialog Header */}
          <div
            className="flex items-center justify-between border-b px-6 py-4"
            style={{ borderColor: 'rgb(var(--nb-border))' }}
          >
            <div>
              <h2 className="text-base font-semibold text-ink">
                {tabs.find((t) => t.id === activeTab)?.label}
              </h2>
              <p className="text-xs text-muted">
                {tabs.find((t) => t.id === activeTab)?.desc}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isProcessing}
              className="btn-icon"
              title="Закрыть"
            >
              <CloseIcon size={16} />
            </button>
          </div>

          {/* Dialog Body */}
          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === 'files' && (
              <HubFilesTab
                notebookId={notebookId}
                onSuccess={() => {
                  notifyAdded();
                  onClose();
                }}
                setIsProcessing={setIsProcessing}
              />
            )}
            {activeTab === 'url' && (
              <HubUrlTab
                notebookId={notebookId}
                initialUrl={initialTab === 'url' ? initialValue : ''}
                onSuccess={() => {
                  notifyAdded();
                  onClose();
                }}
                setIsProcessing={setIsProcessing}
              />
            )}
            {activeTab === 'youtube' && (
              <HubYoutubeTab
                notebookId={notebookId}
                initialUrl={initialTab === 'youtube' ? initialValue : ''}
                onSuccess={() => {
                  notifyAdded();
                  onClose();
                }}
                setIsProcessing={setIsProcessing}
              />
            )}
            {activeTab === 'deep' && (
              <HubDeepResearchTab
                notebookId={notebookId}
                initialQuestion={initialTab === 'deep' ? initialValue : ''}
                onSuccess={() => {
                  notifyAdded();
                  onClose();
                }}
                setIsProcessing={setIsProcessing}
              />
            )}
            {activeTab === 'search' && (
              <HubSearchTab
                notebookId={notebookId}
                initialQuery={initialTab === 'search' ? initialValue : ''}
                onSuccess={() => {
                  notifyAdded();
                  onClose();
                }}
                setIsProcessing={setIsProcessing}
              />
            )}
            {activeTab === 'text' && (
              <HubTextTab
                notebookId={notebookId}
                onSuccess={() => {
                  notifyAdded();
                  onClose();
                }}
                setIsProcessing={setIsProcessing}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Tab: Files
   ============================================================ */

function HubFilesTab({
  notebookId,
  onSuccess,
  setIsProcessing,
}: {
  notebookId: string;
  onSuccess: () => void;
  setIsProcessing: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: async (filesToUpload: File[]) => {
      for (const file of filesToUpload) {
        await api.uploadFileSource(notebookId, file);
      }
    },
    onMutate: () => setIsProcessing(true),
    onSuccess: () => {
      setIsProcessing(false);
      qc.invalidateQueries({ queryKey: ['sources', notebookId] });
      onSuccess();
    },
    onError: () => setIsProcessing(false),
  });

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) {
      const dropped = Array.from(e.dataTransfer.files);
      setFiles((prev) => [...prev, ...dropped]);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      const selected = Array.from(e.target.files);
      setFiles((prev) => [...prev, ...selected]);
    }
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.txt,.md,.markdown"
        onChange={handleFileSelect}
        className="hidden"
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed p-8 text-center transition-all ${
          isDragging
            ? 'border-accent bg-accent-soft/40 scale-[1.01]'
            : 'border-border bg-surface-tint/40 hover:bg-surface-tint hover:border-muted'
        }`}
      >
        <span className="text-4xl mb-3" aria-hidden>
          📂
        </span>
        <p className="text-sm font-semibold text-ink">
          Перетащите файлы сюда или нажмите для выбора
        </p>
        <p className="mt-1 text-xs text-muted">
          Поддерживаются PDF, DOCX, TXT, Markdown (до 50 МБ)
        </p>
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">
            Выбранные файлы ({files.length})
          </div>
          <ul className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center justify-between rounded-xl border bg-surface px-3 py-2 text-xs"
                style={{ borderColor: 'rgb(var(--nb-border))' }}
              >
                <div className="flex items-center gap-2 truncate">
                  <span aria-hidden>📄</span>
                  <span className="font-medium text-ink truncate">{f.name}</span>
                  <span className="text-muted">({Math.round(f.size / 1024)} KB)</span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(i);
                  }}
                  className="rounded-full p-1 text-muted hover:bg-surface-tint hover:text-red-600"
                  title="Удалить"
                >
                  <CloseIcon size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {uploadMutation.isError && (
        <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {(uploadMutation.error as Error).message}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={() => uploadMutation.mutate(files)}
          disabled={files.length === 0 || uploadMutation.isPending}
          className="btn btn-primary"
        >
          {uploadMutation.isPending ? 'Загрузка…' : `Загрузить файлы (${files.length})`}
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   Tab: URL
   ============================================================ */

function HubUrlTab({
  notebookId,
  initialUrl = '',
  onSuccess,
  setIsProcessing,
}: {
  notebookId: string;
  initialUrl?: string;
  onSuccess: () => void;
  setIsProcessing: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState('');
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);
  const [running, setRunning] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUrl = normalizeUrlInput(url);
    if (!cleanUrl || running) return;

    setRunning(true);
    setIsProcessing(true);
    setProgress(INITIAL_PROGRESS);

    const stream = api.ingestUrlSourceStream(
      notebookId,
      { url: cleanUrl, title: title.trim() || undefined },
      (delta) => setProgress((prev) => progressFromDelta(delta, prev)),
    );

    stream.promise
      .then(() => {
        qc.invalidateQueries({ queryKey: ['sources', notebookId] });
        setIsProcessing(false);
        setRunning(false);
        onSuccess();
      })
      .catch((err: Error) => {
        setIsProcessing(false);
        setRunning(false);
        setProgress((p) => ({ ...p, error: err.message }));
      });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="section-label mb-1.5 block">Ссылка на страницу</label>
        <input
          className="input"
          placeholder="https://habr.com/ru/articles/... или https://arxiv.org/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={running}
          autoFocus
          required
        />
      </div>

      <div>
        <label className="section-label mb-1.5 block">Название источника (опционально)</label>
        <input
          className="input"
          placeholder="Например: Архитектура микросервисов"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={running}
        />
      </div>

      {(running || progress.error || progress.stage) && (
        <HubProgressStepper progress={progress} />
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="submit"
          disabled={!url.trim() || running}
          className="btn btn-primary"
        >
          <PlusIcon size={14} />
          {running ? 'Импортирую…' : 'Добавить ссылку'}
        </button>
      </div>
    </form>
  );
}

/* ============================================================
   Tab: YouTube
   ============================================================ */

function HubYoutubeTab({
  notebookId,
  initialUrl = '',
  onSuccess,
  setIsProcessing,
}: {
  notebookId: string;
  initialUrl?: string;
  onSuccess: () => void;
  setIsProcessing: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState('');
  const [asr, setAsr] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);
  const [running, setRunning] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || running) return;

    setRunning(true);
    setIsProcessing(true);
    setProgress(INITIAL_PROGRESS);

    const body = { url: url.trim(), title: title.trim() || undefined };
    const stream = asr
      ? api.ingestYoutubeAsrSourceStream(notebookId, body, (delta) =>
          setProgress((prev) => progressFromDelta(delta, prev)),
        )
      : api.ingestYoutubeSourceStream(notebookId, body, (delta) =>
          setProgress((prev) => progressFromDelta(delta, prev)),
        );

    stream.promise
      .then(() => {
        qc.invalidateQueries({ queryKey: ['sources', notebookId] });
        setIsProcessing(false);
        setRunning(false);
        onSuccess();
      })
      .catch((err: Error) => {
        setIsProcessing(false);
        setRunning(false);
        setProgress((p) => ({ ...p, error: err.message }));
      });
  };

  const reset = () => {
    setProgress(INITIAL_PROGRESS);
    setRunning(false);
  };

  // Auto-suggest Whisper when error message mentions it
  const errorSuggestsWhisper =
    progress.error?.toLowerCase().includes('whisper') ?? false;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="section-label mb-1.5 block">Ссылка на YouTube или ID видео</label>
        <input
          className="input"
          placeholder="https://www.youtube.com/watch?v=... или https://youtu.be/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={running}
          autoFocus
          required
        />
      </div>

      <div>
        <label className="section-label mb-1.5 block">Название видео (опционально)</label>
        <input
          className="input"
          placeholder="Например: Лекция по машинному обучению"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={running}
        />
      </div>

      <label
        className="flex cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition-colors hover:bg-surface-tint/50"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
      >
        <input
          type="checkbox"
          checked={asr}
          onChange={(e) => setAsr(e.target.checked)}
          disabled={running}
          className="mt-0.5 h-4 w-4 rounded accent-accent"
        />
        <div className="text-xs">
          <span className="font-semibold text-ink">
            Распознать речь через Whisper ASR
          </span>
          <p className="mt-0.5 text-muted leading-relaxed">
            Скачивает аудио и локально распознает речь через <code>whisper.cpp</code>.
            Незаменимо для роликов без официальных или авто-субтитров.
          </p>
        </div>
      </label>

      {(running || progress.error || progress.stage) && (
        <HubProgressStepper progress={progress} />
      )}

      {/* Error action buttons */}
      {progress.error && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="btn btn-secondary"
          >
            ✕ Очистить ошибку
          </button>
          {errorSuggestsWhisper && !asr && (
            <button
              type="button"
              onClick={() => { setAsr(true); reset(); }}
              className="btn btn-primary"
            >
              🎙 Включить Whisper и попробовать снова
            </button>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="submit"
          disabled={!url.trim() || running}
          className="btn btn-primary"
        >
          <PlusIcon size={14} />
          {running ? 'Обработка видео…' : asr ? 'Распознать и добавить' : 'Добавить видео'}
        </button>
      </div>
    </form>
  );
}

/* ============================================================
   Tab: Deep Research
   ============================================================ */

const DEEP_PHASE_ORDER: DeepResearchPhase[] = [
  'planning',
  'searching',
  'fetching',
  'synthesizing',
];

const DEEP_PHASE_LABEL: Record<DeepResearchPhase, string> = {
  planning: 'Планирование поисковых запросов',
  searching: 'Поиск релевантных материалов',
  fetching: 'Загрузка и парсинг источников',
  synthesizing: 'Синтез структурированного отчёта',
  done: 'Готово',
  failed: 'Ошибка',
};

function HubDeepResearchTab({
  notebookId,
  initialQuestion = '',
  onSuccess,
  setIsProcessing,
}: {
  notebookId: string;
  initialQuestion?: string;
  onSuccess: () => void;
  setIsProcessing: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [question, setQuestion] = useState(initialQuestion);
  const [maxQueries, setMaxQueries] = useState(3);
  const [maxSources, setMaxSources] = useState(5);

  const [running, setRunning] = useState(false);
  const [serverPhase, setServerPhase] = useState<DeepResearchPhase | null>(null);
  const [ratio, setRatio] = useState(0);
  const [message, setMessage] = useState('');
  const [queries, setQueries] = useState<string[]>([]);
  const [hits, setHits] = useState<Array<{ url: string; title: string }>>([]);
  const [report, setReport] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => abortRef.current?.();
  }, []);

  const handleStart = (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || running) return;

    setRunning(true);
    setIsProcessing(true);
    setServerPhase('planning');
    setRatio(0);
    setMessage('');
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
            setServerPhase(delta.phase);
            if (typeof delta.ratio === 'number') setRatio(delta.ratio);
            if (delta.message) setMessage(delta.message);
            break;
          case 'queries':
            setQueries(delta.queries);
            break;
          case 'hit':
            setHits((prev) => [...prev, { url: delta.url, title: delta.title }]);
            break;
          case 'token':
            acc += delta.text;
            setReport(acc);
            break;
          case 'error':
            setError(delta.message);
            break;
        }
      },
    );

    abortRef.current = handle.abort;
    handle.promise
      .then(() => {
        setIsProcessing(false);
        setRunning(false);
        setServerPhase('done');
        setRatio(1);
        qc.invalidateQueries({ queryKey: ['sources', notebookId] });
        qc.invalidateQueries({ queryKey: ['artifacts', notebookId] });
        onSuccess();
      })
      .catch((err: unknown) => {
        setIsProcessing(false);
        setRunning(false);
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const activeIdx = serverPhase ? DEEP_PHASE_ORDER.indexOf(serverPhase) : -1;

  return (
    <div className="space-y-4">
      {!running && !report && !error && (
        <form onSubmit={handleStart} className="space-y-4">
          <div>
            <label className="section-label mb-1.5 block">Тема или вопрос исследования</label>
            <textarea
              className="textarea min-h-[90px] text-sm"
              placeholder="Сформулируйте задачу (например: Сравнительный анализ RAG-фреймворков в 2026 году)..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              autoFocus
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-2xl border p-4 bg-surface-tint/30"
               style={{ borderColor: 'rgb(var(--nb-border))' }}>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-ink">Поисковых запросов</span>
                <span className="font-semibold text-accent">{maxQueries}</span>
              </div>
              <input
                type="range"
                min={1}
                max={5}
                value={maxQueries}
                onChange={(e) => setMaxQueries(Number(e.target.value))}
                className="w-full accent-accent"
              />
              <p className="text-[10px] text-muted mt-1">
                Количество тем, которые спланирует AI
              </p>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-medium text-ink">Лимит источников</span>
                <span className="font-semibold text-accent">{maxSources}</span>
              </div>
              <input
                type="range"
                min={2}
                max={10}
                value={maxSources}
                onChange={(e) => setMaxSources(Number(e.target.value))}
                className="w-full accent-accent"
              />
              <p className="text-[10px] text-muted mt-1">
                Сколько веб-страниц будет выкачано и изучено
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="submit"
              disabled={!question.trim()}
              className="btn btn-primary"
            >
              <SparkleIcon size={14} />
              Начать исследование
            </button>
          </div>
        </form>
      )}

      {(running || report || error) && (
        <div className="space-y-4">
          <div className="rounded-2xl border p-4 bg-surface-tint/40"
               style={{ borderColor: 'rgb(var(--nb-border))' }}>
            <div className="flex items-center justify-between text-xs text-muted mb-2">
              <span className="font-medium text-ink">
                {error ? 'Ошибка исследования' : message || 'Исследование запущено…'}
              </span>
              <span className="font-semibold">{Math.round(ratio * 100)}%</span>
            </div>

            <div className="h-1.5 overflow-hidden rounded-full bg-surface-tint">
              <div
                className={`h-full transition-all duration-300 ${
                  error ? 'bg-red-500' : 'bg-accent'
                }`}
                style={{ width: `${Math.round(ratio * 100)}%` }}
              />
            </div>

            <ol className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              {DEEP_PHASE_ORDER.map((ph, idx) => {
                const done = activeIdx > idx || ratio >= 1;
                const active = activeIdx === idx && !error;
                return (
                  <li
                    key={ph}
                    className={`flex items-center gap-1.5 truncate ${
                      done
                        ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                        : active
                          ? 'text-accent font-semibold'
                          : 'text-subtle'
                    }`}
                  >
                    <span>{done ? '✓' : active ? '●' : '○'}</span>
                    <span className="truncate">{DEEP_PHASE_LABEL[ph]}</span>
                  </li>
                );
              })}
            </ol>
          </div>

          {queries.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Сгенерированные запросы
              </div>
              <div className="flex flex-wrap gap-1.5">
                {queries.map((q, i) => (
                  <span
                    key={i}
                    className="rounded-full border bg-surface px-2.5 py-1 text-xs text-ink"
                    style={{ borderColor: 'rgb(var(--nb-border))' }}
                  >
                    🔍 {q}
                  </span>
                ))}
              </div>
            </div>
          )}

          {hits.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Найденные источники ({hits.length})
              </div>
              <ul className="max-h-28 space-y-1 overflow-y-auto text-xs pr-1">
                {hits.map((h, i) => (
                  <li key={i} className="truncate text-muted">
                    ✓ <span className="font-medium text-ink">{h.title}</span> ({h.url})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Синтезированный отчёт
              </div>
              <div
                className="max-h-48 overflow-y-auto rounded-2xl border bg-surface p-3 text-xs leading-relaxed text-ink"
                style={{ borderColor: 'rgb(var(--nb-border))' }}
              >
                {report}
              </div>
            </div>
          )}

          {error && (
            <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
              {error}
            </p>
          )}

          {running && (
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => abortRef.current?.()}
                className="btn btn-secondary text-xs"
              >
                Остановить
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Tab: Web Search
   ============================================================ */

function HubSearchTab({
  notebookId,
  initialQuery = '',
  onSuccess,
  setIsProcessing,
}: {
  notebookId: string;
  initialQuery?: string;
  onSuccess: () => void;
  setIsProcessing: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchPreviewResult[]>([]);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);
  const [step, setStep] = useState<'search' | 'results' | 'ingesting'>('search');

  const previewMutation = useMutation({
    mutationFn: () => api.searchPreview(notebookId, query.trim(), 10),
    onSuccess: (data) => {
      setResults(data.results);
      setSelectedUrls(new Set(data.results.slice(0, 4).map((r) => r.url)));
      setStep('results');
    },
  });

  useEffect(() => {
    if (initialQuery.trim()) {
      previewMutation.mutate();
    }
  }, []);

  const handleStartIngest = () => {
    if (selectedUrls.size === 0) return;
    setStep('ingesting');
    setIsProcessing(true);
    setProgress(INITIAL_PROGRESS);

    const stream = api.ingestSearchAddBatchStream(
      notebookId,
      { urls: Array.from(selectedUrls) },
      (delta) => setProgress((prev) => progressFromDelta(delta, prev)),
    );

    stream.promise
      .then(() => {
        setIsProcessing(false);
        qc.invalidateQueries({ queryKey: ['sources', notebookId] });
        onSuccess();
      })
      .catch((err: Error) => {
        setIsProcessing(false);
        setProgress((p) => ({ ...p, error: err.message }));
      });
  };

  const toggleUrl = (u: string) => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(u)) next.delete(u);
      else next.add(u);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {step === 'search' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) previewMutation.mutate();
          }}
          className="space-y-4"
        >
          <div>
            <label className="section-label mb-1.5 block">Тема или поисковый запрос</label>
            <div className="flex gap-2">
              <input
                className="input"
                placeholder="например: Новые возможности TypeScript 5.5..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                required
              />
              <button
                type="submit"
                disabled={!query.trim() || previewMutation.isPending}
                className="btn btn-primary shrink-0"
              >
                <SearchIcon size={14} />
                {previewMutation.isPending ? 'Поиск…' : 'Найти'}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              Поиск выполняется в реальном времени. На следующем шаге вы сможете выбрать нужные ссылки.
            </p>
          </div>

          {previewMutation.isError && (
            <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
              {(previewMutation.error as Error).message}
            </p>
          )}
        </form>
      )}

      {step === 'results' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">
              Найдено: {results.length} · Выбрано: {selectedUrls.size}
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setSelectedUrls(new Set(results.map((r) => r.url)))}
                className="btn btn-ghost text-xs py-1"
              >
                Все
              </button>
              <button
                type="button"
                onClick={() => setSelectedUrls(new Set())}
                className="btn btn-ghost text-xs py-1"
              >
                Снять
              </button>
            </div>
          </div>

          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {results.map((r) => {
              const selected = selectedUrls.has(r.url);
              return (
                <li
                  key={r.url}
                  onClick={() => toggleUrl(r.url)}
                  className={`flex cursor-pointer gap-3 rounded-2xl border p-3 transition-all ${
                    selected
                      ? 'border-accent bg-accent-soft/40 shadow-sm'
                      : 'border-border bg-surface hover:bg-surface-tint'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => {}}
                    className="mt-1 h-4 w-4 rounded accent-accent shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-ink" title={r.title}>
                      {r.title}
                    </div>
                    <div className="truncate text-[10px] text-accent mt-0.5" title={r.url}>
                      {r.url}
                    </div>
                    {r.snippet && (
                      <p className="mt-1 line-clamp-2 text-[11px] text-muted leading-snug">
                        {r.snippet}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex justify-between items-center pt-2">
            <button
              type="button"
              onClick={() => setStep('search')}
              className="btn btn-secondary text-xs"
            >
              ← Изменить запрос
            </button>
            <button
              type="button"
              onClick={handleStartIngest}
              disabled={selectedUrls.size === 0}
              className="btn btn-primary"
            >
              <PlusIcon size={14} />
              Добавить {selectedUrls.size} источник(а)
            </button>
          </div>
        </div>
      )}

      {step === 'ingesting' && (
        <div className="space-y-4">
          <HubProgressStepper progress={progress} />
          {progress.error && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setStep('results')}
                className="btn btn-secondary text-xs"
              >
                ← Вернуться
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Tab: Raw Text / Markdown
   ============================================================ */

function HubTextTab({
  notebookId,
  onSuccess,
  setIsProcessing,
}: {
  notebookId: string;
  onSuccess: () => void;
  setIsProcessing: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const createNoteMutation = useMutation({
    mutationFn: async () => {
      const fileName = `${(title.trim() || 'Заметка').replace(/[/\\?%*:|"<>]/g, '_')}.md`;
      const file = new File([content], fileName, { type: 'text/markdown' });
      return api.uploadFileSource(notebookId, file);
    },
    onMutate: () => setIsProcessing(true),
    onSuccess: () => {
      setIsProcessing(false);
      qc.invalidateQueries({ queryKey: ['sources', notebookId] });
      onSuccess();
    },
    onError: () => setIsProcessing(false),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (content.trim()) createNoteMutation.mutate();
      }}
      className="space-y-4"
    >
      <div>
        <label className="section-label mb-1.5 block">Заголовок заметки</label>
        <input
          className="input"
          placeholder="Например: Тезисы встречи / Выжимка статьи"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
      </div>

      <div>
        <label className="section-label mb-1.5 block">Текст или Markdown</label>
        <textarea
          className="textarea min-h-[160px] font-mono text-xs"
          placeholder="Вставьте скопированный текст, заметки или конспект..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
        />
      </div>

      {createNoteMutation.isError && (
        <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {(createNoteMutation.error as Error).message}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="submit"
          disabled={!content.trim() || createNoteMutation.isPending}
          className="btn btn-primary"
        >
          <PlusIcon size={14} />
          {createNoteMutation.isPending ? 'Сохранение…' : 'Добавить заметку'}
        </button>
      </div>
    </form>
  );
}

/* ============================================================
   Shared Progress Stepper
   ============================================================ */

function HubProgressStepper({ progress }: { progress: ProgressState }) {
  const currentIndex = progress.stage ? STAGE_ORDER.indexOf(progress.stage) : -1;
  return (
    <div className="space-y-3 rounded-2xl border p-4 bg-surface-tint/30"
         style={{ borderColor: 'rgb(var(--nb-border))' }}>
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="font-medium text-ink">
          {progress.error ? '✗ Ошибка обработки' : progress.message || 'Готовлюсь…'}
        </span>
        {!progress.error && (
          <span className="font-semibold text-accent">{Math.round(progress.ratio * 100)}%</span>
        )}
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-surface-tint">
        <div
          className={`h-full transition-all duration-300 ${
            progress.error ? 'bg-red-500' : 'bg-accent'
          }`}
          style={{ width: `${Math.round(progress.ratio * 100)}%` }}
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
                  ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                  : active
                    ? 'text-accent font-semibold'
                    : 'text-subtle'
              }`}
            >
              <span className="w-4 text-center">
                {done ? '✓' : active ? '●' : '○'}
              </span>
              <span>{STAGE_LABEL[stage]}</span>
            </li>
          );
        })}
      </ol>

      {progress.error && (
        <p className="rounded-xl border border-red-300 bg-red-50 p-2.5 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {progress.error}
        </p>
      )}
    </div>
  );
}
