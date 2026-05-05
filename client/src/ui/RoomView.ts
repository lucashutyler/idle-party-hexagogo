import type { TileClickInfo } from './CanvasWorldMap';
import { classIconHtml } from '@idle-party-rpg/shared';
import { renderAssetImg } from './assets';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';

/**
 * RoomView replaces the old TileInfoModal with three states:
 *   - **Current room (you're here)** — near-full-screen, background image,
 *     parties grouped, shop / NPC affordances.
 *   - **Remote room (discovered)** — smaller centered popup, hints at what's
 *     there, primary action is "Go to room".
 *   - **Undiscovered room** — the smaller popup with minimal info.
 *
 * `showWithTransition` plays an "arrival" expand animation when called after
 * a remote-room popup was open, so travel completion has weight.
 */
export class RoomView {
  private overlay: HTMLElement;
  private modal: HTMLElement;
  private onMove: (col: number, row: number) => void;
  private onUserClick?: (username: string, anchor: HTMLElement, tileCol: number, tileRow: number) => void;
  private onShopClick?: () => void;
  /** Whether the player's current tile has a shop. Set externally before showing. */
  hasShop = false;
  /** Last shown remote-room key — used to drive the arrival transition. */
  private lastRemoteKey: string | null = null;

  constructor(
    parent: HTMLElement,
    onMove: (col: number, row: number) => void,
    onUserClick?: (username: string, anchor: HTMLElement, tileCol: number, tileRow: number) => void,
    onShopClick?: () => void,
  ) {
    this.onMove = onMove;
    this.onUserClick = onUserClick;
    this.onShopClick = onShopClick;

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

  show(info: TileClickInfo): void {
    const isCurrent = info.isCurrentTile;

    if (isCurrent) {
      this.renderCurrentRoom(info);
    } else {
      this.renderRemoteRoom(info);
    }

    this.overlay.style.display = 'flex';
    this.overlay.classList.toggle('room-view-overlay-current', isCurrent);
    bringToFront(this.overlay);

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

    const tileBgUrl = `/room-bg-artwork/${info.zoneId}-${info.col}-${info.row}.png`;
    const zoneBgUrl = `/room-bg-artwork/${info.zoneId}.png`;
    // We layer two background images so the tile-specific one wins if present;
    // otherwise the zone default fills in. CSS `background` short-hand falls
    // through gracefully via the second URL.
    const bgStyle = `background-image: url('${tileBgUrl}'), url('${zoneBgUrl}'); background-size: cover; background-position: center;`;

    // Group players by who's in your party vs others
    const partyPlayers = info.playersHere.filter(p => info.partyMemberUsernames.includes(p.username));
    const otherPlayers = info.playersHere.filter(p => !info.partyMemberUsernames.includes(p.username));

    const renderParty = (players: { username: string; className?: string }[], label: string, partyClass: string): string => {
      if (players.length === 0) return '';
      const tiles = players.map(p => `
        <div class="room-party-member" data-username="${this.escapeHtml(p.username)}">
          <span class="room-party-member-icon">${RoomView.classIcon(p.className)}</span>
          <span class="room-party-member-name">${this.escapeHtml(p.username)}</span>
        </div>
      `).join('');
      return `
        <div class="room-party-group ${partyClass}">
          <div class="room-party-group-label">${label}</div>
          <div class="room-party-group-tiles">${tiles}</div>
        </div>
      `;
    };

    const partySection = renderParty(partyPlayers, 'Your party', 'room-party-self');
    const otherSection = otherPlayers.length > 0
      ? `<div class="room-party-other-label">Other parties here</div>${renderParty(otherPlayers, '', 'room-party-other')}`
      : '';

    const shopButton = this.hasShop
      ? `<button class="room-view-action room-view-action-shop">${renderAssetImg('shop', info.zoneId, { className: 'room-view-action-icon', label: 'Shop' })}<span>Shop</span></button>`
      : '';

    this.modal.innerHTML = `
      <div class="room-view-bg" style="${bgStyle}"></div>
      <div class="room-view-scrim"></div>
      <div class="room-view-content">
        <button class="room-view-close" aria-label="Close">×</button>
        <div class="room-view-header">
          <div class="room-view-zone">${this.escapeHtml(info.zoneName)}</div>
          <div class="room-view-name">${this.escapeHtml(info.roomName || 'Unnamed Room')}</div>
        </div>
        <div class="room-view-here-label">You are here</div>
        <div class="room-view-parties">
          ${partySection}
          ${otherSection}
        </div>
        <div class="room-view-actions">
          ${shopButton}
        </div>
      </div>
    `;

    this.modal.querySelector('.room-view-close')!.addEventListener('click', () => this.hide());

    this.modal.querySelector('.room-view-action-shop')?.addEventListener('click', () => {
      this.hide();
      this.onShopClick?.();
    });

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

    const playersHere = info.playersHere.length;
    const playersHereLine = playersHere > 0
      ? `<div class="room-view-meta">${playersHere} player${playersHere === 1 ? '' : 's'} here</div>`
      : '';

    const undiscoveredNote = !info.roomName || info.roomName === 'Unexplored Room'
      ? `<div class="room-view-meta room-view-meta-dim">Unexplored — travel here to learn more.</div>`
      : '';

    const shopHint = this.hasShop
      ? `<div class="room-view-meta">🪙 A shop awaits you here</div>`
      : '';

    this.modal.innerHTML = `
      <button class="room-view-close" aria-label="Close">×</button>
      <div class="room-view-zone">${this.escapeHtml(info.zoneName)}</div>
      <div class="room-view-name">${this.escapeHtml(info.roomName || 'Unexplored Room')}</div>
      ${playersHereLine}
      ${shopHint}
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
  }

  hide(): void {
    this.overlay.style.display = 'none';
    release(this.overlay);
  }
}
