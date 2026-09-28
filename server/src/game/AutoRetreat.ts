import { wilsonInterval } from '@idle-party-rpg/shared';
import type { ForecastResult, ForecastStratum, HexTile } from '@idle-party-rpg/shared';

/** Battles remembered for the "too many skips here" relocation rule. */
export const AUTO_RETREAT_SKIP_WINDOW = 10;
export const AUTO_RETREAT_SKIPS_TO_RELOCATE = 3;

/** Why a party relocates: the whole room is too dangerous, or lost-cause fights kept coming up in it. */
export type RelocateCause = 'room' | 'skips';

export type AutoRetreatDecision =
  | { kind: 'none' }
  /** The forecast has no rate for the rolled entry: neither skippable nor known to be safe. */
  | { kind: 'unknown' }
  | { kind: 'skip'; winPct: number }
  | { kind: 'relocate'; winPct: number; cause: RelocateCause };

export type RetreatTargetPick =
  | { kind: 'target'; tile: HexTile }
  /** No room is known to be safe yet; these still need a forecast. */
  | { kind: 'wait'; unknown: RetreatCandidate[] }
  | { kind: 'none' };

export interface RetreatCandidate {
  tile: HexTile;
  /** Cached room forecast for this party, null when unknown. */
  forecast: ForecastResult | null;
  /** The room the party walked in from. */
  previous: boolean;
}

/** Upper end (percent) of the 95 % interval for one table entry, sized by its share of the sims. */
export function stratumUpperPct(stratum: ForecastStratum, sims: number): number {
  const n = Math.max(1, Math.floor((stratum.sharePct / 100) * sims));
  return wilsonInterval(stratum.winPct / 100, n)[1] * 100;
}

/**
 * What auto-retreat does about this fight, from the room's forecast. Every trigger needs the
 * interval's upper bound under the threshold. See docs/architecture/combat.md (auto-retreat).
 */
export function decideAutoRetreat(
  room: ForecastResult,
  rolledEntryId: string | null,
  belowPct: number,
  recentSkips: number,
): AutoRetreatDecision {
  if (!(belowPct > 0)) return { kind: 'none' };
  if (!(room.sims > 0)) return { kind: 'unknown' };
  if (room.ci[1] < belowPct) return { kind: 'relocate', winPct: room.winPct, cause: 'room' };
  const stratum = rolledEntryId === null ? undefined : room.strata?.find(s => s.entryId === rolledEntryId);
  if (!stratum) return { kind: 'unknown' };
  if (stratumUpperPct(stratum, room.sims) >= belowPct) return { kind: 'none' };
  if (recentSkips + 1 >= AUTO_RETREAT_SKIPS_TO_RELOCATE) return { kind: 'relocate', winPct: stratum.winPct, cause: 'skips' };
  return { kind: 'skip', winPct: stratum.winPct };
}

/**
 * Only a room known to be safe enough is a target: the previous room when it is, else the best
 * known neighbour. With none known, wait for the unknown rooms' forecasts; with none left, give up.
 */
export function pickRetreatTarget(candidates: readonly RetreatCandidate[], belowPct: number): RetreatTargetPick {
  const safe = candidates.filter(c => c.forecast !== null && c.forecast.winPct >= belowPct);
  const previous = safe.find(c => c.previous);
  if (previous) return { kind: 'target', tile: previous.tile };
  let best: RetreatCandidate | null = null;
  for (const c of safe) {
    if (!best || c.forecast!.winPct > best.forecast!.winPct) best = c;
  }
  if (best) return { kind: 'target', tile: best.tile };
  const unknown = candidates.filter(c => c.forecast === null);
  return unknown.length > 0 ? { kind: 'wait', unknown } : { kind: 'none' };
}
