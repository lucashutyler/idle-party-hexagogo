const MIN_TOAST_MS = 5000;
const MAX_TOAST_MS = 9000;
const BASE_TOAST_MS = 2000;
const TOAST_MS_PER_CHAR = 60;

let current: { el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

/** How long a map toast stays up: longer messages get more reading time, within 5–9 seconds. */
export function mapToastDurationMs(message: string): number {
  return Math.min(MAX_TOAST_MS, Math.max(MIN_TOAST_MS, BASE_TOAST_MS + TOAST_MS_PER_CHAR * message.length));
}

/** Shows `message` over the map, replacing any toast already up. A tap dismisses it early. */
export function showMapToast(container: HTMLElement, message: string): HTMLElement {
  dismissMapToast();

  const durationMs = mapToastDurationMs(message);
  const el = document.createElement('div');
  el.className = 'map-toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  el.style.setProperty('--toast-ms', `${durationMs}ms`);
  el.addEventListener('click', () => {
    if (current?.el === el) dismissMapToast();
  });
  container.appendChild(el);

  current = { el, timer: setTimeout(dismissMapToast, durationMs) };
  return el;
}

export function dismissMapToast(): void {
  if (!current) return;
  clearTimeout(current.timer);
  current.el.remove();
  current = null;
}
