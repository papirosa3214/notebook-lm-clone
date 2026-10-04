import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ruPlural } from '../lib/ruPlural';
import { useSwipe } from '../lib/useSwipe';
import { SourcesPanel } from '../components/SourcesPanel';
import { SourceDetailSheet } from '../components/SourceDetailSheet';
import { SourceScopeProvider } from '../lib/sourceScopeContext';
import { SourcesStrip } from '../components/SourcesStrip';
import { ChatPanel } from '../components/ChatPanel';
import { PanelErrorBoundary } from '../components/ErrorBoundary';
import { ArtifactsPanel } from '../components/ArtifactsPanel';
import { SummaryPanel } from '../components/SummaryPanel';
import { AudioOverviewDialog } from '../components/AudioOverviewDialog';
import { StudioReportDialog } from '../components/StudioReportDialog';
import { ShareDialog } from '../components/ShareDialog';
import { ResizableDivider, CollapsedRail } from '../components/ResizableDivider';
import { useTheme } from '../hooks/useTheme';
import type { CitationChunk } from '../lib/types';
import { CommandPalette, useCommandPaletteHotkey, type CommandDef } from '../components/CommandPalette';
import {
  NotebookLogoMark,
  MoonIcon,
  SunIcon,
  CloseIcon,
  SparkleIcon,
  PanelRightIcon,
  SourceIcon,
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
  /** Which page-level layout to render. */
  mode: 'threeColumn' | 'notebooklm';
}

