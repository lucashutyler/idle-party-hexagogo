import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { classIconHtml } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import { artworkUrl, renderTrackedImg } from './assets';
import { deferWhilePressed, setHtml } from './render';

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

export interface HudStatus {
  room: string;
  detail: string;
}

function roomCountText(count: number): string {
  return `${count} ${count === 1 ? 'room' : 'rooms'}`;
}

/** The HUD's two status lines. A walking destination is named only once it has been explored. */
export function hudStatus(
  state: ServerStateMessage,
  worldCache: Pick<WorldCache, 'getTileOn'>,
  connected: boolean,
): HudStatus {
  const { col, row, path } = state.party;
  const room = worldCache.getTileOn(state.currentMapId, col, row)?.name ?? state.zoneName;
  if (!connected) return { room, detail: 'Reconnecting…' };
  if (path.length > 0) {
    const last = path[path.length - 1];
    const destination = worldCache.getTileOn(state.currentMapId, last.col, last.row);
    const name = destination && state.unlocked.includes(destination.id) ? `${destination.name} · ` : '';
    return { room, detail: `→ ${name}${roomCountText(path.length)}` };
  }
  if (state.dungeon) {
    return { room, detail: `${state.dungeon.name} · Floor ${state.dungeon.floor}/${state.dungeon.totalFloors}` };
  }
  return { room, detail: state.zoneName };
}

const GEAR_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M6.9 1h2.2l.3 1.9 1.2.5 1.6-1.1 1.5 1.5-1.1 1.6.5 1.2 1.9.3v2.2l-1.9.3-.5 1.2 1.1 1.6-1.5 1.5-1.6-1.1-1.2.5-.3 1.9H6.9l-.3-1.9-1.2-.5-1.6 1.1-1.5-1.5 1.1-1.6-.5-1.2L1 9.1V6.9l1.9-.3.5-1.2-1.1-1.6 1.5-1.5 1.6 1.1 1.2-.5zM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"/></svg>';

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Top bar: avatar and level (Settings), status lines (Map), gold (Hero), notification bell slot. */
export class TopHud {
  private container: HTMLElement;
  private avatarEl: HTMLElement;
  private levelEl: HTMLElement;
  private roomEl: HTMLElement;
  private detailEl: HTMLElement;
  private nameEl: HTMLElement;
  private statusBtn: HTMLElement;
  private goldBtn: HTMLElement;
  private goldEl: HTMLElement;
  private forcedHidden = false;
  private hasCharacter = false;
  private connected = true;

  constructor(private gameClient: GameClient, private worldCache: WorldCache) {
    this.container = document.getElementById('top-hud')!;
    this.container.innerHTML = `
      <button type="button" class="top-hud-player" data-nav="settings" aria-label="Settings">
        <span class="top-hud-avatar"></span>
        <span class="top-hud-level">1</span>
        <span class="top-hud-gear">${GEAR_ICON}</span>
      </button>
      <button type="button" class="top-hud-status" data-nav="map">
        <span class="top-hud-status-lines">
          <span class="top-hud-room"></span>
          <span class="top-hud-detail"></span>
        </span>
        <span class="top-hud-name"></span>
      </button>
      <button type="button" class="top-hud-gold" data-nav="items">
        <span class="top-hud-gold-coin"></span>
        <span class="top-hud-gold-amount">0</span>
      </button>
      <div class="top-hud-bell-slot"></div>
    `;
    this.avatarEl = this.container.querySelector('.top-hud-avatar')!;
    this.levelEl = this.container.querySelector('.top-hud-level')!;
    this.roomEl = this.container.querySelector('.top-hud-room')!;
    this.detailEl = this.container.querySelector('.top-hud-detail')!;
    this.nameEl = this.container.querySelector('.top-hud-name')!;
    this.statusBtn = this.container.querySelector('.top-hud-status')!;
    this.goldBtn = this.container.querySelector('.top-hud-gold')!;
    this.goldEl = this.container.querySelector('.top-hud-gold-amount')!;

    gameClient.subscribe(() => this.paint(), { replay: true });
    gameClient.onConnection((connected) => {
      this.connected = connected;
      this.paint();
    });
  }

  setVisible(visible: boolean): void {
    this.forcedHidden = !visible;
    this.applyVisibility();
  }

  private paint(): void {
    const state = this.gameClient.lastState;
    const char = state?.character;
    this.hasCharacter = !!char;
    this.applyVisibility();
    if (!state || !char) return;

    const status = hudStatus(state, this.worldCache, this.connected);
    setText(this.roomEl, status.room);
    setText(this.detailEl, status.detail);
    this.statusBtn.setAttribute('aria-label', `Open map, ${status.room}`);
    this.container.toggleAttribute('data-offline', !this.connected);
    setText(this.nameEl, state.username);
    setText(this.levelEl, String(char.level));
    setText(this.goldEl, formatGoldChip(char.gold));
    this.goldBtn.setAttribute('aria-label', `${char.gold.toLocaleString()} gold`);
    deferWhilePressed(this.container, () => setHtml(
      this.avatarEl,
      renderTrackedImg(artworkUrl('class', char.className), { className: 'top-hud-avatar-img', alt: char.className })
        + `<span class="top-hud-avatar-icon">${classIconHtml(char.className)}</span>`,
    ));
  }

  private applyVisibility(): void {
    this.container.style.display = this.hasCharacter && !this.forcedHidden ? '' : 'none';
  }
}
