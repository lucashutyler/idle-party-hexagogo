import type { CombatLogEntry, ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import { bringToFront, release } from './ModalStack';
import { deferWhilePressed } from './render';

export const OPENED_BANNER_MS = 10_000;

export interface OpenedBannerActions {
  /** Opens the map on the room, whichever map holds it. */
  showRoom: (roomId: string) => void;
  showMap: () => void;
}

/** The `opened` journal entries after `lastSeenId`, oldest first. */
export function newOpenings(log: readonly CombatLogEntry[], lastSeenId: number): CombatLogEntry[] {
  const found: CombatLogEntry[] = [];
  for (let i = log.length - 1; i >= 0 && log[i].id > lastSeenId; i--) {
    if (log[i].type === 'opened') found.unshift(log[i]);
  }
  return found;
}

/** A gold "Now open" banner for new `opened` journal lines. See docs/architecture/client.md → Now open banner. */
export class OpenedBanner {
  /** Null until the first state: whatever that one holds is already known. */
  private lastSeenId: number | null = null;
  private banner: HTMLElement | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe: () => void;

  constructor(
    gameClient: GameClient,
    private worldCache: Pick<WorldCache, 'getTileByGuid'>,
    private actions: OpenedBannerActions,
  ) {
    this.unsubscribe = gameClient.subscribe(state => this.update(state), { replay: true });
  }

  destroy(): void {
    this.unsubscribe();
    this.remove();
  }

  private update(state: ServerStateMessage): void {
    const log = state.combatLog ?? [];
    const newestId = log.length > 0 ? log[log.length - 1].id : 0;
    const seen = this.lastSeenId;
    this.lastSeenId = newestId;
    const journalReset = seen !== null && newestId < seen;
    if (seen === null || journalReset) return;
    if (state.awayRecap?.moments.some(m => m.kind === 'opened')) return;
    const openings = newOpenings(log, seen);
    const newest = openings[openings.length - 1];
    if (!newest) return;
    const text = openings.length > 1 ? `${newest.text} (+${openings.length - 1} more)` : newest.text;
    if (this.banner) deferWhilePressed(this.banner, () => this.show(text, newest.roomId));
    else this.show(text, newest.roomId);
  }

  private show(text: string, roomId: string | undefined): void {
    this.remove();
    const banner = document.createElement('button');
    banner.type = 'button';
    banner.className = 'opened-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = `🔓 ${text}`;
    banner.addEventListener('click', () => {
      this.remove();
      if (roomId && this.worldCache.getTileByGuid(roomId)) this.actions.showRoom(roomId);
      else this.actions.showMap();
    });
    document.body.appendChild(banner);
    bringToFront(banner);
    this.banner = banner;
    this.timer = setTimeout(() => this.remove(), OPENED_BANNER_MS);
  }

  private remove(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.banner) return;
    release(this.banner);
    this.banner.remove();
    this.banner = null;
  }
}
