import type { ClassName } from './CharacterStats.js';
import { getSkillTrigger } from './SkillTypes.js';
import type { SkillDefinition } from './SkillTypes.js';
import { COMBAT_STEP_MS } from './CombatTiming.js';

/**
 * How fast combat plays. Content and the engine's numbers stay in authored time, and `clock` stretches them all
 * together. See docs/architecture/combat.md.
 */
export interface CombatPace {
  /** Real seconds per authored second, for every combat timer. */
  clock: number;
  /** Real seconds between a class's actions, snapped to whole steps (see paceKit). A class left out acts once per authored second. */
  classSeconds: Partial<Record<ClassName, number>>;
  /** A player's cast adds to the wait before their next action instead of being absorbed by it. */
  castsAddTime: boolean;
  /** Applied to XP, gold and drop chances, since slower fights mean fewer kills per hour. */
  rewardMultiplier: number;
}

/** Plays content exactly as written. What the engine uses unless told otherwise, so its tests read in authored time. */
export const AUTHORED_PACE: CombatPace = { clock: 1, classSeconds: {}, castsAddTime: false, rewardMultiplier: 1 };

/** The game's pace. Every real fight, forecast and reward uses this. Keep Priest equal to the clock: see docs/architecture/combat.md. */
export const COMBAT_PACE: CombatPace = {
  clock: 1.8,
  classSeconds: { Knight: 3.6, Archer: 2, Priest: 1.8, Mage: 2.5, Bard: 2.5 },
  castsAddTime: true,
  rewardMultiplier: 1.8,
};

/** At or above this a drop stays as authored, and lower ones scale only up to it, so a rarer drop never passes a commoner one. */
const PACE_DROP_CHANCE_FLOOR = 0.5;

/** A class's actions relative to the clock, snapped to tenths so every action lands on a whole step. See docs/architecture/combat.md. */
export function paceKit(pace: CombatPace, className: string): number {
  const seconds = pace.classSeconds[className as ClassName];
  return seconds === undefined ? 1 : Math.round((seconds / pace.clock) * 10) / 10;
}

/** Real seconds between a class's actions. */
export function paceActionSeconds(pace: CombatPace, className: string): number {
  return Math.round(paceKit(pace, className) * pace.clock * 100) / 100;
}

export function paceRealMs(pace: CombatPace, engineMs: number): number {
  return pace.clock === 1 ? engineMs : Math.round(engineMs * pace.clock);
}

/** Engine time for real seconds, on the step grid: nearest step, and a nonzero time stays at least one. */
export function paceEngineMs(pace: CombatPace, realSeconds: number): number {
  if (!(realSeconds > 0)) return 0;
  return Math.max(1, Math.round((realSeconds / pace.clock) * 1000 / COMBAT_STEP_MS)) * COMBAT_STEP_MS;
}

export function paceDropChance(pace: CombatPace, chance: number): number {
  if (pace.rewardMultiplier === 1 || chance >= PACE_DROP_CHANCE_FLOOR) return chance;
  return Math.min(PACE_DROP_CHANCE_FLOOR, chance * pace.rewardMultiplier);
}

/** Real seconds for a skill's authored seconds: actions keep to the class's pace, reactions to the clock. */
export function paceSkillSeconds(pace: CombatPace, skill: SkillDefinition, className: string, seconds: number): number {
  return seconds * (getSkillTrigger(skill) ? pace.clock : paceActionSeconds(pace, className));
}

/** What an authored damage number hits for in play, for showing players. */
export function paceHitDamage(pace: CombatPace, className: string, damage: number): number {
  return Math.round(damage * paceKit(pace, className));
}
