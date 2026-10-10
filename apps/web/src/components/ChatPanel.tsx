import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { streamChat } from '../lib/stream';
import { buildChatHistory } from '../lib/chatHistory';
import {
  scopeToSourceIds,
  useSourceScopeContext,
} from '../lib/sourceScopeContext';
import type { ChatMessage, CitationChunk, ProviderId } from '../lib/types';
import { SummaryCard } from './SummaryCard';
import { CitationChip } from './CitationChip';
import { SuggestionsChips } from './SuggestionsChips';
import { MessageActions } from './MessageActions';
import {
  answerAsMarkdown,
  conversationAsMarkdown,
  downloadText,
  slugifyFilename,
} from '../lib/download';
import {
  SendIcon,
  StopIcon,
  SparkleIcon,
  DownloadIcon,
  PlusIcon,
  PaperclipIcon,
  CloseIcon,
  ChevronDownIcon,
} from './icons/NotebookLogo';

interface Props {
  notebookId: string;
  onSaveArtifact: (question: string, answer: string, citations: CitationChunk[]) => void;
  onOpenCitation?: (chunk: CitationChunk, index: number) => void;
}

/** Display names for the provider ids the API hands us. */
const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  minimax: 'MiniMax',
};

const providerStorageKey = (notebookId: string) => `chat-provider:${notebookId}`;
const modelStorageKey = (notebookId: string) => `chat-model:${notebookId}`;
const reasoningStorageKey = (notebookId: string) => `chat-reasoning:${notebookId}`;

function readSaved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSaved(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
}

type ReasoningLevel = 'fast' | 'standard' | 'deep';