const DEFAULT_LAYOUT: LayoutState = {
  sourcesWidth: 300,
  notesWidth: 320,
  sourcesCollapsed: false,
  // Notes (artifacts) are hidden by default — the summary lives in the
  // chat panel as a pinned first message, and artifact creation flows
  // through the chat's "сохранить в заметки" button. Users who want
  // a dedicated notes panel can open it from the right rail.
  notesCollapsed: true,
  mode: 'threeColumn',
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
      mode: parsed.mode === 'notebooklm' ? 'notebooklm' : 'threeColumn',
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
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [layout, setLayout] = useState<LayoutState>(() => loadLayout());
  const [paletteOpen, openPalette, closePalette] = useCommandPaletteHotkey();

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
  const commands: CommandDef[] = [
    {
      id: 'home',
      label: '🏠 На главную',
      hint: 'список ноутбуков',
      keywords: ['home', 'notebooks', 'list'],
      run: () => navigate('/'),
    },
    {
      id: 'theme',
      label: theme === 'dark' ? '☀️ Светлая тема' : '🌙 Тёмная тема',
      hint: 'переключить',
      keywords: ['theme', 'dark', 'light', 'тёмная'],
      run: () => toggle(),
    },
    {
      id: 'collapse-sources',
      label: '📚 Скрыть источники',
      hint: 'левая панель',
      keywords: ['collapse', 'sources', 'panel', 'скрыть'],
      run: () => updateLayout?.({ sourcesCollapsed: true }),
    },
    {
      id: 'collapse-notes',
      label: '📝 Скрыть заметки',
      hint: 'правая панель',
      keywords: ['collapse', 'notes', 'panel', 'скрыть'],
      run: () => updateLayout?.({ notesCollapsed: true }),
    },
  ];
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
  const [showAudioDialog, setShowAudioDialog] = useState(false);
  const [showStudioDialog, setShowStudioDialog] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);

  // Live drag — drives both the visible width (via setLayout) and the
  // persisted layout so a reload keeps the user's choice.
  const onResizeLeft = useCallback(
    (delta: number) => {
      if (layout.sourcesCollapsed) return;
      const next = clamp(layout.sourcesWidth + delta, MIN_PANEL, MAX_PANEL);
      if (next !== layout.sourcesWidth) updateLayout({ sourcesWidth: next });
    },
    [layout.sourcesWidth, layout.sourcesCollapsed, updateLayout],
  );

  const onResizeRight = useCallback(
    (delta: number) => {
      if (layout.notesCollapsed) return;
      const next = clamp(layout.notesWidth - delta, MIN_PANEL, MAX_PANEL);
      if (next !== layout.notesWidth) updateLayout({ notesWidth: next });
    },
    [layout.notesWidth, layout.notesCollapsed, updateLayout],
  );

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

  // Mobile swipe between tabs. The handler is always attached; on
  // desktop ≥ 640 px the tabs are hidden so setMobileTab is a no-op
  // visually but harmless. The hook is gated by a CSS class on the
  // main element so swipe is only enabled at the mobile breakpoint.
  const TABS: MobileTab[] = ['sources', 'overview', 'chat', 'artifacts'];
  const swipeRef = useSwipe<HTMLElement>({
    onSwipeLeft: () => {
      const i = TABS.indexOf(mobileTab);
      if (i >= 0 && i < TABS.length - 1) setMobileTab(TABS[i + 1]!);
    },
    onSwipeRight: () => {
      const i = TABS.indexOf(mobileTab);
      if (i > 0) setMobileTab(TABS[i - 1]!);
    },
  });

  return (
    <SourceScopeProvider notebookId={notebookId} sources={sources.data?.sources}>
      <div className="flex h-screen flex-col">
      {/* ---- Top header ---- */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 min-[640px]:px-6 pt-safe pl-safe pr-safe"
        style={{ borderColor: 'rgb(var(--nb-border))' }}>
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/"
            className="flex items-center gap-2 text-muted transition-colors hover:text-ink"
            title="Все ноутбуки"
          >
            <NotebookLogoMark size={28} />
            <span className="hidden items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium min-[640px]:inline-flex"
              style={{ borderColor: 'rgb(var(--nb-border))' }}>
              <span aria-hidden>←</span>
              Все ноутбуки
            </span>
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-[17px] font-semibold tracking-tight min-[640px]:text-[19px]">
              {notebook.data.title}
            </h1>
            <p className="hidden text-xs text-muted min-[640px]:block">
              {readyCount} из {totalCount} источник{ruPlural(totalCount)} готов{readyCount === 1 ? '' : 'ы'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAudioDialog(true)}
            disabled={readyCount === 0}
            className="hidden items-center gap-1.5 rounded-full bg-surface-tint px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-ink disabled:opacity-50 min-[640px]:inline-flex"
            title={readyCount === 0 ? 'Сначала добавьте источники' : 'Сгенерировать двухголосый подкаст по источникам'}
          >
            <SparkleIcon size={12} className="text-accent" />
            <span>Audio Overview</span>
          </button>
          <button
            type="button"
            onClick={() => setShowStudioDialog(true)}
            disabled={readyCount === 0}
            className="hidden items-center gap-1.5 rounded-full bg-surface-tint px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-ink disabled:opacity-50 min-[640px]:inline-flex"
            title={readyCount === 0 ? 'Сначала добавьте источники' : 'Сгенерировать структурированный отчёт (FAQ, TL;DR, timeline, противоречия)'}
          >
            <SparkleIcon size={12} className="text-accent" />
            <span>Studio</span>
          </button>
          <button
            type="button"
            onClick={() => setShowShareDialog(true)}
            className="hidden items-center gap-1.5 rounded-full bg-surface-tint px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-ink min-[640px]:inline-flex"
            title="Создать read-only публичную ссылку"
            data-testid="share-open"
          >
            <SparkleIcon size={12} className="text-accent" />
            <span>Поделиться</span>
          </button>
          <a
            href={api.exportUrl(notebookId)}
            // `download` lets the browser save the file with the
            // server-provided Content-Disposition filename.
            // Same min-[640px] breakpoint as the other header chips.
            className="hidden items-center gap-1.5 rounded-full bg-surface-tint px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-ink min-[640px]:inline-flex"
            title="Скачать .zip со всеми источниками, артефактами и чатом"
            data-testid="export-zip"
          >
            <SparkleIcon size={12} className="text-accent" />
            <span>Скачать .zip</span>
          </a>
          <div className="hidden items-center gap-1.5 rounded-full bg-surface-tint px-2.5 py-1 text-xs text-muted min-[640px]:flex">
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
          <button
            type="button"
            onClick={() =>
              updateLayout({
                mode: layout.mode === 'threeColumn' ? 'notebooklm' : 'threeColumn',
              })
            }
            className="btn-icon"
            title={
              layout.mode === 'threeColumn'
                ? 'Переключить в NotebookLM-стиль (горизонтальные источники сверху)'
                : 'Вернуть трёхколонный layout'
            }
          >
            {layout.mode === 'threeColumn' ? '⇆' : '☰'}
          </button>
        </div>
      </header>

      {/* ---- Compact-layout tabs ----
          A 640px cutoff is intentional: a split desktop window can be about
          744 CSS px wide, which is enough for Sources + Chat with notes
          collapsed. Tailwind's default md cutoff (768px) made that desktop
          window look like an unfinished mobile screen. */}
      <nav className="flex shrink-0 items-center gap-1 border-b px-2 py-2 min-[640px]:hidden"
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
        {/* Page indicator — four dots, the active one filled.
            Screen readers expose each dot as a labelled "Tab N of 4". */}
        <div
          className="ml-auto flex items-center gap-1.5"
          aria-label={`Вкладка ${TABS.indexOf(mobileTab) + 1} из ${TABS.length}`}
          data-testid="mobile-tab-indicator"
        >
          {TABS.map((t) => (
            <span
              key={t}
              className={
                'h-1.5 rounded-full transition-all ' +
                (t === mobileTab
                  ? 'w-4 bg-accent'
                  : 'w-1.5 bg-muted/40')
              }
              aria-hidden
            />
          ))}
        </div>
      </nav>

      {/* ---- NotebookLM-style layout: horizontal source strip + chat ---- */}
      {layout.mode === 'notebooklm' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <SourcesStrip notebookId={notebookId} />
          <div className="flex min-h-0 flex-1 overflow-hidden p-3 min-[640px]:p-6">
            <div className="hidden min-h-0 flex-1 overflow-hidden min-[640px]:rounded-2xl min-[640px]:border min-[640px]:bg-surface min-[640px]:shadow-soft min-[640px]:flex"
              style={{ borderColor: 'rgb(var(--nb-border))' }}>
              <PanelErrorBoundary panel="Чат">
                <ChatPanel
                  notebookId={notebookId}
                  onSaveArtifact={(question, answer, citations) => {
                    setPrefilled(buildArtifactMarkdown(question, answer, citations));
                  }}
                  onOpenCitation={(chunk, index) => setOpenCitation({ chunk, index })}
                />
              </PanelErrorBoundary>
            </div>
            <div className="flex w-full flex-1 min-[640px]:hidden">
              <PanelErrorBoundary panel="Чат">
                <ChatPanel
                  notebookId={notebookId}
                  onSaveArtifact={(question, answer, citations) => {
                    setPrefilled(buildArtifactMarkdown(question, answer, citations));
                  }}
                  onOpenCitation={(chunk, index) => setOpenCitation({ chunk, index })}
                />
              </PanelErrorBoundary>
            </div>
          </div>
        </div>
      )}

      {/* ---- Three-column layout (resizable + collapsible) ---- */}
      {layout.mode === 'threeColumn' && (
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* LEFT — Sources (or collapsed rail) */}
        {layout.sourcesCollapsed ? (
          <CollapsedRail
            side="left"
            onExpand={() => updateLayout({ sourcesCollapsed: false })}
            label="Источники"
            icon={<SourceIcon kind="url" size={16} />}
          />
        ) : (
          <aside
            className="hidden min-w-0 shrink-0 overflow-hidden min-[640px]:block"
            style={{ width: layout.sourcesWidth, borderRight: '1px solid rgb(var(--nb-border))' }}
          >
            <SourcesPanel notebookId={notebookId} />
          </aside>
        )}

        {/* Resizer between Sources and Chat (only when both visible) */}
        <div className="hidden min-[640px]:flex">
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
        <main
          ref={swipeRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden p-3 min-[640px]:gap-5 min-[640px]:p-6"
          data-testid="notebook-center"
        >
          <div className={mobileTab === 'sources' ? 'min-[640px]:hidden' : 'hidden'}>
            <div className="card overflow-hidden">
              <SourcesPanel notebookId={notebookId} />
            </div>
          </div>

          {/* Mobile-only overview tab. Desktop renders the summary inside
              ChatPanel as a pinned first message (see SummaryCard) so the
              central column stays a single scrolling conversation. */}
          <div className={mobileTab === 'overview' ? 'min-[640px]:hidden' : 'hidden'}>
            {hasReadySources ? (
              <PanelErrorBoundary panel="Краткий обзор">
                <SummaryPanel
                  notebookId={notebookId}
                  onOpenSource={(chunk, index) => setOpenCitation({ chunk, index })}
                />
              </PanelErrorBoundary>
            ) : (
              <EmptyCentreState hasAnySources={hasSources} />
            )}
          </div>

          <div className={mobileTab === 'chat' ? 'flex min-h-0 flex-1 bg-canvas' : 'hidden min-[640px]:flex min-[640px]:min-h-0 min-[640px]:flex-1'}>
            {/* Mobile: edge-to-edge, no card wrapper.
                Desktop: card wrapper so the chat has a defined panel boundary. */}
            <div className="hidden min-h-0 min-[640px]:flex min-[640px]:h-full min-[640px]:min-h-[460px] min-[640px]:w-full min-[640px]:flex-1 min-[640px]:overflow-hidden min-[640px]:rounded-2xl min-[640px]:border min-[640px]:bg-surface min-[640px]:shadow-soft"
              style={{ borderColor: 'rgb(var(--nb-border))' }}>
              <PanelErrorBoundary panel="Чат">
                <ChatPanel
                  notebookId={notebookId}
                  onSaveArtifact={(question, answer, citations) => {
                    setPrefilled(buildArtifactMarkdown(question, answer, citations));
                  }}
                  onOpenCitation={(chunk, index) => setOpenCitation({ chunk, index })}
                />
              </PanelErrorBoundary>
            </div>
            <div className="flex min-h-0 w-full flex-1 min-[640px]:hidden">
              <PanelErrorBoundary panel="Чат">
                <ChatPanel
                  notebookId={notebookId}
                  onSaveArtifact={(question, answer, citations) => {
                    setPrefilled(buildArtifactMarkdown(question, answer, citations));
                  }}
                  onOpenCitation={(chunk, index) => setOpenCitation({ chunk, index })}
                />
              </PanelErrorBoundary>
            </div>
          </div>

          <div className={mobileTab === 'artifacts' ? 'min-[640px]:hidden' : 'hidden'}>
            <ArtifactsPanel
              notebookId={notebookId}
              prefilled={prefilled}
              onConsumedPrefilled={() => setPrefilled(null)}
            />
          </div>
        </main>

        {/* Resizer between Chat and Notes */}
        <div className="hidden min-[640px]:flex">
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
            className="hidden min-w-0 shrink-0 overflow-hidden min-[640px]:block"
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
      )}

      {openCitation && (() => {
        // "Фрагмент N" — open the source reader with the matching chunk
        // highlighted + scrolled into view. Anything else falls back to
        // the legacy dialog (kept for very small screens).
        const m = /Фрагмент\s+(\d+)/.exec(openCitation.chunk.location ?? '');
        if (m) {
          return (
            <SourceDetailSheet
              source={{
                id: openCitation.chunk.sourceId,
                notebookId,
                kind: openCitation.chunk.sourceKind,
                title: openCitation.chunk.sourceTitle,
                url: null,
                status: 'ready',
                error: null,
                createdAt: '',
                summary: null,
                summaryTopics: null,
                summarizedAt: null,
              }}
              highlightOrdinal={Number(m[1]) - 1}
              onClose={() => setOpenCitation(null)}
            />
          );
        }
        return (
          <CitationDialog
            chunk={openCitation.chunk}
            index={openCitation.index}
            onClose={() => setOpenCitation(null)}
          />
        );
      })()}

      <CommandPalette open={paletteOpen} onClose={() => closePalette(false)} commands={commands} />
      {showAudioDialog && (
        <AudioOverviewDialog
          notebookId={notebookId}
          onClose={() => setShowAudioDialog(false)}
        />
      )}
      {showStudioDialog && (
        <StudioReportDialog
          notebookId={notebookId}
          onClose={() => setShowStudioDialog(false)}
        />
      )}
      {showShareDialog && (
        <ShareDialog
          notebookId={notebookId}
          onClose={() => setShowShareDialog(false)}
        />
      )}
    </div>
    </SourceScopeProvider>
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

function CitationDialog({
  chunk,
  index,
  onClose,
}: {
  chunk: CitationChunk;
  index: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
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
          <button type="button" onClick={onClose} className="btn-icon" title="Закрыть" aria-label="Закрыть">
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
