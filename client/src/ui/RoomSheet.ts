import { classIconHtml } from '@idle-party-rpg/shared';
import { forecastHeadline, forecastVerdict } from '../combat/ForecastFormat';
import { artworkUrl, placeholderUrl } from './assets';
import { renderForecastRing } from './ForecastChip';
import { registerDismiss, release } from './ModalStack';
import { escapeHtml } from './ItemIcon';
import { deferWhilePressed, setHtml } from './render';
import { LOCKED_DETAIL, ROOM_ICONS, actionLabel, questPipClass } from './RoomActions';
import type { RoomAction } from './RoomActions';
import type { RoomForecastProvider, RoomForecastState } from './RoomView';
import type { TileClickInfo } from './ThreeWorldMap';
import { routeUnknown } from './routePreview';
import type { RoutePreview } from './routePreview';

export const ROOM_SHEET_FORECAST_DEBOUNCE_MS = 250;
export const DUNGEON_TRAVEL_LOCK_TEXT = 'Leave the dungeon before traveling';
const LOCK_PULSE_CLASS = 'room-sheet-lock-pulse';

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
  /** No pack this room can roll pays anyone XP. */
  paysNoXp: boolean;
  /** Why the party can't go in, one line per unmet requirement; null when nothing the client can see stops it. */
  lock: string[] | null;
  /** How the party would get there; null when the client can't tell. */
  route: RoutePreview | null;
  /** What the sheet says about the way there (see routePreviewLines). */
  routeLines: string[];
  /** Another player is in the party: they may know a door the viewer doesn't, so an unknown way keeps Go. */
  partyHasOthers: boolean;
}

export interface RoomSheetHandlers {
  onGo: (info: TileClickInfo) => void;
  onDetails: (info: TileClickInfo) => void;
  onUserClick: (username: string, anchor: HTMLElement, col: number, row: number) => void;
  onDismiss: () => void;
}

function isExplored(info: TileClickInfo): boolean {
  return info.isUnlocked || info.isCurrentTile;
}

/** An unknown way withholds Go only from a lone player; with others along, the server judges. */
function routeBlocksGo(model: RoomSheetModel): boolean {
  return routeUnknown(model.route) && !model.partyHasOthers;
}

function blockedLines(model: RoomSheetModel): string[] {
  return [...(model.lock ?? []), ...(routeBlocksGo(model) ? model.routeLines : [])];
}

/** The one line under the name about the way there, when it isn't already in the lock block. */
function routeNote(model: RoomSheetModel): string | null {
  if (routeBlocksGo(model)) return null;
  return model.routeLines[0] ?? null;
}

