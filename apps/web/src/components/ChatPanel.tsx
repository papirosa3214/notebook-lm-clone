import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { streamChat } from '../lib/stream';
import type { ChatMessage, CitationChunk } from '../lib/types';
import { Dot } from './Dot';
import {
  SendIcon,
  StopIcon,
  SparkleIcon,
  ChevronDownIcon,
} from './icons/NotebookLogo';

interface Props {
  notebookId: string;
  onSaveArtifact: (question: string, answer: string, citations: CitationChunk[]) => void;
  onOpenCitation?: (chunk: CitationChunk, index: number) => void;
}

export function ChatPanel({ notebookId, onSaveArtifact, onOpenCitation }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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

  function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    const userMsg: ChatMessage = { role: 'user', content: text };
    const assistantMsg: ChatMessage = { role: 'assistant', content: '', pending: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    let accText = '';
    let citations: CitationChunk[] = [];

    abortRef.current = streamChat(
      { notebookId, message: text, provider, model, topK: 5 },
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
        },
      },
    );
  }

  function stop() {
    abortRef.current?.();
    abortRef.current = null;
    setStreaming(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex h-full flex-col bg-canvas md:bg-surface">
      {/* ---- Provider/model strip ---- */}
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2"
        style={{ borderColor: 'rgb(var(--nb-border))' }}>
        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">
            <SparkleIcon size={11} className="text-accent" />
            Чат
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
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

      {/* ---- Messages ---- */}
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5 md:px-6">
        {messages.length === 0 && (
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
        {messages.map((m, i) => (
          <MessageBubble
            key={i}
            message={m}
            onSaveArtifact={onSaveArtifact}
            onOpenCitation={onOpenCitation}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* ---- Input ---- */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t p-3 md:p-4"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
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
  onSaveArtifact,
  onOpenCitation,
}: {
  message: ChatMessage;
  onSaveArtifact: (question: string, answer: string, citations: CitationChunk[]) => void;
  onOpenCitation?: (chunk: CitationChunk, index: number) => void;
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
    <div className="flex animate-fade-up items-start gap-3">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl"
        style={{
          background:
            'linear-gradient(135deg, rgb(var(--nb-ai)) 0%, rgb(46 38 117) 100%)',
        }}
      >
        <SparkleIcon size={14} className="text-white" />
      </div>
      <div className="min-w-0 max-w-[88%] flex-1 space-y-2">
        <div className="prose-chat rounded-2xl rounded-tl-md border bg-surface px-4 py-3"
          style={{ borderColor: 'rgb(var(--nb-border) / 0.6)' }}>
          {message.pending && !message.content ? (
            <span className="inline-flex items-center gap-1.5 text-muted">
              <Dot delay={0} />
              <Dot delay={150} />
              <Dot delay={300} />
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
            Ошибка: {message.error}
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
          <button
            className="btn btn-ghost text-xs"
            onClick={() => {
              void onSaveArtifact('?', message.content, message.citations ?? []);
            }}
            title="Сохранить как заметку"
          >
            Сохранить в заметки
          </button>
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
      if (chunk && onOpenCitation) {
        parts.push(
          <button
            key={`c-${key++}`}
            type="button"
            onClick={() => onOpenCitation(chunk, n - 1)}
            className="chip-indigo mx-0.5 cursor-pointer align-baseline transition-all hover:brightness-95"
            title={chunk.text}
          >
            [{n}]
          </button>,
        );
      } else {
        parts.push(
          <span key={`c-${key++}`} className="chip-indigo mx-0.5 align-baseline">
            [{n}]
          </span>,
        );
      }
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