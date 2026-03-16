import type { TileClickInfo } from '../scenes/WorldMapScene';
import { CLASS_ICONS, UNKNOWN_CLASS_ICON } from '@idle-party-rpg/shared';

export class TileInfoModal {
  private overlay: HTMLElement;
  private modal: HTMLElement;
  private onMove: (col: number, row: number) => void;
  private onInvite?: (username: string) => void;
  private onChat?: (username: string) => void;

  constructor(
    parent: HTMLElement,
    onMove: (col: number, row: number) => void,
    onInvite?: (username: string) => void,
    onChat?: (username: string) => void,
  ) {
    this.onMove = onMove;
    this.onInvite = onInvite;
    this.onChat = onChat;

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

    const renderPlayerRows = (players: { username: string; className?: string }[], showInvite: boolean) => players.map(p => `
      <div class="tile-modal-player-row">
        <span class="tile-modal-player">${TileInfoModal.classIcon(p.className)} ${this.escapeHtml(p.username)}</span>
        ${this.onChat ? `<button class="tile-modal-btn tile-modal-chat" data-username="${this.escapeHtml(p.username)}">Chat</button>` : ''}
        ${this.onInvite && showInvite && info.isCurrentTile ? `<button class="tile-modal-btn tile-modal-invite" data-username="${this.escapeHtml(p.username)}">Invite</button>` : ''}
      </div>
    `).join('');

    const otherSection = otherPlayers.length > 0
      ? `<span class="tile-modal-players-label">Other players:</span>${renderPlayerRows(otherPlayers, true)}`
      : '';

    const partySection = partyPlayers.length > 0
      ? `<span class="tile-modal-players-label">Party members:</span>${renderPlayerRows(partyPlayers, false)}`
      : '';

    const divider = otherPlayers.length > 0 && partyPlayers.length > 0 ? '<hr class="tile-modal-divider">' : '';

    const playerList = info.playersHere.length > 0
      ? `<div class="tile-modal-players">${otherSection}${divider}${partySection}</div>`
      : '';

    // Room name subheader — discovered = white with name, unexplored = gray placeholder
    const roomNameHtml = info.roomName
      ? `<div class="tile-modal-room-name">${this.escapeHtml(info.roomName)}</div>`
      : `<div class="tile-modal-room-name tile-modal-room-unexplored">Unexplored room</div>`;

    this.modal.innerHTML = `
      <div class="tile-modal-header">
        <span class="tile-modal-title">${this.escapeHtml(info.zoneName)}</span>
      </div>
      ${roomNameHtml}
      ${playerList}
      <div class="tile-modal-actions">
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

    // Wire chat buttons
    for (const btn of this.modal.querySelectorAll('.tile-modal-chat')) {
      btn.addEventListener('click', () => {
        const username = btn.getAttribute('data-username');
        if (username && this.onChat) {
          this.onChat(username);
          this.hide();
        }
      });
    }

    // Wire invite buttons
    for (const btn of this.modal.querySelectorAll('.tile-modal-invite')) {
      btn.addEventListener('click', () => {
        const username = btn.getAttribute('data-username');
        if (username && this.onInvite) {
          this.onInvite(username);
          btn.textContent = 'Invited';
          (btn as HTMLButtonElement).disabled = true;
        }
      });
    }

    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }
}
