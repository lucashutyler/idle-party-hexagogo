import type { DamageType } from './CharacterStats.js';

// --- Types ---

export interface MonsterSkillDefinition {
  id: string;
  name: string;
  description: string;
  damageType?: DamageType;
  targeting: 'aoe_all' | 'lowest_hp_enemy' | 'lowest_hp_ally' | 'all_class';
  targetClasses?: string[];
  effect: 'damage' | 'stun' | 'dot' | 'heal';
  dotDuration?: number;
  cooldown: number;
}

// --- Monster Skill Catalog ---

export const MONSTER_SKILL_CATALOG: Record<string, MonsterSkillDefinition> = {
  fireball: {
    id: 'fireball',
    name: 'Fireball',
    description: 'Deals magical damage to all enemies',
    damageType: 'magical',
    targeting: 'aoe_all',
    effect: 'damage',
    cooldown: 3,
  },
  fear: {
    id: 'fear',
    name: 'Fear',
    description: 'Stuns all archers and mages for 1 turn',
    targeting: 'all_class',
    targetClasses: ['Archer', 'Mage'],
    effect: 'stun',
    cooldown: 3,
  },
  rot: {
    id: 'rot',
    name: 'Rot',
    description: 'Applies a stacking magical DoT to the weakest enemy',
    damageType: 'magical',
    targeting: 'lowest_hp_enemy',
    effect: 'dot',
    dotDuration: 3,
    cooldown: 2,
  },
  heal: {
    id: 'heal',
    name: 'Heal',
    description: 'Heals the ally with the lowest HP',
    targeting: 'lowest_hp_ally',
    effect: 'heal',
    cooldown: 2,
  },
  assassinate: {
    id: 'assassinate',
    name: 'Assassinate',
    description: 'Deals heavy physical damage to the weakest enemy',
    damageType: 'physical',
    targeting: 'lowest_hp_enemy',
    effect: 'damage',
    cooldown: 5,
  },
};
