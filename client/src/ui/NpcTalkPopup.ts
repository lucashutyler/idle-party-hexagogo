import type { NpcDefinition } from '@idle-party-rpg/shared';

export class NpcTalkPopup {
  private overlay: HTMLElement;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'npc-talk-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    document.body.appendChild(this.overlay);
  }

  show(npc: NpcDefinition): void {
    const portrait = npc.artworkUrl
      ? `<img class="npc-talk-portrait-img" src="${this.escape(npc.artworkUrl)}" alt="">`
      : `<div class="npc-talk-portrait-emoji">${this.escape(npc.emoji)}</div>`;

    this.overlay.innerHTML = `
      <div class="npc-talk-modal">
        <div class="npc-talk-header">
          ${portrait}
          <div class="npc-talk-name">${this.escape(npc.name)}</div>
        </div>
        <div class="npc-talk-greeting">"${this.escape(npc.greeting)}"</div>
        <div class="npc-talk-actions">
          <button class="npc-talk-btn npc-talk-close">Close</button>
        </div>
      </div>
    `;
    this.overlay.querySelector('.npc-talk-close')?.addEventListener('click', () => this.hide());
    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
