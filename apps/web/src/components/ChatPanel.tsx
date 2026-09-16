import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { streamChat } from '../lib/stream';
import type { ChatMessage, CitationChunk } from '../lib/types';

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

  function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Чат</h2>
        <select
          className="input w-auto py-1 text-xs"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="ollama">Ollama</option>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
        <input
          className="input flex-1 py-1 text-xs"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="модель"
        />
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">
            Задай вопрос по источникам. Ассистент ответит с цитатами [N] — кликни на маркер, чтобы
            увидеть откуда цитата.
          </p>
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

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
      >
        <input
          className="input flex-1"
          placeholder={streaming ? 'Генерация…' : 'Спроси что-нибудь…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={streaming}
        />
        {streaming ? (
          <button type="button" onClick={stop} className="btn btn-secondary">
            Стоп
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
            Отправить
          </button>
        )}
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
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-amber-600 px-4 py-2 text-sm text-white shadow-sm">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-2">
        <div className="card px-4 py-3 text-sm">
          <AnswerContent
            text={message.content || (message.pending ? '⏳' : '…')}
            citations={message.citations}
            onOpenCitation={onOpenCitation}
          />
        </div>
        {message.error && <div className="text-xs text-red-600">Ошибка: {message.error}</div>}
        {message.citations && message.citations.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.citations.map((c, idx) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onOpenCitation?.(c, idx)}
                className="chip-indigo cursor-pointer hover:brightness-95"
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
            title="Сохранить как артефакт"
          >
            💾 Сохранить как артефакт
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
        <h3 key={`h-${key++}`} className="mt-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 first:mt-0">
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
            className="chip-indigo mx-0.5 cursor-pointer !py-0 align-baseline"
            title={chunk.text}
          >
            [{n}]
          </button>,
        );
      } else {
        parts.push(
          <span key={`c-${key++}`} className="chip-indigo mx-0.5 !py-0 align-baseline">
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