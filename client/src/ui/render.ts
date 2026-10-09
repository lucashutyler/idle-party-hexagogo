/**
 * Primitives for repainting from state pushes without swallowing clicks.
 * See docs/architecture/client.md → State-driven re-rendering.
 */

const CLICK_GRACE_MS = 400;
const MAX_HOLD_MS = 5000;

let pressed: Element | null = null;
let graceTimer: ReturnType<typeof setTimeout> | undefined;
let capTimer: ReturnType<typeof setTimeout> | undefined;
const deferred = new Map<Element, () => void>();
const written = new WeakMap<Element, string>();

/**
 * Runs `paint` now, or — while a press that started inside `root` is in flight — once that
 * press has delivered its click. Only the latest deferred paint per root runs.
 */
export function deferWhilePressed(root: Element, paint: () => void): void {
  if (pressed && root.contains(pressed)) {
    deferred.set(root, paint);
    return;
  }
  deferred.delete(root);
  paint();
}

/** Sets `el.innerHTML` unless it already holds exactly what this helper last wrote. Returns whether it wrote. */
export function setHtml(el: Element, html: string): boolean {
  if (written.get(el) === html) return false;
  written.set(el, html);
  el.innerHTML = html;
  return true;
}

function release(): void {
  clearTimeout(graceTimer);
  clearTimeout(capTimer);
  pressed = null;
  const paints = [...deferred.values()];
  deferred.clear();
  for (const paint of paints) paint();
}

function releaseAfter(ms: number): void {
  clearTimeout(graceTimer);
  graceTimer = setTimeout(release, ms);
}

function installPressTracking(): void {
  if (typeof document === 'undefined') return;
  // Capture phase: several panels stopPropagation on pointer events in the bubble phase.
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    clearTimeout(graceTimer);
    clearTimeout(capTimer);
    pressed = e.target;
    capTimer = setTimeout(release, MAX_HOLD_MS);
  }, true);
  document.addEventListener('pointerup', () => { if (pressed) releaseAfter(CLICK_GRACE_MS); }, true);
  // A macrotask, not a microtask: the flush must wait until the click's own handlers have run.
  document.addEventListener('click', () => { if (pressed) releaseAfter(0); }, true);
  document.addEventListener('pointercancel', () => { if (pressed) release(); }, true);
  window.addEventListener('blur', () => { if (pressed) release(); });
}

installPressTracking();
