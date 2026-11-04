import { classIconHtml } from '@idle-party-rpg/shared';
import { forecastHeadline } from '../combat/ForecastFormat';
import { artworkUrl, placeholderUrl } from './assets';
import { renderForecastRing } from './ForecastChip';
import { registerDismiss, release } from './ModalStack';
import { deferWhilePressed, setHtml } from './render';
import { questPipClass } from './RoomActions';
import type { RoomAction } from './RoomActions';
import type { RoomForecastProvider, RoomForecastState } from './RoomView';
import type { TileClickInfo } from './ThreeWorldMap';

export const ROOM_SHEET_FORECAST_DEBOUNCE_MS = 250;
export const DUNGEON_TRAVEL_LOCK_TEXT = 'Leave the dungeon before traveling';

export interface RoomSheetModel {
  info: TileClickInfo;
  actions: RoomAction[];
  /** Players outside the viewer's party in this room. */
  othersHere: number;
  roomId: string | null;
  typeId: string | null;
  /** Room to forecast; null hides the chip. */
  forecastTileId: string | null;
  inDungeon: boolean;
}

export interface RoomSheetHandlers {
  onGo: (info: TileClickInfo) => void;
  onDetails: (info: TileClickInfo) => void;
  onUserClick: (username: string, anchor: HTMLElement, col: number, row: number) => void;
  onDismiss: () => void;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isExplored(info: TileClickInfo): boolean {
  return info.isUnlocked || info.isCurrentTile;
}

/** Non-modal panel for the selected room, docked in the map screen so the map keeps panning behind it. */
export class RoomSheet {
  private el: HTMLElement;
  private artEl: HTMLElement;
  private headEl: HTMLElement;
  private forecastEl: HTMLElement;
  private playersEl: HTMLElement;
  private goEl: HTMLButtonElement;
  private detailsEl: HTMLButtonElement;
  private handlers: RoomSheetHandlers;
  private forecastProvider: RoomForecastProvider;
  private model: RoomSheetModel | null = null;
  private forecastTimer: ReturnType<typeof setTimeout> | undefined;
  private shownForecastTileId: string | null = null;

