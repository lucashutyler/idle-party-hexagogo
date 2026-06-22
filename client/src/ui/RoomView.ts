import type { TileClickInfo } from './ThreeWorldMap';
import type { NpcDefinition, DungeonDefinition } from '@idle-party-rpg/shared';
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
  private onNpcTalk?: (npc: NpcDefinition) => void;
  private onEnterDungeon?: (dungeon: DungeonDefinition) => void;
  private onEnterTransition?: () => void;
  /** Whether the player's current tile has a shop. Set externally before showing. */
  hasShop = false;
  /** NPC on the player's current tile (if any). Set externally before showing. */
  npc: NpcDefinition | null = null;
  /** Dungeon linked to the player's current tile (if any). Set externally before showing. */
  dungeon: DungeonDefinition | null = null;
  /** Map transition on the player's current tile (if any). Set externally before showing. */
  transition: { name: string } | null = null;
  /** Last shown remote-room key — used to drive the arrival transition. */
  private lastRemoteKey: string | null = null;

  constructor(
    parent: HTMLElement,
    onMove: (col: number, row: number) => void,
    onUserClick?: (username: string, anchor: HTMLElement, tileCol: number, tileRow: number) => void,
    onShopClick?: () => void,
    onNpcTalk?: (npc: NpcDefinition) => void,
    onEnterDungeon?: (dungeon: DungeonDefinition) => void,
    onEnterTransition?: () => void,
  ) {
    this.onMove = onMove;
    this.onUserClick = onUserClick;
    this.onShopClick = onShopClick;
    this.onNpcTalk = onNpcTalk;
    this.onEnterDungeon = onEnterDungeon;
    this.onEnterTransition = onEnterTransition;

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

    const grouped = this.groupPlayersByParty(info.playersHere, info.partyMemberUsernames);

    const partySection = grouped.mine.length > 0
      ? this.renderPartyBox(grouped.mine, 'Your party', 'room-party-self', grouped.mineDungeonName)
      : '';
    const otherBoxes = grouped.others.map(g => this.renderPartyBox(g.members, null, 'room-party-other', g.dungeonName)).join('');
    const otherSection = otherBoxes
      ? `<div class="room-party-other-label">Other parties here</div>${otherBoxes}`
      : '';

    const shopButton = this.hasShop
      ? `<button class="room-view-action room-view-action-shop">${renderAssetImg('shop', info.zoneId, { className: 'room-view-action-icon', label: 'Shop' })}<span>Shop</span></button>`
      : '';

    const talkButton = this.npc
      ? `<button class="room-view-action room-view-action-talk"><span class="room-view-action-icon room-view-action-icon-emoji">${this.escapeHtml(this.npc.emoji)}</span><span>Talk to ${this.escapeHtml(this.npc.name)}</span></button>`
      : '';

    const dungeonButton = this.dungeon
      ? `<button class="room-view-action room-view-action-dungeon"><span class="room-view-action-icon room-view-action-icon-emoji">🗝️</span><span>Enter ${this.escapeHtml(this.dungeon.name)}</span></button>`
      : '';

    const transitionButton = this.transition
      ? `<button class="room-view-action room-view-action-transition"><span class="room-view-action-icon room-view-action-icon-emoji">🕳️</span><span>Enter ${this.escapeHtml(this.transition.name)}</span></button>`
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
          ${transitionButton}
          ${dungeonButton}
          ${talkButton}
          ${shopButton}
        </div>
      </div>
    `;

    this.modal.querySelector('.room-view-close')!.addEventListener('click', () => this.hide());

    this.modal.querySelector('.room-view-action-shop')?.addEventListener('click', () => {
      this.hide();
      this.onShopClick?.();
    });

    this.modal.querySelector('.room-view-action-talk')?.addEventListener('click', () => {
      const npc = this.npc;
      this.hide();
      if (npc) this.onNpcTalk?.(npc);
    });

    this.modal.querySelector('.room-view-action-dungeon')?.addEventListener('click', () => {
      const dungeon = this.dungeon;
      this.hide();
      if (dungeon) this.onEnterDungeon?.(dungeon);
    });

    this.modal.querySelector('.room-view-action-transition')?.addEventListener('click', () => {
      this.hide();
      this.onEnterTransition?.();
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

    const shopHint = this.hasShop
      ? `<div class="room-view-meta">🪙 A shop awaits you here</div>`
      : '';

    this.modal.innerHTML = `
      <button class="room-view-close" aria-label="Close">×</button>
      <div class="room-view-zone">${this.escapeHtml(info.zoneName)}</div>
      <div class="room-view-name">${this.escapeHtml(info.roomName || 'Unexplored Room')}</div>
      ${partiesBlock}
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
      ? `<div class="room-party-dungeon-tag">🗝️ Delving ${this.escapeHtml(dungeonName)}</div>`
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
    release(this.overlay);
  }
}
