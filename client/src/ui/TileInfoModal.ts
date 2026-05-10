import type { TileClickInfo } from '../scenes/WorldMapScene';
import type { NpcDefinition } from '@idle-party-rpg/shared';
import { CLASS_ICONS, UNKNOWN_CLASS_ICON } from '@idle-party-rpg/shared';

export class TileInfoModal {
  private overlay: HTMLElement;
  private modal: HTMLElement;
  private onMove: (col: number, row: number) => void;
  private onUserClick?: (username: string, anchor: HTMLElement, tileCol: number, tileRow: number) => void;
  private onShopClick?: () => void;
  private onNpcTalk?: (npc: NpcDefinition) => void;
  /** Whether the player's current tile has a shop. Set externally before showing. */
  hasShop = false;
  /** NPC on the player's current tile (if any). Set externally before showing. */
  npc: NpcDefinition | null = null;

  constructor(
    parent: HTMLElement,
    onMove: (col: number, row: number) => void,
    onUserClick?: (username: string, anchor: HTMLElement, tileCol: number, tileRow: number) => void,
    onShopClick?: () => void,
    onNpcTalk?: (npc: NpcDefinition) => void,
  ) {
    this.onMove = onMove;
    this.onUserClick = onUserClick;
    this.onShopClick = onShopClick;
    this.onNpcTalk = onNpcTalk;

    this.overlay = document.createElement('div');
    this.overlay.className = 'tile-modal-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });

    this.modal = document.createElement('div');
    this.modal.className = 'tile-modal';
    this.overlay.appendChild(this.modal);
    parent.appendChild(this.overlay);
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private static classIcon(className?: string): string {
    if (!className) return UNKNOWN_CLASS_ICON;
    return CLASS_ICONS[className] ?? UNKNOWN_CLASS_ICON;
  }

  show(info: TileClickInfo): void {
    const otherPlayers = info.playersHere.filter(p => !info.partyMemberUsernames.includes(p.username));
    const partyPlayers = info.playersHere.filter(p => info.partyMemberUsernames.includes(p.username));

    const renderPlayerRows = (players: { username: string; className?: string }[]) => players.map(p => `
      <div class="tile-modal-player-row">
        <span class="tile-modal-player tile-modal-player-clickable" data-username="${this.escapeHtml(p.username)}">${TileInfoModal.classIcon(p.className)} ${this.escapeHtml(p.username)}</span>
      </div>
    `).join('');

    const otherSection = otherPlayers.length > 0
      ? `<span class="tile-modal-players-label">Other players:</span>${renderPlayerRows(otherPlayers)}`
      : '';

    const partySection = partyPlayers.length > 0
      ? `<span class="tile-modal-players-label">Party members:</span>${renderPlayerRows(partyPlayers)}`
      : '';

    const divider = otherPlayers.length > 0 && partyPlayers.length > 0 ? '<hr class="tile-modal-divider">' : '';

    const playerList = info.playersHere.length > 0
      ? `<div class="tile-modal-players">${otherSection}${divider}${partySection}</div>`
      : '';

    // Room name subheader — discovered = white with name, unexplored = gray placeholder
    const roomNameHtml = info.roomName
      ? `<div class="tile-modal-room-name">${this.escapeHtml(info.roomName)}</div>`
      : `<div class="tile-modal-room-name tile-modal-room-unexplored">Unexplored room</div>`;

    const npcHtml = this.npc
      ? `<div class="tile-modal-npc">
           <span class="tile-modal-npc-emoji">${this.escapeHtml(this.npc.emoji)}</span>
           <span class="tile-modal-npc-name">${this.escapeHtml(this.npc.name)}</span>
         </div>`
      : '';

    this.modal.innerHTML = `
      <div class="tile-modal-header">
        <span class="tile-modal-title">${this.escapeHtml(info.zoneName)}</span>
      </div>
      ${roomNameHtml}
      ${npcHtml}
      ${playerList}
      <div class="tile-modal-actions">
        ${this.npc ? `<button class="tile-modal-btn tile-modal-npc-talk" style="background:#7ab8ff;color:#000;">Talk to ${this.escapeHtml(this.npc.name)}</button>` : ''}
        ${this.hasShop ? '<button class="tile-modal-btn tile-modal-shop" style="background:#e9bc18;color:#000;">Shop</button>' : ''}
        <button class="tile-modal-btn tile-modal-move">Go to room</button>
        <button class="tile-modal-btn tile-modal-close">Close</button>
      </div>
    `;

    this.modal.querySelector('.tile-modal-move')!.addEventListener('click', () => {
      this.onMove(info.col, info.row);
      this.hide();
    });

    this.modal.querySelector('.tile-modal-close')!.addEventListener('click', () => {
      this.hide();
    });

    this.modal.querySelector('.tile-modal-shop')?.addEventListener('click', () => {
      this.hide();
      this.onShopClick?.();
    });

    this.modal.querySelector('.tile-modal-npc-talk')?.addEventListener('click', () => {
      const npc = this.npc;
      this.hide();
      if (npc) this.onNpcTalk?.(npc);
    });

    // Wire clickable usernames to open popup
    for (const el of this.modal.querySelectorAll('.tile-modal-player-clickable')) {
      el.addEventListener('click', () => {
        const username = el.getAttribute('data-username');
        if (username && this.onUserClick) {
          this.onUserClick(username, el as HTMLElement, info.col, info.row);
        }
      });
    }

    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }
}
