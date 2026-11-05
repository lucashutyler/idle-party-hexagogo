import type { AwayLedger, AwayMoment, AwayMomentKind, ItemDefinition, ItemRarity } from '@idle-party-rpg/shared';
import { AUTO_RETREAT_OPTIONS, AWAY_NOTABLE_MIN_RARITY, awayRarityRank, awayRecapStyle, topAwayMoments } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { renderItemIcon } from './ItemIcon';
import { reducedMotion } from './motion';
import { OPEN_OPTIONS_ATTR } from './ForecastChip';

export const RECAP_TIMELINE_MAX = 6;
export const RECAP_LOSS_NUDGE_FRACTION = 0.25;
const TOAST_LIFETIME_MS = 8000;
const COUNT_UP_MS = 700;
const PCT = ' %';
const MAX_AUTO_RETREAT_PCT = Math.max(...AUTO_RETREAT_OPTIONS);

const MOMENT_ICONS: Record<AwayMomentKind, string> = {
  level_up: '⬆️',
  first_clear: '🏆',
  rare_item: '💎',
  checkpoint: '🚩',
  eject: '💀',
  relocate: '🏳️',
  mastery: '⭐',
  closest_call: '❤️',
};

export interface RecapLevelProgress {
  label: string;
  gainText: string;
  levelledUp: boolean;
  /** Bar segment already filled before the absence (0 after a level-up). */
  baseFrac: number;
  /** Bar fill now. */
  fillFrac: number;
}

export type RecapWarningAction = 'options' | 'map';

export interface RecapWarning {
  kind: 'losses' | 'route' | 'ejected' | 'left' | 'items_lost';
  text: string;
  action?: RecapWarningAction;
}

export interface RecapItemLookup {
  (itemId: string): ItemDefinition | undefined;
}

/** "12 min", "4 h 12 min", "2 d 3 h". */
export function formatAwayDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.max(0, ms) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

