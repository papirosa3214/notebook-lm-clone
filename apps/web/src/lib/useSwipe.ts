import { useEffect, useRef } from 'react';

interface SwipeHandlers {
  /** Fired when the user swipes left (finger moves right→left, content follows finger). */
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

/**
 * Horizontal swipe handler for touch devices. Implemented with the
 * native Pointer Events API so it works for both finger and Apple
 * Pencil / mouse drags. The hook attaches to the element returned
 * by `ref` and only fires when the gesture is dominantly horizontal
 * (the user wasn't trying to scroll).
 *
 * Use case: mobile notebooks with a tabbed layout (Sources /
 * Overview / Chat / Artifacts). A left swipe advances to the next
 * tab; a right swipe goes back.
 *
 * Why not react-swipeable or @use-gesture? Both add ~5–10 KB and
 * a dependency surface we don't otherwise need. Pointer Events
 * cover the same gesture in 60 lines and a single file.
 */
export function useSwipe<T extends HTMLElement>(handlers: SwipeHandlers) {
  const { onSwipeLeft, onSwipeRight, threshold = 50, verticalTolerance = 25 } = handlers;
  const ref = useRef<T | null>(null);
  // Stash handlers in a ref so the listener attached in the effect
  // always sees the latest closure without us having to re-bind on
  // every render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let cancelled = false;

    const onDown = (e: PointerEvent) => {
      // Only track primary touch / pen / mouse (not right-click etc).
      if (!e.isPrimary) return;
      tracking = true;
      cancelled = false;
      startX = e.clientX;
      startY = e.clientY;
    };

    const onMove = (e: PointerEvent) => {
      if (!tracking || cancelled) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Vertical-dominant gestures are scrolls, not swipes.
      if (Math.abs(dy) > verticalTolerance && Math.abs(dy) > Math.abs(dx)) {
        cancelled = true;
        return;
      }
    };

    const onUp = (e: PointerEvent) => {
      if (!tracking) return;
      tracking = false;
      if (cancelled) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Require the gesture to be dominantly horizontal at the
      // release point too — otherwise a fast vertical flick that
      // happened to slide a few px sideways would still fire.
      if (Math.abs(dx) < threshold) return;
      if (Math.abs(dy) > verticalTolerance && Math.abs(dy) > Math.abs(dx)) return;
      if (dx < 0) handlersRef.current.onSwipeLeft?.();
      else handlersRef.current.onSwipeRight?.();
    };

    const onCancel = () => {
      tracking = false;
      cancelled = false;
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
    };
  }, [threshold, verticalTolerance, onSwipeLeft, onSwipeRight]);

  return ref;
}
