import type { ForecastResult, ForecastStats } from '@idle-party-rpg/shared';

export type ForecastKind = 'room' | 'dungeon' | 'battle';
export type RoomVerdict = 'safe' | 'good' | 'slow' | 'losing';
export type RunVerdict = 'safe' | 'likely' | 'risky' | 'deadly';
export type ForecastVerdict = RoomVerdict | RunVerdict;
/** 0 = best band, 3 = worst; drives the verdict colour. */
export type ForecastBand = 0 | 1 | 2 | 3;

export interface ForecastVerdictInfo {
  verdict: ForecastVerdict;
  label: string;
  band: ForecastBand;
}

/** Show an exact percentage only when the Wilson 95 % half-width is at most this many points. */
export const FORECAST_EXACT_MAX_HALF_WIDTH = 7;

const BAND_FLOORS = [90, 70, 40] as const;
const ROOM_VERDICTS: readonly RoomVerdict[] = ['safe', 'good', 'slow', 'losing'];
const RUN_VERDICTS: readonly RunVerdict[] = ['safe', 'likely', 'risky', 'deadly'];

export const FORECAST_VERDICT_LABELS: Record<ForecastVerdict, string> = {
  safe: 'Safe',
  good: 'Good',
  slow: 'Slow',
  losing: 'Losing',
  likely: 'Likely',
  risky: 'Risky',
  deadly: 'Deadly',
};

const PCT = ' %';

export function forecastBand(pct: number): ForecastBand {
  const p = Number.isFinite(pct) ? pct : 0;
  if (p >= BAND_FLOORS[0]) return 0;
  if (p >= BAND_FLOORS[1]) return 1;
  if (p >= BAND_FLOORS[2]) return 2;
  return 3;
}

/** Band from the point estimate, stepped down one when the CI lower bound sits two or more bands lower. */
export function forecastVerdict(stats: Pick<ForecastStats, 'winPct' | 'ci'>, kind: ForecastKind): ForecastVerdictInfo {
  const point = forecastBand(stats.winPct);
  const low = forecastBand(stats.ci?.[0] ?? stats.winPct);
  const band = (low - point >= 2 ? Math.min(3, point + 1) : point) as ForecastBand;
  const verdict = kind === 'room' ? ROOM_VERDICTS[band] : RUN_VERDICTS[band];
  return { verdict, label: FORECAST_VERDICT_LABELS[verdict], band };
}

export function wilsonHalfWidth(stats: Pick<ForecastStats, 'ci'>): number {
  const [lo, hi] = stats.ci ?? [0, 100];
  return Math.max(0, (hi - lo) / 2);
}

export function isExactForecast(stats: Pick<ForecastStats, 'ci' | 'sims'>): boolean {
  return stats.sims > 0 && wilsonHalfWidth(stats) <= FORECAST_EXACT_MAX_HALF_WIDTH;
}

export function formatPct(pct: number): string {
  return `${Math.round(Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0)))}${PCT}`;
}

/** "78 %" when the estimate is tight, "~62 %" otherwise. */
export function formatWinPct(stats: Pick<ForecastStats, 'winPct' | 'ci' | 'sims'>): string {
  return `${isExactForecast(stats) ? '' : '~'}${formatPct(stats.winPct)}`;
}

/** "likely 39–78 %" for loose estimates, null when the exact number is shown. */
export function formatWinRange(stats: Pick<ForecastStats, 'ci' | 'sims'>): string | null {
  if (isExactForecast(stats)) return null;
  const [lo, hi] = stats.ci;
  return `likely ${Math.round(lo)}–${formatPct(hi)}`;
}

/** "Win chance ~62 %, likely 39–78 %" for loose estimates; null when the exact number is shown. */
export function forecastRangeLine(stats: Pick<ForecastStats, 'winPct' | 'ci' | 'sims'>): string | null {
  const range = formatWinRange(stats);
  return range ? `Win chance ${formatWinPct(stats)}, ${range}` : null;
}

