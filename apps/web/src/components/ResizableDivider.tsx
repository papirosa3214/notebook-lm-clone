import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from './icons/NotebookLogo';

interface Props {
  /** Called while the user drags with horizontal delta in CSS pixels. */
  onResize: (deltaX: number) => void;
  /** When set, a small collapse/expand toggle is shown on the divider. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Which side the panel this divider controls is on. Controls chevron direction. */
  side: 'left' | 'right';
}

/**
 * A thin vertical grab-handle between two panels. Drag to resize; click the
 * chevron to collapse / expand the adjacent panel. The hit area is wider than
 * the visible line so it's still grabable on touchpads.
 */
export function ResizableDivider({
  onResize,
  collapsed,
  onToggleCollapse,
  side,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const lastXRef = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // ignore if the user clicked the collapse button itself
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      setDragging(true);
      startXRef.current = e.clientX;
      lastXRef.current = e.clientX;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - lastXRef.current;
      lastXRef.current = e.clientX;
      onResize(delta);
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onResize]);

  return (
    <div
      onMouseDown={onMouseDown}
      className={`group relative z-10 flex w-2 shrink-0 cursor-col-resize items-center justify-center transition-colors ${
        dragging ? 'bg-accent/10' : 'hover:bg-accent/5'
      }`}
      title="Потяните, чтобы изменить ширину"
      aria-hidden
    >
      {/* Visible 1px line */}
      <div
        className={`h-full w-px transition-colors ${
          dragging
            ? 'bg-accent'
            : 'bg-[rgb(var(--nb-border))] group-hover:bg-accent/60'
        }`}
      />
      {onToggleCollapse && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className={`absolute top-1/2 z-20 flex h-6 w-4 -translate-y-1/2 ${
            side === 'left' ? '-translate-x-1/2' : 'translate-x-1/2'
          } items-center justify-center rounded-full border bg-surface text-muted opacity-0 shadow-soft transition-opacity group-hover:opacity-100 hover:text-ink`}
          style={{ borderColor: 'rgb(var(--nb-border))' }}
          title={collapsed ? 'Развернуть панель' : 'Свернуть панель'}
          aria-label={collapsed ? 'Развернуть панель' : 'Свернуть панель'}
        >
          {side === 'left' ? (
            collapsed ? <ChevronRightIcon size={10} /> : <ChevronLeftIcon size={10} />
          ) : collapsed ? (
            <ChevronLeftIcon size={10} />
          ) : (
            <ChevronRightIcon size={10} />
          )}
        </button>
      )}
    </div>
  );
}

/**
 * Small always-visible rail shown when a panel is collapsed. Clicking it
 * expands the panel back to its last width.
 */
export function CollapsedRail({
  side,
  width = 36,
  onExpand,
  label,
  icon,
}: {
  side: 'left' | 'right';
  width?: number;
  onExpand: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <aside
      className={`hidden shrink-0 md:flex flex-col items-center border-zinc-200 bg-canvas ${
        side === 'left' ? 'border-r' : 'border-l'
      }`}
      style={{
        width,
        borderColor: 'rgb(var(--nb-border))',
      }}
    >
      <button
        type="button"
        onClick={onExpand}
        className="mt-3 flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-all hover:bg-surface-tint hover:text-ink"
        title={`Развернуть: ${label}`}
        aria-label={`Развернуть: ${label}`}
      >
        {icon}
      </button>
    </aside>
  );
}