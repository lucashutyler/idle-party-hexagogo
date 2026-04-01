import type { ItemDrop } from './ItemTypes.js';
import type { DamageType } from './CharacterStats.js';
import type { PartyGridPosition } from './SocialTypes.js';

// --- Types ---

export interface Resistance {
  damageType: DamageType;
  flatReduction: number;
  percentReduction: number;
}

export interface MonsterSkillEntry {
  skillId: string;
  value: number;
  cooldown: number;
}

export interface MonsterDefinition {
  id: string;
  name: string;
  hp: number;
  damage: number;
  damageType: DamageType;
  xp: number;
  goldMin: number;
  goldMax: number;
  drops?: ItemDrop[];
  resistances?: Resistance[];
  skills?: MonsterSkillEntry[];
}

export interface MonsterInstance {
  id: string;
  name: string;
  maxHp: number;
  currentHp: number;
  damage: number;
  damageType: DamageType;
  xp: number;
  gridPosition: PartyGridPosition;
  /** Remaining stun turns (0 = not stunned). */
  stunTurns: number;
  resistances?: Resistance[];
  skills?: MonsterSkillEntry[];
  /** Cooldown ticks remaining per skill ID. */
  skillCooldowns?: Record<string, number>;
}

// --- Seed data (used as defaults when data files don't exist) ---

export const SEED_MONSTERS: Record<string, MonsterDefinition> = {
  goblin: {
    id: 'goblin',
    name: 'Goblin',
    hp: 15,
    damage: 4,
    damageType: 'physical',
    xp: 5,
    goldMin: 1,
    goldMax: 2,
    drops: [
      { itemId: 'janky_helmet', chance: 0.01 },
      { itemId: 'rusty_dagger', chance: 0.01 },
      { itemId: 'tarnished_ring', chance: 0.005 },
      { itemId: 'cracked_bracers', chance: 0.005 },
      { itemId: 'worn_gloves', chance: 0.005 },
      { itemId: 'gnarled_wand', chance: 0.004 },
      { itemId: 'tin_whistle', chance: 0.004 },
    ],
  },
  wolf: {
    id: 'wolf',
    name: 'Wolf',
    hp: 20,
    damage: 6,
    damageType: 'magical',
    xp: 10,
    goldMin: 3,
    goldMax: 5,
    drops: [
      { itemId: 'mangy_pelt', chance: 0.01 },
      { itemId: 'moth_eaten_cloak', chance: 0.005 },
      { itemId: 'tattered_pauldrons', chance: 0.004 },
      { itemId: 'short_bow', chance: 0.004 },
      { itemId: 'prayer_beads', chance: 0.004 },
    ],
  },
  bandit: {
    id: 'bandit',
    name: 'Bandit',
    hp: 30,
    damage: 5,
    damageType: 'physical',
    xp: 15,
    goldMin: 2,
    goldMax: 5,
    drops: [
      { itemId: 'leather_vest', chance: 0.008 },
      { itemId: 'old_leather_boots', chance: 0.01 },
      { itemId: 'frayed_cord_necklace', chance: 0.005 },
      { itemId: 'splintered_buckler', chance: 0.005 },
      { itemId: 'cracked_idol', chance: 0.004 },
      { itemId: 'iron_battleaxe', chance: 0.003 },
    ],
  },
};

// --- Functions ---

/** Create a live monster instance from a definition. */
export function createMonsterInstance(def: MonsterDefinition, gridPosition: PartyGridPosition = 4): MonsterInstance {
  const instance: MonsterInstance = {
    id: def.id,
    name: def.name,
    maxHp: def.hp,
    currentHp: def.hp,
    damage: def.damage,
    damageType: def.damageType,
    xp: def.xp,
    gridPosition,
    stunTurns: 0,
  };
  if (def.resistances?.length) {
    instance.resistances = def.resistances;
  }
  if (def.skills?.length) {
    instance.skills = def.skills;
    instance.skillCooldowns = {};
    for (const s of def.skills) {
      instance.skillCooldowns[s.skillId] = 0;
    }
  }
  return instance;
}

