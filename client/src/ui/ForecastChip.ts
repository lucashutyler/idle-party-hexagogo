import type { AutoRetreatPct, ForecastResult, PartyAutoRetreatInfo } from '@idle-party-rpg/shared';
import { LEVEL_CON_INFO, levelCon } from '@idle-party-rpg/shared';
import {
  autoRetreatLine,
  forecastAriaLabel,
  forecastHeadline,
  forecastSampleLine,
  forecastVerdict,
  formatEnemyLevels,
  forecastRangeLine,
  formatPct,
  formatWinPct,
  worstStratumLine,
} from '../combat/ForecastFormat';
import type { ForecastKind } from '../combat/ForecastFormat';

/** Any element carrying this attribute opens Player Options when clicked (App wires the delegate). */
export const OPEN_OPTIONS_ATTR = 'data-open-options';

export interface ForecastRingOptions {
  kind: ForecastKind;
  /** Ring plus number only (combat header). */
  compact?: boolean;
  /** The party changed since the result was computed. */
  stale?: boolean;
}

export interface ForecastPopoverOptions {
  kind: ForecastKind;
  /** Policy in effect; omit where auto-retreat does not apply (dungeons). */
  autoRetreat?: PartyAutoRetreatInfo | AutoRetreatPct | null;
  /** Live fights: combat time already elapsed, for "~1:40 left". */
  elapsedMs?: number;
  /** Colours the enemy level range relative to this level. */
  viewerLevel?: number;
  stale?: boolean;
}

/**
 * Win-chance ring as an HTML string (`.forecast-chip`); '' for null. The chip is a span:
 * hosts that make it interactive wrap it in their own button.
 */
export function renderForecastRing(result: ForecastResult | 'loading' | null, opts: ForecastRingOptions): string {
  if (result === null) return '';
  const compact = opts.compact ? ' data-compact="true"' : '';
  if (result === 'loading') {
    return `<span class="forecast-chip" data-kind="${opts.kind}" data-state="loading"${compact} role="img" aria-label="Estimating your chances">`
      + '<span class="forecast-ring" aria-hidden="true"></span>'
      + '<span class="forecast-win" aria-hidden="true">…</span>'
      + '</span>';
  }
  const verdict = forecastVerdict(result, opts.kind);
  const fraction = Math.max(0, Math.min(1, result.winPct / 100)).toFixed(3);
  const verdictHtml = opts.compact ? '' : `<span class="forecast-verdict" aria-hidden="true">${verdict.label}</span>`;
  const state = opts.stale ? 'stale' : 'ready';
  const aria = forecastAriaLabel(result, opts.kind) + (opts.stale ? ' (updating)' : '');
  return `<span class="forecast-chip" data-kind="${opts.kind}" data-state="${state}" data-verdict="${verdict.verdict}" data-band="${verdict.band}"${compact} role="img" aria-label="${escapeHtml(aria)}">`
    + `<span class="forecast-ring" style="--p:${fraction}" aria-hidden="true"></span>`
    + `<span class="forecast-win" aria-hidden="true">${formatWinPct(result)}</span>`
    + verdictHtml
    + '</span>';
}

/** Details for a forecast: verdict, headline, reasons, worst encounter, sample size and auto-retreat line. */
export function renderForecastPopover(result: ForecastResult, opts: ForecastPopoverOptions): string {
  const verdict = forecastVerdict(result, opts.kind);
  const range = forecastRangeLine(result);
  const reasons = (result.reasons ?? []).slice(0, 3);
  const hasWorstReason = reasons.some(r => r.code === 'worst_encounter');
  const levels = formatEnemyLevels(result);

  const parts: string[] = [];
  parts.push(`<div class="forecast-pop-head">${renderForecastRing(result, { kind: opts.kind, compact: true, stale: opts.stale })}`
    + '<div class="forecast-pop-titles">'
    + `<div class="forecast-pop-verdict">${verdict.label}</div>`
    + `<div class="forecast-pop-headline">${escapeHtml(forecastHeadline(result, opts.kind, opts.elapsedMs))}</div>`
    + '</div></div>');
  if (range) parts.push(`<div class="forecast-pop-range">${escapeHtml(range)}</div>`);
  if (opts.kind === 'dungeon' && result.firstTryPct !== undefined) {
    parts.push(`<div class="forecast-pop-line">Boss beaten on the first try: ${formatPct(result.firstTryPct)}</div>`);
  }
  if (levels && result.enemyLevels) {
    const con = opts.viewerLevel ? levelCon(result.enemyLevels[1], opts.viewerLevel) : 'even';
    parts.push('<div class="forecast-pop-line">Enemies '
      + `<span class="lvl-badge forecast-lvl" data-con="${con}" aria-label="Level ${escapeHtml(levels.slice(1))}, ${LEVEL_CON_INFO[con].label}">`
      + `${LEVEL_CON_INFO[con].glyph} ${levels}</span></div>`);
  }
  if (opts.stale) parts.push('<div class="forecast-pop-stale">Your party changed — updating…</div>');
  if (reasons.length > 0) {
    parts.push('<ul class="forecast-reasons">'
      + reasons.map(r => `<li class="forecast-reason" data-tone="${r.tone}" data-code="${escapeHtml(r.code)}">${escapeHtml(r.text)}</li>`).join('')
      + '</ul>');
  }
  if (result.worst && !hasWorstReason && opts.kind === 'room') {
    parts.push(`<div class="forecast-worst">${escapeHtml(worstStratumLine(result.worst))}</div>`);
  }
  parts.push(`<div class="forecast-foot">${forecastSampleLine(result, opts.kind)}</div>`);
  if (opts.autoRetreat !== undefined) {
    const pct = typeof opts.autoRetreat === 'object' && opts.autoRetreat !== null
      ? opts.autoRetreat.belowPct
      : opts.autoRetreat;
    parts.push(`<div class="forecast-retreat">${autoRetreatLine(pct)} · `
      + `<button type="button" class="forecast-retreat-change" ${OPEN_OPTIONS_ATTR}>Change</button></div>`);
  }
  return `<div class="forecast-popover" data-kind="${opts.kind}" data-verdict="${verdict.verdict}" data-band="${verdict.band}">${parts.join('')}</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
