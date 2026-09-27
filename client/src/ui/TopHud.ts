import type { GameClient } from '../network/GameClient';
import { classIconHtml } from '@idle-party-rpg/shared';
import { artworkUrl } from './assets';

/** Gold chip text: full number below 10 000, otherwise `12.3k` / `1.2M`. */
export function formatGoldChip(gold: number): string {
  if (gold < 10_000) return gold.toLocaleString();
  if (gold < 1_000_000) return `${trimDecimal(gold / 1_000)}k`;
  if (gold < 1_000_000_000) return `${trimDecimal(gold / 1_000_000)}M`;
  return `${trimDecimal(gold / 1_000_000_000)}B`;
}

function trimDecimal(n: number): string {
  const floored = Math.floor(n * 10) / 10;
  return floored >= 100 ? String(Math.floor(floored)) : floored.toFixed(1).replace(/\.0$/, '');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Top-of-screen HUD: avatar + level, username, gold chip and the notification bell slot. */
export class TopHud {
  private container: HTMLElement;
  private avatarEl: HTMLElement;
  private levelEl: HTMLElement;
  private nameEl: HTMLElement;
  private goldEl: HTMLElement;
  private forcedHidden = false;
  private hasCharacter = false;
  private lastClassName: string | null = null;

  constructor(gameClient: GameClient) {
    this.container = document.getElementById('top-hud')!;
    this.container.innerHTML = `
      <div class="top-hud-player">
        <div class="top-hud-avatar"></div>
        <span class="top-hud-level">1</span>
      </div>
      <div class="top-hud-name"></div>
      <div class="top-hud-spacer"></div>
      <div class="top-hud-gold" aria-label="Gold">
        <span class="top-hud-gold-coin"></span>
        <span class="top-hud-gold-amount">0</span>
      </div>
      <div class="top-hud-bell-slot"></div>
    `;
    this.avatarEl = this.container.querySelector('.top-hud-avatar')!;
    this.levelEl = this.container.querySelector('.top-hud-level')!;
    this.nameEl = this.container.querySelector('.top-hud-name')!;
    this.goldEl = this.container.querySelector('.top-hud-gold-amount')!;

    gameClient.subscribe((state) => {
      const char = state.character;
      this.hasCharacter = !!char;
      this.applyVisibility();
      if (!char) return;
      this.nameEl.textContent = state.username;
      this.levelEl.textContent = String(char.level);
      this.goldEl.textContent = formatGoldChip(char.gold);
      this.goldEl.title = `${char.gold.toLocaleString()} gold`;
      if (char.className !== this.lastClassName) {
        this.lastClassName = char.className;
        this.renderAvatar(char.className);
      }
    }, { replay: true });
  }

  setVisible(visible: boolean): void {
    this.forcedHidden = !visible;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.container.style.display = this.hasCharacter && !this.forcedHidden ? '' : 'none';
  }

  private renderAvatar(className: string): void {
    const src = artworkUrl('class', className);
    this.avatarEl.innerHTML = `<img class="top-hud-avatar-img" src="${escapeHtml(src)}" alt="${escapeHtml(className)}" />`;
    const img = this.avatarEl.querySelector('img')!;
    img.addEventListener('error', () => {
      this.avatarEl.innerHTML = `<span class="top-hud-avatar-icon">${classIconHtml(className)}</span>`;
    }, { once: true });
  }
}
