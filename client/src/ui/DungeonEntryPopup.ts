import type { GameClient } from '../network/GameClient';
import type { DungeonDefinition, ForecastResult, ServerForecastMessage } from '@idle-party-rpg/shared';
import { floorCheckpoints, floorMaxWipes } from '@idle-party-rpg/shared';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { renderForecastRing } from './ForecastChip';
import {
  forecastBand,
  forecastHeadline,
  forecastSampleLine,
  forecastVerdict,
  formatPct,
  forecastRangeLine,
  formatResumeMarker,
  isForecastStale,
  parseDungeonResume,
} from '../combat/ForecastFormat';
import type { DungeonResumePoint } from '../combat/ForecastFormat';

export interface DungeonEntryOptions {
  /** False for plain members: the popup is read-only and explains whose progress counts. */
  canEnter?: boolean;
}

type ForecastView = { message: ServerForecastMessage; stale: boolean } | 'loading' | null;

/**
 * Confirmation popup for "Enter {dungeon}": flavor, requirements, a run forecast with a
 * floor strip and resume marker, then the owner/leader commits. Entry is server-authoritative.
 */
export class DungeonEntryPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private dungeon: DungeonDefinition | null = null;
  private unsubForecast?: () => void;
  private keyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.hide();
  };

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.overlay = document.createElement('div');
    this.overlay.className = 'dungeon-entry-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    wireFocusOnInteract(this.overlay);
    document.body.appendChild(this.overlay);
  }

  get isOpen(): boolean {
    return this.dungeon !== null;
  }

  show(dungeon: DungeonDefinition, col: number, row: number, opts: DungeonEntryOptions = {}): void {
    const canEnter = opts.canEnter !== false;
    this.dungeon = dungeon;
    const floors = dungeon.floors.length;
    const description = dungeon.description?.trim();
    const descHtml = description
      ? `<div class="dungeon-entry-desc">"${this.escape(description)}"</div>`
      : '';
    const reqHtml = this.renderRequirements(dungeon);
    const leaderNote = canEnter
      ? ''
      : '<div class="dungeon-entry-note">Your party leader\'s progress decides where you start.</div>';

    this.overlay.innerHTML = `
      <div class="dungeon-entry-modal" role="dialog" aria-modal="true" aria-label="${this.escape(dungeon.name)}">
        <div class="dungeon-entry-header">
          <span class="dungeon-entry-icon">🗝️</span>
          <div class="dungeon-entry-title">${this.escape(dungeon.name)}</div>
        </div>
        ${descHtml}
        <div class="dungeon-entry-meta">${floors} floor${floors === 1 ? '' : 's'} · clear the final floor to complete the run</div>
        <div class="dungeon-entry-forecast" data-state="loading" aria-live="polite"></div>
        ${reqHtml}
        <div class="dungeon-entry-warning">${this.warningText(dungeon)}</div>
        ${leaderNote}
        <div class="dungeon-entry-actions">
          <button class="dungeon-entry-btn dungeon-entry-enter" type="button"${canEnter ? '' : ' disabled title="Only the party owner or a leader can enter"'}>Enter</button>
          <button class="dungeon-entry-btn dungeon-entry-cancel" type="button">Cancel</button>
        </div>
      </div>
    `;

    this.overlay.querySelector('.dungeon-entry-cancel')?.addEventListener('click', () => this.hide());
    this.overlay.querySelector('.dungeon-entry-enter')?.addEventListener('click', () => {
      if (!canEnter) return;
      this.gameClient.sendEnterDungeon(col, row, dungeon.id);
      this.hide();
    });

    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);
    document.addEventListener('keydown', this.keyHandler);

    this.unsubForecast?.();
    this.unsubForecast = this.gameClient.onForecast((msg) => {
      if (msg.target.kind !== 'dungeon' || msg.target.dungeonId !== this.dungeon?.id) return;
      if (msg.status === 'pending') return;
      this.renderForecast(this.toView(msg));
    });
    const target = { kind: 'dungeon' as const, dungeonId: dungeon.id };
    const cached = this.gameClient.requestForecast(target);
    const view = cached ?? this.gameClient.peekForecast(target);
    this.renderForecast(view ? this.toView(view, !cached) : 'loading');
  }

  hide(): void {
    this.unsubForecast?.();
    this.unsubForecast = undefined;
    document.removeEventListener('keydown', this.keyHandler);
    this.dungeon = null;
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    release(this.overlay);
  }

  private toView(message: ServerForecastMessage, forceStale = false): ForecastView {
    if (message.status === 'pending') return 'loading';
    if (message.status !== 'ok' || !message.result) return null;
    const forecastKey = this.gameClient.lastState?.social?.party?.forecastKey;
    return { message, stale: forceStale || isForecastStale(message.result, forecastKey) };
  }

  private warningText(dungeon: DungeonDefinition): string {
    const checkpointFloor = dungeon.floors.find(f => floorCheckpoints(f).length > 0);
    if (!checkpointFloor) return 'If your party is defeated, you\'ll be sent back to this entrance.';
    const retries = floorMaxWipes(checkpointFloor);
    return `Falling on the boss floor regroups your party at its last checkpoint (up to ${retries} ${retries === 1 ? 'time' : 'times'}). `
      + 'Falling anywhere else sends you back to this entrance.';
  }

  private renderForecast(view: ForecastView): void {
    const slot = this.overlay.querySelector<HTMLElement>('.dungeon-entry-forecast');
    const dungeon = this.dungeon;
    if (!slot || !dungeon) return;
    if (view === null) {
      slot.dataset.state = 'none';
      slot.innerHTML = '';
      return;
    }
    if (view === 'loading') {
      slot.dataset.state = 'loading';
      slot.innerHTML = `<div class="dungeon-entry-forecast-head">${renderForecastRing('loading', { kind: 'dungeon', compact: true })}`
        + '<div class="dungeon-entry-forecast-titles"><div class="dungeon-entry-forecast-headline">Estimating your chances…</div></div></div>'
        + this.renderFloorStrip(dungeon, null, null);
      return;
    }
    const result = view.message.result!;
    const resume = parseDungeonResume(view.message.key || result.key);
    const verdict = forecastVerdict(result, 'dungeon');
    const range = forecastRangeLine(result);
    const reasons = (result.reasons ?? []).slice(0, 3);
    slot.dataset.state = view.stale ? 'stale' : 'ready';
    slot.innerHTML = `<div class="dungeon-entry-forecast-head">${renderForecastRing(result, { kind: 'dungeon', compact: true, stale: view.stale })}`
      + '<div class="dungeon-entry-forecast-titles">'
      + `<div class="dungeon-entry-forecast-verdict" data-band="${verdict.band}">${verdict.label}</div>`
      + `<div class="dungeon-entry-forecast-headline">${this.escape(forecastHeadline(result, 'dungeon'))}</div>`
      + '</div></div>'
      + this.renderFloorStrip(dungeon, result, resume)
      + this.renderResume(dungeon, resume)
      + (range ? `<div class="dungeon-entry-forecast-line">${this.escape(range)}</div>` : '')
      + (result.firstTryPct !== undefined ? `<div class="dungeon-entry-forecast-line">Boss beaten on the first try: ${formatPct(result.firstTryPct)}</div>` : '')
      + (reasons.length > 0
        ? `<ul class="forecast-reasons">${reasons.map(r => `<li class="forecast-reason" data-tone="${r.tone}" data-code="${this.escape(r.code)}">${this.escape(r.text)}</li>`).join('')}</ul>`
        : '')
      + `<div class="forecast-foot">${forecastSampleLine(result, 'dungeon')}${view.stale ? ' · updating…' : ''}</div>`;
  }

  private renderFloorStrip(dungeon: DungeonDefinition, result: ForecastResult | null, resume: DungeonResumePoint | null): string {
    const pips = dungeon.floors.map((floor, index) => {
      const info = result?.floors?.find(f => f.floor === index + 1) ?? result?.floors?.[index];
      const boss = floor.isBoss || info?.boss;
      const checkpoints = floorCheckpoints(floor).length > 0;
      const isResume = !!resume && resume.floorIndex === index && (resume.floorIndex > 0 || resume.phase > 0);
      const passed = !!resume && index < resume.floorIndex;
      const attrs = [
        `data-floor="${index + 1}"`,
        boss ? 'data-boss="true"' : '',
        checkpoints ? 'data-checkpoint="true"' : '',
        isResume ? 'data-resume="true"' : '',
        passed ? 'data-passed="true"' : '',
        info ? `data-band="${forecastBand(info.winPct)}"` : '',
      ].filter(Boolean).join(' ');
      const labelParts = [`Floor ${index + 1}`];
      if (boss) labelParts.push('boss');
      if (checkpoints) labelParts.push('checkpoints');
      if (passed) labelParts.push('already cleared');
      const winText = info ? `: wins ${formatPct(info.winPct)}` : '';
      const glyph = boss ? '♛' : String(index + 1);
      const pct = info && !passed ? `<span class="dungeon-floor-pct">${formatPct(info.winPct)}</span>` : '';
      return `<li class="dungeon-floor-pip" ${attrs} aria-label="${this.escape(labelParts.join(', ') + winText)}">`
        + `<span class="dungeon-floor-glyph" aria-hidden="true">${glyph}</span>${pct}`
        + (isResume ? '<span class="dungeon-floor-flag" aria-hidden="true">🚩</span>' : '')
        + '</li>';
    }).join('');
    return `<ol class="dungeon-entry-floors" aria-label="Floors">${pips}</ol>`;
  }

  private renderResume(dungeon: DungeonDefinition, resume: DungeonResumePoint | null): string {
    const marker = formatResumeMarker(resume);
    if (!marker || !resume) return '';
    const floor = dungeon.floors[resume.floorIndex];
    const hasBudget = floor && floorCheckpoints(floor).length > 0;
    const left = hasBudget ? Math.max(0, floorMaxWipes(floor) - resume.wipes) : null;
    const retries = left === null ? '' : ` · ${left === 0 ? 'no retries left' : `${left} ${left === 1 ? 'retry' : 'retries'} left`}`;
    return `<div class="dungeon-entry-resume"><span aria-hidden="true">🚩</span> ${this.escape(marker)}${retries}</div>`;
  }

  /** Render a bullet list of entry requirements, or nothing if unrestricted. */
  private renderRequirements(dungeon: DungeonDefinition): string {
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

    if (req.requiredItemId) {
      const itemName = this.gameClient.lastState?.itemDefinitions?.[req.requiredItemId]?.name ?? 'a key item';
      lines.push(req.consumeRequiredItem ? `Consumes ${this.escape(itemName)} (per member)` : `Requires ${this.escape(itemName)} (per member)`);
    }

    if (lines.length === 0) return '';
    return `
      <div class="dungeon-entry-reqs">
        <div class="dungeon-entry-reqs-title">Requirements</div>
        ${lines.map(l => `<div class="dungeon-entry-req">• ${l}</div>`).join('')}
      </div>
    `;
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
