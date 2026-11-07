import { MONSTER_TIERS } from '@idle-party-rpg/shared';
import type { MonsterDefinition } from '@idle-party-rpg/shared';

/** Range checks for level/tier/enrage, shared by the admin routes and validate_draft. */

export const MONSTER_LEVEL_MIN = 1;
export const MONSTER_LEVEL_MAX = 200;
export const ENRAGE_LIMITS = {
  afterSeconds: { min: 0, max: 86_400 },
  stepSeconds: { min: 1, max: 3_600 },
  stepPercent: { min: 0, max: 1 },
  maxStacks: { min: 0, max: 1_000 },
} as const;

export function monsterScalingProblems(monster: MonsterDefinition): string[] {
  const problems: string[] = [];
  const label = `Monster '${monster.id}'`;
  if (monster.level !== undefined && !isIntegerInRange(monster.level, MONSTER_LEVEL_MIN, MONSTER_LEVEL_MAX)) {
    problems.push(`${label} level must be a whole number from ${MONSTER_LEVEL_MIN} to ${MONSTER_LEVEL_MAX}, or omitted for no level scaling (got ${String(monster.level)}).`);
  }
  if (monster.tier !== undefined && !(MONSTER_TIERS as readonly unknown[]).includes(monster.tier)) {
    problems.push(`${label} tier must be one of ${MONSTER_TIERS.join(', ')} (got ${String(monster.tier)}).`);
  }
  if (monster.enrage !== undefined) problems.push(...enrageProblems(monster.enrage, label));
  return problems;
}

function enrageProblems(enrage: unknown, label: string): string[] {
  if (typeof enrage !== 'object' || enrage === null || Array.isArray(enrage)) {
    return [`${label} enrage must be an object {afterSeconds, stepSeconds?, stepPercent?, maxStacks?}.`];
  }
  const problems: string[] = [];
  const fields = enrage as Record<string, unknown>;
  for (const key of Object.keys(ENRAGE_LIMITS) as (keyof typeof ENRAGE_LIMITS)[]) {
    const value = fields[key];
    if (value === undefined && key !== 'afterSeconds') continue;
    const { min, max } = ENRAGE_LIMITS[key];
    const ok = key === 'maxStacks' ? isIntegerInRange(value, min, max) : isNumberInRange(value, min, max);
    if (!ok) {
      const unit = key === 'stepPercent' ? ' (a fraction: 0.1 = +10 % damage per stack)' : key === 'maxStacks' ? '' : ' seconds';
      problems.push(`${label} enrage.${key} must be ${key === 'maxStacks' ? 'a whole number' : 'a number'} from ${min} to ${max}${unit} (got ${String(value)}).`);
    }
  }
  return problems;
}

function isNumberInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return isNumberInRange(value, min, max) && Number.isInteger(value);
}