  constructor(parent: HTMLElement, handlers: RoomSheetHandlers, forecastProvider: RoomForecastProvider) {
    this.handlers = handlers;
    this.forecastProvider = forecastProvider;

    this.el = document.createElement('section');
    this.el.className = 'room-sheet';
    this.el.setAttribute('aria-label', 'Selected room');
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="room-sheet-art" aria-hidden="true"></div>
      <button type="button" class="room-sheet-close" aria-label="Close">×</button>
      <div class="room-sheet-head"></div>
      <div class="room-sheet-forecast" hidden></div>
      <div class="room-sheet-players"></div>
      <div class="room-sheet-buttons">
        <button type="button" class="room-sheet-go">Go</button>
        <button type="button" class="room-sheet-details">Details</button>
      </div>
    `;
    this.artEl = this.el.querySelector('.room-sheet-art')!;
    this.headEl = this.el.querySelector('.room-sheet-head')!;
    this.forecastEl = this.el.querySelector('.room-sheet-forecast')!;
    this.playersEl = this.el.querySelector('.room-sheet-players')!;
    this.goEl = this.el.querySelector('.room-sheet-go')!;
    this.detailsEl = this.el.querySelector('.room-sheet-details')!;

    const stop = (e: Event) => { e.stopPropagation(); };
    for (const ev of ['pointerdown', 'mousedown', 'click', 'touchstart'] as const) {
      this.el.addEventListener(ev, stop);
    }
    this.el.addEventListener('click', (e) => this.onClick(e));
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.model !== null;
  }

  isShowing(col: number, row: number): boolean {
    return this.model?.info.col === col && this.model.info.row === row;
  }

  get selectedCol(): number | null {
    return this.model?.info.col ?? null;
  }

  get selectedRow(): number | null {
    return this.model?.info.row ?? null;
  }

  get visibleForecastTileId(): string | null {
    return this.shownForecastTileId;
  }

  show(model: RoomSheetModel): void {
    const sameRoom = this.model !== null && this.isShowing(model.info.col, model.info.row);
    this.model = model;
    this.el.hidden = false;
    this.el.dataset.explored = isExplored(model.info) ? '1' : '0';
    registerDismiss(this.el, () => this.handlers.onDismiss());
    this.paint(model);
    if (!sameRoom) this.startForecast(model.forecastTileId);
  }

  /** Repaints from a state push, without restarting the forecast. */
  update(model: RoomSheetModel): void {
    if (!this.model) return;
    this.model = model;
    deferWhilePressed(this.el, () => {
      if (this.model) this.paint(this.model);
    });
  }

  updateForecast(tileId: string, state: RoomForecastState): void {
    if (this.shownForecastTileId !== tileId) return;
    deferWhilePressed(this.forecastEl, () => this.fillForecast(state));
  }

  hide(): void {
    clearTimeout(this.forecastTimer);
    this.model = null;
    this.shownForecastTileId = null;
    this.el.hidden = true;
    release(this.el);
  }

  private onClick(e: Event): void {
    const target = e.target as HTMLElement;
    const model = this.model;
    if (!model) return;
    if (target.closest('.room-sheet-close')) {
      this.handlers.onDismiss();
    } else if (target.closest('.room-sheet-go')) {
      if (!model.inDungeon) this.handlers.onGo(model.info);
    } else if (target.closest('.room-sheet-details, .room-sheet-forecast')) {
      this.handlers.onDetails(model.info);
    } else {
      const player = target.closest<HTMLElement>('[data-username]');
      const username = player?.dataset.username;
      if (player && username) this.handlers.onUserClick(username, player, model.info.col, model.info.row);
    }
  }

  private paint(model: RoomSheetModel): void {
    const { info } = model;
    const explored = isExplored(info);
    setHtml(this.headEl, explored ? this.exploredHead(model) : this.unexploredHead(info));
    setHtml(this.playersEl, explored ? this.playerList(info) : '');
    this.paintArt(model, explored);
    this.detailsEl.hidden = !explored;
    this.goEl.disabled = model.inDungeon;
    const goText = model.inDungeon ? DUNGEON_TRAVEL_LOCK_TEXT : 'Go';
    if (this.goEl.textContent !== goText) this.goEl.textContent = goText;
    this.goEl.dataset.locked = model.inDungeon ? '1' : '0';
  }

  private unexploredHead(info: TileClickInfo): string {
    return `<div class="room-sheet-name">${escapeHtml(info.roomName || 'Unexplored Room')}</div>`;
  }

  private exploredHead({ info, actions, othersHere }: RoomSheetModel): string {
    const count = othersHere > 0 ? ` · ${othersHere} ${othersHere === 1 ? 'player' : 'players'}` : '';
    const icons = actions.map(action => {
      const pip = questPipClass(action);
      const detail = action.detail ? ` · ${action.detail}` : '';
      return `<span class="room-sheet-action" title="${escapeHtml(action.name + detail)}">`
        + `<span class="room-sheet-action-icon${pip ? ` ${pip}` : ''}">${escapeHtml(action.icon)}</span>`
        + `<span class="room-sheet-action-name">${escapeHtml(action.name)}</span></span>`;
    }).join('');
    return `<div class="room-sheet-name">${escapeHtml(info.roomName || 'Unnamed Room')}</div>`
      + `<div class="room-sheet-sub">${escapeHtml(info.zoneName)}${count}</div>`
      + (icons ? `<div class="room-sheet-actions">${icons}</div>` : '');
  }

  private playerList(info: TileClickInfo): string {
    if (info.playersHere.length === 0) return '';
    return '<div class="room-sheet-players-label">Here now</div>'
      + info.playersHere.map(p =>
        `<button type="button" class="room-sheet-player" data-username="${escapeHtml(p.username)}">`
        + `<span class="room-sheet-player-icon">${classIconHtml(p.className)}</span>`
        + `<span class="room-sheet-player-name">${escapeHtml(p.username)}</span></button>`).join('');
  }

  private paintArt({ info, roomId, typeId }: RoomSheetModel, explored: boolean): void {
    if (!explored) {
      this.artEl.style.backgroundImage = '';
      return;
    }
    const url = (href: string) => `url("${href}")`;
    const layers = [
      roomId ? url(artworkUrl('room-bg', roomId)) : '',
      roomId ? url(artworkUrl('tile', roomId)) : '',
      typeId ? url(artworkUrl('tile-type', typeId)) : '',
      url(placeholderUrl(info.zoneName, { w: 640, h: 360 })),
    ].filter(Boolean).join(', ');
    if (this.artEl.dataset.layers !== layers) {
      this.artEl.dataset.layers = layers;
      this.artEl.style.backgroundImage = layers;
    }
  }

  /** Quick taps across the map shouldn't each cost the server a simulation. */
  private startForecast(tileId: string | null): void {
    clearTimeout(this.forecastTimer);
    this.shownForecastTileId = tileId;
    this.forecastEl.hidden = !tileId;
    setHtml(this.forecastEl, '');
    if (!tileId) return;
    this.fillForecast('loading');
    this.forecastTimer = setTimeout(() => {
      if (this.shownForecastTileId === tileId) this.fillForecast(this.forecastProvider(tileId));
    }, ROOM_SHEET_FORECAST_DEBOUNCE_MS);
  }

  private fillForecast(state: RoomForecastState): void {
    if (state === null) {
      this.forecastEl.hidden = true;
      setHtml(this.forecastEl, '');
      return;
    }
    this.forecastEl.hidden = false;
    if (state === 'loading') {
      setHtml(this.forecastEl, renderForecastRing('loading', { kind: 'room', compact: true }));
      return;
    }
    const headline = forecastHeadline(state.result, 'room') + (state.stale ? ' · updating…' : '');
    setHtml(this.forecastEl,
      renderForecastRing(state.result, { kind: 'room', compact: true, stale: state.stale })
      + `<span class="room-sheet-forecast-text">${escapeHtml(headline)}</span>`);
  }
}
