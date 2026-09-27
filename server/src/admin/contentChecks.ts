import { MONSTER_TIERS, isBossTier } from '@idle-party-rpg/shared';
import type { DungeonFloor, EncounterDefinition, MonsterDefinition } from '@idle-party-rpg/shared';

/** Range checks for level/tier/enrage and dungeon checkpoint fields, shared by the admin routes and validate_draft. */

export const MONSTER_LEVEL_MIN = 1;
export const MONSTER_LEVEL_MAX = 200;
export const ENRAGE_LIMITS = {
  afterSeconds: { min: 0, max: 86_400 },
  stepSeconds: { min: 1, max: 3_600 },
  stepPercent: { min: 0, max: 1 },
  maxStacks: { min: 0, max: 1_000 },
} as const;
export const MAX_WIPES_LIMIT = 20;

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

/** Range checks for one floor's checkpoints, maxWipes and checkpointRewardFraction. */
export function floorCheckpointProblems(floor: DungeonFloor, label: string): string[] {
  const problems: string[] = [];
  const checkpoints: unknown = floor.checkpoints;
  if (checkpoints !== undefined) {
    if (!Array.isArray(checkpoints)) {
      problems.push(`${label} checkpoints must be an array of boss-HP fractions.`);
    } else {
      const valid = checkpoints.every(f => typeof f === 'number' && Number.isFinite(f) && f > 0 && f < 1);
      const descending = checkpoints.every((f, i) => i === 0 || f < checkpoints[i - 1]);
      if (!valid || !descending) {
        problems.push(`${label} checkpoints must be boss-HP fractions strictly between 0 and 1 in descending order, e.g. [0.66, 0.33] (got ${JSON.stringify(checkpoints)}).`);
      }
    }
  }
  if (floor.maxWipes !== undefined && !isIntegerInRange(floor.maxWipes, 0, MAX_WIPES_LIMIT)) {
    problems.push(`${label} maxWipes must be a whole number from 0 to ${MAX_WIPES_LIMIT} (got ${String(floor.maxWipes)}).`);
  }
  if (floor.checkpointRewardFraction !== undefined && !isNumberInRange(floor.checkpointRewardFraction, 0, 1)) {
    problems.push(`${label} checkpointRewardFraction must be a number from 0 to 1 (got ${String(floor.checkpointRewardFraction)}).`);
  }
  return problems;
}

/** A checkpoint floor must only roll explicit encounters that place a boss- or raid-tier monster. */
export function checkpointEncounterProblems(
  floor: DungeonFloor,
  label: string,
  encounters: ReadonlyMap<string, EncounterDefinition>,
  monsters: ReadonlyMap<string, MonsterDefinition>,
): string[] {
  if (!Array.isArray(floor.checkpoints) || floor.checkpoints.length === 0) return [];
  const table = Array.isArray(floor.encounterTable) ? floor.encounterTable : [];
  if (table.length === 0) {
    return [`${label} has checkpoints but no encounter table — checkpoint floors need an explicit encounter with a boss- or raid-tier monster.`];
  }
  const problems: string[] = [];
  for (const entry of table) {
    const encounter = encounters.get(entry.encounterId);
    if (!encounter) continue;
    if (encounter.type !== 'explicit') {
      problems.push(`${label} has checkpoints, so its encounter '${encounter.id}' must be 'explicit' (random pools can roll zero or several bosses).`);
      continue;
    }
    const hasBoss = (encounter.placements ?? []).some(p => isBossTier(monsters.get(p.monsterId)?.tier));
    if (!hasBoss) {
      problems.push(`${label} has checkpoints, but its encounter '${encounter.id}' places no boss- or raid-tier monster.`);
    }
  }
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
