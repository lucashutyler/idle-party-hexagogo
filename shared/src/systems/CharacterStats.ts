// --- Types ---

export type ClassName = 'Adventurer' | 'Knight' | 'Archer' | 'Priest' | 'Mage' | 'Bard';

export type DamageType = 'physical' | 'magical';

export type StatName = 'STR' | 'INT' | 'WIS' | 'DEX' | 'CON' | 'CHA';

export interface StatBlock {
  STR: number;
  INT: number;
  WIS: number;
  DEX: number;
  CON: number;
  CHA: number;
}

export interface ClassDefinition {
  displayName: string;
  description: string;
  baseStats: Readonly<StatBlock>;
  hpMultiplier: number;
  /** Which stat drives attack damage. null = no stat scaling (base damage 0). */
  attackStat: StatName | null;
  /** Flat physical damage reduction for this player. */
  physicalReductionBase: number;
  physicalReductionPerLevel: number;
  /** Party-wide magical damage reduction (from each alive player of this class). */
  partyMagicalReductionBase: number;
  partyMagicalReductionPerLevel: number;
  /** Bard: percentage buff to all stats per party member. 0 for non-bards. */
  bardStatMultiplierPerMember: number;
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

export const CLASS_ICONS: Record<string, string> = {
  Knight: '\uD83D\uDEE1\uFE0F',  // 🛡️ shield
  Archer: '\uD83C\uDFF9',          // 🏹 bow
  Priest: '\u2625\uFE0F',          // ☥ ankh
  Mage: '\uD83E\uDE84',            // 🪄 magic wand
  Bard: '\uD83C\uDFB5',            // 🎵 musical note
};
export const UNKNOWN_CLASS_ICON = '\u2753'; // ❓
export const SERVER_ICON = '\uD83D\uDDA5\uFE0F'; // 🖥️

export const ALL_STATS: StatName[] = ['STR', 'INT', 'WIS', 'DEX', 'CON', 'CHA'];

export const BASE_STATS: Readonly<StatBlock> = {
  STR: 10,
  INT: 10,
  WIS: 10,
  DEX: 10,
  CON: 10,
  CHA: 10,
};

export const CLASS_DEFINITIONS: Record<ClassName, ClassDefinition> = {
  Adventurer: {
    displayName: 'Adventurer',
    description: 'Legacy class. Pick a real class!',
    baseStats: { ...BASE_STATS },
    hpMultiplier: 1.0,
    attackStat: 'STR',
    physicalReductionBase: 0,
    physicalReductionPerLevel: 0,
    partyMagicalReductionBase: 0,
    partyMagicalReductionPerLevel: 0,
    bardStatMultiplierPerMember: 0,
  },
  Knight: {
    displayName: 'Knight',
    description: 'Full defense, very little damage, high HP. Passive physical damage reduction scales with level.',
    baseStats: { STR: 16, INT: 8, WIS: 8, DEX: 8, CON: 20, CHA: 8 },
    hpMultiplier: 0.6,
    attackStat: null,
    physicalReductionBase: 2,
    physicalReductionPerLevel: 1,
    partyMagicalReductionBase: 0,
    partyMagicalReductionPerLevel: 0,
    bardStatMultiplierPerMember: 0,
  },
  Archer: {
    displayName: 'Archer',
    description: 'Full physical offense, extremely weak HP. DEX-based damage.',
    baseStats: { STR: 4, INT: 8, WIS: 8, DEX: 16, CON: 4, CHA: 8 },
    hpMultiplier: 0.2,
    attackStat: 'DEX',
    physicalReductionBase: 0,
    physicalReductionPerLevel: 0,
    partyMagicalReductionBase: 0,
    partyMagicalReductionPerLevel: 0,
    bardStatMultiplierPerMember: 0,
  },
  Priest: {
    displayName: 'Priest',
    description: 'Passive magical damage reduction for the entire party, scales with level. Mid HP.',
    baseStats: { STR: 8, INT: 8, WIS: 16, DEX: 8, CON: 10, CHA: 8 },
    hpMultiplier: 0.5,
    attackStat: null,
    physicalReductionBase: 0,
    physicalReductionPerLevel: 0,
    partyMagicalReductionBase: 2,
    partyMagicalReductionPerLevel: 1,
    bardStatMultiplierPerMember: 0,
  },
  Mage: {
    displayName: 'Mage',
    description: 'Full magic damage, extremely weak HP. INT-based damage.',
    baseStats: { STR: 4, INT: 20, WIS: 8, DEX: 8, CON: 4, CHA: 8 },
    hpMultiplier: 0.2,
    attackStat: 'INT',
    physicalReductionBase: 0,
    physicalReductionPerLevel: 0,
    partyMagicalReductionBase: 0,
    partyMagicalReductionPerLevel: 0,
    bardStatMultiplierPerMember: 0,
  },
  Bard: {
    displayName: 'Bard',
    description: 'Increases all stats of the party by 20% per member. Weak alone, godlike in groups.',
    baseStats: { STR: 8, INT: 8, WIS: 8, DEX: 8, CON: 6, CHA: 16 },
    hpMultiplier: 0.3,
    attackStat: null,
    physicalReductionBase: 0,
    physicalReductionPerLevel: 0,
    partyMagicalReductionBase: 0,
    partyMagicalReductionPerLevel: 0,
    bardStatMultiplierPerMember: 0.20,
  },
};

/** Playable class names (excludes legacy Adventurer). */
export const ALL_CLASS_NAMES: ClassName[] = ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'];

export const STAT_POINTS_PER_LEVEL = 2;
export const BASE_HP = 30;
export const HP_PER_LEVEL = 5;
export const MAX_GOLD = 999_999_999;

// --- Pure functions ---

/** XP required to advance from `level` to `level + 1`. */
export function xpForNextLevel(level: number): number {
  return Math.floor(18000 * Math.pow(level, 1.2) * Math.pow(1.06, level));
}

/** Max HP = floor((30 + (level-1)*5 + CON) * hpMultiplier). */
export function calculateMaxHp(level: number, con: number, className: ClassName = 'Adventurer'): number {
  const base = BASE_HP + (level - 1) * HP_PER_LEVEL + con;
  return Math.floor(base * CLASS_DEFINITIONS[className].hpMultiplier);
}

/** Create a fresh Level 1 Adventurer with base stats (legacy, for backward compat). */
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

/** Create a fresh Level 1 character of the given class. */
export function createCharacter(className: ClassName): CharacterState {
  const def = CLASS_DEFINITIONS[className];
  return {
    className,
    level: 1,
    xp: 0,
    gold: 0,
    stats: { ...def.baseStats },
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
    // Stats no longer increase on level-up. Class passives scale with level instead.
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
