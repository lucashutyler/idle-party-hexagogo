import { wilsonInterval } from '@idle-party-rpg/shared';
import type { ForecastResult, ForecastStratum, HexTile } from '@idle-party-rpg/shared';

/** Battles remembered for the "too many skips here" relocation rule. */
export const AUTO_RETREAT_SKIP_WINDOW = 10;
export const AUTO_RETREAT_SKIPS_TO_RELOCATE = 3;

export type AutoRetreatDecision =
  | { kind: 'none' }
  | { kind: 'skip'; winPct: number }
  | { kind: 'relocate'; winPct: number };

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
  if (!(belowPct > 0) || !(room.sims > 0)) return { kind: 'none' };
  if (room.ci[1] < belowPct) return { kind: 'relocate', winPct: room.winPct };
  const stratum = rolledEntryId === null ? undefined : room.strata?.find(s => s.entryId === rolledEntryId);
  if (!stratum || stratumUpperPct(stratum, room.sims) >= belowPct) return { kind: 'none' };
  if (recentSkips + 1 >= AUTO_RETREAT_SKIPS_TO_RELOCATE) return { kind: 'relocate', winPct: stratum.winPct };
  return { kind: 'skip', winPct: stratum.winPct };
}

/** The previous room when it is safe enough, else the neighbour with the best forecast (unknown rooms last). */
export function pickRetreatTarget(candidates: readonly RetreatCandidate[], belowPct: number): HexTile | null {
  const safe = candidates.filter(c => c.forecast === null || c.forecast.winPct >= belowPct);
  const previous = safe.find(c => c.previous);
  if (previous) return previous.tile;
  let best: RetreatCandidate | null = null;
  for (const c of safe) {
    if (!best || score(c) > score(best)) best = c;
  }
  return best?.tile ?? null;
}

function score(c: RetreatCandidate): number {
  return c.forecast ? c.forecast.winPct : -1;
}
