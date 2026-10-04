// @vitest-environment jsdom
import { renderHook, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSwipe } from './useSwipe';

/**
 * Tests for the useSwipe hook. jsdom doesn't dispatch real pointer
 * events with `pointerType`, so we drive the listeners manually via
 * `fireEvent` — the same path the browser uses once the hook has
 * attached `pointerdown` / `pointermove` / `pointerup`.
 */

function makeEl() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function dispatchPointer(el: Element, type: string, init: PointerEventInit) {
  // jsdom's PointerEvent constructor takes the same args as
  // MouseEvent, so we fall back to a regular Event with pointer-*
  // properties. The hook reads `clientX` / `clientY` / `isPrimary`
  // directly, which we set via init. We use defineProperty so the
  // properties are non-writable but readable (matches what
  // PointerEvent does in real browsers).
  const ev = new Event(type, { bubbles: true });
  for (const [k, v] of Object.entries(init)) {
    Object.defineProperty(ev, k, { value: v, configurable: true });
  }
  el.dispatchEvent(ev);
}

describe('useSwipe', () => {
  it('fires onSwipeLeft when horizontal distance crosses the threshold to the right→left', () => {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    const el = makeEl();
    const { result } = renderHook(() =>
      useSwipe<HTMLDivElement>({ onSwipeLeft: onLeft, onSwipeRight: onRight }),
    );
    // The hook returns a callback ref — assign the element so the
    // listeners attach synchronously.
    act(() => {
      result.current(el);
    });

    act(() => {
      dispatchPointer(el, 'pointerdown', { clientX: 200, clientY: 100, isPrimary: true });
      dispatchPointer(el, 'pointerup', { clientX: 120, clientY: 100, isPrimary: true });
    });
    expect(onLeft).toHaveBeenCalledTimes(1);
    expect(onRight).not.toHaveBeenCalled();
  });

  it('fires onSwipeRight when horizontal distance crosses the threshold to the left→right', () => {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    const el = makeEl();
    const { result } = renderHook(() =>
      useSwipe<HTMLDivElement>({ onSwipeLeft: onLeft, onSwipeRight: onRight }),
    );
    act(() => {
      result.current(el);
    });

    act(() => {
      dispatchPointer(el, 'pointerdown', { clientX: 100, clientY: 100, isPrimary: true });
      dispatchPointer(el, 'pointerup', { clientX: 200, clientY: 100, isPrimary: true });
    });
    expect(onRight).toHaveBeenCalledTimes(1);
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('does not fire when the horizontal distance is below the threshold', () => {
    const onLeft = vi.fn();
    const el = makeEl();
    const { result } = renderHook(() => useSwipe<HTMLDivElement>({ onSwipeLeft: onLeft }));
    act(() => {
      result.current(el);
    });

    act(() => {
      dispatchPointer(el, 'pointerdown', { clientX: 200, clientY: 100, isPrimary: true });
      dispatchPointer(el, 'pointerup', { clientX: 180, clientY: 100, isPrimary: true });
    });
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('respects a custom threshold', () => {
    const onLeft = vi.fn();
    const el = makeEl();
    const { result } = renderHook(() =>
      useSwipe<HTMLDivElement>({ onSwipeLeft: onLeft, threshold: 100 }),
    );
    act(() => {
      result.current(el);
    });

    // 60 px is above the default 50 but below the custom 100.
    act(() => {
      dispatchPointer(el, 'pointerdown', { clientX: 200, clientY: 100, isPrimary: true });
      dispatchPointer(el, 'pointerup', { clientX: 140, clientY: 100, isPrimary: true });
    });
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('cancels when the gesture becomes vertically dominant mid-flight', () => {
    const onLeft = vi.fn();
    const el = makeEl();
    const { result } = renderHook(() => useSwipe<HTMLDivElement>({ onSwipeLeft: onLeft }));
    act(() => {
      result.current(el);
    });

    act(() => {
      dispatchPointer(el, 'pointerdown', { clientX: 200, clientY: 100, isPrimary: true });
      // Big vertical drift — should cancel the gesture.
      dispatchPointer(el, 'pointermove', { clientX: 195, clientY: 200, isPrimary: true });
      // Even though horizontal distance is large, the move was
      // already cancelled, so the up event should not fire.
      dispatchPointer(el, 'pointerup', { clientX: 100, clientY: 200, isPrimary: true });
    });
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('ignores non-primary pointers (e.g. multi-touch second finger)', () => {
    const onLeft = vi.fn();
    const el = makeEl();
    const { result } = renderHook(() => useSwipe<HTMLDivElement>({ onSwipeLeft: onLeft }));
    act(() => {
      result.current(el);
    });

    act(() => {
      dispatchPointer(el, 'pointerdown', { clientX: 200, clientY: 100, isPrimary: false });
      dispatchPointer(el, 'pointerup', { clientX: 100, clientY: 100, isPrimary: false });
    });
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('detaches the listeners when the ref is called with null (unmount)', () => {
    const onLeft = vi.fn();
    const el = makeEl();
    const { result } = renderHook(() => useSwipe<HTMLDivElement>({ onSwipeLeft: onLeft }));
    act(() => {
      result.current(el);
      // Simulate unmount: React calls the callback ref with null.
      result.current(null);
    });
    act(() => {
      dispatchPointer(el, 'pointerdown', { clientX: 200, clientY: 100, isPrimary: true });
      dispatchPointer(el, 'pointerup', { clientX: 100, clientY: 100, isPrimary: true });
    });
    expect(onLeft).not.toHaveBeenCalled();
  });
});