function clampFrac(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

export function recapLevelProgress(ledger: Pick<AwayLedger, 'levelFrom' | 'levelTo' | 'xpFracFrom' | 'xpFracTo'>): RecapLevelProgress {
  const from = clampFrac(ledger.xpFracFrom);
  const to = clampFrac(ledger.xpFracTo);
  const levelledUp = ledger.levelTo > ledger.levelFrom;
  const gained = Math.max(0, (ledger.levelTo - ledger.levelFrom) + (to - from));
  let gainText: string;
  if (levelledUp) {
    const levels = ledger.levelTo - ledger.levelFrom;
    gainText = `+${levels} ${levels === 1 ? 'level' : 'levels'}`;
  } else {
    gainText = `+${formatLevelPct(gained * 100)}${PCT} of a level`;
  }
  return {
    label: levelledUp ? `Level ${ledger.levelFrom} → ${ledger.levelTo}` : `Level ${ledger.levelTo}`,
    gainText,
    levelledUp,
    baseFrac: levelledUp ? 0 : from,
    fillFrac: to,
  };
}

/** Whole percent from 1 up; one decimal below that so small gains don't read as "+<1 %". */
function formatLevelPct(pct: number): string {
  if (pct <= 0) return '0';
  if (pct >= 0.95) return String(Math.round(pct));
  return pct < 0.05 ? '<0.1' : pct.toFixed(1);
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function momentPhrase(moment: AwayMoment, ledger: AwayLedger, item: RecapItemLookup): string {
  switch (moment.kind) {
    case 'level_up':
      return `reached Level ${ledger.levelTo}`;
    case 'first_clear': {
      const cleared = [...ledger.dungeons].reverse().find(d => d.outcome === 'cleared');
      return cleared ? `cleared ${cleared.name}` : lowerFirst(moment.text);
    }
    case 'rare_item': {
      const rarest = ledger.notableItems.find(n => item(n.itemId));
      const def = rarest ? item(rarest.itemId) : moment.itemId ? item(moment.itemId) : undefined;
      return def ? `found ${def.name}` : lowerFirst(moment.text);
    }
    case 'checkpoint': {
      const run = [...ledger.dungeons].reverse().find(d => (d.checkpoint ?? 0) > 0);
      return run ? `hit Checkpoint ${run.checkpoint} in ${run.name}` : lowerFirst(moment.text);
    }
    case 'eject': {
      const run = [...ledger.dungeons].reverse().find(d => d.outcome === 'ejected');
      return run ? `was pushed out of ${run.name}` : lowerFirst(moment.text);
    }
    case 'relocate':
      return 'retreated to a safer room';
    case 'mastery': {
      const up = moment.monsterId ? ledger.masteryUps.find(m => m.monsterId === moment.monsterId) : undefined;
      return up ? `earned mastery rank ${up.rankTo} against ${up.name}` : lowerFirst(moment.text);
    }
    case 'closest_call':
      return ledger.closestCall ? `survived a close call against ${ledger.closestCall.vs}` : lowerFirst(moment.text);
  }
}

/** "Your party reached Level 4 and cleared Goblin Warren." from the top two moments of different kinds. */
export function recapHeadline(ledger: AwayLedger, where: string | undefined, item: RecapItemLookup = () => undefined): string {
  const seen = new Set<AwayMomentKind>();
  const phrases: string[] = [];
  for (const moment of topAwayMoments(ledger, ledger.moments.length)) {
    if (seen.has(moment.kind)) continue;
    seen.add(moment.kind);
    phrases.push(momentPhrase(moment, ledger, item));
    if (phrases.length === 2) break;
  }
  if (phrases.length === 0) return where ? `Your party kept fighting in ${where}.` : 'Your party kept fighting.';
  return `Your party ${phrases.join(' and ')}.`;
}

/** Up to `max` moments by priority, shown in the order they happened. */
export function recapTimeline(ledger: AwayLedger, max = RECAP_TIMELINE_MAX): AwayMoment[] {
  return topAwayMoments(ledger, max).sort((a, b) => a.at - b.at);
}

export function commonItemCount(ledger: Pick<AwayLedger, 'items'>): number {
  const min = awayRarityRank(AWAY_NOTABLE_MIN_RARITY);
  let total = 0;
  for (const [rarity, count] of Object.entries(ledger.items) as [ItemRarity, number][]) {
    if (awayRarityRank(rarity) < min) total += count;
  }
  return total;
}

/** `autoRetreatPct` is the setting in effect now; the nudge only suggests raising it while it can go higher. */
export function recapWarnings(
  ledger: AwayLedger,
  formatTime: (at: number) => string = formatMomentTime,
  autoRetreatPct = 0,
): RecapWarning[] {
  const warnings: RecapWarning[] = [];
  if (ledger.battles > 0 && ledger.losses / ledger.battles >= RECAP_LOSS_NUDGE_FRACTION) {
    warnings.push(lossWarning(ledger, autoRetreatPct));
  }
  if (ledger.routeStopped) {
    warnings.push({
      kind: 'route',
      text: `Your party stopped traveling at ${ledger.routeStopped.where} (${formatTime(ledger.routeStopped.at)}). Pick a new destination on the map.`,
      action: 'map',
    });
  }
  for (const run of ledger.dungeons) {
    if (run.outcome === 'ejected') {
      warnings.push({ kind: 'ejected', text: `Your party was defeated in ${run.name}. Enter again to start a new run.` });
    } else if (run.outcome === 'left' && (run.checkpoint ?? 0) > 0) {
      warnings.push({ kind: 'left', text: `Your party left ${run.name} at Checkpoint ${run.checkpoint}. Enter again to resume there.` });
    }
  }
  if (ledger.itemsLost > 0) {
    warnings.push({
      kind: 'items_lost',
      text: `Your bags were full: ${fmt(ledger.itemsLost)} ${ledger.itemsLost === 1 ? 'item was' : 'items were'} left behind.`,
    });
  }
  return warnings;
}

function lossWarning(ledger: AwayLedger, autoRetreatPct: number): RecapWarning {
  const lost = `You lost ${fmt(ledger.losses)} of ${fmt(ledger.battles)} fights`;
  if (!(autoRetreatPct > 0)) {
    return { kind: 'losses', text: `${lost}. Auto-retreat can keep your party out of losing fights.`, action: 'options' };
  }
  if (autoRetreatPct < MAX_AUTO_RETREAT_PCT) {
    return {
      kind: 'losses',
      text: `${lost} with auto-retreat below ${autoRetreatPct}${PCT}. A higher setting leaves more of them.`,
      action: 'options',
    };
  }
  return { kind: 'losses', text: `${lost}. An easier room may suit your party better.`, action: 'map' };
}

/** "Won 1,204 of 1,240 fights · +310 gold · 2,480 foes defeated", with count-up spans. */
export function recapFooterHtml(ledger: AwayLedger): string {
  const parts = [
    `Won ${countSpan(ledger.wins)} of ${countSpan(ledger.battles)} fights`,
    `+${countSpan(ledger.gold)} gold`,
    `${countSpan(ledger.kills)} foes defeated`,
  ];
  if (ledger.retreats > 0) parts.push(`${countSpan(ledger.retreats)} ${ledger.retreats === 1 ? 'retreat' : 'retreats'}`);
  return parts.join(' · ');
}

/** "While you were away (12 min): +3 % of a level · 42 gold". */
export function recapToastText(ledger: AwayLedger, now: number): string {
  const away = formatAwayDuration((ledger.until ?? now) - ledger.since);
  const parts = [recapLevelProgress(ledger).gainText];
  if (ledger.gold > 0) parts.push(`${fmt(ledger.gold)} gold`);
  return `While you were away (${away}): ${parts.join(' · ')}`;
}

export function formatMomentTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function countSpan(n: number): string {
  return `<span class="recap-count" data-count="${Math.round(n)}">${fmt(n)}</span>`;
}

export interface RecapModalOptions {
  onOpenMap?: () => void;
  now?: () => number;
}

/** "While you were away": a toast for short quiet absences, otherwise a modal; acknowledged on Continue. */
export class RecapModal {
  private overlay: HTMLElement | null = null;
  private toast: HTMLElement | null = null;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private shownId: string | null = null;
  private unsubscribe: () => void;
  private keyHandler = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.isTopmost()) return;
    e.preventDefault();
    this.acknowledge();
  };

  constructor(private gameClient: GameClient, private opts: RecapModalOptions = {}) {
    this.unsubscribe = gameClient.onRecap(recap => this.handle(recap));
  }

  destroy(): void {
    this.unsubscribe();
    this.closeAll();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private handle(recap: AwayLedger | null): void {
    if (!recap) {
      this.closeAll();
      this.shownId = null;
      return;
    }
    if (recap.id === this.shownId) return;
    this.closeAll();
    this.shownId = recap.id;
    if (awayRecapStyle(recap, this.now()) === 'toast') this.showToast(recap);
    else this.showModal(recap);
  }

  private itemLookup(): RecapItemLookup {
    const defs = this.gameClient.lastRecapItemDefinitions;
    return (id) => defs[id];
  }

  private showToast(recap: AwayLedger): void {
    const toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'recap-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = recapToastText(recap, this.now());
    toast.addEventListener('click', () => {
      this.removeToast();
      this.showModal(recap);
    });
    document.body.appendChild(toast);
    bringToFront(toast);
    this.toast = toast;
    this.toastTimer = setTimeout(() => this.acknowledge(), TOAST_LIFETIME_MS);
  }

  private showModal(recap: AwayLedger): void {
    const item = this.itemLookup();
    const where = this.gameClient.lastState?.zoneName;
    const level = recapLevelProgress(recap);
    const timeline = recapTimeline(recap);
    const state = this.gameClient.lastState;
    const warnings = recapWarnings(recap, formatMomentTime, state?.social?.party?.autoRetreat?.belowPct
      ?? state?.character?.combatPrefs?.autoRetreatBelowPct ?? 0);
    const loot = recap.notableItems
      .map(n => ({ n, def: item(n.itemId) }))
      .filter((x): x is { n: typeof x.n; def: ItemDefinition } => !!x.def);
    const commons = commonItemCount(recap);
    const awayMs = (recap.until ?? this.now()) - recap.since;

    const timelineHtml = timeline.length > 0
      ? `<ol class="recap-timeline">${timeline.map(m => `<li class="recap-moment" data-kind="${m.kind}">`
        + `<span class="recap-moment-time">${escapeHtml(formatMomentTime(m.at))}</span>`
        + `<span class="recap-moment-icon" aria-hidden="true">${MOMENT_ICONS[m.kind] ?? '•'}</span>`
        + `<span class="recap-moment-text">${escapeHtml(m.text)}</span></li>`).join('')}</ol>`
      : '';
    const lootHtml = loot.length > 0 || commons > 0
      ? '<section class="recap-loot"><div class="recap-section-title">Loot</div>'
        + (loot.length > 0 ? `<div class="recap-loot-icons">${loot.map(({ n, def }) => renderItemIcon(n.itemId, def, { qty: n.count })).join('')}</div>` : '')
        + (commons > 0 ? `<div class="recap-loot-common">${loot.length > 0 ? '+ ' : ''}${fmt(commons)} common ${commons === 1 ? 'item' : 'items'}</div>` : '')
        + '</section>'
      : '';
    const warningsHtml = warnings.length > 0
      ? `<ul class="recap-warnings">${warnings.map(w => `<li class="recap-warning" data-kind="${w.kind}">`
        + `<span class="recap-warning-text">${escapeHtml(w.text)}</span>`
        + (w.action === 'options' ? `<button type="button" class="pixel-btn recap-warning-action" ${OPEN_OPTIONS_ATTR}>Options</button>` : '')
        + (w.action === 'map' && this.opts.onOpenMap ? '<button type="button" class="pixel-btn recap-warning-action" data-recap-action="map">Map</button>' : '')
        + '</li>').join('')}</ul>`
      : '';

    const overlay = document.createElement('div');
    overlay.className = 'player-options-overlay recap-overlay';
    overlay.innerHTML = `
      <div class="player-options-modal recap-modal" role="dialog" aria-modal="true" aria-labelledby="recap-title">
        <div class="recap-header">
          <div class="recap-title" id="recap-title">While you were away</div>
          <div class="recap-away">${escapeHtml(formatAwayDuration(awayMs))}</div>
        </div>
        <div class="recap-body">
          <p class="recap-headline">${escapeHtml(recapHeadline(recap, where, item))}</p>
          <div class="recap-level" data-levelled="${level.levelledUp}">
            <div class="recap-level-row">
              <span class="recap-level-label">${escapeHtml(level.label)}</span>
              <span class="recap-level-gain">${level.gainText}</span>
            </div>
            <div class="recap-level-bar" role="progressbar" aria-label="Level progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(level.fillFrac * 100)}">
              <div class="recap-level-base" style="width:${(level.baseFrac * 100).toFixed(1)}%"></div>
              <div class="recap-level-fill" style="left:${(level.baseFrac * 100).toFixed(1)}%;width:${(Math.max(0, level.fillFrac - level.baseFrac) * 100).toFixed(1)}%"></div>
            </div>
          </div>
          ${timelineHtml}
          ${lootHtml}
          ${warningsHtml}
        </div>
        <div class="recap-footer">${recapFooterHtml(recap)}</div>
        <div class="recap-actions">
          <button type="button" class="pixel-btn recap-continue">Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;

    overlay.querySelector('.recap-continue')!.addEventListener('click', () => this.acknowledge());
    overlay.querySelector('[data-recap-action="map"]')?.addEventListener('click', () => {
      this.acknowledge();
      this.opts.onOpenMap?.();
    });
    document.addEventListener('keydown', this.keyHandler);

    bringToFront(overlay, () => this.acknowledge());
    wireFocusOnInteract(overlay);
    (overlay.querySelector('.recap-continue') as HTMLElement | null)?.focus({ preventScroll: true });
    if (!reducedMotion()) this.countUp(overlay);
  }

  private countUp(root: HTMLElement): void {
    const spans = [...root.querySelectorAll<HTMLElement>('.recap-count[data-count]')];
    const fill = root.querySelector<HTMLElement>('.recap-level-fill');
    const targetWidth = fill?.style.width ?? '';
    if (fill) fill.style.width = '0%';
    const start = performance.now();
    const step = (t: number): void => {
      if (!root.isConnected) return;
      const k = Math.min(1, (t - start) / COUNT_UP_MS);
      const eased = 1 - Math.pow(1 - k, 3);
      for (const span of spans) span.textContent = fmt(Number(span.dataset.count) * eased);
      if (fill) fill.style.width = `${(parseFloat(targetWidth) || 0) * eased}%`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Escape belongs to whatever window sits above the recap (Player Options opened from a warning), not to toasts. */
  private isTopmost(): boolean {
    const z = Number(this.overlay?.style.zIndex || 0);
    return ![...document.querySelectorAll<HTMLElement>('body > *')]
      .some(el => el !== this.overlay && el !== this.toast && el.getAttribute('role') !== 'status'
        && Number(el.style.zIndex || 0) > z);
  }

  private acknowledge(): void {
    const id = this.shownId;
    this.closeAll();
    if (id) this.gameClient.sendAckRecap(id);
  }

  private removeToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = undefined;
    if (this.toast) {
      release(this.toast);
      this.toast.remove();
      this.toast = null;
    }
  }

  private closeAll(): void {
    this.removeToast();
    if (this.overlay) {
      document.removeEventListener('keydown', this.keyHandler);
      release(this.overlay);
      this.overlay.remove();
      this.overlay = null;
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
