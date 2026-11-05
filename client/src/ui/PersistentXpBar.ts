import type { GameClient } from '../network/GameClient';

/** XP hairline under the HUD, on every screen. The HUD shows the level; raw numbers live on the Hero screen. */
export class PersistentXpBar {
  private container: HTMLElement;
  private fill: HTMLElement;
  private forcedHidden = false;
  private hasCharacter = false;

  constructor(gameClient: GameClient) {
    this.container = document.getElementById('persistent-xp-bar')!;
    this.container.setAttribute('role', 'progressbar');
    this.container.setAttribute('aria-label', 'Experience');
    this.container.setAttribute('aria-valuemin', '0');
    this.container.setAttribute('aria-valuemax', '100');
    this.container.innerHTML = '<div class="xpbar-fill"></div>';
    this.fill = this.container.querySelector('.xpbar-fill')!;

    gameClient.subscribe((state) => {
      const char = state.character;
      this.hasCharacter = !!char;
      this.applyVisibility();
      if (!char) return;
      const fraction = char.xpForNextLevel > 0 ? Math.max(0, Math.min(1, char.xp / char.xpForNextLevel)) : 0;
      this.fill.style.transform = `scaleX(${fraction})`;
      this.container.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    }, { replay: true });
  }

  setVisible(visible: boolean): void {
    this.forcedHidden = !visible;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.container.style.display = this.hasCharacter && !this.forcedHidden ? '' : 'none';
  }
}
