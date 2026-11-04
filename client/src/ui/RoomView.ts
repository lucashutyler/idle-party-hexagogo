import type { TileClickInfo } from './ThreeWorldMap';
import type { ForecastResult, PartyAutoRetreatInfo, AutoRetreatPct } from '@idle-party-rpg/shared';
import { classIconHtml } from '@idle-party-rpg/shared';
import { ROOM_ICONS, actionLabel, questPipClass } from './RoomActions';
import type { RoomAction } from './RoomActions';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { renderForecastPopover, renderForecastRing } from './ForecastChip';
import { forecastHeadline } from '../combat/ForecastFormat';
import { renderAssetImg } from './assets';
import { deferWhilePressed, setHtml } from './render';

export type RoomForecastState =
  | {
    result: ForecastResult;
    stale?: boolean;
    autoRetreat?: PartyAutoRetreatInfo | AutoRetreatPct | null;
    viewerLevel?: number;
  }
  | 'loading'
  | null;

/** Returns what to show for a room's forecast right now (requesting it when needed). */
export type RoomForecastProvider = (tileId: string) => RoomForecastState;

/**
 * RoomView replaces the old TileInfoModal with three states:
 *   - **Current room (you're here)** — near-full-screen, background image,
 *     parties grouped, one button per room action.
 *   - **Remote room (discovered)** — smaller centered popup, lists what's
 *     there, primary action is "Go to room".
 *   - **Undiscovered room** — the smaller popup with minimal info.
 */
export class RoomView {
  private overlay: HTMLElement;
  private modal: HTMLElement;
  private onMove: (col: number, row: number) => void;
  private onUserClick?: (username: string, anchor: HTMLElement, tileCol: number, tileRow: number) => void;
  private onAction?: (action: RoomAction) => void;
  /** What the room offers. Set externally before showing; buttons on the current room, a list on a remote one. */
  actions: RoomAction[] = [];
  /** Whether the party is walking a route. Set externally before showing. */
  isTraveling = false;
  /** GUID of the room being shown — the per-room artwork override id. Set externally before showing. */
  roomId: string | null = null;
  /** Room to forecast (null hides the forecast). Set externally before showing. */
  forecastTileId: string | null = null;
  /** Last shown remote-room key — used to drive the arrival transition. */
  private lastRemoteKey: string | null = null;
  private forecastProvider?: RoomForecastProvider;
  private shownForecastTileId: string | null = null;
  private forecastExpanded = false;

