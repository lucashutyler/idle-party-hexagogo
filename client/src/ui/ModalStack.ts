/**
 * Tiny modal/overlay stack manager.
 *
 * Replaces hard-coded per-overlay z-index values. Each overlay calls
 * `bringToFront(el)` when it opens AND on `mousedown` (so click-to-focus
 * works like native windows). Calls `release(el)` when it closes.
 *
 * Order is purely click/open dependent — the most recently activated
 * overlay sits on top regardless of its "type". New overlays opt in by
 * calling these two functions; nothing else needed.
 *
 * Implementation notes:
 * - z-index is assigned as `BASE_Z + counter`, with counter incrementing
 *   on every `bringToFront`. We never reset the counter (Number.MAX_SAFE_INTEGER
 *   gives us ~9 quadrillion overlay activations of headroom — enough).
 * - `BASE_Z` is intentionally above the bottom nav (1000) and persistent
 *   XP bar so the overlays sit above persistent chrome.
 * - Calling `bringToFront` on an already-tracked element re-promotes it
 *   to the new top z-index (used by mousedown to refocus a window).
 */

const BASE_Z = 1500;
let counter = 0;
const tracked = new WeakMap<HTMLElement, number>();

/** Promote `el` to the top of the modal stack. */
export function bringToFront(el: HTMLElement): void {
  counter++;
  const z = BASE_Z + counter;
  el.style.zIndex = String(z);
  tracked.set(el, z);
}

/** Remove `el` from the stack — call this when the overlay closes. */
export function release(el: HTMLElement): void {
  el.style.removeProperty('z-index');
  tracked.delete(el);
}

/**
 * Wire an overlay so it auto-promotes on mousedown / touchstart.
 * The overlay still has to call `bringToFront(el)` itself when it opens
 * and `release(el)` when it closes — this just handles the focus-on-click
 * case while it's open.
 */
export function wireFocusOnInteract(el: HTMLElement): void {
  const handler = () => bringToFront(el);
  el.addEventListener('mousedown', handler, true);
  el.addEventListener('touchstart', handler, true);
}
