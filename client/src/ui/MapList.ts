import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import { escapeHtml } from './ItemIcon';
import { bringToFront, release } from './ModalStack';
import { deferWhilePressed, setHtml } from './render';

export interface MapListEntry {
  mapId: string;
  name: string;
  found: number;
  total: number;
  partyHere: boolean;
  viewing: boolean;
}

type MapLookups = Pick<WorldCache, 'roomsFoundByMap'>;

/** The party's map first, then every other map with a found room, in world order. */
export function mapListEntries(state: ServerStateMessage | null, worldCache: MapLookups, viewedMapId: string | null): MapListEntry[] {
  if (!state) return [];
  const entries: MapListEntry[] = [];
  for (const [mapId, rooms] of worldCache.roomsFoundByMap(state.unlocked ?? [])) {
    const partyHere = mapId === state.currentMapId;
    if (!partyHere && rooms.found === 0) continue;
    const entry = { mapId, name: rooms.name, found: rooms.found, total: rooms.total, partyHere, viewing: mapId === viewedMapId };
    if (partyHere) entries.unshift(entry);
    else entries.push(entry);
  }
  return entries;
}

/** The Maps sheet: pick a map to look at. Closes on Back, Escape, a pick or a tap outside. */
export class MapList {
  private overlay: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly gameClient: GameClient,
    private readonly worldCache: WorldCache,
    private readonly viewedMapId: () => string | null,
    private readonly onPick: (mapId: string) => void,
  ) {}

  get isOpen(): boolean {
    return this.overlay !== null;
  }

  open(): void {
    if (this.overlay) return;
    const overlay = document.createElement('div');
    overlay.className = 'player-options-overlay map-list-overlay';
    overlay.innerHTML = `
      <div class="player-options-modal map-list-modal" role="dialog" aria-label="Maps">
        <div class="player-options-header">
          <span class="player-options-title">Maps</span>
          <button type="button" class="player-options-close" aria-label="Close">×</button>
        </div>
        <div class="map-list-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.body = overlay.querySelector('.map-list-body');

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || (e.target instanceof Element && e.target.closest('.player-options-close'))) {
        this.close();
        return;
      }
      const mapId = e.target instanceof Element ? e.target.closest<HTMLElement>('.map-list-item')?.dataset.mapId : undefined;
      if (!mapId) return;
      this.close();
      this.onPick(mapId);
    });
    bringToFront(overlay, () => this.close());

    this.render();
    this.unsubscribe = this.gameClient.subscribe(() => {
      if (this.body) deferWhilePressed(this.body, () => this.render());
    });
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!this.overlay) return;
    release(this.overlay);
    this.overlay.remove();
    this.overlay = null;
    this.body = null;
  }

  private render(): void {
    if (!this.body) return;
    const entries = mapListEntries(this.gameClient.lastState, this.worldCache, this.viewedMapId());
    setHtml(this.body, `<ul class="map-list">${entries.map(entryHtml).join('')}</ul>`);
  }
}

function entryHtml(entry: MapListEntry): string {
  const share = entry.total > 0 ? Math.min(1, entry.found / entry.total) : 0;
  const tag = entry.partyHere ? '<span class="map-list-tag">Your party is here</span>' : '';
  return `<li><button type="button" class="map-list-item" data-map-id="${escapeHtml(entry.mapId)}"${entry.viewing ? ' aria-current="true"' : ''}>`
    + `<span class="map-list-name">${escapeHtml(entry.name)}</span>${tag}`
    + `<span class="map-list-count">${entry.found} of ${entry.total} rooms</span>`
    + `<span class="map-list-bar" aria-hidden="true"><span class="map-list-fill" style="transform:scaleX(${share.toFixed(3)})"></span></span>`
    + '</button></li>';
}
