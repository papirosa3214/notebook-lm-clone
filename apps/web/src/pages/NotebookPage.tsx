import { Link, useParams } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { SourcesPanel } from '../components/SourcesPanel';
import { ChatPanel } from '../components/ChatPanel';
import { ArtifactsPanel } from '../components/ArtifactsPanel';
import { SummaryPanel } from '../components/SummaryPanel';
import { ResizableDivider, CollapsedRail } from '../components/ResizableDivider';
import { useTheme } from '../hooks/useTheme';
import type { CitationChunk } from '../lib/types';
import {
  NotebookLogoMark,
  MoonIcon,
  SunIcon,
  CloseIcon,
  SparkleIcon,
  PanelRightIcon,
} from '../components/icons/NotebookLogo';

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

interface LayoutState {
  sourcesWidth: number;
  notesWidth: number;
  sourcesCollapsed: boolean;
  notesCollapsed: boolean;
}

const DEFAULT_LAYOUT: LayoutState = {
  sourcesWidth: 300,
  notesWidth: 320,
  sourcesCollapsed: false,
  notesCollapsed: false,
};

const LAYOUT_KEY = 'nb.layout';
const MIN_PANEL = 200;
const MAX_PANEL = 600;

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return {
      sourcesWidth: clamp(
        Number(parsed.sourcesWidth) || DEFAULT_LAYOUT.sourcesWidth,
        MIN_PANEL,
        MAX_PANEL,
      ),
      notesWidth: clamp(
        Number(parsed.notesWidth) || DEFAULT_LAYOUT.notesWidth,
        MIN_PANEL,
        MAX_PANEL,
      ),
      sourcesCollapsed: Boolean(parsed.sourcesCollapsed),
      notesCollapsed: Boolean(parsed.notesCollapsed),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export default function NotebookPage() {
  const { id } = useParams<{ id: string }>();
  const notebookId = id!;
  const { theme, toggle } = useTheme();
  const notebook = useQuery({
    queryKey: ['notebook', notebookId],
    queryFn: async () => {
      const r = await fetch(`/api/notebooks/${notebookId}`).then((r) => r.json());
      return r as { id: string; title: string; description?: string };
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

  const [layout, setLayout] = useState<LayoutState>(DEFAULT_LAYOUT);
  useEffect(() => {
    setLayout(loadLayout());
  }, []);

  const updateLayout = useCallback((patch: Partial<LayoutState>) => {
    setLayout((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {
        /* quota — ignore */
      }
      return next;
    });
  }, []);

  // Live drag — doesn't re-render NotebookPage; updates panel widths directly.
  const onResizeLeft = useCallback((delta: number) => {
    setLayout((prev) => {
      if (prev.sourcesCollapsed) return prev;
      const next = clamp(prev.sourcesWidth + delta, MIN_PANEL, MAX_PANEL);
      if (next === prev.sourcesWidth) return prev;
      const stored = { ...prev, sourcesWidth: next };
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(stored));
      } catch {}
      return stored;
    });
  }, []);

  const onResizeRight = useCallback((delta: number) => {
    setLayout((prev) => {
      if (prev.notesCollapsed) return prev;
      const next = clamp(prev.notesWidth - delta, MIN_PANEL, MAX_PANEL);
      if (next === prev.notesWidth) return prev;
      const stored = { ...prev, notesWidth: next };
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(stored));
      } catch {}
      return stored;
    });
  }, []);

  if (notebook.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted">
        Загрузка ноутбука…
      </div>
    );
  }
  if (notebook.isError || !notebook.data) {
    return (
      <div className="mx-auto max-w-md p-10 text-center">
        <p className="text-sm text-red-600">Не удалось загрузить ноутбук</p>
        <Link to="/" className="mt-4 inline-block text-sm text-accent hover:underline">
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
      {/* ---- Top header ---- */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 md:px-6"
        style={{ borderColor: 'rgb(var(--nb-border))' }}>
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/" className="flex items-center gap-2 text-muted hover:text-ink transition-colors" title="Все ноутбуки">
            <NotebookLogoMark size={28} />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-[17px] font-semibold tracking-tight md:text-[19px]">
              {notebook.data.title}
            </h1>
            <p className="hidden text-xs text-muted md:block">
              {readyCount} из {totalCount} источник{ruPlural(totalCount)} готов{readyCount === 1 ? '' : 'ы'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1.5 rounded-full bg-surface-tint px-2.5 py-1 text-xs text-muted md:flex">
            <SparkleIcon size={12} className="text-accent" />
            <span>AI-ассистент</span>
          </div>
          <button
            onClick={toggle}
            className="btn-icon"
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          >
            {theme === 'dark' ? <SunIcon size={18} /> : <MoonIcon size={18} />}
          </button>
        </div>
      </header>

      {/* ---- Mobile tabs ---- */}
      <nav className="flex shrink-0 gap-1 border-b px-2 py-2 md:hidden"
        style={{ borderColor: 'rgb(var(--nb-border))' }}>
        <MobileTabBtn active={mobileTab === 'sources'} onClick={() => setMobileTab('sources')}>
          Источники
          {totalCount > 0 && (
            <span className="ml-1 rounded-full bg-surface-tint px-1.5 py-0.5 text-[10px]">
              {readyCount}/{totalCount}
            </span>
          )}
        </MobileTabBtn>
        <MobileTabBtn active={mobileTab === 'overview'} onClick={() => setMobileTab('overview')}>
          Обзор
        </MobileTabBtn>
        <MobileTabBtn active={mobileTab === 'chat'} onClick={() => setMobileTab('chat')}>
          Чат
        </MobileTabBtn>
        <MobileTabBtn active={mobileTab === 'artifacts'} onClick={() => setMobileTab('artifacts')}>
          Заметки
        </MobileTabBtn>
      </nav>

      {/* ---- Three-column layout (resizable + collapsible) ---- */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* LEFT — Sources (or collapsed rail) */}
        {layout.sourcesCollapsed ? (
          <CollapsedRail
            side="left"
            onExpand={() => updateLayout({ sourcesCollapsed: false })}
            label="Источники"
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18" />
                <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
              </svg>
            }
          />
        ) : (
          <aside
            className="hidden min-w-0 shrink-0 overflow-hidden md:block"
            style={{ width: layout.sourcesWidth, borderRight: '1px solid rgb(var(--nb-border))' }}
          >
            <SourcesPanel notebookId={notebookId} />
          </aside>
        )}

        {/* Resizer between Sources and Chat (only when both visible) */}
        <div className="hidden md:flex">
          {!layout.sourcesCollapsed && (
            <ResizableDivider
              side="left"
              collapsed={layout.sourcesCollapsed}
              onToggleCollapse={() => updateLayout({ sourcesCollapsed: true })}
              onResize={onResizeLeft}
            />
          )}
        </div>

        {/* CENTER */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-3 md:gap-5 md:p-6">
          <div className={mobileTab === 'sources' ? '' : 'hidden'}>
            <div className="card overflow-hidden">
              <SourcesPanel notebookId={notebookId} />
            </div>
          </div>

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

          <div className={mobileTab === 'chat' ? 'flex flex-1 bg-canvas' : 'hidden md:flex md:flex-1'}>
            {/* Mobile: edge-to-edge, no card wrapper.
                Desktop: card wrapper so the chat has a defined panel boundary. */}
            <div className="hidden md:flex md:min-h-[460px] md:w-full md:flex-1 md:overflow-hidden md:rounded-2xl md:border md:bg-surface md:shadow-soft"
              style={{ borderColor: 'rgb(var(--nb-border))' }}>
              <ChatPanel
                notebookId={notebookId}
                onSaveArtifact={(question, answer, citations) => {
                  setPrefilled(buildArtifactMarkdown(question, answer, citations));
                }}
                onOpenCitation={(chunk, index) => setOpenCitation({ chunk, index })}
              />
            </div>
            <div className="flex w-full flex-1 md:hidden">
              <ChatPanel
                notebookId={notebookId}
                onSaveArtifact={(question, answer, citations) => {
                  setPrefilled(buildArtifactMarkdown(question, answer, citations));
                }}
                onOpenCitation={(chunk, index) => setOpenCitation({ chunk, index })}
              />
            </div>
          </div>

          <div className={mobileTab === 'artifacts' ? '' : 'hidden'}>
            <ArtifactsPanel
              notebookId={notebookId}
              prefilled={prefilled}
              onConsumedPrefilled={() => setPrefilled(null)}
            />
          </div>
        </main>

        {/* Resizer between Chat and Notes */}
        <div className="hidden md:flex">
          {!layout.notesCollapsed && (
            <ResizableDivider
              side="right"
              collapsed={layout.notesCollapsed}
              onToggleCollapse={() => updateLayout({ notesCollapsed: true })}
              onResize={onResizeRight}
            />
          )}
        </div>

        {/* RIGHT — Notes (or collapsed rail) */}
        {layout.notesCollapsed ? (
          <CollapsedRail
            side="right"
            onExpand={() => updateLayout({ notesCollapsed: false })}
            label="Заметки"
            icon={<PanelRightIcon size={16} />}
          />
        ) : (
          <aside
            className="hidden min-w-0 shrink-0 overflow-hidden md:block"
            style={{ width: layout.notesWidth, borderLeft: '1px solid rgb(var(--nb-border))' }}
          >
            <ArtifactsPanel
              notebookId={notebookId}
              prefilled={prefilled}
              onConsumedPrefilled={() => setPrefilled(null)}
            />
          </aside>
        )}
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
      className={`flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
        active
          ? 'text-white shadow-sm'
          : 'text-muted hover:bg-surface-tint hover:text-ink'
      }`}
      style={active ? { backgroundColor: 'rgb(var(--nb-accent))' } : undefined}
    >
      {children}
    </button>
  );
}

function EmptyCentreState({ hasAnySources }: { hasAnySources: boolean }) {
  return (
    <div className="ai-surface relative px-6 py-7">
      <div className="relative z-10 flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
          <SparkleIcon size={22} className="text-white" />
        </div>
        <div>
          <h3 className="text-lg font-semibold">
            {hasAnySources ? 'Источники ещё обрабатываются' : 'Здесь появится обзор ноутбука'}
          </h3>
          <p className="mt-1 text-sm text-white/80">
            {hasAnySources
              ? 'Обзор сгенерируется автоматически, как только источники будут готовы.'
              : 'Добавьте первый источник — обзор появится в этой карточке, а чат сможет отвечать по нему.'}
          </p>
        </div>
      </div>
    </div>
  );
}

function ruPlural(n: number): string {
  const last = n % 10;
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'ов';
  if (last === 1) return '';
  if (last >= 2 && last <= 4) return 'а';
  return 'ов';
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
    <div className="modal-backdrop animate-fade-in" onClick={onClose}>
      <div
        className="card-pop w-full max-w-xl p-6 animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-subtle">
              <span>Цитата</span>
              <span className="font-semibold text-accent">[{index + 1}]</span>
            </div>
            <h3 className="truncate text-base font-semibold">
              {chunk.sourceTitle}
            </h3>
          </div>
          <button onClick={onClose} className="btn-icon" title="Закрыть">
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="mb-3 flex items-center gap-2 text-xs text-muted">
          <span className="chip">{chunk.sourceKind}</span>
          {chunk.score > 0 && <span>similarity: {chunk.score.toFixed(2)}</span>}
        </div>
        <div className="max-h-80 overflow-y-auto rounded-xl border bg-canvas p-4 text-sm leading-relaxed"
          style={{ borderColor: 'rgb(var(--nb-border))' }}>
          {chunk.text}
        </div>
      </div>
    </div>
  );
}