import type { SkillLoadout } from './SkillTypes.js';
import { createDefaultSkillLoadout } from './SkillTypes.js';

// --- Types ---

export type ClassName = 'Knight' | 'Archer' | 'Priest' | 'Mage' | 'Bard';

export type DamageType = 'physical' | 'magical' | 'holy';

export interface ClassDefinition {
  displayName: string;
  description: string;
  baseHp: number;
  hpPerLevel: number;
  baseDamage: number;
  damagePerLevel: number;
  damageType: DamageType;
}

export interface CharacterState {
  className: ClassName;
  level: number;
  xp: number;
  gold: number;
  inventory: Record<string, number>;
  equipment: Record<string, string | null>;
  skillLoadout: SkillLoadout;
  skillPoints: number;
}

// --- Constants ---

export const CLASS_ICONS: Record<string, string> = {
  Knight: '\uD83D\uDEE1\uFE0F',  // 🛡️ shield
  Archer: '\uD83C\uDFF9',          // 🏹 bow
  Priest: '\u2625\uFE0F',          // ☥ ankh
  Mage: '\uD83E\uDE84',            // 🪄 magic wand
  Bard: '\uD83C\uDFB5',            // 🎵 musical note
};
export const UNKNOWN_CLASS_ICON = '\u2753'; // ❓
export const SERVER_ICON = '\uD83D\uDDA5\uFE0F'; // 🖥️

export const CLASS_DEFINITIONS: Record<ClassName, ClassDefinition> = {
  Knight: {
    displayName: 'Knight',
    description: 'Massive HP pool, low damage. Guard reduces physical damage taken.',
    baseHp: 50,
    hpPerLevel: 5,
    baseDamage: 1,
    damagePerLevel: 1,
    damageType: 'physical',
  },
  Archer: {
    displayName: 'Archer',
    description: 'High physical damage, very low HP. Pierce gives critical hits.',
    baseHp: 8,
    hpPerLevel: 1,
    baseDamage: 15,
    damagePerLevel: 2,
    damageType: 'physical',
  },
  Priest: {
    displayName: 'Priest',
    description: 'Holy damage, moderate HP. Bless reduces magical damage for the party.',
    baseHp: 20,
    hpPerLevel: 2,
    baseDamage: 3,
    damagePerLevel: 1,
    damageType: 'holy',
  },
  Mage: {
    displayName: 'Mage',
    description: 'High magical damage, very low HP. Burn increases damage per level.',
    baseHp: 8,
    hpPerLevel: 1,
    baseDamage: 15,
    damagePerLevel: 2,
    damageType: 'magical',
  },
  Bard: {
    displayName: 'Bard',
    description: 'Low stats, but Rally boosts party damage by 20% per member.',
    baseHp: 10,
    hpPerLevel: 1,
    baseDamage: 1,
    damagePerLevel: 1,
    damageType: 'physical',
  },
};

/** All playable class names. */
export const ALL_CLASS_NAMES: ClassName[] = ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'];

export const MAX_GOLD = 999_999_999;

// --- Pure functions ---

/** Max HP = baseHp + (level - 1) * hpPerLevel. */
export function calculateMaxHp(level: number, className: ClassName): number {
  const def = CLASS_DEFINITIONS[className];
  return def.baseHp + (level - 1) * def.hpPerLevel;
}

/** Base damage = baseDamage + (level - 1) * damagePerLevel. */
export function calculateBaseDamage(level: number, className: ClassName): number {
  const def = CLASS_DEFINITIONS[className];
  return def.baseDamage + (level - 1) * def.damagePerLevel;
}

/** XP required to advance from `level` to `level + 1`. */
export function xpForNextLevel(level: number): number {
  return Math.floor(18000 * Math.pow(level, 1.2) * Math.pow(1.06, level));
}

/** Create a fresh Level 1 character of the given class. */
export function createCharacter(className: ClassName): CharacterState {
  return {
    className,
    level: 1,
    xp: 0,
    gold: 0,
    inventory: {},
    equipment: { head: null, shoulders: null, chest: null, bracers: null, gloves: null, mainhand: null, offhand: null, foot: null, ring: null, necklace: null, back: null, relic: null },
    skillLoadout: createDefaultSkillLoadout(className),
    skillPoints: 0,
  };
}

/** Add gold to a character, clamping at MAX_GOLD. Returns actual gold added. */
export function addGold(char: CharacterState, amount: number): number {
  const before = char.gold;
  char.gold = Math.min(char.gold + amount, MAX_GOLD);
  return char.gold - before;
}

/**
 * Add XP to a character, leveling up as needed.
 * Mutates `char` in place. Returns info about level-ups.
 * Grants 1 skill point every 5 levels.
 */
export function addXp(char: CharacterState, amount: number): { leveledUp: boolean; levelsGained: number } {
  char.xp += amount;
  let levelsGained = 0;
  const LEVELS_PER_SKILL_POINT = 5;

  while (char.xp >= xpForNextLevel(char.level)) {
    char.xp -= xpForNextLevel(char.level);
    const oldLevel = char.level;
    char.level++;
    levelsGained++;

    // Grant skill point if crossing a 5-level boundary
    if (Math.floor(char.level / LEVELS_PER_SKILL_POINT) > Math.floor(oldLevel / LEVELS_PER_SKILL_POINT)) {
      char.skillPoints++;
    }
  }

  return { leveledUp: levelsGained > 0, levelsGained };
}
