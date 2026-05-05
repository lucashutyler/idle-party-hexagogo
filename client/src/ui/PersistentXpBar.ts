import type { GameClient } from '../network/GameClient';

/**
 * Thin XP strip that lives directly above the bottom nav, visible on every
 * screen. Level badge sits on the left; the fill bar takes the rest. No raw
 * numbers — those live on the Character screen.
 */
export class PersistentXpBar {
  private container: HTMLElement;
  private fill!: HTMLElement;
  private levelLabel!: HTMLElement;

  constructor(gameClient: GameClient) {
    this.container = document.getElementById('persistent-xp-bar')!;
    this.container.innerHTML = `
      <div class="xpbar-level">Lv 1</div>
      <div class="xpbar-track">
        <div class="xpbar-fill"></div>
      </div>
    `;
    this.fill = this.container.querySelector('.xpbar-fill')!;
    this.levelLabel = this.container.querySelector('.xpbar-level')!;

    gameClient.subscribe((state) => {
      const char = state.character;
      if (!char) {
        this.container.style.display = 'none';
        return;
      }
      this.container.style.display = '';
      this.levelLabel.textContent = `Lv ${char.level}`;
      const pct = char.xpForNextLevel > 0
        ? Math.max(0, Math.min(100, (char.xp / char.xpForNextLevel) * 100))
        : 0;
      this.fill.style.width = `${pct}%`;
    });
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }
}
