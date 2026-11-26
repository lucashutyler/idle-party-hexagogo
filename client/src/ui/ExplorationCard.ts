import type { MapRoomsFound } from '../network/WorldCache';
import { escapeHtml } from './ItemIcon';

/** Hero > Stats card: rooms found per region visited, then how many regions are still unseen. Empty before any. */
export function explorationCardHtml(byMap: ReadonlyMap<string, MapRoomsFound>): string {
  const all = [...byMap.values()];
  const visited = all.filter(entry => entry.found > 0);
  if (visited.length === 0) return '';
  const unseen = all.length - visited.length;
  const rows = visited.map(({ name, found, total }) => {
    const share = Math.min(1, found / total);
    return '<div class="hero-exploration-row">'
      + `<div class="hero-exploration-row-head"><span class="hero-exploration-map">${escapeHtml(name)}</span>`
      + `<span class="hero-exploration-count">${found} of ${total} ${total === 1 ? 'room' : 'rooms'}</span></div>`
      + `<div class="hero-exploration-bar" aria-hidden="true"><div class="hero-exploration-fill" style="transform:scaleX(${share.toFixed(3)})"></div></div>`
      + '</div>';
  }).join('');
  const rest = unseen > 0
    ? `<div class="hero-exploration-rest">${unseen} ${unseen === 1 ? 'region' : 'regions'} not yet visited</div>`
    : '';
  return `<div class="items-section-label">Exploration</div><div class="hero-exploration-card">${rows}${rest}</div>`;
}
