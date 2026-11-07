import { OFFLINE_NOTICE, type GameClient } from '../network/GameClient';
import type { DungeonDefinition, ForecastResult, ServerForecastMessage, ServerStateMessage } from '@idle-party-rpg/shared';
import { dungeonItemName, previewDungeonEntry } from './DungeonEntryCheck';
import { renderForecastRing } from './ForecastChip';
import { escapeHtml } from './ItemIcon';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { deferWhilePressed, setHtml } from './render';
import {
  forecastBand,
  forecastHeadline,
  forecastSampleLine,
  forecastVerdict,
  formatPct,
  forecastRangeLine,
  isForecastStale,
} from '../combat/ForecastFormat';

const ANSWER_TIMEOUT_MS = 5000;
const NO_ANSWER_MESSAGE = 'No answer from the server. Please try again.';
const HENCHMEN_WAIT_MESSAGE = 'Your henchmen will wait at the entrance until you return.';
const BLOCKED_LINE_ID = 'dungeon-entry-blocked';
const DEFEAT_WARNING = 'If your party is defeated on any floor, the run ends and you\'ll be sent back to this entrance.';
const LEADERS_ONLY_MESSAGE = 'Only the party owner or a leader can enter.';

export interface DungeonEntryOptions {
  /** False for plain members: the popup is read-only and says who can enter. */
  canEnter?: boolean;
}

interface Entrance {
  dungeon: DungeonDefinition;
  col: number;
  row: number;
  canEnter: boolean;
}

type ForecastView = { message: ServerForecastMessage; stale: boolean } | 'loading' | null;

/**
 * Confirmation popup for entering a dungeon: flavor, requirements, and a run forecast with a floor
 * strip. Enter is disabled with a visible reason when the party can't enter, and a server refusal
 * shows inline. See docs/architecture/client.md.
 */
