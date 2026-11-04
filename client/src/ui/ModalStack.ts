/**
 * Click-order z-index for overlays, plus the dismiss order Back and Escape follow.
 * `bringToFront` on open and on interaction, `release` on close. See docs/architecture/client.md.
 */

const BASE_Z = 1500;
let counter = 0;

interface StackEntry {
  order: number;
  dismiss?: () => void;
}

const tracked = new Map<HTMLElement, StackEntry>();

function pruneDetached(keep?: HTMLElement): void {
  for (const el of tracked.keys()) {
    if (el !== keep && !el.isConnected) tracked.delete(el);
  }
}

/** Promote `el` to the top. `dismiss` is what Back and Escape call; a re-promotion without one keeps the earlier one. */
export function bringToFront(el: HTMLElement, dismiss?: () => void): void {
  pruneDetached(el);
  counter++;
  el.style.zIndex = String(BASE_Z + counter);
  tracked.set(el, { order: counter, dismiss: dismiss ?? tracked.get(el)?.dismiss });
}

/** Make Back and Escape close `el` without touching its z-index, for panels docked inside a screen. Undo with `release`. */
export function registerDismiss(el: HTMLElement, dismiss: () => void): void {
  const entry = tracked.get(el);
  if (entry) {
    entry.dismiss = dismiss;
    return;
  }
  counter++;
  tracked.set(el, { order: counter, dismiss });
}

/** Remove `el` from the stack when the overlay closes. */
export function release(el: HTMLElement): void {
  el.style.removeProperty('z-index');
  tracked.delete(el);
}

/** Dismiss the most recently promoted overlay that can be dismissed. Returns whether there was one. */
export function dismissTop(): boolean {
  pruneDetached();
  let top: StackEntry | null = null;
  for (const entry of tracked.values()) {
    if (entry.dismiss && (!top || entry.order > top.order)) top = entry;
  }
  if (!top?.dismiss) return false;
  top.dismiss();
  return true;
}

/** Promote `el` on every press while it is open. */
export function wireFocusOnInteract(el: HTMLElement): void {
  const handler = () => bringToFront(el);
  el.addEventListener('mousedown', handler, true);
  el.addEventListener('touchstart', handler, true);
}
