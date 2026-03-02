// --- Types ---

export type ClassName = 'Adventurer';

export type StatName = 'STR' | 'INT' | 'WIS' | 'DEX' | 'CON' | 'CHA';

export interface StatBlock {
  STR: number;
  INT: number;
  WIS: number;
  DEX: number;
  CON: number;
  CHA: number;
}

export interface CharacterState {
  className: ClassName;
  level: number;
  xp: number;
  gold: number;
  stats: StatBlock;
  priorityStat: StatName | null;
  inventory: Record<string, number>;
  equipment: Record<string, string | null>;
}

// --- Constants ---

export const ALL_STATS: StatName[] = ['STR', 'INT', 'WIS', 'DEX', 'CON', 'CHA'];

export const BASE_STATS: Readonly<StatBlock> = {
  STR: 10,
  INT: 10,
  WIS: 10,
  DEX: 10,
  CON: 10,
  CHA: 10,
};

export const XP_PER_VICTORY = 10;
export const STAT_POINTS_PER_LEVEL = 2;
export const BASE_HP = 30;
export const HP_PER_LEVEL = 5;
export const MAX_GOLD = 999_999_999;

// --- Pure functions ---

/** XP required to advance from `level` to `level + 1`. */
export function xpForNextLevel(level: number): number {
  return 100 * level;
}

/** Max HP = 30 + (level-1)*5 + CON. */
export function calculateMaxHp(level: number, con: number): number {
  return BASE_HP + (level - 1) * HP_PER_LEVEL + con;
}

/** Create a fresh Level 1 Adventurer with base stats. */
export function createDefaultCharacter(): CharacterState {
  return {
    className: 'Adventurer',
    level: 1,
    xp: 0,
    gold: 0,
    stats: { ...BASE_STATS },
    priorityStat: null,
    inventory: {},
    equipment: { head: null, chest: null, hand: null, foot: null },
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
 */
export function addXp(char: CharacterState, amount: number): { leveledUp: boolean; levelsGained: number } {
  char.xp += amount;
  let levelsGained = 0;

  while (char.xp >= xpForNextLevel(char.level)) {
    char.xp -= xpForNextLevel(char.level);
    char.level++;
    levelsGained++;
    allocateStatPoints(char, STAT_POINTS_PER_LEVEL);
  }

  return { leveledUp: levelsGained > 0, levelsGained };
}

/**
 * Allocate stat points to a character.
 * If `priorityStat` is set, all points go there.
 * Otherwise, points are distributed randomly among all stats.
 */
export function allocateStatPoints(char: CharacterState, points: number): void {
  for (let i = 0; i < points; i++) {
    if (char.priorityStat) {
      char.stats[char.priorityStat]++;
    } else {
      const stat = ALL_STATS[Math.floor(Math.random() * ALL_STATS.length)];
      char.stats[stat]++;
    }
  }
}
