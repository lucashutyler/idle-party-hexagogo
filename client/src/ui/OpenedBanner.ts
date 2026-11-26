import type { CombatLogEntry } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { bringToFront, release } from './ModalStack';
import { deferWhilePressed } from './render';

export const OPENED_BANNER_MS = 10_000;

/** The newest `opened` journal entry after `lastSeenId`. */
export function newestOpening(log: readonly CombatLogEntry[], lastSeenId: number): CombatLogEntry | undefined {
  for (let i = log.length - 1; i >= 0 && log[i].id > lastSeenId; i--) {
    if (log[i].type === 'opened') return log[i];
  }
  return undefined;
}

/** A gold "Now open" banner for each new `opened` journal line. See docs/architecture/client.md → Now open banner. */
export class OpenedBanner {
  /** Null until the first state: whatever that one holds is already known. */
  private lastSeenId: number | null = null;
  private banner: HTMLElement | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe: () => void;

  constructor(gameClient: GameClient, private onOpen: (roomId: string | undefined) => void) {
    this.unsubscribe = gameClient.subscribe(state => this.update(state.combatLog ?? []), { replay: true });
  }

  destroy(): void {
    this.unsubscribe();
    this.remove();
  }

  private update(log: readonly CombatLogEntry[]): void {
    const newestId = log.length > 0 ? log[log.length - 1].id : 0;
    const seen = this.lastSeenId;
    this.lastSeenId = newestId;
    const journalReset = seen !== null && newestId < seen;
    if (seen === null || journalReset) return;
    const entry = newestOpening(log, seen);
    if (!entry) return;
    if (this.banner) deferWhilePressed(this.banner, () => this.show(entry));
    else this.show(entry);
  }

  private show(entry: CombatLogEntry): void {
    this.remove();
    const banner = document.createElement('button');
    banner.type = 'button';
    banner.className = 'opened-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = `🔓 ${entry.text}`;
    banner.addEventListener('click', () => {
      this.remove();
      this.onOpen(entry.roomId);
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