export class DungeonEntryPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private entrance: Entrance | null = null;
  private pending = false;
  private refusal: string | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  private forecastView: ForecastView = 'loading';
  private unsubscribeState: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private unsubscribeForecast: (() => void) | null = null;
  private keyHandler = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    this.hide();
  };

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

  show(dungeon: DungeonDefinition, col: number, row: number, opts: DungeonEntryOptions = {}): void {
    this.hide();
    const canEnter = opts.canEnter !== false;
    this.entrance = { dungeon, col, row, canEnter };
    this.overlay.innerHTML = this.renderShell(dungeon, canEnter);
    this.overlay.querySelector('.dungeon-entry-cancel')?.addEventListener('click', () => this.hide());
    this.overlay.querySelector('.dungeon-entry-enter')?.addEventListener('click', () => this.enter());
    this.overlay.style.display = 'flex';
    bringToFront(this.overlay, () => this.hide());
    document.addEventListener('keydown', this.keyHandler);

    this.unsubscribeState = this.gameClient.subscribe(() => this.repaintLater());
    this.unsubscribeError = this.gameClient.onServerError((message, code) => {
      if (code !== 'dungeon_entry_refused' || !this.entrance) return;
      this.settle(message);
      this.repaintLater();
    });
    this.unsubscribeForecast = this.gameClient.onForecast((msg) => {
      if (msg.target.kind !== 'dungeon' || msg.target.dungeonId !== this.entrance?.dungeon.id) return;
      if (msg.status === 'pending') return;
      this.forecastView = this.toView(msg);
      this.repaintLater();
    });
    const target = { kind: 'dungeon' as const, dungeonId: dungeon.id };
    const cached = this.gameClient.requestForecast(target);
    const view = cached ?? this.gameClient.peekForecast(target);
    this.forecastView = view ? this.toView(view, !cached) : 'loading';
    this.paint();
  }

  hide(): void {
    this.entrance = null;
    this.settle(null);
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.unsubscribeForecast?.();
    this.unsubscribeForecast = null;
    document.removeEventListener('keydown', this.keyHandler);
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

  // deferWhilePressed keeps only the latest paint per root, so every repaint must cover all regions.
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

    this.renderForecast(entrance.dungeon, this.forecastView);
    const reqs = this.overlay.querySelector('.dungeon-entry-reqs-slot');
    if (reqs) setHtml(reqs, this.renderRequirements(entrance.dungeon, state));
    const status = this.overlay.querySelector('.dungeon-entry-status');
    if (status) setHtml(status, this.renderStatus(state, reason));

    const button = this.enterButton();
    if (!button) return;
    button.disabled = !entrance.canEnter || this.pending || blocked !== null;
    const label = this.pending ? 'Entering…' : 'Enter';
    if (button.textContent !== label) button.textContent = label;
    button.setAttribute('aria-busy', String(this.pending));
    if (reason) button.setAttribute('aria-describedby', BLOCKED_LINE_ID);
    else button.removeAttribute('aria-describedby');
  }

  private enterButton(): HTMLButtonElement | null {
    return this.overlay.querySelector<HTMLButtonElement>('.dungeon-entry-enter');
  }

  private renderShell(dungeon: DungeonDefinition, canEnter: boolean): string {
    const floors = dungeon.floors.length;
    const description = dungeon.description?.trim();
    const descHtml = description
      ? `<div class="dungeon-entry-desc">"${escapeHtml(description)}"</div>`
      : '';
    const leaderNote = canEnter
      ? ''
      : `<div class="dungeon-entry-note">${LEADERS_ONLY_MESSAGE}</div>`;
    return `
      <div class="dungeon-entry-modal" role="dialog" aria-modal="true" aria-labelledby="dungeon-entry-title">
        <div class="dungeon-entry-header">
          <span class="dungeon-entry-icon">🗝️</span>
          <div class="dungeon-entry-title" id="dungeon-entry-title">${escapeHtml(dungeon.name)}</div>
        </div>
        <div class="dungeon-entry-body">
          ${descHtml}
          <div class="dungeon-entry-meta">${floors} floor${floors === 1 ? '' : 's'} · clear the final floor to complete the run</div>
          <div class="dungeon-entry-forecast" data-state="loading" aria-live="polite"></div>
          <div class="dungeon-entry-reqs-slot"></div>
          <div class="dungeon-entry-warning">${DEFEAT_WARNING}</div>
          ${leaderNote}
        </div>
        <div class="dungeon-entry-foot">
          <div class="dungeon-entry-status" aria-live="polite"></div>
          <div class="dungeon-entry-actions">
            <button class="dungeon-entry-btn dungeon-entry-enter" type="button"${canEnter ? '' : ` disabled title="${LEADERS_ONLY_MESSAGE}"`}>Enter</button>
            <button class="dungeon-entry-btn dungeon-entry-cancel" type="button">Cancel</button>
          </div>
        </div>
      </div>
    `;
  }

  private toView(message: ServerForecastMessage, forceStale = false): ForecastView {
    if (message.status === 'pending') return 'loading';
    if (message.status === 'unavailable') {
      const previous = this.gameClient.peekForecast(message.target);
      return previous ? this.toView(previous, true) : null;
    }
    if (message.status !== 'ok' || !message.result) return null;
    const forecastKey = this.gameClient.lastState?.social?.party?.forecastKey;
    return { message, stale: forceStale || isForecastStale(message.result, forecastKey) };
  }

  private renderForecast(dungeon: DungeonDefinition, view: ForecastView): void {
    const slot = this.overlay.querySelector<HTMLElement>('.dungeon-entry-forecast');
    if (!slot) return;
    if (view === null) {
      slot.dataset.state = 'none';
      setHtml(slot, '');
      return;
    }
    if (view === 'loading') {
      slot.dataset.state = 'loading';
      setHtml(slot, `<div class="dungeon-entry-forecast-head">${renderForecastRing('loading', { kind: 'dungeon', compact: true })}`
        + '<div class="dungeon-entry-forecast-titles"><div class="dungeon-entry-forecast-headline">Estimating your chances…</div></div></div>'
        + this.renderFloorStrip(dungeon, null));
      return;
    }
    const result = view.message.result!;
    const verdict = forecastVerdict(result, 'dungeon');
    const range = forecastRangeLine(result);
    const reasons = (result.reasons ?? []).slice(0, 3);
    slot.dataset.state = view.stale ? 'stale' : 'ready';
    setHtml(slot, `<div class="dungeon-entry-forecast-head">${renderForecastRing(result, { kind: 'dungeon', compact: true, stale: view.stale })}`
      + '<div class="dungeon-entry-forecast-titles">'
      + `<div class="dungeon-entry-forecast-verdict" data-band="${verdict.band}">${verdict.label}</div>`
      + `<div class="dungeon-entry-forecast-headline">${escapeHtml(forecastHeadline(result, 'dungeon'))}</div>`
      + '</div></div>'
      + this.renderFloorStrip(dungeon, result)
      + (range ? `<div class="dungeon-entry-forecast-line">${escapeHtml(range)}</div>` : '')
      + (reasons.length > 0
        ? `<ul class="forecast-reasons">${reasons.map(r => `<li class="forecast-reason" data-tone="${r.tone}" data-code="${escapeHtml(r.code)}">${escapeHtml(r.text)}</li>`).join('')}</ul>`
        : '')
      + `<div class="forecast-foot">${forecastSampleLine(result, 'dungeon')}${view.stale ? ' · updating…' : ''}</div>`);
  }

  private renderFloorStrip(dungeon: DungeonDefinition, result: ForecastResult | null): string {
    const pips = dungeon.floors.map((floor, index) => {
      const info = result?.floors?.find(f => f.floor === index + 1);
      const boss = floor.isBoss || info?.boss;
      const attrs = [
        `data-floor="${index + 1}"`,
        boss ? 'data-boss="true"' : '',
        info ? `data-band="${forecastBand(info.winPct)}"` : '',
      ].filter(Boolean).join(' ');
      const labelParts = [`Floor ${index + 1}`];
      if (boss) labelParts.push('boss');
      const winText = info ? `: wins ${formatPct(info.winPct)}` : '';
      const glyph = boss ? '♛' : String(index + 1);
      const pct = info ? `<span class="dungeon-floor-pct">${formatPct(info.winPct)}</span>` : '';
      return `<li class="dungeon-floor-pip" ${attrs} aria-label="${escapeHtml(labelParts.join(', ') + winText)}">`
        + `<span class="dungeon-floor-glyph" aria-hidden="true">${glyph}</span>${pct}</li>`;
    }).join('');
    return `<ol class="dungeon-entry-floors" aria-label="Floors">${pips}</ol>`;
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
