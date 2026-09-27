import type { DamageType } from './CharacterStats.js';
import type { MonsterSkillEntry } from './MonsterTypes.js';
import { COMBAT_STEP_MS } from './CombatTiming.js';

// --- Types ---

export interface MonsterSkillDefinition {
  id: string;
  name: string;
  description: string;
  damageType?: DamageType;
  targeting: 'standard' | 'aoe_all' | 'lowest_hp_enemy' | 'lowest_hp_ally' | 'all_class';
  targetClasses?: string[];
  effect: 'damage' | 'stun' | 'dot' | 'heal';
  /** DoT pulses (one per second). */
  dotDuration?: number;
  /** Default cooldown in seconds offered by the admin editor; the engine reads the entry's. */
  cooldown: number;
  /** Default telegraphed wind-up in seconds; an entry's `castTime` overrides it. */
  castTime?: number;
}

// --- Monster Skill Catalog ---

export const MONSTER_SKILL_CATALOG: Record<string, MonsterSkillDefinition> = {
  fireball: {
    id: 'fireball',
    name: 'Fireball',
    description: 'Casts for 1.5 seconds, then deals magical damage to all enemies',
    damageType: 'magical',
    targeting: 'aoe_all',
    effect: 'damage',
    cooldown: 3,
    castTime: 1.5,
  },
  fear: {
    id: 'fear',
    name: 'Fear',
    description: 'Stuns all archers and mages for 1 second',
    targeting: 'all_class',
    targetClasses: ['Archer', 'Mage'],
    effect: 'stun',
    cooldown: 3,
    castTime: 1.0,
  },
  rot: {
    id: 'rot',
    name: 'Rot',
    description: 'Applies a stacking magical DoT to the target in front',
    damageType: 'magical',
    targeting: 'standard',
    effect: 'dot',
    dotDuration: 3,
    cooldown: 2,
    castTime: 0,
  },
  heal: {
    id: 'heal',
    name: 'Heal',
    description: 'Casts for 1 second, then heals the ally with the lowest HP (itself included)',
    targeting: 'lowest_hp_ally',
    effect: 'heal',
    cooldown: 2,
    castTime: 1.0,
  },
  assassinate: {
    id: 'assassinate',
    name: 'Assassinate',
    description: 'Takes aim at the weakest enemy for 1 second, then deals heavy physical damage to it',
    damageType: 'physical',
    targeting: 'lowest_hp_enemy',
    effect: 'damage',
    cooldown: 5,
    castTime: 1.0,
  },
};

/** Effective wind-up of a monster's skill entry in milliseconds (entry override, else catalog default). */
export function getMonsterSkillCastTimeMs(entry: MonsterSkillEntry, def?: MonsterSkillDefinition): number {
  const seconds = entry.castTime ?? def?.castTime ?? MONSTER_SKILL_CATALOG[entry.skillId]?.castTime ?? 0;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.ceil(Math.round(seconds * 1000) / COMBAT_STEP_MS) * COMBAT_STEP_MS;
}
