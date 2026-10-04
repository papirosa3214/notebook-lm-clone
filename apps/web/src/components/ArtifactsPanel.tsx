import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Artifact } from '../lib/types';
import { FlashcardDeck } from './FlashcardDeck';
import { DataTableView } from './DataTableView';
import { AudioPlayer } from './AudioPlayer';
import { AiEditMenu } from './AiEditMenu';
import { useSourceScopeContext } from '../lib/sourceScopeContext';
import type { AudioOverviewMeta } from '@notebook/shared';
import {
  PlusIcon,
  CloseIcon,
  ArrowLeftIcon,
  DownloadIcon,
  TrashIcon,
} from './icons/NotebookLogo';

interface Props {
  notebookId: string;
  // default content for a new artifact (from "save as artifact" button)
  prefilled?: { title: string; contentMd: string } | null;
  onConsumedPrefilled?: () => void;
}

export function ArtifactsPanel({ notebookId, prefilled, onConsumedPrefilled }: Props) {
  const qc = useQueryClient();
  // A mind map is a view over the notebook's own sources; with none
  // there is nothing to map, so the button stays disabled instead of
  // letting the model invent a topic.
  const { hasReady: hasReadySources } = useSourceScopeContext();
  const artifacts = useQuery({
    queryKey: ['artifacts', notebookId],
    queryFn: () => api.listArtifacts(notebookId),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Highlights the just-created note for a moment so the user can see
  // that their "save to notes" click actually did something. The chat
  // button is in a different column; without this the only feedback
  // is that a new row appears in the list, which is easy to miss.
  const [pulseId, setPulseId] = useState<string | null>(null);
  useEffect(() => {
    if (!pulseId) return;
    const t = setTimeout(() => setPulseId(null), 2400);
    return () => clearTimeout(t);
  }, [pulseId]);

  const create = useMutation({
    mutationFn: ({ title, contentMd }: { title: string; contentMd: string }) =>
      api.createArtifact(notebookId, title, contentMd),
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ['artifacts', notebookId] });
      setSelectedId(a.id);
      setPulseId(a.id);
      onConsumedPrefilled?.();
    },
  });
  const mindmap = useMutation({
    mutationFn: () => api.createMindmap(notebookId),
    onSuccess: ({ artifact }) => {
      qc.invalidateQueries({ queryKey: ['artifacts', notebookId] });
      setSelectedId(artifact.id);
    },
  });

  const selected = artifacts.data?.artifacts.find((a) => a.id === selectedId);

  // Drain prefilled content from the chat "save as artifact" button into a
  // real POST. Guarded by a ref so a single prefilled value fires exactly once
  // even if the effect re-runs (e.g. on artifacts query refetch).
  const lastPrefilledRef = useRef<typeof prefilled>(null);
  useEffect(() => {
    if (!prefilled || create.isPending) return;
    if (lastPrefilledRef.current === prefilled) return;
    lastPrefilledRef.current = prefilled;
    create.mutate(prefilled);
  }, [prefilled, create.isPending]); // create.mutate is stable per react-query

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-[13px] font-semibold tracking-tight text-ink">
          Заметки
          {artifacts.data && artifacts.data.artifacts.length > 0 && (
            <span className="ml-1.5 text-xs font-normal text-muted">
              {artifacts.data.artifacts.length}
            </span>
          )}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => mindmap.mutate()}
            disabled={mindmap.isPending || !hasReadySources}
            className="flex h-8 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium text-muted transition-all hover:bg-surface-tint disabled:opacity-40"
            style={{ borderColor: 'rgb(var(--nb-border))' }}
            title={
              hasReadySources
                ? 'Сгенерировать майнд-карту ключевых концепций'
                : 'Сначала добавьте источники — карта строится только по материалам ноутбука'
            }
            data-testid="gen-mindmap"
          >
            🧠 Майнд-карта
          </button>
          <button
            onClick={() =>
              create.mutate({
                title: `Заметка ${new Date().toLocaleString('ru')}`,
                contentMd: '# Новая заметка\n\n',
              })
            }
            className="flex h-8 w-8 items-center justify-center rounded-full text-white transition-all hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: 'rgb(var(--nb-accent))' }}
            disabled={create.isPending}
            title="Создать заметку"
          >
            <PlusIcon size={14} />
          </button>
        </div>
      </div>

      {mindmap.isError && (
        <p
          className="mx-4 mb-2 rounded-xl border px-3 py-2 text-[11px] text-red-600"
          style={{ borderColor: 'rgb(252 165 165 / 0.5)' }}
          data-testid="mindmap-error"
        >
          {mindmap.error instanceof Error ? mindmap.error.message : 'Не удалось построить майнд-карту'}
        </p>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {artifacts.isLoading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="shimmer h-16 rounded-2xl" />
            ))}
          </div>
        )}
        {artifacts.data && artifacts.data.artifacts.length === 0 && (
          <div className="empty-card mt-2 py-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl"
              style={{ backgroundColor: 'rgb(var(--nb-accent-soft))' }}>
              <span className="text-base">📝</span>
            </div>
              <p className="text-sm font-medium">Пока нет заметок</p>
              <p className="max-w-xs text-xs text-muted">
                Сохраните ответ ассистента или создайте новую заметку.
              </p>
          </div>
        )}

        {selected ? (
          <ArtifactEditor
            key={selected.id}
            artifact={selected}
            notebookId={notebookId}
            onClose={() => setSelectedId(null)}
            onDelete={() => {
              if (confirm(`Удалить «${selected.title}»?`)) {
                void api.deleteArtifact(selected.id).then(() => {
                  setSelectedId(null);
                  qc.invalidateQueries({ queryKey: ['artifacts', notebookId] });
                });
              }
            }}
          />
        ) : (
          <ul className="space-y-2">
            {artifacts.data?.artifacts.map((a) => {
              const badge = artifactBadge(a);
              return (
                <li
                  key={a.id}
                  className={
                    'source-pill group cursor-pointer transition-all ' +
                    (a.id === pulseId ? 'ring-2 ring-accent' : '')
                  }
                  onClick={() => setSelectedId(a.id)}
                  data-testid={`artifact-list-item-${a.id}`}
                >
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base"
                    style={{
                      backgroundColor: 'rgb(var(--nb-accent-soft))',
                    }}
                  >
                    {badge.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{a.title}</span>
                      {badge.label && (
                        <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-accent">
                          {badge.label}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {badge.subtitle}
                    </div>
                    <div className="mt-0.5 text-[10px] text-subtle">
                      {new Date(a.updatedAt).toLocaleString('ru')}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ArtifactEditor({
  artifact,
  notebookId,
  onClose,
  onDelete,
}: {
  artifact: Artifact;
  notebookId: string;
  onClose: () => void;
  onDelete: () => void;
}) {
  // The editor detects Studio-generated structured artifacts by meta
  // and falls back to body-shape detection for legacy / shared rows.
  // Four modes:
  //   - report + template=flashcards → FlashcardDeck
  //   - report + template=data_table → DataTableView
  //   - audio_overview → AudioPlayer + transcript textarea
  //     (body is read-only — we still allow re-titling)
  //   - everything else → markdown textarea
  const specialRender = detectSpecialRender(artifact);
  const isReadonlyBody = specialRender !== 'markdown';

  const [title, setTitle] = useState(artifact.title);
  const [contentMd, setContentMd] = useState(artifact.contentMd);
  const [dirty, setDirty] = useState(false);
  const save = useMutation({
    mutationFn: () => api.updateArtifact(artifact.id, { title, contentMd }),
    onSuccess: () => setDirty(false),
  });

  return (
    <div className="flex h-full flex-col animate-fade-up">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button onClick={onClose} className="btn btn-ghost text-xs">
          <ArrowLeftIcon size={13} />
          К списку
        </button>
        <div className="flex gap-1">
          <a
            href={api.artifactDownloadUrl(artifact.id)}
            download
            className="btn btn-secondary text-xs"
            title="Скачать .md"
          >
            <DownloadIcon size={12} />
            .md
          </a>
          <button
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending || isReadonlyBody}
            className="btn btn-primary text-xs"
            title={
              isReadonlyBody
                ? 'Заголовок редактируется отдельно; тело артефакта неизменяемо'
                : undefined
            }
          >
            {save.isPending ? '…' : 'Сохранить'}
          </button>
          <button onClick={onDelete} className="btn btn-ghost text-xs" title="Удалить">
            <TrashIcon size={12} />
          </button>
        </div>
      </div>
      <input
        className="input mb-2 text-base font-semibold"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setDirty(true);
        }}
        placeholder="Заголовок заметки"
      />
      {specialRender === 'flashcards' && (
        <div className="flex-1 overflow-y-auto">
          <FlashcardDeck data={artifact.contentMd} />
        </div>
      )}
      {specialRender === 'data_table' && (
        <div className="flex-1 overflow-y-auto">
          <DataTableView data={artifact.contentMd} />
        </div>
      )}
      {specialRender === 'audio_overview' && (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
          <AudioOverviewPlayer
            artifact={artifact}
            notebookId={notebookId}
          />
          <label className="section-label">Сценарий</label>
          <textarea
            className="textarea min-h-0 flex-1 font-mono text-[13px] leading-relaxed"
            value={contentMd}
            onChange={(e) => {
              setContentMd(e.target.value);
              setDirty(true);
            }}
            placeholder="Markdown-сценарий подкаста…"
          />
        </div>
      )}
      {specialRender === 'markdown' && (
        <>
          <MarkdownEditor
            artifactId={artifact.id}
            value={contentMd}
            onChange={(v) => {
              setContentMd(v);
              setDirty(true);
            }}
          />
          {dirty && (
            <p className="mt-2 text-center text-[11px] font-medium text-accent">
              ● Не сохранено
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Markdown text editor with the AI assist popover. The popover
 *  shows up when the user selects at least one character; clicks
 *  run the corresponding LLM edit and replace the selection with
 *  the streamed output. */
function MarkdownEditor({
  artifactId,
  value,
  onChange,
}: {
  artifactId: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [menu, setMenu] = useState<{
    selection: string;
    start: number;
    end: number;
    anchor: { x: number; y: number };
  } | null>(null);

  function refreshMenu() {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start === end) {
      setMenu(null);
      return;
    }
    const sel = value.slice(start, end);
    // Get pixel coordinates of the selection's *end* using a
    // hidden mirror element. We only use the y for vertical
    // placement; the x is anchored to the right edge of the
    // textarea so the menu doesn't overflow horizontally.
    const rect = ta.getBoundingClientRect();
    const anchor = { x: rect.right - 4, y: rect.top + 4 };
    setMenu({ selection: sel, start, end, anchor });
  }

  return (
    <>
      <textarea
        ref={taRef}
        className="textarea min-h-0 flex-1 font-mono text-[13px] leading-relaxed"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onSelect={refreshMenu}
        onMouseUp={refreshMenu}
        onKeyUp={refreshMenu}
        onBlur={() => {
          // Give the click a tick to register on the menu before
          // we dismiss. We only fire on `relatedTarget` outside
          // the menu in the next iteration if needed; for now
          // we leave the menu up so the user can click it.
        }}
        placeholder="Текст заметки в Markdown…"
        data-testid="markdown-editor"
      />
      {menu && (
        <AiEditMenu
          artifactId={artifactId}
          fullText={value}
          selection={menu.selection}
          selectionStart={menu.start}
          selectionEnd={menu.end}
          anchor={menu.anchor}
          onDismiss={() => setMenu(null)}
          onError={(msg) => {
            // eslint-disable-next-line no-console
            console.error('[ai-edit]', msg);
            setMenu(null);
          }}
          onReplace={(newText) => {
            const before = value.slice(0, menu.start);
            const after = value.slice(menu.end);
            onChange(before + newText + after);
            setMenu(null);
          }}
        />
      )}
    </>
  );
}

/** Render an audio_overview artifact's player + meta header. The
 *  underlying `AudioPlayer` is generic (any src); this wrapper
 *  pulls the right URL out of the artifact + parses the meta. */
function AudioOverviewPlayer({
  artifact,
  notebookId,
}: {
  artifact: Artifact;
  notebookId: string;
}) {
  const audioFilename = parseAudioFilename(artifact.meta);
  if (!audioFilename) {
    // Script-only (TTS_PROVIDER=noop) — nothing to play, but we
    // still hint that the user can re-generate to get an mp3.
    return (
      <div
        className="rounded-2xl border bg-surface px-3 py-2.5 text-xs text-muted"
        style={{ borderColor: 'rgb(var(--nb-border) / 0.6)' }}
        data-testid="audio-overview-player-empty"
      >
        Аудио не отрисовано (TTS_PROVIDER=noop) — артефакт содержит
        только сценарий.
      </div>
    );
  }
  const status = parseStatus(artifact.meta);
  return (
    <div className="space-y-1.5" data-testid="audio-overview-player">
      <AudioPlayer
        src={api.audioUrlByFilename(notebookId, audioFilename)}
        downloadName={audioFilename}
        title="Готовый подкаст"
        meta={
          [
            artifact.meta ? styleFromMeta(artifact.meta) : null,
            `${lineCountFromContent(artifact.contentMd)} реплик`,
            durationFromMeta(artifact.meta),
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        onErrorHint="Не удалось загрузить mp3. Файл мог быть удалён или ещё рендерится."
      />
      {status === 'failed' && (
        <p className="text-[11px] text-red-600">
          TTS упал на этапе рендеринга. Перегенерируйте артефакт.
        </p>
      )}
    </div>
  );
}

function parseAudioFilename(metaStr: string | null | undefined): string | null {
  if (!metaStr) return null;
  try {
    const m = JSON.parse(metaStr) as { audioFilename?: string | null };
    return m.audioFilename ?? null;
  } catch {
    return null;
  }
}

function parseStatus(metaStr: string | null | undefined): string | null {
  if (!metaStr) return null;
  try {
    const m = JSON.parse(metaStr) as { status?: string };
    return m.status ?? null;
  } catch {
    return null;
  }
}

function styleFromMeta(metaStr: string | null | undefined): string | null {
  if (!metaStr) return null;
  try {
    const m = JSON.parse(metaStr) as { style?: string };
    return m.style ?? null;
  } catch {
    return null;
  }
}

function durationFromMeta(metaStr: string | null | undefined): string | null {
  if (!metaStr) return null;
  try {
    const m = JSON.parse(metaStr) as { durationSec?: number | null };
    if (typeof m.durationSec !== 'number' || m.durationSec <= 0) return null;
    const sec = m.durationSec;
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

/** Quick parse of the SCRIPT/MIRA/STAGE line count from the markdown
 *  body — we only need it for the meta hint, so a regex is enough.
 *  Matches the speaker prefix at the start of a line, with optional
 *  leading markdown emphasis (`**`, `*`, `_`). Case-insensitive. */
export function lineCountFromContent(contentMd: string): number {
  const matches = contentMd.match(/(?:^|\n)\s*(?:\*+\s*|_\s*)?(?:SCRIPT|MIRA|STAGE)\s*:/gi);
  return matches?.length ?? 0;
}

export { parseAudioFilename, parseStatus, styleFromMeta, durationFromMeta };

/** Discriminator for the structured Studio renderers. We check
 *  `meta.template` first (cheap, no JSON parse of the body) and
 *  fall back to body-shape detection for legacy / shared rows that
 *  pre-date the meta column. Audio overview is detected via
 *  `artifact.kind === 'audio_overview'`, set by the route on insert. */
function detectSpecialRender(
  artifact: Artifact,
): 'flashcards' | 'data_table' | 'audio_overview' | 'markdown' {
  if (artifact.kind === 'audio_overview') return 'audio_overview';
  if (artifact.meta) {
    try {
      const meta = JSON.parse(artifact.meta) as { template?: string };
      if (meta.template === 'flashcards') return 'flashcards';
      if (meta.template === 'data_table') return 'data_table';
    } catch {
      // fall through to body-based detection
    }
  }
  // Body-shape fallback.
  try {
    const parsed = JSON.parse(artifact.contentMd) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      if ('cards' in parsed && Array.isArray((parsed as { cards: unknown }).cards)) {
        return 'flashcards';
      }
      if (
        'columns' in parsed &&
        Array.isArray((parsed as { columns: unknown }).columns) &&
        'rows' in parsed &&
        Array.isArray((parsed as { rows: unknown }).rows)
      ) {
        return 'data_table';
      }
    }
  } catch {
    // not a JSON body — falls through to markdown
  }
  return 'markdown';
}

/** Visual badge for the artifact list row. Defaults to a plain
 *  "📝 note" chip; structured templates get a coloured label and
 *  a quick summary derived from the body. */
function artifactBadge(a: Artifact): {
  icon: string;
  label: string | null;
  subtitle: string;
} {
  const kind = detectSpecialRender(a);
  if (kind === 'flashcards') {
    let count: number | null = null;
    try {
      const parsed = JSON.parse(a.contentMd) as { cards?: unknown };
      if (Array.isArray(parsed.cards)) count = parsed.cards.length;
    } catch {
      // body may be unparseable; fall through to meta label
    }
    if (a.meta) {
      try {
        const m = JSON.parse(a.meta) as { flashcardCount?: number };
        if (typeof m.flashcardCount === 'number') count = m.flashcardCount;
      } catch {
        // ignore
      }
    }
    return {
      icon: '🃏',
      label: 'Flashcards',
      subtitle: count ? `${count} карточек` : 'Интерактивный deck',
    };
  }
  if (kind === 'data_table') {
    let cols: number | null = null;
    let rows: number | null = null;
    if (a.meta) {
      try {
        const m = JSON.parse(a.meta) as { columnCount?: number; rowCount?: number };
        if (typeof m.columnCount === 'number') cols = m.columnCount;
        if (typeof m.rowCount === 'number') rows = m.rowCount;
      } catch {
        // ignore
      }
    }
    const subtitle = cols && rows ? `${cols} × ${rows}` : 'Сравнительная таблица';
    return { icon: '📊', label: 'Data Table', subtitle };
  }
  return {
    icon: '📝',
    label: null,
    subtitle: a.contentMd.slice(0, 80).replace(/\n/g, ' '),
  };
}