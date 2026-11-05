export type ForecastTarget =
  | { kind: 'room'; tileId: string }
  | { kind: 'dungeon'; dungeonId: string }
  | { kind: 'battle'; battleId: number };

/** Targets a client may request; live battle forecasts are server-pushed only. */
export type ForecastRequestTarget = Exclude<ForecastTarget, { kind: 'battle' }>;

export type ForecastStatus = 'ok' | 'pending' | 'unavailable' | 'denied';

export type ForecastReasonCode =
  | 'level_gap'
  | 'no_interrupt'
  | 'no_cleanse'
  | 'no_healer'
  | 'enrage'
  | 'worst_encounter'
  | 'stalemate'
  | 'needs_group'
  | 'outlevel';

export interface ForecastReason {
  code: ForecastReasonCode | (string & {});
  tone: 'good' | 'bad' | 'info';
  text: string;
}

export interface ForecastStats {
  sims: number;
  wins: number;
  losses: number;
  stalemates: number;
  winPct: number;
  /** Wilson 95 % interval on winPct, in percentage points. */
  ci: [number, number];
  /** Over victories only, from battle start; null when wins < 3. */
  medianMs: number | null;
  p90Ms: number | null;
  /** Clone point (0 for a fresh fight). */
  atMs: number;
  /** Median elapsed × boss HP at start / boss damage dealt (extrapolated for losses). */
  killEtaMs: number | null;
}

export interface ForecastFloor {
  /** 1-based position in the dungeon's floor list (not the authored floorNumber). */
  floor: number;
  winPct: number;
  boss?: boolean;
  attempts?: number;
}

export interface ForecastStratum {
  label: string;
  entryId: string;
  winPct: number;
  sharePct: number;
}

export interface ForecastResult extends ForecastStats {
  key: string;
  partyKey: string;
  /** Dungeons with checkpoints: boss won on the first attempt. */
  firstTryPct?: number;
  floors?: ForecastFloor[];
  strata?: ForecastStratum[];
  /** Lowest stratum with a share ≥ 10 %. */
  worst?: { label: string; winPct: number; sharePct: number };
  /** Level range of the enemies with an authored level. */
  enemyLevels?: [number, number];
  /** Some enemies have no authored level and are left out of `enemyLevels`. */
  someUnrated?: boolean;
  /** At most 3. */
  reasons: ForecastReason[];
}

export type AutoRetreatPct = 0 | 25 | 40 | 60;

export interface CombatPrefs {
  autoRetreatBelowPct: AutoRetreatPct;
}

/** The auto-retreat policy in effect for a party (its owner's setting). */
export interface PartyAutoRetreatInfo {
  belowPct: AutoRetreatPct;
  setBy: string;
}

export const AUTO_RETREAT_OPTIONS: readonly AutoRetreatPct[] = [0, 25, 40, 60];

export const DEFAULT_COMBAT_PREFS: Readonly<CombatPrefs> = { autoRetreatBelowPct: 25 };

export function isAutoRetreatPct(value: unknown): value is AutoRetreatPct {
  return typeof value === 'number' && (AUTO_RETREAT_OPTIONS as readonly number[]).includes(value);
}

export function sanitizeCombatPrefs(raw: unknown): CombatPrefs {
  const pct = (raw as { autoRetreatBelowPct?: unknown } | null | undefined)?.autoRetreatBelowPct;
  return { autoRetreatBelowPct: isAutoRetreatPct(pct) ? pct : DEFAULT_COMBAT_PREFS.autoRetreatBelowPct };
}
