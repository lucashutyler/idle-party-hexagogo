import type { MonsterEnrage, MonsterTier } from './MonsterTypes.js';
import { COMBAT_STEP_MS } from './CombatTiming.js';
import { masteryBonus } from './Mastery.js';

/** Rating per attacker level that gives 50 % mitigation. */
export const ARMOR_K = 4;
/** Guard/Bless rating = SKILL_RATING_SCALE × valuePerLevel × level. */
export const SKILL_RATING_SCALE = 2;
export const MAX_MITIGATION = 0.8;
export const MAX_PERCENT_RESIST = 0.75;
export const LEVEL_GAP_SLOPE = 0.05;
export const GAP_LEVEL_OFFSET = 40;
export const LEVEL_GAP_MIN = 0.5;
export const LEVEL_GAP_MAX = 1.5;
export const MAX_ENEMY_DAMAGE_REDUCTION = 0.6;
export const MAX_DODGE = 0.5;
export const FOCUS_MAX_STACKS = 5;
export const SUNDER_MAX_STACKS = 3;
export const WAR_SONG_MAX_STACKS = 5;
export const IGNITE_MAX_STACKS = 8;

export const ENRAGE_STEP_SECONDS = 30;
export const ENRAGE_STEP_PERCENT = 0.10;
export const ENRAGE_MAX_STACKS = 30;
export const ENRAGE_TIER_DEFAULTS: Partial<Record<MonsterTier, MonsterEnrage>> = {
  boss: { afterSeconds: 480 },
  raid: { afterSeconds: 3600 },
};

/** A combatant's level and whether it may drive level-relative scaling (authored) or not (derived). */
export interface CombatLevel {
  level: number;
  derived: boolean;
  /** Estimated from damage output (unauthored monster); never used to judge mitigation. */
  estimated?: boolean;
}

/** Enrage config resolved to engine units. */
export interface ResolvedEnrage {
  afterMs: number;
  stepMs: number;
  stepPercent: number;
  maxStacks: number;
}

export function sanitizeLevel(level: number | undefined): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) return 1;
  return Math.max(1, level);
}

/** min(MAX_MITIGATION, R / (R + ARMOR_K × max(1, L))); negative or non-finite ratings count as 0. */
export function ratingMitigation(rating: number, attackerLevel: number): number {
  const r = Number.isFinite(rating) && rating > 0 ? rating : 0;
  if (r === 0) return 0;
  return Math.min(MAX_MITIGATION, r / (r + ARMOR_K * sanitizeLevel(attackerLevel)));
}

/** Mitigation a Guard/Bless value gives its owner against a same-level attacker (level-independent). */
export function skillRatingMitigation(valuePerLevel: number, level = 1): number {
  const l = sanitizeLevel(level);
  return ratingMitigation(SKILL_RATING_SCALE * valuePerLevel * l, l);
}

/** clamp(1 + slope × (Llo + offset)/(offset + 10) × (a − d), MIN, MAX) with Llo = min(a, d). */
export function levelGapMultiplier(attackerLevel: number, defenderLevel: number): number {
  const a = sanitizeLevel(attackerLevel);
  const d = sanitizeLevel(defenderLevel);
  const slope = LEVEL_GAP_SLOPE * (Math.min(a, d) + GAP_LEVEL_OFFSET) / (GAP_LEVEL_OFFSET + 10);
  return Math.min(LEVEL_GAP_MAX, Math.max(LEVEL_GAP_MIN, 1 + slope * (a - d)));
}

/**
 * Gap multiplier and the level mitigation is judged against. A derived level on either side disables the gap;
 * mitigation uses the attacker's level unless it is an estimate, then the defender's.
 */
export function pairScaling(attacker: CombatLevel, defender: CombatLevel): { gap: number; mitigationLevel: number } {
  const gap = attacker.derived || defender.derived ? 1 : levelGapMultiplier(attacker.level, defender.level);
  return { gap, mitigationLevel: attacker.estimated ? defender.level : attacker.level };
}

/** A percent resist (0–100 scale) as a damage factor, clamped to [minPercent, MAX_PERCENT_RESIST]. */
export function percentResistFactor(percent: number | undefined, minPercent = 0): number {
  const fraction = typeof percent === 'number' && Number.isFinite(percent) ? percent / 100 : 0;
  return 1 - Math.min(MAX_PERCENT_RESIST, Math.max(minPercent, fraction));
}

/** Keeps float noise (100 × (1 − 0.8) = 19.999…) from flooring a whole number down. */
const FLOOR_TOLERANCE = 1 + 1e-12;

/** floor(raw × factor), at least 1 for raw ≥ 1; anything below 1 (0, NaN) deals 0. */
export function scaleDamage(raw: number, factor: number): number {
  if (!(raw >= 1)) return 0;
  const f = Number.isFinite(factor) && factor > 0 ? factor : 0;
  return Math.max(1, Math.floor(raw * f * FLOOR_TOLERANCE));
}


/** Damage multiplier from a kill-mastery rank: dealt × (1 + bonus), taken × (1 − bonus). */
export function masteryFactor(rank: number | undefined, side: 'dealt' | 'taken'): number {
  if (typeof rank !== 'number' || !Number.isFinite(rank)) return 1;
  const bonus = masteryBonus(rank);
  return side === 'dealt' ? 1 + bonus : 1 - bonus;
}

export function isBossTier(tier: MonsterTier | undefined): boolean {
  return tier === 'boss' || tier === 'raid';
}

/** The explicit enrage, else the tier default; null when the monster never enrages. */
export function resolveEnrage(tier: MonsterTier | undefined, enrage: MonsterEnrage | undefined): ResolvedEnrage | null {
  const config = validEnrage(enrage) ? enrage : ENRAGE_TIER_DEFAULTS[tier ?? 'trash'];
  if (!config || !validEnrage(config)) return null;
  const stepSeconds = positiveOr(config.stepSeconds, ENRAGE_STEP_SECONDS);
  return {
    afterMs: Math.round(config.afterSeconds * 1000),
    stepMs: Math.max(COMBAT_STEP_MS, Math.round(stepSeconds * 1000)),
    stepPercent: nonNegativeOr(config.stepPercent, ENRAGE_STEP_PERCENT),
    maxStacks: Math.floor(nonNegativeOr(config.maxStacks, ENRAGE_MAX_STACKS)),
  };
}

/** Stacks at `elapsedMs` for a clock that fires its first stack at `atMs`. */
export function enrageStacksAt(enrage: { atMs: number; stepMs: number; maxStacks: number }, elapsedMs: number): number {
  if (elapsedMs < enrage.atMs || enrage.maxStacks <= 0) return 0;
  return Math.min(enrage.maxStacks, 1 + Math.floor((elapsedMs - enrage.atMs) / enrage.stepMs));
}

function validEnrage(enrage: MonsterEnrage | undefined): enrage is MonsterEnrage {
  return !!enrage && typeof enrage.afterSeconds === 'number' && Number.isFinite(enrage.afterSeconds) && enrage.afterSeconds >= 0;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
