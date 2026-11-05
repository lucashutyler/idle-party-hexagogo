import { countText } from './countText';
import { escapeHtml } from './ItemIcon';

export interface SegmentItem {
  id: string;
  label: string;
  /** A number shows as a count, `true` as a dot; 0, false and undefined show nothing. */
  badge?: number | boolean;
}

function badgeHtml(badge: SegmentItem['badge']): string {
  if (!badge) return '';
  const count = typeof badge === 'number' ? countText(badge) : '';
  return `<span class="ui-segment-badge${count ? ' ui-segment-badge-count' : ''}">${count}</span>`;
}

/** Sticky tab row. Pair with `wireSegments` on a stable parent; repaint through `setHtml`. */
export function renderSegments(items: readonly SegmentItem[], activeId: string): string {
  const buttons = items.map((item) => {
    const active = item.id === activeId;
    return `<button type="button" class="ui-segment${active ? ' active' : ''}" role="tab"`
      + ` aria-selected="${active}" tabindex="${active ? 0 : -1}" data-seg="${escapeHtml(item.id)}">`
      + `<span class="ui-segment-label">${escapeHtml(item.label)}</span>${badgeHtml(item.badge)}</button>`;
  }).join('');
  return `<div class="ui-segments" role="tablist">${buttons}</div>`;
}

/** One delegated listener, so it survives repaints. Arrow keys move between tabs. */
export function wireSegments(root: HTMLElement, onSelect: (id: string) => void): void {
  root.addEventListener('click', (e) => {
    const id = (e.target as Element).closest<HTMLElement>('[data-seg]')?.dataset.seg;
    if (id) onSelect(id);
  });
  root.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const current = (e.target as Element).closest<HTMLElement>('[data-seg]');
    if (step === 0 || !current) return;
    const tabs = [...root.querySelectorAll<HTMLElement>('[data-seg]')];
    const next = tabs[(tabs.indexOf(current) + step + tabs.length) % tabs.length];
    e.preventDefault();
    if (next.dataset.seg) onSelect(next.dataset.seg);
    root.querySelector<HTMLElement>(`[data-seg="${next.dataset.seg}"]`)?.focus();
  });
}
