import type { MonsterTier } from './MonsterTypes.js';

export interface MasteryEntry {
  monsterId: string;
  name: string;
  level?: number;
  levelDerived?: boolean;
  tier?: MonsterTier;
  kills: number;
  rank: number;
  maxRank: number;
  nextAt: number | null;
  prevAt: number;
  bonusPct: number;
}

export interface MasterySummary {
  discovered: number;
  mastered: number;
  /** Bumps whenever any kill count changes; clients refetch the bestiary when it moves. */
  version: number;
  recent: MasteryEntry[];
}

export interface MasteryMonsterInfo {
  name: string;
  level?: number;
  levelDerived?: boolean;
  tier?: MonsterTier;
}

export const MASTERY_THRESHOLDS: Record<MonsterTier, readonly number[]> = {
  trash: [10, 50, 250, 1500, 10000],
  elite: [5, 20, 75, 300, 1000],
  boss: [1, 3, 10, 25, 60],
  raid: [1, 2, 4, 8, 15],
};

export const MASTERY_BONUS_PER_RANK = 0.02;
export const MASTERY_MAX_RANK = 5;
/** Trash rank-ups below this only reach the journal; other tiers always get a toast/recap moment. */
export const MASTERY_TRASH_MOMENT_MIN_RANK = 2;

function thresholdsFor(tier: MonsterTier | undefined): readonly number[] {
  return MASTERY_THRESHOLDS[tier ?? 'trash'] ?? MASTERY_THRESHOLDS.trash;
}

export function masteryRank(kills: number, tier?: MonsterTier): number {
  if (!Number.isFinite(kills) || kills <= 0) return 0;
  let rank = 0;
  for (const at of thresholdsFor(tier)) {
    if (kills < at) break;
    rank++;
  }
  return rank;
}

export function nextMasteryAt(kills: number, tier?: MonsterTier): number | null {
  const thresholds = thresholdsFor(tier);
  return thresholds[masteryRank(kills, tier)] ?? null;
}

export function prevMasteryAt(kills: number, tier?: MonsterTier): number {
  const rank = masteryRank(kills, tier);
  return rank > 0 ? thresholdsFor(tier)[rank - 1] : 0;
}

/** Fraction added to damage dealt to (and removed from damage taken from) a monster of this rank. */
export function masteryBonus(rank: number): number {
  return Math.max(0, Math.min(MASTERY_MAX_RANK, Math.floor(rank))) * MASTERY_BONUS_PER_RANK;
}

export function isMasteryMoment(rank: number, tier?: MonsterTier): boolean {
  if (rank <= 0) return false;
  return (tier ?? 'trash') !== 'trash' || rank >= MASTERY_TRASH_MOMENT_MIN_RANK;
}

export function buildMasteryEntry(monsterId: string, kills: number, info: MasteryMonsterInfo): MasteryEntry {
  const rank = masteryRank(kills, info.tier);
  const entry: MasteryEntry = {
    monsterId,
    name: info.name,
    kills,
    rank,
    maxRank: thresholdsFor(info.tier).length,
    nextAt: nextMasteryAt(kills, info.tier),
    prevAt: prevMasteryAt(kills, info.tier),
    bonusPct: Math.round(masteryBonus(rank) * 100),
  };
  if (info.level !== undefined) entry.level = info.level;
  if (info.levelDerived) entry.levelDerived = true;
  if (info.tier) entry.tier = info.tier;
  return entry;
}

/**
 * Monster id → rank, keeping only ranks ≥ 1 (the engine's `PartyCombatantInit.mastery` input).
 * Prototype-free, so ids such as `__proto__` or `constructor` are plain keys.
 */
export function masteryRanks(
  kills: Record<string, number>,
  tierOf: (monsterId: string) => MonsterTier | undefined,
): Record<string, number> {
  const ranks = Object.create(null) as Record<string, number>;
  for (const [id, count] of Object.entries(kills)) {
    const rank = masteryRank(count, tierOf(id));
    if (rank > 0) ranks[id] = rank;
  }
  return ranks;
}