/** "~0:12", "~4:50", "~23 min", "~1 h 20 min"; empty for missing values. */
export function formatApproxDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `~0:${String(seconds).padStart(2, '0')}`;
  if (seconds < 600) {
    const rounded = Math.round(seconds / 10) * 10;
    return `~${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 5) * 5;
  if (rest === 0) return `~${hours} h`;
  if (rest === 60) return `~${hours + 1} h`;
  return `~${hours} h ${rest} min`;
}

function outOfTen(pct: number): number {
  return Math.round(Math.max(0, Math.min(100, pct)) / 10);
}

function roomHeadline(pct: number): string {
  const n = outOfTen(pct);
  if (n >= 10) return pct >= 99.5 ? 'Wins every fight' : 'Wins nearly every fight';
  if (n <= 0) return pct < 0.5 ? 'Loses every fight' : 'Wins almost no fights';
  return `Wins ~${n} in 10 fights`;
}

function dungeonHeadline(pct: number): string {
  const n = outOfTen(pct);
  if (n >= 10) return pct >= 99.5 ? 'Clears every run' : 'Clears nearly every run';
  if (n <= 0) return pct < 0.5 ? "Can't clear it yet" : 'Almost never clears';
  return `Clears ~${n} in 10 runs`;
}

/** Remaining time of a live fight: median win time minus time already fought. */
export function forecastRemainingMs(result: Pick<ForecastStats, 'medianMs'>, elapsedMs: number): number | null {
  if (result.medianMs === null || !Number.isFinite(elapsedMs)) return null;
  return Math.max(0, result.medianMs - elapsedMs);
}

/**
 * Room: "Wins ~9 in 10 fights · ~0:12 each"; dungeon: "Clears ~7 in 10 runs · ~12 min each";
 * battle: "62 % to win this attempt · ~1:40 left" (remaining time only when `elapsedMs` is given).
 */
export function forecastHeadline(
  result: Pick<ForecastStats, 'winPct' | 'ci' | 'sims' | 'medianMs'>,
  kind: ForecastKind,
  elapsedMs?: number,
): string {
  if (kind === 'battle') {
    const head = `${formatWinPct(result)} to win this attempt`;
    const left = elapsedMs === undefined ? null : forecastRemainingMs(result, elapsedMs);
    return left === null ? head : `${head} · ${formatApproxDuration(left)} left`;
  }
  const head = kind === 'room' ? roomHeadline(result.winPct) : dungeonHeadline(result.winPct);
  const each = formatApproxDuration(result.medianMs);
  return each && result.winPct >= 0.5 ? `${head} · ${each} each` : head;
}

export function forecastSampleLine(result: Pick<ForecastStats, 'sims'>, kind: ForecastKind): string {
  const noun = kind === 'dungeon' ? 'run' : 'fight';
  return `Estimate from ${result.sims} simulated ${noun}${result.sims === 1 ? '' : 's'}`;
}

/** "1 in 3 fights here are Bandits: wins 41 %". */
export function worstStratumLine(worst: NonNullable<ForecastResult['worst']>): string {
  const share = Math.max(0, worst.sharePct);
  const lead = share >= 67
    ? 'Most fights here are'
    : `1 in ${Math.max(2, Math.round(100 / Math.max(1, share)))} fights here are`;
  return `${lead} ${worst.label}: wins ${formatPct(worst.winPct)}`;
}

export function autoRetreatLine(belowPct: number | null | undefined): string {
  return belowPct ? `Auto-retreat: below ${formatPct(belowPct)}` : 'Auto-retreat: off';
}

/** A result is stale when the party's forecast inputs changed since it was computed. */
export function isForecastStale(result: Pick<ForecastResult, 'partyKey'>, forecastKey: string | null | undefined): boolean {
  return !!forecastKey && result.partyKey !== forecastKey;
}

/** Enemy level range, only for authored levels ("L8–10"); derived levels are never shown. */
export function formatEnemyLevels(result: Pick<ForecastResult, 'enemyLevels' | 'enemyLevelsDerived'>): string | null {
  if (!result.enemyLevels || result.enemyLevelsDerived) return null;
  const [lo, hi] = result.enemyLevels;
  return lo === hi ? `L${lo}` : `L${lo}–${hi}`;
}

export function forecastAriaLabel(result: Pick<ForecastStats, 'winPct' | 'ci' | 'sims'>, kind: ForecastKind): string {
  const { label } = forecastVerdict(result, kind);
  const approx = isExactForecast(result) ? '' : 'about ';
  return `Win chance ${approx}${formatPct(result.winPct)}, ${label}`;
}

export interface DungeonResumePoint {
  floorIndex: number;
  phase: number;
  wipes: number;
}

/** Reads the start point a dungeon forecast was computed from (`…dungeon:<id>:<floorIdx>:<phase>:<wipes>`). */
export function parseDungeonResume(key: string | null | undefined): DungeonResumePoint | null {
  if (!key) return null;
  const segment = key.slice(key.lastIndexOf('|') + 1);
  if (!segment.startsWith('dungeon:')) return null;
  const parts = segment.split(':');
  if (parts.length < 5) return null;
  const [floorIndex, phase, wipes] = parts.slice(-3).map(p => Number(p));
  if (![floorIndex, phase, wipes].every(n => Number.isInteger(n) && n >= 0)) return null;
  return { floorIndex, phase, wipes };
}

/** "Resume: Floor 3 · Checkpoint 2"; null for a fresh start. */
export function formatResumeMarker(point: Pick<DungeonResumePoint, 'floorIndex' | 'phase'> | null): string | null {
  if (!point || (point.floorIndex <= 0 && point.phase <= 0)) return null;
  const floor = `Floor ${point.floorIndex + 1}`;
  return point.phase > 0 ? `Resume: ${floor} · Checkpoint ${point.phase}` : `Resume: ${floor}`;
}
