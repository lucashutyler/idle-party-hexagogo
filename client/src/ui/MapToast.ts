export const MAP_TOAST_MS = 6000;

let current: { el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;

/** Shows `message` over the map, replacing any toast already up. A tap dismisses it early. */
export function showMapToast(container: HTMLElement, message: string): HTMLElement {
  dismissMapToast();

  const el = document.createElement('div');
  el.className = 'map-toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  el.style.setProperty('--toast-ms', `${MAP_TOAST_MS}ms`);
  el.addEventListener('click', () => {
    if (current?.el === el) dismissMapToast();
  });
  container.appendChild(el);

  current = { el, timer: setTimeout(dismissMapToast, MAP_TOAST_MS) };
  return el;
}

export function dismissMapToast(): void {
  if (!current) return;
  clearTimeout(current.timer);
  current.el.remove();
  current = null;
}
