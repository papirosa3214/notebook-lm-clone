import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { streamChat } from '../lib/stream';
import { buildChatHistory } from '../lib/chatHistory';
import {
  scopeToSourceIds,
  useSourceScopeContext,
} from '../lib/sourceScopeContext';
import type { ChatMessage, CitationChunk } from '../lib/types';
import { Dot } from './Dot';
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
  ChevronDownIcon,
  DownloadIcon,
  PlusIcon,
} from './icons/NotebookLogo';

interface Props {
  notebookId: string;
  onSaveArtifact: (question: string, answer: string, citations: CitationChunk[]) => void;
  onOpenCitation?: (chunk: CitationChunk, index: number) => void;
}

export function ChatPanel({ notebookId, onSaveArtifact, onOpenCitation }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Source-scope state. Falls back to "all" when no provider is
  // present (older layouts / standalone tests).
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

  // Compact history payload (last N valid turns, char-budgeted).
  const historyForNextTurn = useMemo(() => buildChatHistory(messages), [messages]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const notebook = useQuery({
    queryKey: ['notebook', notebookId],
    queryFn: async () => {
      const r = await fetch(`/api/notebooks/${notebookId}`).then((r) => r.json());
      return r as { id: string; defaultProvider: string; defaultModel: string };
    },
  });

  // Persistent chat history. Replaces the local state on notebook switch and
  // a fresh query after each streamed assistant turn (invalidation in the
  // send() flow below) so reload preserves what was said.
  const qc = useQueryClient();
  const history = useQuery({
    queryKey: ['messages', notebookId],
    queryFn: () => api.getMessages(notebookId, { limit: 100 }),
    enabled: !!notebookId,
  });
  useEffect(() => {
    if (!history.data) return;
    // Server returns oldest-first; flip to oldest-first in renderer order.
    setMessages(
      history.data.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        citations: m.citations ?? undefined,
        createdAt: m.createdAt,
      })),
    );
  }, [history.data?.messages.length, notebookId]);

  // Sources are needed to drive the pinned SummaryCard — it counts
  // ready sources and shows the overview when at least one is ready.
  // Shares the cache key with SourcesPanel and SummaryPanel.
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

  /** Finished turns only — the header actions operate on real content. */
  const doneMessages = useMemo(
    () =>
      messages
        .filter((m) => !m.pending && !m.error && m.content.trim().length > 0)
        .map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
    [messages],
  );

  const [provider, setProvider] = useState('ollama');
  const [model, setModel] = useState('qwen3.6-27b-iq4-16k:latest');

  useEffect(() => {
    if (notebook.data) {
      setProvider(notebook.data.defaultProvider);
      setModel(notebook.data.defaultModel);
    }
  }, [notebook.data?.id, notebook.data?.defaultProvider, notebook.data?.defaultModel]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea as user types
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [input]);

  function send(messageOverride?: string) {
    const text = (messageOverride ?? input).trim();
    if (!text || streaming) return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    const userMsg: ChatMessage = { role: 'user', content: text };
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

    abortRef.current = streamChat(
      {
        notebookId,
        message: text,
        provider,
        model,
        topK: 5,
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
          // Server has persisted the user+assistant rows by this point.
          // Invalidate so a reload (or any other observer) sees the new history.
          qc.invalidateQueries({ queryKey: ['messages', notebookId] });
        },
        onAbort: () => {
          // Refresh / Strict-Mode double-mount superseded us — reset state
          // so the loader stops spinning without surfacing an error.
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
          // The assistant row persisted with empty content + error encoded
          // into the row, so refresh history so the next reload shows it.
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

  // Re-submit the most recent user-message with the currently selected
  // provider/model. Called from the inline retry button under an error.
  function retryLastUserMessage() {
    const userMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!userMsg) return;
    send(userMsg.content);
  }

  // Cycle the LLM provider ollama→anthropic→openai→ollama so the user can
  // hop to a different backend after a failure without leaving the page.
  function cycleProvider() {
    const order: Array<'ollama' | 'anthropic' | 'openai'> = ['ollama', 'anthropic', 'openai'];
    const cur = provider as (typeof order)[number];
    const next = order[(order.indexOf(cur) + 1) % order.length]!;
    setProvider(next);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Two ways to send: plain Enter (the existing shortcut) or Cmd/Ctrl+Enter
    // (a common chat-app convention that doesn't fight multi-line input).
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    // `flex-1 min-w-0 w-full` matters: every parent that hosts this panel
    // is a flex ROW (the desktop card, the NotebookLM-mode wrapper, the
    // mobile edge-to-edge wrapper). Without an explicit grow the panel is
    // sized to its content, so on a wide window it rendered ~890 px wide
    // inside a ~1210 px card and left a blank column on the right — which
    // reads as a phone-width chat that refuses to expand on desktop.
    <div className="flex h-full w-full min-h-0 min-w-0 flex-1 flex-col bg-canvas min-[640px]:bg-surface">
      {/* ---- Provider/model strip ---- */}
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">
            <SparkleIcon size={11} className="text-accent" />
            Чат
          </span>
          {scope && scope.hasReady && (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: scope.isScoped
                  ? 'rgb(var(--nb-accent-soft) / 0.5)'
                  : 'rgb(var(--nb-surface-tint))',
                color: scope.isScoped ? 'rgb(var(--nb-accent))' : 'rgb(var(--nb-muted))',
              }}
              title={
                scope.isScoped
                  ? 'Чат ограничен выбранными источниками'
                  : 'Чат по всем готовым источникам'
              }
            >
              {scope.isScoped
                ? `${scope.selectedIds.length} из ${scope.readyIds.length} источников`
                : 'Все источники'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {/* Whole-conversation actions. Per-answer copy/download/note
              live under each answer; these cover "выгрузить весь
              разговор" and "сделать заметку из разговора". */}
          {doneMessages.length > 0 && (
            <div className="mr-1 flex items-center gap-0.5" data-testid="conversation-actions">
              <button
                type="button"
                onClick={() =>
                  downloadText(
                    `разговор-${slugifyFilename(notebookId)}.md`,
                    conversationAsMarkdown('Разговор', doneMessages),
                  )
                }
                className="rounded-full p-1.5 text-muted transition-colors hover:bg-surface-tint hover:text-ink"
                title="Скачать весь разговор как Markdown"
                aria-label="Скачать весь разговор"
                data-testid="conversation-download"
              >
                <DownloadIcon size={13} />
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
                className="rounded-full p-1.5 text-muted transition-colors hover:bg-surface-tint hover:text-ink"
                title="Сохранить весь разговор в заметки"
                aria-label="Сохранить разговор в заметки"
                data-testid="conversation-save-note"
              >
                <PlusIcon size={13} />
              </button>
            </div>
          )}
          <select
            className="cursor-pointer rounded-full border bg-surface-tint py-1 pl-3 pr-7 text-xs font-medium text-ink transition-colors hover:bg-surface"
            style={{ borderColor: 'rgb(var(--nb-border))' }}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="ollama">Ollama</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
          <input
            className="w-44 rounded-full border bg-surface-tint py-1 px-3 text-xs transition-colors hover:bg-surface focus:bg-surface"
            style={{ borderColor: 'rgb(var(--nb-border))' }}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="модель"
            title={model}
          />
        </div>
      </div>

      {hasUncitedNoSourceAnswer && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-b bg-surface-tint px-4 py-2 text-xs text-muted"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
          role="status"
        >
          <span>
            Сейчас доступны {readyCount} источн{readyCount === 1 ? 'ик' : 'иков'}.
            {' '}Ответы без цитат выше не обновляются автоматически.
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
        {/* Pinned summary card — the cached notebook summary is rendered
            as the first message so the user sees the overview before any
            chat turns. Inline [N] citations are clickable. */}
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
        {/* Only the truly empty notebook gets this prompt — once there is
            at least one ready source the summary card or the input row
            are the obvious next move and the centered "ask a question"
            block just competes with them for the user's attention. */}
        {messages.length === 0 && readyCount === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl"
                style={{ backgroundColor: 'rgb(var(--nb-accent-soft))' }}>
                <SparkleIcon size={22} className="text-accent" />
              </div>
              <h3 className="text-base font-semibold">Задайте вопрос по источникам</h3>
              <p className="mt-1 text-sm text-muted">
                Ассистент ответит с цитатами{' '}
                <span className="chip-indigo mx-0.5">[1]</span>{' '}
                — кликните на маркер, чтобы увидеть оригинал.
              </p>
            </div>
          </div>
        )}
        {messages.map((m, i) => {
          // Find the user message that produced this assistant
          // answer. The chat send flow always pushes [user, assistant]
          // so the user message is the row immediately before this
          // one. For user messages we pass null (the chip row is
          // only rendered under assistant answers).
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
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* ---- Input ---- */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="px-3 pt-3 pb-3 min-[640px]:px-4 min-[640px]:pt-4"
      >
        <div
          className="flex items-end gap-2 rounded-2xl border bg-surface px-3 py-2 transition-all focus-within:border-accent"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
        >
          <textarea
            ref={textareaRef}
            className="min-h-[28px] max-h-40 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-sm leading-relaxed focus:outline-none focus:ring-0"
            placeholder={
              streaming
                ? 'Генерация ответа…'
                : 'Спросите что-нибудь по вашим источникам…'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={streaming}
            rows={1}
            style={{ outline: 'none' }}
          />
          {streaming ? (
            <button
              type="button"
              onClick={stop}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-surface transition-all hover:opacity-90"
              title="Остановить генерацию"
            >
              <StopIcon size={12} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-soft transition-all hover:bg-accent-hover disabled:opacity-40"
              title="Отправить (Enter)"
            >
              <SendIcon size={14} />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-subtle">
          Ответ может содержать неточности — проверяйте важные факты.{' '}
          <kbd className="rounded bg-surface-tint px-1.5 py-0.5 text-[10px] font-medium">
            Enter
          </kbd>{' '}
          для отправки ·{' '}
          <kbd className="rounded bg-surface-tint px-1.5 py-0.5 text-[10px] font-medium">
            Shift+Enter
          </kbd>{' '}
          для новой строки
        </p>
      </form>
    </div>
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
}: {
  message: ChatMessage;
  notebookId: string;
  /** The user question that produced this assistant answer, if any.
   *  Used to scope the suggestions endpoint. */
  prevUser: ChatMessage | null;
  /** Click handler for suggestion chips. */
  onPick: (suggestion: string) => void;
  onSaveArtifact: (question: string, answer: string, citations: CitationChunk[]) => void;
  onOpenCitation?: (chunk: CitationChunk, index: number) => void;
  onRetry?: () => void;
  onCycleProvider?: () => void;
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
    // The model's reply is plain text in the column — no avatar chip,
    // no frame, no background. Only the human's message has a tint.
    <div className="animate-fade-up">
      <div className="min-w-0 space-y-2">
        {/* Flat: the column already delimits the reply from the user's
            question above. A frame here would just nest another box
            inside the chat window. */}
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
          <div className="rounded-xl border bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300"
            style={{ borderColor: 'rgb(252 165 165 / 0.5)' }}>
            <p className="mb-1.5"><span className="font-medium">Ошибка:</span> {message.error}</p>
            <p className="mb-1.5 text-red-700/80 dark:text-red-300/80">
              Если проблема в провайдере — попробуйте сменить модель выше и задать вопрос ещё раз.
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
            onPick={onPick}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Render assistant answer text with inline [N] citation markers as clickable chips,
 * plus basic markdown (paragraphs, bullet lists, **bold**, headings).
 */
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

/**
 * A stored assistant row cannot be retroactively grounded when sources finish
 * ingestion. Flag the specific historical failure wording so the UI can tell
 * the user to retry instead of implying the currently-ready sources are empty.
 */
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
