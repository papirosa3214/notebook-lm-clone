import { Link, useParams } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { SourcesPanel } from '../components/SourcesPanel';
import { ChatPanel } from '../components/ChatPanel';
import { ArtifactsPanel } from '../components/ArtifactsPanel';
import type { CitationChunk } from '../lib/types';

function buildArtifactMarkdown(question: string, answer: string, citations: CitationChunk[]): { title: string; contentMd: string } {
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

export default function NotebookPage() {
  const { id } = useParams<{ id: string }>();
  const notebookId = id!;
  const notebook = useQuery({
    queryKey: ['notebook', notebookId],
    queryFn: async () => {
      const r = await fetch(`/api/notebooks/${notebookId}`).then((r) => r.json());
      return r as { id: string; title: string };
    },
  });

  const [prefilled, setPrefilled] = useState<{ title: string; contentMd: string } | null>(null);

  if (notebook.isLoading) {
    return <div className="flex h-screen items-center justify-center text-sm text-zinc-500">Загрузка…</div>;
  }
  if (notebook.isError || !notebook.data) {
    return (
      <div className="mx-auto max-w-md p-10 text-center">
        <p className="text-sm text-red-600">Не удалось загрузить ноутбук</p>
        <Link to="/" className="mt-4 inline-block text-sm text-blue-600">← На главную</Link>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-900">←</Link>
          <h1 className="text-lg font-semibold">{notebook.data.title}</h1>
        </div>
      </header>
      <div className="grid flex-1 grid-cols-1 md:grid-cols-[280px_1fr_360px] overflow-hidden">
        <aside className="border-r border-zinc-200 dark:border-zinc-800">
          <SourcesPanel notebookId={notebookId} />
        </aside>
        <main className="min-w-0">
          <ChatPanel
            notebookId={notebookId}
            onSaveArtifact={(question, answer, citations) => {
              setPrefilled(buildArtifactMarkdown(question, answer, citations));
            }}
          />
        </main>
        <aside className="border-l border-zinc-200 dark:border-zinc-800">
          <ArtifactsPanel
            notebookId={notebookId}
            prefilled={prefilled}
            onConsumedPrefilled={() => setPrefilled(null)}
          />
        </aside>
      </div>
    </div>
  );
}
