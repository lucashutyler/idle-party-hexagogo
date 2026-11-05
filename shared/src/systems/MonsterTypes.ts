import type { ItemDrop } from './ItemTypes.js';
import type { DamageType } from './CharacterStats.js';
import type { PartyGridPosition } from './SocialTypes.js';
import { effectiveMonsterLevel } from './MonsterLevels.js';

// --- Types ---

export type MonsterTier = 'trash' | 'elite' | 'boss' | 'raid';
export const MONSTER_TIERS: readonly MonsterTier[] = ['trash', 'elite', 'boss', 'raid'];

/** `authored` = set on the definition; `derived` = estimated from its damage output. */
export type MonsterLevelSource = 'authored' | 'derived';

/** Outgoing damage × (1 + stacks × stepPercent); a stack every stepSeconds from afterSeconds. */
export interface MonsterEnrage {
  afterSeconds: number;
  /** Default 30. */
  stepSeconds?: number;
  /** Default 0.10. */
  stepPercent?: number;
  /** Default 30. */
  maxStacks?: number;
}

export interface Resistance {
  damageType: DamageType;
  flatReduction: number;
  percentReduction: number;
}

export interface MonsterSkillEntry {
  skillId: string;
  value: number;
  /** Seconds after use; 0 = usable on every action. */
  cooldown: number;
  /** Seconds of telegraphed wind-up; overrides the catalog default. */
  castTime?: number;
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
  /** Seconds between actions; default 1, clamped to at least 0.3 by the engine. */
  attackInterval?: number;
  /** Passive monsters (e.g. walls) never attack and don't count toward victory. */
  passive?: boolean;
  /** Optional flavor text shown in the monster popup. */
  description?: string;
  /** 1..200. Absent → an estimate from damage output, which shows no level and applies no gap factor or XP con. */
  level?: number;
  /** Absent → 'trash'. */
  tier?: MonsterTier;
  /** Absent → the tier default (boss 480 s, raid 3600 s, none for trash/elite). */
  enrage?: MonsterEnrage;
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
  resistances?: Resistance[];
  skills?: MonsterSkillEntry[];
  /** Cooldown milliseconds remaining per skill ID. */
  skillCooldowns?: Record<string, number>;
  /** Seconds between actions (see MonsterDefinition.attackInterval). */
  attackInterval?: number;
  /** Passive monsters (e.g. walls) never attack and don't count toward victory. */
  passive?: boolean;
  /** Optional flavor text shown in the monster popup. */
  description?: string;
  level?: number;
  levelSource?: MonsterLevelSource;
  tier?: MonsterTier;
  enrage?: MonsterEnrage;
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
    level: 1,
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
    damage: 5,
    damageType: 'magical',
    attackInterval: 0.8,
    xp: 10,
    goldMin: 3,
    goldMax: 5,
    level: 3,
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
    damage: 6,
    damageType: 'physical',
    attackInterval: 1.25,
    xp: 15,
    goldMin: 2,
    goldMax: 5,
    level: 4,
    drops: [
      { itemId: 'leather_vest', chance: 0.008 },
      { itemId: 'old_leather_boots', chance: 0.01 },
      { itemId: 'frayed_cord_necklace', chance: 0.005 },
      { itemId: 'splintered_buckler', chance: 0.005 },
      { itemId: 'cracked_idol', chance: 0.004 },
      { itemId: 'iron_battleaxe', chance: 0.003 },
    ],
  },
  goblin_shaman: {
    id: 'goblin_shaman',
    name: 'Goblin Shaman',
    hp: 18,
    damage: 3,
    damageType: 'magical',
    xp: 9,
    goldMin: 2,
    goldMax: 4,
    level: 2,
    skills: [
      { skillId: 'fireball', value: 4, cooldown: 5 },
      { skillId: 'heal', value: 8, cooldown: 4 },
    ],
    description: 'A wiry goblin draped in charms, muttering over a smoking fetish. It hurls fire and patches up its kin.',
    drops: [
      { itemId: 'gnarled_wand', chance: 0.01 },
      { itemId: 'tarnished_ring', chance: 0.005 },
    ],
  },
  bandit_cutthroat: {
    id: 'bandit_cutthroat',
    name: 'Bandit Cutthroat',
    hp: 60,
    damage: 5,
    damageType: 'physical',
    xp: 30,
    goldMin: 4,
    goldMax: 8,
    level: 5,
    tier: 'elite',
    skills: [
      { skillId: 'assassinate', value: 12, cooldown: 6 },
    ],
    description: 'A quiet killer who picks out the weakest in a group and waits for an opening.',
    drops: [
      { itemId: 'rusty_dagger', chance: 0.01 },
      { itemId: 'old_leather_boots', chance: 0.008 },
    ],
  },
  goblin_chieftain: {
    id: 'goblin_chieftain',
    name: 'Goblin Chieftain',
    hp: 19000,
    damage: 70,
    damageType: 'physical',
    attackInterval: 2,
    xp: 2300,
    goldMin: 650,
    goldMax: 1200,
    level: 6,
    tier: 'boss',
    enrage: { afterSeconds: 480 },
    skills: [
      { skillId: 'fireball', value: 18, cooldown: 10 },
      { skillId: 'fear', value: 0, cooldown: 15 },
    ],
    description: 'The warlord of the Crystal Caves goblins, scarred and bellowing, flanked by his guards. Built for a group.',
    drops: [
      { itemId: 'iron_battleaxe', chance: 0.15 },
      { itemId: 'leather_vest', chance: 0.2 },
      { itemId: 'magma_boots', chance: 0.05 },
    ],
  },
  stone_wall: {
    id: 'stone_wall',
    name: 'Stone Wall',
    hp: 100,
    damage: 0,
    damageType: 'physical',
    xp: 0,
    goldMin: 0,
    goldMax: 0,
    passive: true,
    level: 1,
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
  };
  if (def.attackInterval !== undefined) instance.attackInterval = def.attackInterval;
  if (def.resistances?.length) {
    instance.resistances = def.resistances.map(r => ({ ...r }));
  }
  if (def.skills?.length) {
    instance.skills = def.skills.map(s => ({ ...s }));
    instance.skillCooldowns = {};
    for (const s of def.skills) {
      instance.skillCooldowns[s.skillId] = 0;
    }
  }
  if (def.passive) instance.passive = true;
  if (def.description) instance.description = def.description;
  const { level, source } = effectiveMonsterLevel(def);
  instance.level = level;
  instance.levelSource = source;
  if (def.tier && MONSTER_TIERS.includes(def.tier)) instance.tier = def.tier;
  if (def.enrage) instance.enrage = { ...def.enrage };
  return instance;
}

