import { Link, useParams } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { SourcesPanel } from '../components/SourcesPanel';
import { ChatPanel } from '../components/ChatPanel';
import { ArtifactsPanel } from '../components/ArtifactsPanel';
import { SummaryPanel } from '../components/SummaryPanel';
import { useTheme } from '../hooks/useTheme';
import type { CitationChunk } from '../lib/types';

function buildArtifactMarkdown(
  question: string,
  answer: string,
  citations: CitationChunk[],
): { title: string; contentMd: string } {
  const title = question.length > 80 ? question.slice(0, 77) + '…' : question;
  const lines = [`# ${title}`, '', '## Ответ', '', answer.trim(), ''];
  if (citations.length > 0) {
    lines.push('## Источники', '');
    citations.forEach((c, i) => {
      lines.push(`**[${i + 1}]** ${c.sourceTitle}`);
      const snippet = c.text.length > 400 ? c.text.slice(0, 400) + '…' : c.text;
      lines.push('', snippet, '');
    });
  }
  return { title, contentMd: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n' };
}

type MobileTab = 'sources' | 'overview' | 'chat' | 'artifacts';

export default function NotebookPage() {
  const { id } = useParams<{ id: string }>();
  const notebookId = id!;
  const { theme, toggle } = useTheme();
  const notebook = useQuery({
    queryKey: ['notebook', notebookId],
    queryFn: async () => {
      const r = await fetch(`/api/notebooks/${notebookId}`).then((r) => r.json());
      return r as { id: string; title: string };
    },
  });

  const sources = useQuery({
    queryKey: ['sources', notebookId],
    queryFn: () => api.listSources(notebookId),
  });

  const [prefilled, setPrefilled] = useState<{ title: string; contentMd: string } | null>(null);
  const [openCitation, setOpenCitation] = useState<{
    chunk: CitationChunk;
    index: number;
  } | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat');

  if (notebook.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-zinc-500">
        Загрузка…
      </div>
    );
  }
  if (notebook.isError || !notebook.data) {
    return (
      <div className="mx-auto max-w-md p-10 text-center">
        <p className="text-sm text-red-600">Не удалось загрузить ноутбук</p>
        <Link to="/" className="mt-4 inline-block text-sm text-amber-700 hover:underline">
          ← На главную
        </Link>
      </div>
    );
  }

  const hasSources = (sources.data?.sources.length ?? 0) > 0;
  const hasReadySources = sources.data?.sources.some((s) => s.status === 'ready') ?? false;
  const readyCount = sources.data?.sources.filter((s) => s.status === 'ready').length ?? 0;
  const totalCount = sources.data?.sources.length ?? 0;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 md:px-6">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
            ←
          </Link>
          <h1 className="truncate text-base font-semibold md:text-lg">{notebook.data.title}</h1>
          {sources.data && (
            <span className="hidden text-xs text-zinc-500 md:inline">
              {readyCount} из {totalCount} готовы
            </span>
          )}
        </div>
        <button
          onClick={toggle}
          className="btn btn-ghost text-base"
          title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      {/* Mobile-only tabs. */}
      <nav className="flex shrink-0 gap-1 border-b border-zinc-200 px-2 py-2 dark:border-zinc-800 md:hidden">
        <MobileTabBtn active={mobileTab === 'sources'} onClick={() => setMobileTab('sources')}>
          Источники
          {totalCount > 0 && (
            <span className="ml-1 rounded-full bg-zinc-200 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">
              {readyCount}/{totalCount}
            </span>
          )}
        </MobileTabBtn>
        <MobileTabBtn active={mobileTab === 'overview'} onClick={() => setMobileTab('overview')}>
          ✨ Обзор
        </MobileTabBtn>
        <MobileTabBtn active={mobileTab === 'chat'} onClick={() => setMobileTab('chat')}>
          Чат
        </MobileTabBtn>
        <MobileTabBtn active={mobileTab === 'artifacts'} onClick={() => setMobileTab('artifacts')}>
          Артефакты
        </MobileTabBtn>
      </nav>

      <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[280px_1fr_340px]">
        <aside className="hidden border-r border-zinc-200 dark:border-zinc-800 md:block md:overflow-hidden">
          <SourcesPanel notebookId={notebookId} />
        </aside>
        <main className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto bg-zinc-50/60 p-3 dark:bg-zinc-950 md:gap-4 md:p-4">
          {/* SourcesPanel on mobile lives here when the Sources tab is active; on desktop it lives in the left aside. */}
          <div className={mobileTab === 'sources' ? '' : 'hidden'}>
            <div className="card overflow-hidden">
              <SourcesPanel notebookId={notebookId} />
            </div>
          </div>

          {/* Overview (SummaryPanel) is always shown in the centre column on desktop; on mobile only when its tab is active. */}
          <div className={mobileTab === 'overview' ? '' : 'hidden md:block'}>
            {hasReadySources ? (
              <SummaryPanel
                notebookId={notebookId}
                onOpenSource={(chunk) => setOpenCitation({ chunk, index: 0 })}
              />
            ) : (
              <EmptyCentreState hasAnySources={hasSources} />
            )}
          </div>

          {/* ChatPanel is always in the centre column on desktop; on mobile only when its tab is active. */}
          <div className={mobileTab === 'chat' ? 'flex flex-1' : 'hidden md:flex md:flex-1'}>
            <div className="card flex min-h-[420px] w-full flex-1 overflow-hidden">
              <ChatPanel
                notebookId={notebookId}
                onSaveArtifact={(question, answer, citations) => {
                  setPrefilled(buildArtifactMarkdown(question, answer, citations));
                }}
                onOpenCitation={(chunk, index) => setOpenCitation({ chunk, index })}
              />
            </div>
          </div>

          {/* ArtifactsPanel on mobile lives here when the Artifacts tab is active; on desktop it lives in the right aside. */}
          <div className={mobileTab === 'artifacts' ? '' : 'hidden'}>
            <div className="card overflow-hidden">
              <ArtifactsPanel
                notebookId={notebookId}
                prefilled={prefilled}
                onConsumedPrefilled={() => setPrefilled(null)}
              />
            </div>
          </div>
        </main>
        <aside className="hidden border-l border-zinc-200 dark:border-zinc-800 md:block md:overflow-hidden">
          <ArtifactsPanel
            notebookId={notebookId}
            prefilled={prefilled}
            onConsumedPrefilled={() => setPrefilled(null)}
          />
        </aside>
      </div>

      {openCitation && (
        <CitationDialog
          chunk={openCitation.chunk}
          index={openCitation.index}
          onClose={() => setOpenCitation(null)}
        />
      )}
    </div>
  );
}

function MobileTabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyCentreState({ hasAnySources }: { hasAnySources: boolean }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-8 text-center">
      <span className="text-3xl" aria-hidden>
        📚
      </span>
      <p className="text-sm font-medium">
        {hasAnySources ? 'Источники ещё парсятся' : 'Здесь появится обзор ноутбука'}
      </p>
      <p className="max-w-sm text-xs text-zinc-500">
        {hasAnySources
          ? 'Обзор сгенерируется автоматически, как только Ragflow закончит обработку.'
          : 'Добавьте первый источник — обзор появится в этой карточке, а чат сможет отвечать по нему.'}
      </p>
    </div>
  );
}

function CitationDialog({
  chunk,
  index,
  onClose,
}: {
  chunk: CitationChunk;
  index: number;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg p-5 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">
            [{index + 1}] {chunk.sourceTitle}
          </h3>
          <button onClick={onClose} className="btn btn-ghost">
            ×
          </button>
        </div>
        <div className="mb-3 flex items-center gap-2 text-xs text-zinc-500">
          <span className="chip">{chunk.sourceKind}</span>
          {chunk.score > 0 && <span>similarity: {chunk.score.toFixed(2)}</span>}
        </div>
        <div className="max-h-80 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm leading-relaxed dark:border-zinc-800 dark:bg-zinc-950/50">
          {chunk.text}
        </div>
      </div>
    </div>
  );
}