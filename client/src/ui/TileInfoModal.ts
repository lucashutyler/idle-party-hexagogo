import type { TileClickInfo } from '../scenes/WorldMapScene';

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

  show(info: TileClickInfo): void {
    const playerList = info.playersHere.length > 0
      ? `<div class="tile-modal-players">
          <span class="tile-modal-players-label">Players in this room:</span>
          ${info.playersHere.map(p => `
            <div class="tile-modal-player-row">
              <span class="tile-modal-player">${this.escapeHtml(p)}</span>
              ${this.onChat ? `<button class="tile-modal-btn tile-modal-chat" data-username="${this.escapeHtml(p)}">Chat</button>` : ''}
              ${this.onInvite && info.isCurrentTile ? `<button class="tile-modal-btn tile-modal-invite" data-username="${this.escapeHtml(p)}">Invite</button>` : ''}
            </div>
          `).join('')}
        </div>`
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