/** Custom dropdown that always opens upward — used in the input toolbar. */
function ToolbarSelect<T extends string>({
  value,
  options,
  onChange,
  testId,
  title,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  testId?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative" data-testid={testId} title={title}>
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 bg-transparent py-0.5 text-xs font-medium text-ink hover:text-accent focus:outline-none"
        onClick={() => setOpen((p) => !p)}
      >
        <span>{current?.label ?? value}</span>
        <ChevronDownIcon
          size={10}
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          className="absolute bottom-full left-0 z-50 mb-1.5 min-w-max overflow-hidden rounded-xl border bg-surface shadow-lg"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`flex w-full items-center px-3 py-2 text-left text-xs transition-colors hover:bg-surface-tint ${
                o.value === value ? 'font-semibold text-accent' : 'text-ink'
              }`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatPanel({ notebookId, onSaveArtifact, onOpenCitation }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  let scope: ReturnType<typeof useSourceScopeContext> | null = null;
  try {
    scope = useSourceScopeContext();
  } catch {
    scope = null;
  }
  const scopedSourceIds = useMemo(
    () => (scope ? scopeToSourceIds(scope.selectedIds, scope.readyIds) : undefined),
    [scope],
  );

  const historyForNextTurn = useMemo(() => buildChatHistory(messages), [messages]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(
    () => (readSaved(reasoningStorageKey(notebookId)) as ReasoningLevel) || 'standard',
  );

  const abortRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const notebook = useQuery({
    queryKey: ['notebook', notebookId],
    queryFn: async () => {
      const r = await fetch(`/api/notebooks/${notebookId}`).then((r) => r.json());
      return r as { id: string; defaultProvider: string; defaultModel: string };
    },
  });

  const qc = useQueryClient();
  const history = useQuery({
    queryKey: ['messages', notebookId],
    queryFn: () => api.getMessages(notebookId, { limit: 100 }),
    enabled: !!notebookId,
  });

  useEffect(() => {
    if (!history.data) return;
    setMessages(
      history.data.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        citations: m.citations ?? undefined,
        createdAt: m.createdAt,
      })),
    );
  }, [history.data?.messages.length, notebookId]);

  const sources = useQuery({
    queryKey: ['sources', notebookId],
    queryFn: () => api.listSources(notebookId),
  });
  const readyCount =
    sources.data?.sources.filter((s) => s.status === 'ready').length ?? 0;
  const hasUncitedNoSourceAnswer = useMemo(
    () => containsUncitedNoSourceAnswer(messages, readyCount),
    [messages, readyCount],
  );

  const doneMessages = useMemo(
    () =>
      messages
        .filter((m) => !m.pending && !m.error && m.content.trim().length > 0)
        .map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          citations: m.citations,
        })),
    [messages],
  );

  const [provider, setProvider] = useState('minimax');
  const [model, setModel] = useState('MiniMax-M3');

  const providersQuery = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.listProviders(),
    staleTime: 5 * 60 * 1000,
  });
  const providerList = providersQuery.data?.providers ?? [];
  const providerIds: ProviderId[] = providerList.length
    ? providerList.map((p) => p.id)
    : provider
      ? [provider as ProviderId]
      : [];
  const modelOptions = providerList.find((p) => p.id === provider)?.models ?? [];

  function changeProvider(next: string) {
    setProvider(next);
    writeSaved(providerStorageKey(notebookId), next);
    const def = providerList.find((p) => p.id === next)?.defaultModel;
    if (def) {
      setModel(def);
      writeSaved(modelStorageKey(notebookId), def);
    }
  }

  function changeModel(next: string) {
    setModel(next);
    writeSaved(modelStorageKey(notebookId), next);
  }

  function changeReasoning(next: ReasoningLevel) {
    setReasoningLevel(next);
    writeSaved(reasoningStorageKey(notebookId), next);
  }

  useEffect(() => {
    if (!notebook.data) return;
    const savedProvider = readSaved(providerStorageKey(notebookId));
    const savedModel = readSaved(modelStorageKey(notebookId));
    setProvider(savedProvider ?? notebook.data.defaultProvider);
    setModel(savedModel ?? notebook.data.defaultModel);
  }, [notebookId, notebook.data?.id, notebook.data?.defaultProvider, notebook.data?.defaultModel]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [input]);

  async function send(messageOverride?: string) {
    const text = (messageOverride ?? input).trim();
    if ((!text && attachments.length === 0) || streaming || isUploadingFiles) return;

    // If there are attached files, upload them first
    if (attachments.length > 0) {
      setIsUploadingFiles(true);
      try {
        for (const file of attachments) {
          await api.uploadFileSource(notebookId, file);
        }
        qc.invalidateQueries({ queryKey: ['sources', notebookId] });
        setAttachments([]);
      } catch (err) {
        console.error('Failed to upload attachments', err);
      } finally {
        setIsUploadingFiles(false);
      }
    }

    const queryText = text || 'Проанализируй прикреплённые материалы.';
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const userMsg: ChatMessage = { role: 'user', content: queryText };
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      pending: true,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    let accText = '';
    let citations: CitationChunk[] = [];

    // Calculate topK based on reasoning effort
    const topK = reasoningLevel === 'fast' ? 3 : reasoningLevel === 'deep' ? 12 : 5;

    abortRef.current = streamChat(
      {
        notebookId,
        message: queryText,
        provider,
        model,
        topK,
        sourceIds: scopedSourceIds,
        history: historyForNextTurn,
      },
      {
        onCitations: (chunks) => {
          citations = chunks;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') next[next.length - 1] = { ...last, citations: chunks };
            return next;
          });
        },
        onToken: (t) => {
          accText += t;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: accText };
            return next;
          });
        },
        onDone: () => {
          setStreaming(false);
          abortRef.current = null;
          qc.invalidateQueries({ queryKey: ['messages', notebookId] });
        },
        onAbort: () => {
          setStreaming(false);
          abortRef.current = null;
        },
        onError: (msg) => {
          setStreaming(false);
          abortRef.current = null;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant')
              next[next.length - 1] = { ...last, error: msg, pending: false };
            return next;
          });
          qc.invalidateQueries({ queryKey: ['messages', notebookId] });
        },
      },
    );
  }

  function stop() {
    abortRef.current?.();
    abortRef.current = null;
    setStreaming(false);
  }

  function retryLastUserMessage() {
    const userMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!userMsg) return;
    send(userMsg.content);
  }

  function cycleProvider() {
    if (providerIds.length === 0) return;
    const cur = providerIds.indexOf(provider as ProviderId);
    const next = providerIds[(cur + 1) % providerIds.length]!;
    changeProvider(next);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const handleFilesAdded = (files: FileList | null) => {
    if (!files?.length) return;
    const arr = Array.from(files);
    setAttachments((prev) => [...prev, ...arr]);
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  // Calculate estimated context metrics
  const activeSourcesCount = scopedSourceIds ? scopedSourceIds.length : readyCount;
  const estimatedTokens = Math.max(1, activeSourcesCount * 3.5);

  return (
    <div
      className="flex h-full w-full min-h-0 min-w-0 flex-1 flex-col bg-canvas"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        handleFilesAdded(e.dataTransfer.files);
      }}
    >
      {/* Hidden file input for attachments */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.txt,.md,.markdown,.png,.jpg,.jpeg"
        className="hidden"
        onChange={(e) => handleFilesAdded(e.target.files)}
      />

      {/* ---- Clean Minimal Top Header ---- */}
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
            <SparkleIcon size={13} className="text-accent" />
            Чат
          </span>
          {scope && scope.hasReady && (
            <button
              type="button"
              onClick={() => scope.selectAll()}
              className="rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors"
              style={{
                backgroundColor: scope.isScoped
                  ? 'rgb(var(--nb-accent-soft) / 0.7)'
                  : 'rgb(var(--nb-surface-tint))',
                color: scope.isScoped ? 'rgb(var(--nb-accent-ink))' : 'rgb(var(--nb-muted))',
              }}
              title={
                scope.isScoped
                  ? 'Кликните, чтобы выбрать все источники'
                  : 'Чат по всем готовым источникам'
              }
            >
              {scope.isScoped
                ? `${scope.selectedIds.length} из ${scope.readyIds.length} в фокусе`
                : `${scope.readyIds.length} источн.`}
            </button>
          )}
        </div>

        {/* Top actions */}
        <div className="flex items-center gap-1">
          {doneMessages.length > 0 && (
            <div className="flex items-center gap-1" data-testid="conversation-actions">
              <button
                type="button"
                onClick={() =>
                  downloadText(
                    `разговор-${slugifyFilename(notebookId)}.md`,
                    conversationAsMarkdown('Разговор', doneMessages),
                  )
                }
                className="btn-icon"
                title="Скачать весь разговор как Markdown"
                aria-label="Скачать весь разговор"
                data-testid="conversation-download"
              >
                <DownloadIcon size={14} />
              </button>
              <button
                type="button"
                onClick={() =>
                  void onSaveArtifact(
                    'Разговор',
                    conversationAsMarkdown('Разговор', doneMessages),
                    [],
                  )
                }
                className="btn-icon"
                title="Сохранить весь разговор в заметки"
                aria-label="Сохранить разговор в заметки"
                data-testid="conversation-save-note"
              >
                <PlusIcon size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {hasUncitedNoSourceAnswer && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-b bg-surface-tint px-4 py-2 text-xs text-muted"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
          role="status"
        >
          <span>
            Сейчас доступны {readyCount} источн{readyCount === 1 ? 'ик' : 'иков'}. Ответы без цитат выше не обновляются автоматически.
          </span>
          <button
            type="button"
            onClick={retryLastUserMessage}
            disabled={streaming}
            className="font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            Повторить последний вопрос
          </button>
        </div>
      )}

      {/* ---- Messages ---- */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 min-[640px]:px-6">
        {readyCount > 0 && (
          <SummaryCard
            notebookId={notebookId}
            readyCount={readyCount}
            onOpenCitation={onOpenCitation}
            onSaveNote={(content, citations) => {
              void onSaveArtifact('Краткое содержание', content, citations);
            }}
            onAsk={setInput}
          />
        )}

        {messages.length === 0 && readyCount === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md text-center">
              <div
                className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl"
              >
                <SparkleIcon size={22} className="text-muted" />
              </div>
              <h3 className="text-base font-semibold text-ink">Задайте вопрос по источникам</h3>
              <p className="mt-1 text-xs text-muted">
                Ассистент ответит с интерактивными цитатами <span className="mx-0.5 text-muted">[1]</span>.
              </p>
            </div>
          </div>
        )}

        {messages.map((m, i) => {
          const prev = i > 0 ? messages[i - 1] : undefined;
          const prevUser = prev && prev.role === 'user' ? prev : null;
          return (
            <MessageBubble
              key={i}
              message={m}
              notebookId={notebookId}
              prevUser={prevUser}
              onPick={setInput}
              onSaveArtifact={onSaveArtifact}
              onOpenCitation={onOpenCitation}
              onRetry={retryLastUserMessage}
              onCycleProvider={cycleProvider}
              provider={provider}
              model={model}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* ---- Modern Industrial Standard Input Dock ---- */}
      <div className="p-3 min-[640px]:p-4 max-w-4xl w-full mx-auto">
        <div
          className={`flex flex-col rounded-3xl border bg-surface transition-all shadow-sm focus-within:border-accent focus-within:shadow-md ${
            isDragging ? 'border-accent bg-accent-soft/30 ring-2 ring-accent' : ''
          }`}
          style={{ borderColor: 'rgb(var(--nb-border))' }}
        >
          {/* Attachments preview row */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3.5 pt-3 pb-1 border-b border-border/40">
              {attachments.map((file, idx) => (
                <div
                  key={`${file.name}-${idx}`}
                  className="flex items-center gap-1.5 rounded-xl border bg-surface-tint/80 px-2.5 py-1 text-xs text-ink"
                  style={{ borderColor: 'rgb(var(--nb-border))' }}
                >
                  <span aria-hidden>📄</span>
                  <span className="max-w-[140px] truncate font-medium">{file.name}</span>
                  <span className="text-[10px] text-muted">({Math.round(file.size / 1024)} KB)</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(idx)}
                    className="ml-1 rounded-full p-0.5 text-muted hover:text-red-500 transition-colors"
                    title="Удалить"
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            className="min-h-[44px] max-h-48 w-full resize-none border-0 bg-transparent px-4 pt-3 pb-2 text-sm leading-relaxed text-ink placeholder:text-muted focus:outline-none focus:ring-0"
            placeholder={
              streaming
                ? 'Генерация ответа…'
                : isUploadingFiles
                  ? 'Загрузка прикреплённых файлов…'
                  : 'Спросите что-нибудь по источникам или прикрепите файл…'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={streaming || isUploadingFiles}
            rows={1}
          />

          {/* Bottom Dock Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-t border-border/40">
            {/* Left toolbar items */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {/* Attach button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={streaming || isUploadingFiles}
                className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-tint hover:text-ink transition-colors"
                title="Прикрепить файлы (PDF, DOCX, TXT, MD, картинки)"
              >
                <PaperclipIcon size={16} />
              </button>

              {/* Provider & Model chip selector */}
              <div className="flex items-center rounded-full border bg-surface-tint px-2 py-0.5 text-xs text-ink"
                   style={{ borderColor: 'rgb(var(--nb-border))' }}>
                <span className="mr-1 text-[11px] opacity-70">⚡</span>
                <ToolbarSelect
                  value={provider as string}
                  options={providerIds.map((id) => ({ value: id, label: PROVIDER_LABELS[id] ?? id }))}
                  onChange={changeProvider}
                  testId="chat-provider"
                  title="Выберите LLM провайдера"
                />
                <span className="mx-1 text-muted">/</span>
                <ToolbarSelect
                  value={model}
                  options={modelOptions.map((m) => ({ value: m, label: m }))}
                  onChange={changeModel}
                  testId="chat-model"
                  title="Выберите модель"
                />
              </div>

              {/* Reasoning Level Selector */}
              <div className="flex items-center rounded-full border bg-surface-tint px-2 py-0.5 text-xs text-ink"
                   style={{ borderColor: 'rgb(var(--nb-border))' }}>
                <span className="mr-1 text-[11px]">💡</span>
                <ToolbarSelect<ReasoningLevel>
                  value={reasoningLevel}
                  options={[
                    { value: 'fast', label: 'Быстро' },
                    { value: 'standard', label: 'Авто (Стандарт)' },
                    { value: 'deep', label: 'Глубокие рассуждения' },
                  ]}
                  onChange={changeReasoning}
                  title="Уровень рассуждений и глубина анализа"
                />
              </div>

              {/* Context token indicator */}
              <div
                className="hidden sm:flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium text-muted bg-surface-tint"
                title={`Активный контекст: ${activeSourcesCount} источников в скоупе (~${estimatedTokens.toFixed(1)}k токенов)`}
              >
                <span className="mr-1">📊</span>
                <span>{activeSourcesCount} ист. (~{estimatedTokens.toFixed(0)}k токенов)</span>
              </div>
            </div>

            {/* Right send button */}
            <div className="flex items-center gap-1.5 ml-auto">
              {streaming ? (
                <button
                  type="button"
                  onClick={stop}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-surface transition-all hover:opacity-90 active:scale-95"
                  title="Остановить генерацию"
                >
                  <StopIcon size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={(!input.trim() && attachments.length === 0) || isUploadingFiles}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition-all hover:opacity-90 disabled:opacity-30 active:scale-95 shadow-sm"
                  title="Отправить сообщение (Enter)"
                >
                  <SendIcon size={14} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Small hint under input */}
        <div className="mt-1.5 flex items-center justify-between px-2 text-[10px] text-muted">
          <span>
            {reasoningLevel === 'deep' ? 'Режим глубокого анализа: расширенный поиск по всем чанкам' : 'Ответ строится по источникам с точными цитатами'}
          </span>
          <span className="hidden sm:inline">
            <kbd className="font-sans">Enter</kbd> — отправить, <kbd className="font-sans">Shift+Enter</kbd> — перенос строки
          </span>
        </div>
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-strong"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}

function MessageBubble({
  message,
  notebookId,
  prevUser,
  onPick,
  onSaveArtifact,
  onOpenCitation,
  onRetry,
  onCycleProvider,
  provider,
  model,
}: {
  message: ChatMessage;
  notebookId: string;
  prevUser: ChatMessage | null;
  onPick: (text: string) => void;
  onSaveArtifact: (question: string, answer: string, citations: CitationChunk[]) => void;
  onOpenCitation?: (chunk: CitationChunk, index: number) => void;
  onRetry?: () => void;
  onCycleProvider?: () => void;
  provider?: string;
  model?: string;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end animate-fade-up">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] text-white shadow-soft">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="animate-fade-up">
      <div className="min-w-0 space-y-2">
        <div className="prose-chat text-[15px] leading-relaxed">
          {message.pending && !message.content ? (
            <span className="inline-flex items-center gap-2 text-sm text-muted">
              <span className="inline-flex items-center gap-1.5">
                <Dot delay={0} />
                <Dot delay={150} />
                <Dot delay={300} />
              </span>
              Загружаю модель…
            </span>
          ) : (
            <AnswerContent
              text={message.content}
              citations={message.citations}
              onOpenCitation={onOpenCitation}
            />
          )}
        </div>
        {message.error && (
          <div
            className="rounded-xl border bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300"
            style={{ borderColor: 'rgb(252 165 165 / 0.5)' }}
          >
            <p className="mb-1.5"><span className="font-medium">Ошибка:</span> {message.error}</p>
            <p className="mb-1.5 text-red-700/80 dark:text-red-300/80">
              Если проблема в провайдере — попробуйте сменить модель в поле ввода и задать вопрос ещё раз.
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={onRetry}
                className="rounded-md border border-red-300 px-2 py-1 font-medium hover:bg-red-100 dark:hover:bg-red-900/40"
              >
                🔄 Повторить
              </button>
              <button
                type="button"
                onClick={onCycleProvider}
                className="rounded-md border border-red-300 px-2 py-1 font-medium hover:bg-red-100 dark:hover:bg-red-900/40"
              >
                🔁 Сменить провайдера
              </button>
            </div>
          </div>
        )}
        {message.citations && message.citations.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.citations.map((c, idx) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onOpenCitation?.(c, idx)}
                className="chip-indigo cursor-pointer transition-all hover:brightness-95"
                title={c.text}
              >
                [{idx + 1}] {c.sourceTitle}
              </button>
            ))}
          </div>
        )}
        {message.content && !message.pending && (
          <MessageActions
            createdAt={message.createdAt}
            markdown={answerAsMarkdown(prevUser?.content, message.content, message.citations)}
            filename={`ответ-${slugifyFilename(prevUser?.content ?? 'notebook')}`}
            onSaveNote={() => {
              void onSaveArtifact(
                prevUser?.content ?? '?',
                message.content,
                message.citations ?? [],
              );
            }}
          />
        )}
        {message.content && !message.pending && !message.error && prevUser && (
          <SuggestionsChips
            notebookId={notebookId}
            question={prevUser.content}
            answer={message.content}
            provider={provider}
            model={model}
            onPick={onPick}
          />
        )}
      </div>
    </div>
  );
}

function AnswerContent({
  text,
  citations,
  onOpenCitation,
}: {
  text: string;
  citations?: CitationChunk[];
  onOpenCitation?: (chunk: CitationChunk, index: number) => void;
}) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split('\n');
  let bulletBuf: string[] = [];
  let key = 0;

  const flushBullets = () => {
    if (bulletBuf.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`} className="mb-2 list-disc space-y-1 pl-5">
        {bulletBuf.map((line, j) => (
          <li key={j}>{renderInline(line, citations, onOpenCitation)}</li>
        ))}
      </ul>,
    );
    bulletBuf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      continue;
    }
    if (trimmed.startsWith('## ')) {
      flushBullets();
      blocks.push(
        <h3 key={`h-${key++}`} className="first:mt-0">
          {trimmed.slice(3)}
        </h3>,
      );
      continue;
    }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      bulletBuf.push(trimmed.slice(2));
      continue;
    }
    flushBullets();
    blocks.push(
      <p key={`p-${key++}`} className="mb-2 whitespace-pre-wrap last:mb-0">
        {renderInline(trimmed, citations, onOpenCitation)}
      </p>,
    );
  }
  flushBullets();
  return <>{blocks}</>;
}

function renderInline(
  text: string,
  citations: CitationChunk[] | undefined,
  onOpenCitation: ((chunk: CitationChunk, index: number) => void) | undefined,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const cite = text.slice(i).match(/^\[(\d+)\]/);
    const bold = text.slice(i).match(/^\*\*([^*]+)\*\*/);
    if (cite) {
      const n = Number(cite[1]);
      const chunk = citations?.[n - 1];
      parts.push(
        <CitationChip
          key={`c-${key++}`}
          index={n}
          chunk={chunk}
          onOpenCitation={onOpenCitation}
        />,
      );
      i += cite[0].length;
    } else if (bold) {
      parts.push(<strong key={`b-${key++}`}>{bold[1]}</strong>);
      i += bold[0].length;
    } else {
      const next = text.indexOf('[', i);
      const nextBold = text.indexOf('**', i);
      const stop =
        next === -1
          ? nextBold === -1
            ? text.length
            : nextBold
          : nextBold === -1
            ? next
            : Math.min(next, nextBold);
      parts.push(text.slice(i, stop));
      i = stop;
    }
  }
  return parts;
}

export function containsUncitedNoSourceAnswer(
  messages: ChatMessage[],
  readyCount: number,
): boolean {
  if (readyCount === 0) return false;
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      (!message.citations || message.citations.length === 0) &&
      /no sources available|источники\s+(?:отсутствуют|недоступны)/iu.test(message.content),
  );
}
