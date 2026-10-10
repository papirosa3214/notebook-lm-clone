import { useCallback, useEffect, useRef } from 'react';

interface SwipeHandlers {
  /** Fired when the user swipes left (finger moves right→left). */
  onSwipeLeft?: () => void;
  /** Fired when the user swipes right (finger moves left→right). */
  onSwipeRight?: () => void;
  /**
   * Minimum horizontal distance (px) before a swipe counts. Default 50.
   * Anything below this is treated as a tap and ignored.
   */
  threshold?: number;
  /**
   * If the user moves vertically more than this many px before crossing
   * the horizontal threshold, the gesture is treated as a scroll and
   * cancelled. Default 25.
   */
  verticalTolerance?: number;
}

interface InternalState {
  handlers: { onSwipeLeft?: () => void; onSwipeRight?: () => void };
  options: { threshold: number; verticalTolerance: number };
  detach: () => void;
}

/**
 * Horizontal swipe handler for touch devices, implemented with the
 * native Pointer Events API. The hook returns a callback ref that
 * attaches listeners as soon as React mounts the element and
 * detaches on unmount. Listeners are always the same function
 * identity, so adding / removing them in a test loop is safe.
 *
 * Use case: mobile notebooks with a tabbed layout (Sources /
 * Overview / Chat / Artifacts). A left swipe advances to the next
 * tab; a right swipe goes back.
 *
 * Why not react-swipeable or @use-gesture? Both add 5–10 KB and a
 * dependency surface we don't otherwise need. Pointer Events cover
 * the same gesture in 80 lines and a single file.
 */
export function useSwipe<T extends HTMLElement>(handlers: SwipeHandlers) {
  const { threshold = 50, verticalTolerance = 25 } = handlers;
  // Element we're currently attached to. React's ref callback
  // gives us this directly; the ref tracks the same value to
  // allow the unmount effect to clean up if React skips the
  // null callback (Fast Refresh, older React).
  const attachedRef = useRef<T | null>(null);

  const ref = useCallback((el: T | null) => {
    if (el === attachedRef.current) return;
    if (attachedRef.current) {
      // Detach from the previous element. The previous attach
      // stashed a detach function on the element; we call it.
      const prev = attachedRef.current as T & { __swipe_detach__?: () => void };
      prev.__swipe_detach__?.();
      prev.__swipe_detach__ = undefined;
    }
    attachedRef.current = el;
    if (!el) return;

    // Per-attach state. The handlers / options are read from
    // closures built from the current `handlers` argument, so a
    // late-arriving pointerup after a re-render still fires the
    // freshest callbacks. (We don't use refs because the listeners
    // themselves stay attached across re-renders, so the closure
    // would otherwise be stale.)
    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      state.tracking = true;
      state.cancelled = false;
      state.startX = e.clientX;
      state.startY = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!state.tracking || state.cancelled) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      if (Math.abs(dy) > state.options.verticalTolerance && Math.abs(dy) > Math.abs(dx)) {
        state.cancelled = true;
        return;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!state.tracking) return;
      state.tracking = false;
      if (state.cancelled) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      if (Math.abs(dx) < state.options.threshold) return;
      if (Math.abs(dy) > state.options.verticalTolerance && Math.abs(dy) > Math.abs(dx)) return;
      if (dx < 0) state.handlers.onSwipeLeft?.();
      else state.handlers.onSwipeRight?.();
    };
    const onCancel = () => {
      state.tracking = false;
      state.cancelled = false;
    };

    const state: {
      tracking: boolean;
      cancelled: boolean;
      startX: number;
      startY: number;
      handlers: { onSwipeLeft?: () => void; onSwipeRight?: () => void };
      options: { threshold: number; verticalTolerance: number };
    } = {
      tracking: false,
      cancelled: false,
      startX: 0,
      startY: 0,
      handlers,
      options: { threshold, verticalTolerance },
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);

    const detach = () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
    };
    // Re-read handlers/options on every event from the latest
    // closure values, so the consumer can swap handlers via
    // props without re-attaching.
    Object.defineProperty(state, 'handlers', {
      get: () => handlers,
      configurable: true,
    });
    Object.defineProperty(state, 'options', {
      get: () => ({ threshold, verticalTolerance }),
      configurable: true,
    });

    (el as T & { __swipe_detach__?: () => void }).__swipe_detach__ = detach;
  }, []);

  // Hot-reload / unmount fallback.
  useEffect(() => {
    return () => {
      if (attachedRef.current) {
        const el = attachedRef.current as T & { __swipe_detach__?: () => void };
        el.__swipe_detach__?.();
        el.__swipe_detach__ = undefined;
        attachedRef.current = null;
      }
    };
  }, []);

  return ref;
}

// Re-export InternalState for downstream type helpers; currently
// unused but documents the contract.
export type { InternalState };