/** Non-modal panel for the selected room, docked in the map screen so the map keeps panning behind it. */
export class RoomSheet {
  private el: HTMLElement;
  private artEl: HTMLElement;
  private headEl: HTMLElement;
  private forecastEl: HTMLElement;
  private playersEl: HTMLElement;
  private lockEl: HTMLElement;
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
        <div class="room-sheet-lock" hidden></div>
        <button type="button" class="room-sheet-go">Go</button>
        <button type="button" class="room-sheet-details">Details</button>
      </div>
    `;
    this.artEl = this.el.querySelector('.room-sheet-art')!;
    this.headEl = this.el.querySelector('.room-sheet-head')!;
    this.forecastEl = this.el.querySelector('.room-sheet-forecast')!;
    this.playersEl = this.el.querySelector('.room-sheet-players')!;
    this.lockEl = this.el.querySelector('.room-sheet-lock')!;
    this.lockEl.addEventListener('animationend', () => this.lockEl.classList.remove(LOCK_PULSE_CLASS));
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

  isShowing(mapId: string, col: number, row: number): boolean {
    const info = this.model?.info;
    return info?.mapId === mapId && info.col === col && info.row === row;
  }

  get selectedMapId(): string | null {
    return this.model?.info.mapId ?? null;
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

  /** The shown room is locked or out of walking reach, so Go is withheld. */
  get isBlocked(): boolean {
    return this.model !== null && blockedLines(this.model).length > 0;
  }

  /** Draws the eye back to why the room can't be entered. */
  pulseLock(): void {
    if (this.lockEl.hidden) return;
    this.lockEl.classList.remove(LOCK_PULSE_CLASS);
    void this.lockEl.offsetWidth; // the reflow between remove and add is what restarts the animation
    this.lockEl.classList.add(LOCK_PULSE_CLASS);
  }

  show(model: RoomSheetModel): void {
    const sameRoom = this.model !== null && this.isShowing(model.info.mapId, model.info.col, model.info.row);
    if (!sameRoom) this.lockEl.classList.remove(LOCK_PULSE_CLASS);
    this.model = model;
    this.el.hidden = false;
    this.el.dataset.explored = isExplored(model.info) ? '1' : '0';
    registerDismiss(this.el, () => this.handlers.onDismiss());
    this.paint(model);
    if (!sameRoom) this.startForecast(model.forecastTileId);
  }

  /** Repaints from a state push. The forecast restarts only if the room's own forecast target changed. */
  update(model: RoomSheetModel): void {
    if (!this.model) return;
    this.model = model;
    if (model.forecastTileId !== this.shownForecastTileId) this.startForecast(model.forecastTileId);
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
    setHtml(this.headEl, explored ? this.exploredHead(model) : this.unexploredHead(model));
    setHtml(this.playersEl, explored ? this.playerList(info) : '');
    this.paintArt(model, explored);
    this.paintLock(model);
    this.detailsEl.hidden = !explored;
    this.goEl.disabled = model.inDungeon;
    const goText = model.inDungeon ? DUNGEON_TRAVEL_LOCK_TEXT : 'Go';
    if (this.goEl.textContent !== goText) this.goEl.textContent = goText;
    this.goEl.dataset.locked = model.inDungeon ? '1' : '0';
  }

  private paintLock(model: RoomSheetModel): void {
    const lines = blockedLines(model);
    const blocked = lines.length > 0;
    this.el.dataset.blocked = blocked ? '1' : '0';
    this.lockEl.hidden = !blocked;
    this.goEl.hidden = blocked;
    setHtml(this.lockEl, lines.map(line => `<div class="room-sheet-lock-line">${escapeHtml(line)}</div>`).join(''));
  }

  private nameHtml(name: string, locked: boolean): string {
    const padlock = locked ? `<span class="room-sheet-name-lock" aria-hidden="true">${ROOM_ICONS.lock}</span>` : '';
    return `<div class="room-sheet-name">${padlock}${escapeHtml(name)}</div>`;
  }

  private unexploredHead(model: RoomSheetModel): string {
    const note = routeNote(model);
    return this.nameHtml(model.info.roomName || 'Unexplored Room', model.lock !== null)
      + (note ? `<div class="room-sheet-sub"><span class="room-sheet-sub-route">${escapeHtml(note)}</span></div>` : '');
  }

  private exploredHead(model: RoomSheetModel): string {
    const { info, actions, othersHere, paysNoXp, lock } = model;
    const count = othersHere > 0 ? ` · ${othersHere} ${othersHere === 1 ? 'player' : 'players'}` : '';
    const first = actions[0] ? `<span class="room-sheet-sub-action">${escapeHtml(actionLabel(actions[0]))}</span>` : '';
    const note = routeNote(model);
    const route = note ? `<span class="room-sheet-sub-route">${escapeHtml(note)}</span>` : '';
    const noXp = paysNoXp ? '<span class="room-sheet-sub-noxp">Fights here pay no XP</span>' : '';
    const icons = actions.map(action => {
      const pip = questPipClass(action);
      const detail = action.locked ? ` · ${LOCKED_DETAIL}` : action.detail ? ` · ${action.detail}` : '';
      const classes = ['room-sheet-action', action.locked ? 'room-sheet-action-locked' : ''].filter(Boolean).join(' ');
      return `<span class="${classes}" title="${escapeHtml(action.name + detail)}">`
        + `<span class="room-sheet-action-icon${pip ? ` ${pip}` : ''}">${escapeHtml(action.icon)}</span>`
        + `<span class="room-sheet-action-name">${escapeHtml(action.name)}</span></span>`;
    }).join('');
    return this.nameHtml(info.roomName || 'Unnamed Room', lock !== null)
      + `<div class="room-sheet-sub">${first}<span class="room-sheet-sub-zone">${escapeHtml(info.zoneName)}${count}</span>${route}${noXp}</div>`
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
      + `<span class="room-sheet-forecast-word">${forecastVerdict(state.result, 'room').label}</span>`
      + `<span class="room-sheet-forecast-text">${escapeHtml(headline)}</span>`);
  }
}