  constructor(
    parent: HTMLElement,
    onMove: (col: number, row: number) => void,
    onUserClick?: (username: string, anchor: HTMLElement, tileCol: number, tileRow: number) => void,
    onAction?: (action: RoomAction) => void,
    forecastProvider?: RoomForecastProvider,
  ) {
    this.forecastProvider = forecastProvider;
    this.onMove = onMove;
    this.onUserClick = onUserClick;
    this.onAction = onAction;

    this.overlay = document.createElement('div');
    this.overlay.className = 'room-view-overlay';
    this.overlay.style.display = 'none';
    // Swallow pointer events so they can't bubble to (or be re-targeted at)
    // the canvas underneath. Clicking outside the modal dismisses.
    const stopAll = (e: Event) => { e.stopPropagation(); };
    for (const ev of ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend'] as const) {
      this.overlay.addEventListener(ev, stopAll);
    }
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    wireFocusOnInteract(this.overlay);

    this.modal = document.createElement('div');
    this.modal.className = 'room-view';
    this.overlay.appendChild(this.modal);
    parent.appendChild(this.overlay);
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private static classIcon(className?: string): string {
    return classIconHtml(className);
  }

  /** Room whose forecast is on screen right now (null when hidden or without a forecast). */
  get visibleForecastTileId(): string | null {
    return this.overlay.style.display === 'none' ? null : this.shownForecastTileId;
  }

  /** Patches the forecast slot when `tileId` is the room on screen. */
  updateForecast(tileId: string, state: RoomForecastState): void {
    if (this.overlay.style.display === 'none' || this.shownForecastTileId !== tileId) return;
    const slot = this.modal.querySelector<HTMLElement>('.room-view-forecast');
    if (slot) deferWhilePressed(slot, () => this.fillForecastSlot(slot, state));
  }

  show(info: TileClickInfo): void {
    const isCurrent = info.isCurrentTile;
    this.shownForecastTileId = this.forecastProvider ? this.forecastTileId : null;
    this.forecastExpanded = false;

    if (isCurrent) {
      this.renderCurrentRoom(info);
    } else {
      this.renderRemoteRoom(info);
    }

    this.overlay.style.display = 'flex';
    this.overlay.classList.toggle('room-view-overlay-current', isCurrent);
    bringToFront(this.overlay);
    this.initForecastSlot();

    // If we just transitioned from a remote popup at this same tile, animate
    // the modal expanding from compact → full ("you have arrived").
    if (isCurrent && this.lastRemoteKey === `${info.col},${info.row}`) {
      this.modal.classList.add('room-view-arrival');
      requestAnimationFrame(() => {
        this.modal.classList.add('room-view-arrival-active');
        setTimeout(() => {
          this.modal.classList.remove('room-view-arrival', 'room-view-arrival-active');
        }, 500);
      });
    }
    this.lastRemoteKey = isCurrent ? null : `${info.col},${info.row}`;
  }

  private renderCurrentRoom(info: TileClickInfo): void {
    this.modal.className = 'room-view room-view-current';

    const enc = encodeURIComponent;
    // Layered background, first found wins: room GUID → legacy zone+coords → zone default.
    const layers: string[] = [];
    if (this.roomId) layers.push(`/room-bg-artwork/${enc(this.roomId)}.png`);
    layers.push(`/room-bg-artwork/${enc(info.zoneId)}-${info.col}-${info.row}.png`);
    layers.push(`/room-bg-artwork/${enc(info.zoneId)}.png`);
    const bgLayers = layers.map(u => `url('${u}')`).join(', ');
    const bgStyle = `background-image: ${bgLayers}; background-size: cover; background-position: center;`;

    const grouped = this.groupPlayersByParty(info.playersHere, info.partyMemberUsernames);

    const partySection = grouped.mine.length > 0
      ? this.renderPartyBox(grouped.mine, 'Your party', 'room-party-self', grouped.mineDungeonName)
      : '';
    const otherBoxes = grouped.others.map(g => this.renderPartyBox(g.members, null, 'room-party-other', g.dungeonName)).join('');
    const otherSection = otherBoxes
      ? `<div class="room-party-other-label">Other parties here</div>${otherBoxes}`
      : '';

    const actions = this.actions;
    const stopButton = this.isTraveling
      ? `<button class="room-view-action room-view-action-stop">Stop here</button>`
      : '';
    const actionButtons = actions.map((action, i) => {
      const title = action.detail ? ` title="${this.escapeHtml(action.detail)}"` : '';
      const pip = pipSuffix(action);
      const icon = action.kind === 'shop'
        ? renderAssetImg('shop', action.targetId, { className: 'room-view-action-icon', label: action.name })
        : `<span class="room-view-action-icon room-view-action-icon-emoji${pip}">${this.escapeHtml(action.icon)}</span>`;
      return `<button class="room-view-action room-view-action-${action.kind}" data-action-index="${i}"${title}>`
        + `${icon}<span>${this.escapeHtml(actionLabel(action))}</span></button>`;
    }).join('');

    this.modal.innerHTML = `
      <div class="room-view-bg" style="${bgStyle}"></div>
      <div class="room-view-scrim"></div>
      <div class="room-view-content">
        <button class="room-view-close" aria-label="Close">×</button>
        <div class="room-view-header">
          <div class="room-view-zone">${this.escapeHtml(info.zoneName)}</div>
          <div class="room-view-name">${this.escapeHtml(info.roomName || 'Unnamed Room')}</div>
        </div>
        ${this.forecastSlotHtml()}
        <div class="room-view-here-label">You are here</div>
        <div class="room-view-parties">
          ${partySection}
          ${otherSection}
        </div>
        <div class="room-view-actions">
          ${stopButton}
          ${actionButtons}
        </div>
      </div>
    `;

    this.modal.querySelector('.room-view-close')!.addEventListener('click', () => this.hide());

    this.modal.querySelector('.room-view-action-stop')?.addEventListener('click', () => {
      this.onMove(info.col, info.row);
      this.hide();
    });

    for (const el of this.modal.querySelectorAll('[data-action-index]')) {
      el.addEventListener('click', () => {
        const action = actions[Number(el.getAttribute('data-action-index'))];
        this.hide();
        if (action) this.onAction?.(action);
      });
    }

    for (const el of this.modal.querySelectorAll('.room-party-member')) {
      el.addEventListener('click', () => {
        const username = el.getAttribute('data-username');
        if (username && this.onUserClick) {
          this.onUserClick(username, el as HTMLElement, info.col, info.row);
        }
      });
    }
  }

  private renderRemoteRoom(info: TileClickInfo): void {
    this.modal.className = 'room-view room-view-remote';

    const grouped = this.groupPlayersByParty(info.playersHere, info.partyMemberUsernames);
    const mineBox = grouped.mine.length > 0
      ? this.renderPartyBox(grouped.mine, 'Your party', 'room-party-self', grouped.mineDungeonName)
      : '';
    const otherBoxes = grouped.others.map(g => this.renderPartyBox(g.members, null, 'room-party-other', g.dungeonName)).join('');
    const partiesBlock = (mineBox || otherBoxes)
      ? `<div class="room-view-parties">
           ${mineBox}
           ${otherBoxes ? `<div class="room-party-other-label">Other parties here</div>${otherBoxes}` : ''}
         </div>`
      : '';

    const undiscoveredNote = !info.roomName || info.roomName === 'Unexplored Room'
      ? `<div class="room-view-meta room-view-meta-dim">Unexplored — travel here to learn more.</div>`
      : '';

    this.modal.innerHTML = `
      <button class="room-view-close" aria-label="Close">×</button>
      <div class="room-view-zone">${this.escapeHtml(info.zoneName)}</div>
      <div class="room-view-name">${this.escapeHtml(info.roomName || 'Unexplored Room')}</div>
      ${this.forecastSlotHtml()}
      ${info.isUnlocked ? this.renderContentsList(this.actions) : ''}
      ${partiesBlock}
      ${undiscoveredNote}
      <div class="room-view-actions">
        ${info.isTraversable ? `<button class="room-view-action room-view-action-go">Go to room</button>` : ''}
        <button class="room-view-action room-view-action-cancel">Close</button>
      </div>
    `;

    this.modal.querySelector('.room-view-close')!.addEventListener('click', () => this.hide());
    this.modal.querySelector('.room-view-action-cancel')!.addEventListener('click', () => this.hide());
    this.modal.querySelector('.room-view-action-go')?.addEventListener('click', () => {
      this.onMove(info.col, info.row);
      this.hide();
    });
    // Clickable usernames also work in the remote-room popup.
    for (const el of this.modal.querySelectorAll('.room-party-member')) {
      el.addEventListener('click', () => {
        const username = el.getAttribute('data-username');
        if (username && this.onUserClick) {
          this.onUserClick(username, el as HTMLElement, info.col, info.row);
        }
      });
    }
  }

  private forecastSlotHtml(): string {
    if (!this.shownForecastTileId) return '';
    return `<div class="room-view-forecast" data-tile-id="${this.escapeHtml(this.shownForecastTileId)}"></div>`;
  }

  private initForecastSlot(): void {
    const tileId = this.shownForecastTileId;
    const slot = this.modal.querySelector<HTMLElement>('.room-view-forecast');
    if (!tileId || !slot || !this.forecastProvider) return;
    slot.addEventListener('click', (e) => {
      const toggle = (e.target as HTMLElement).closest('.room-view-forecast-btn');
      if (!toggle || (toggle as HTMLButtonElement).disabled) return;
      this.forecastExpanded = !this.forecastExpanded;
      toggle.setAttribute('aria-expanded', String(this.forecastExpanded));
      const details = slot.querySelector<HTMLElement>('.room-view-forecast-details');
      if (details) details.hidden = !this.forecastExpanded;
    });
    this.fillForecastSlot(slot, this.forecastProvider(tileId));
  }

  private fillForecastSlot(slot: HTMLElement, state: RoomForecastState): void {
    if (state === null) {
      slot.hidden = true;
      setHtml(slot, '');
      return;
    }
    slot.hidden = false;
    if (state === 'loading') {
      slot.dataset.state = 'loading';
      setHtml(slot, `<button type="button" class="room-view-forecast-btn" disabled>${renderForecastRing('loading', { kind: 'room' })}`
        + '<span class="room-view-forecast-text">Estimating your chances…</span></button>');
      return;
    }
    slot.dataset.state = state.stale ? 'stale' : 'ready';
    const headline = forecastHeadline(state.result, 'room') + (state.stale ? ' · updating…' : '');
    const detailsId = `room-forecast-details-${this.shownForecastTileId ?? ''}`;
    setHtml(slot, `<button type="button" class="room-view-forecast-btn" aria-expanded="${this.forecastExpanded}" aria-controls="${this.escapeHtml(detailsId)}">`
      + renderForecastRing(state.result, { kind: 'room', stale: state.stale })
      + `<span class="room-view-forecast-text">${this.escapeHtml(headline)}</span>`
      + '<span class="room-view-forecast-more" aria-hidden="true">ⓘ</span></button>'
      + `<div class="room-view-forecast-details" id="${this.escapeHtml(detailsId)}"${this.forecastExpanded ? '' : ' hidden'}>`
      + renderForecastPopover(state.result, {
        kind: 'room',
        autoRetreat: state.autoRetreat,
        viewerLevel: state.viewerLevel,
        stale: state.stale,
      })
      + '</div>');
  }

  /**
   * Group co-located players into "my party" + per-party other-party buckets.
   * `partyMemberUsernames` identifies the viewer's party so members of it
   * always land in `mine` (even if their `partyId` field is briefly stale
   * during join/leave transitions). Other players are bucketed by `partyId`;
   * any without a known partyId share a synthetic 'unknown' bucket so they
   * still appear rather than silently dropping.
   */
  private groupPlayersByParty(
    players: { username: string; className?: string; partyId?: string; dungeonName?: string }[],
    partyMemberUsernames: string[],
  ): {
    mine: { username: string; className?: string }[];
    mineDungeonName?: string;
    others: { partyId: string; members: { username: string; className?: string }[]; dungeonName?: string }[];
  } {
    const myUsernames = new Set(partyMemberUsernames);
    const mine: { username: string; className?: string }[] = [];
    let mineDungeonName: string | undefined;
    const otherMap = new Map<string, { partyId: string; members: { username: string; className?: string }[]; dungeonName?: string }>();
    const unknown: { username: string; className?: string }[] = [];
    let unknownDungeonName: string | undefined;

    for (const p of players) {
      if (myUsernames.has(p.username)) {
        mine.push({ username: p.username, className: p.className });
        if (p.dungeonName) mineDungeonName = p.dungeonName;
      } else if (p.partyId) {
        let group = otherMap.get(p.partyId);
        if (!group) {
          group = { partyId: p.partyId, members: [] };
          otherMap.set(p.partyId, group);
        }
        group.members.push({ username: p.username, className: p.className });
        if (p.dungeonName) group.dungeonName = p.dungeonName;
      } else {
        unknown.push({ username: p.username, className: p.className });
        if (p.dungeonName) unknownDungeonName = p.dungeonName;
      }
    }

    const others = Array.from(otherMap.values());
    if (unknown.length > 0) others.push({ partyId: 'unknown', members: unknown, dungeonName: unknownDungeonName });
    return { mine, mineDungeonName, others };
  }

  private renderContentsList(actions: RoomAction[]): string {
    if (actions.length === 0) return '';
    const items = actions.map(action => {
      const pip = pipSuffix(action);
      const detail = action.detail
        ? `<span class="room-view-contents-detail">${this.escapeHtml(action.detail)}</span>`
        : '';
      return `<li class="room-view-contents-item">`
        + `<span class="room-view-contents-icon${pip}">${this.escapeHtml(action.icon)}</span>`
        + `<span class="room-view-contents-name">${this.escapeHtml(action.name)}</span>${detail}</li>`;
    }).join('');
    return `
      <div class="room-view-contents">
        <div class="room-view-contents-label">In this room</div>
        <ul class="room-view-contents-list">${items}</ul>
      </div>
    `;
  }

  /** Render a single party box with optional header label and dungeon tag. */
  private renderPartyBox(
    members: { username: string; className?: string }[],
    label: string | null,
    partyClass: string,
    dungeonName?: string,
  ): string {
    if (members.length === 0) return '';
    const tiles = members.map(p => `
      <div class="room-party-member" data-username="${this.escapeHtml(p.username)}">
        <span class="room-party-member-icon">${RoomView.classIcon(p.className)}</span>
        <span class="room-party-member-name">${this.escapeHtml(p.username)}</span>
      </div>
    `).join('');
    const dungeonTag = dungeonName
      ? `<div class="room-party-dungeon-tag">${ROOM_ICONS.dungeon} Delving ${this.escapeHtml(dungeonName)}</div>`
      : '';
    const labelHtml = label ? `<div class="room-party-group-label">${this.escapeHtml(label)}</div>` : '';
    return `
      <div class="room-party-group ${partyClass}">
        ${labelHtml}
        ${dungeonTag}
        <div class="room-party-group-tiles">${tiles}</div>
      </div>
    `;
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.shownForecastTileId = null;
    release(this.overlay);
  }
}

function pipSuffix(action: RoomAction): string {
  const pip = questPipClass(action);
  return pip ? ` ${pip}` : '';
}
