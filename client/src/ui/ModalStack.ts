/**
 * Click-order z-index for overlays, the dismiss order Back and Escape follow, and keyboard focus for modals.
 * `bringToFront` on open and on interaction, `release` on close. See docs/architecture/client.md.
 */

const BASE_Z = 1500;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let counter = 0;

interface StackEntry {
  order: number;
  dismiss?: () => void;
  holdsFocus: boolean;
  returnFocus: HTMLElement | null;
}

export interface BringToFrontOptions {
  /** False for a panel that opens with a dismiss but must not take keyboard focus. */
  holdFocus?: boolean;
}

const tracked = new Map<HTMLElement, StackEntry>();

function pruneDetached(keep?: HTMLElement): void {
  for (const el of tracked.keys()) {
    if (el !== keep && !el.isConnected) tracked.delete(el);
  }
}

function topModal(): HTMLElement | null {
  let top: HTMLElement | null = null;
  let topOrder = -1;
  for (const [el, entry] of tracked) {
    if (entry.holdsFocus && el.isConnected && entry.order > topOrder) {
      top = el;
      topOrder = entry.order;
    }
  }
  return top;
}

function focusModal(el: HTMLElement): void {
  if (!el.isConnected || !tracked.get(el)?.holdsFocus || el.contains(document.activeElement)) return;
  // The panel, not its first control: focusing a text field would raise a phone's keyboard.
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

function restoreFocus(el: HTMLElement, target: HTMLElement | null): void {
  const active = document.activeElement;
  if (active && active !== document.body && !el.contains(active)) return;
  const next = target?.isConnected ? target : topModal();
  if (!next) return;
  const wouldRaiseKeyboard = next.matches('input, textarea') && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
  if (!wouldRaiseKeyboard) next.focus({ preventScroll: true });
}

function tabStops(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(item => item.checkVisibility?.() ?? true);
}

function keepTabInsideModal(e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const modal = topModal();
  if (!modal) return;
  const stops = tabStops(modal);
  const first = stops[0];
  const last = stops[stops.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = !!active && modal.contains(active);
  const atEdge = e.shiftKey ? active === first || active === modal : active === last;
  if (inside && !atEdge) return;
  e.preventDefault();
  (e.shiftKey ? last : first)?.focus({ preventScroll: true });
}

if (typeof document !== 'undefined') document.addEventListener('keydown', keepTabInsideModal, true);

/**
 * Promote `el` to the top. `dismiss` is what Back and Escape call; a re-promotion without one keeps the earlier one.
 * Opening with a `dismiss` makes `el` a modal: it takes focus, keeps Tab inside, and hands focus back on `release`.
 */
export function bringToFront(el: HTMLElement, dismiss?: () => void, options: BringToFrontOptions = {}): void {
  pruneDetached(el);
  counter++;
  el.style.zIndex = String(BASE_Z + counter);
  const existing = tracked.get(el);
  const opensModal = !existing?.holdsFocus && !!dismiss && options.holdFocus !== false;
  const opener = document.activeElement as HTMLElement | null;
  tracked.set(el, {
    order: counter,
    dismiss: dismiss ?? existing?.dismiss,
    holdsFocus: existing?.holdsFocus || opensModal,
    returnFocus: opensModal ? (opener && !el.contains(opener) ? opener : null) : existing?.returnFocus ?? null,
  });
  // A microtask: callers often append or reveal `el` after this call, and it can't take focus until then.
  if (opensModal) queueMicrotask(() => focusModal(el));
}

/** Make Back and Escape close `el` without touching its z-index, for panels docked inside a screen. Undo with `release`. */
export function registerDismiss(el: HTMLElement, dismiss: () => void): void {
  const entry = tracked.get(el);
  if (entry) {
    entry.dismiss = dismiss;
    return;
  }
  counter++;
  tracked.set(el, { order: counter, dismiss, holdsFocus: false, returnFocus: null });
}

/** Back and Escape skip `el`, but it holds its place in the order until `registerDismiss` gives it a dismiss again. */
export function suspendDismiss(el: HTMLElement): void {
  const entry = tracked.get(el);
  if (entry) {
    entry.dismiss = undefined;
    return;
  }
  counter++;
  tracked.set(el, { order: counter, holdsFocus: false, returnFocus: null });
}

/** Lift `el` to the z-index of its place in the order, or drop it back into the page, without moving it in that order. */
export function setRaised(el: HTMLElement, raised: boolean): void {
  const entry = tracked.get(el);
  if (raised && entry) el.style.zIndex = String(BASE_Z + entry.order);
  else el.style.removeProperty('z-index');
}

/** Remove `el` from the stack when the overlay closes. */
export function release(el: HTMLElement): void {
  el.style.removeProperty('z-index');
  const entry = tracked.get(el);
  tracked.delete(el);
  if (entry?.holdsFocus) restoreFocus(el, entry.returnFocus);
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

/** Close every open modal, newest first, so something behind them can be shown. Docked panels stay. */
export function dismissModals(): void {
  pruneDetached();
  const modals = [...tracked.values()]
    .filter(entry => entry.holdsFocus && entry.dismiss)
    .sort((a, b) => b.order - a.order);
  for (const entry of modals) entry.dismiss?.();
}

/** Promote `el` on every press while it is open. */
export function wireFocusOnInteract(el: HTMLElement): void {
  const handler = () => bringToFront(el);
  el.addEventListener('mousedown', handler, true);
  el.addEventListener('touchstart', handler, true);
}
