import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * ⌘K command palette.
 *
 * Opens with Cmd+K (or Ctrl+K on non-Mac). Closes on Escape or backdrop click.
 * The list of commands is computed inside the component (not stored outside)
 * because each command depends on the runtime callbacks (`toggleTheme`, `goHome`,
 * `addUrl`, etc.) which the parent only knows.
 *
 * Filtering is substring-case-insensitive on label + keywords. Selection is
 * keyboard-only — arrow keys to move, Enter to run, Escape to close. We track
 * the selected index in state and scroll the active item into view so the UI
 * stays usable even with 30+ commands.
 */

export interface CommandDef {
  id: string;
  label: string;
  hint?: string;
  keywords?: string[];
  run: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: CommandDef[];
}

export function CommandPalette({ open, onClose, commands }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state every time the palette opens so a stale query doesn't leak
  // between sessions, and so the input is auto-focused for keyboard nav.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.hint ?? ''} ${(c.keywords ?? []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }, [commands, query]);

  useEffect(() => {
    if (selected >= filtered.length) setSelected(Math.max(0, filtered.length - 1));
  }, [filtered.length, selected]);

  // Scroll selected into view inside the list container so keyboard nav stays
  // smooth even with many commands.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  function run(c: CommandDef) {
    void c.run();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border bg-surface shadow-2xl"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-3 py-2" style={{ borderColor: 'rgb(var(--nb-border))' }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Команда… (Enter — запустить, ↑↓ — выбрать)"
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-subtle"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected((s) => Math.min(filtered.length - 1, s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((s) => Math.max(0, s - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const c = filtered[selected];
                if (c) run(c);
              }
            }}
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-subtle">Ничего не найдено</p>
          )}
          {filtered.map((c, i) => (
            <button
              type="button"
              key={c.id}
              data-cmd-index={i}
              onClick={() => run(c)}
              onMouseEnter={() => setSelected(i)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                i === selected ? 'bg-accent/10 text-ink' : 'text-ink/80'
              }`}
            >
              <span className="flex items-center gap-2">
                <span>{c.label}</span>
                {c.hint && <span className="text-xs text-subtle">{c.hint}</span>}
              </span>
              {i === selected && <span className="text-xs text-subtle">↵</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Global ⌘K / Ctrl+K listener hook. Returns the open state so the consumer
 * can render the palette and provides a setter to close it programmatically
 * (e.g. after a command executes).
 */
export function useCommandPaletteHotkey(): [boolean, () => void, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  const open2 = () => setOpen(true);
  const close2 = () => setOpen(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [open, open2, close2];
}
