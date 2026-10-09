import { OFFLINE_NOTICE, type GameClient } from '../network/GameClient';
import type { DungeonDefinition, ServerStateMessage } from '@idle-party-rpg/shared';
import { dungeonItemName, previewDungeonEntry } from './DungeonEntryCheck';
import { escapeHtml } from './ItemIcon';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { deferWhilePressed, setHtml } from './render';

const ANSWER_TIMEOUT_MS = 5000;
const NO_ANSWER_MESSAGE = 'No answer from the server. Please try again.';
const HENCHMEN_WAIT_MESSAGE = 'Your henchmen will wait at the entrance until you return.';
const BLOCKED_LINE_ID = 'dungeon-entry-blocked';

interface Entrance {
  dungeon: DungeonDefinition;
  col: number;
  row: number;
}

/**
 * Confirmation popup for entering a dungeon. Enter is disabled with a visible reason when the party
 * can't enter, and a server refusal shows inline. See docs/architecture/client.md.
 */
export class DungeonEntryPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private entrance: Entrance | null = null;
  private pending = false;
  private refusal: string | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeState: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.overlay = document.createElement('div');
    this.overlay.className = 'dungeon-entry-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    document.body.appendChild(this.overlay);
    wireFocusOnInteract(this.overlay);
  }

  get isOpen(): boolean {
    return this.entrance !== null;
  }

  show(dungeon: DungeonDefinition, col: number, row: number): void {
    this.hide();
    this.entrance = { dungeon, col, row };
    this.overlay.innerHTML = this.renderShell(dungeon);
    this.overlay.querySelector('.dungeon-entry-cancel')?.addEventListener('click', () => this.hide());
    this.overlay.querySelector('.dungeon-entry-enter')?.addEventListener('click', () => this.enter());
    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);

    this.unsubscribeState = this.gameClient.subscribe(() => this.repaintLater());
    this.unsubscribeError = this.gameClient.onServerError((message, code) => {
      if (code !== 'dungeon_entry_refused' || !this.entrance) return;
      this.settle(message);
      this.repaintLater();
    });
    this.paint();
  }

  hide(): void {
    this.entrance = null;
    this.settle(null);
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    release(this.overlay);
  }

  private enter(): void {
    const entrance = this.entrance;
    const button = this.enterButton();
    if (!entrance || this.pending || !button || button.disabled) return;
    if (!this.gameClient.sendEnterDungeon(entrance.col, entrance.row, entrance.dungeon.id)) {
      this.refusal = OFFLINE_NOTICE;
      this.paint();
      return;
    }
    this.pending = true;
    this.refusal = null;
    this.answerTimer = setTimeout(() => {
      this.settle(NO_ANSWER_MESSAGE);
      this.repaintLater();
    }, ANSWER_TIMEOUT_MS);
    this.paint();
  }

  /** Ends any pending entry; `refusal` becomes the line shown until the next attempt. */
  private settle(refusal: string | null): void {
    this.pending = false;
    this.refusal = refusal;
    if (this.answerTimer !== null) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }
  }

  private repaintLater(): void {
    deferWhilePressed(this.overlay, () => this.paint());
  }

  private paint(): void {
    const entrance = this.entrance;
    if (!entrance) return;
    const state = this.gameClient.lastState;
    if (state && (state.dungeon || state.party.col !== entrance.col || state.party.row !== entrance.row)) {
      this.hide();
      return;
    }

    const blocked = state && !this.pending ? previewDungeonEntry(entrance.dungeon, state) : null;
    if (blocked) this.refusal = null;
    const reason = blocked ?? (this.pending ? null : this.refusal);

    const reqs = this.overlay.querySelector('.dungeon-entry-reqs-slot');
    if (reqs) setHtml(reqs, this.renderRequirements(entrance.dungeon, state));
    const status = this.overlay.querySelector('.dungeon-entry-status');
    if (status) setHtml(status, this.renderStatus(state, reason));

    const button = this.enterButton();
    if (!button) return;
    button.disabled = this.pending || blocked !== null;
    const label = this.pending ? 'Entering…' : 'Enter';
    if (button.textContent !== label) button.textContent = label;
    button.setAttribute('aria-busy', String(this.pending));
    if (reason) button.setAttribute('aria-describedby', BLOCKED_LINE_ID);
    else button.removeAttribute('aria-describedby');
  }

  private enterButton(): HTMLButtonElement | null {
    return this.overlay.querySelector<HTMLButtonElement>('.dungeon-entry-enter');
  }

  private renderShell(dungeon: DungeonDefinition): string {
    const floors = dungeon.floors.length;
    const description = dungeon.description?.trim();
    const descHtml = description
      ? `<div class="dungeon-entry-desc">"${escapeHtml(description)}"</div>`
      : '';
    return `
      <div class="dungeon-entry-modal" role="dialog" aria-modal="true" aria-labelledby="dungeon-entry-title">
        <div class="dungeon-entry-header">
          <span class="dungeon-entry-icon">🗝️</span>
          <div class="dungeon-entry-title" id="dungeon-entry-title">${escapeHtml(dungeon.name)}</div>
        </div>
        ${descHtml}
        <div class="dungeon-entry-meta">${floors} floor${floors === 1 ? '' : 's'} · clear the final floor to complete the run</div>
        <div class="dungeon-entry-reqs-slot"></div>
        <div class="dungeon-entry-warning">If your party is defeated, you'll be sent back to this entrance.</div>
        <div class="dungeon-entry-status" aria-live="polite"></div>
        <div class="dungeon-entry-actions">
          <button class="dungeon-entry-btn dungeon-entry-enter" type="button">Enter</button>
          <button class="dungeon-entry-btn dungeon-entry-cancel" type="button">Cancel</button>
        </div>
      </div>
    `;
  }

  private renderStatus(state: ServerStateMessage | null, reason: string | null): string {
    const lines: string[] = [];
    if ((state?.social?.party?.henchmen?.length ?? 0) > 0) {
      lines.push(`<div class="dungeon-entry-info">${HENCHMEN_WAIT_MESSAGE}</div>`);
    }
    if (reason) {
      lines.push(`<div class="dungeon-entry-blocked" id="${BLOCKED_LINE_ID}">⚠ ${escapeHtml(reason)}</div>`);
    }
    return lines.join('');
  }

  private renderRequirements(dungeon: DungeonDefinition, state: ServerStateMessage | null): string {
    const req = dungeon.entryRequirements;
    if (!req) return '';
    const lines: string[] = [];

    if (req.minLevel !== undefined && req.maxLevel !== undefined) {
      lines.push(`Level ${req.minLevel}–${req.maxLevel}`);
    } else if (req.minLevel !== undefined) {
      lines.push(`Level ${req.minLevel}+`);
    } else if (req.maxLevel !== undefined) {
      lines.push(`Level ${req.maxLevel} or below`);
    }

    if (req.minPartySize !== undefined && req.maxPartySize !== undefined) {
      lines.push(`Party of ${req.minPartySize}–${req.maxPartySize}`);
    } else if (req.minPartySize !== undefined) {
      lines.push(`At least ${req.minPartySize} party member${req.minPartySize === 1 ? '' : 's'}`);
    } else if (req.maxPartySize !== undefined) {
      lines.push(`At most ${req.maxPartySize} party member${req.maxPartySize === 1 ? '' : 's'}`);
    }

    if (req.requiredClasses && req.requiredClasses.length > 0) {
      lines.push(`Classes: ${req.requiredClasses.join(', ')}`);
    }

    const itemName = dungeonItemName(dungeon, state);
    if (itemName) {
      lines.push(req.consumeRequiredItem ? `Consumes ${escapeHtml(itemName)} (per member)` : `Requires ${escapeHtml(itemName)} (per member)`);
    }

    if (lines.length === 0) return '';
    return `
      <div class="dungeon-entry-reqs">
        <div class="dungeon-entry-reqs-title">Requirements</div>
        ${lines.map(l => `<div class="dungeon-entry-req">• ${l}</div>`).join('')}
      </div>
    `;
  }
}
