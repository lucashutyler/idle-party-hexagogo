import type { EncounterTableEntry, ZoneDefinition } from './ZoneTypes.js';
import type { ItemDrop } from './ItemTypes.js';
import type { DamageType } from './CharacterStats.js';
import type { PartyGridPosition } from './SocialTypes.js';

// --- Types ---

export interface MonsterDefinition {
  id: string;
  name: string;
  level: number;
  hp: number;
  damage: number;
  damageType: DamageType;
  xp: number;
  goldMin: number;
  goldMax: number;
  drops?: ItemDrop[];
}

export interface MonsterInstance {
  id: string;
  name: string;
  level: number;
  maxHp: number;
  currentHp: number;
  damage: number;
  damageType: DamageType;
  xp: number;
  gridPosition: PartyGridPosition;
  /** Remaining stun turns (0 = not stunned). */
  stunTurns: number;
}

// --- Seed data (used as defaults when data files don't exist) ---

export const SEED_MONSTERS: Record<string, MonsterDefinition> = {
  goblin: {
    id: 'goblin',
    name: 'Goblin',
    level: 1,
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
    level: 2,
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
    level: 3,
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

/** Grid positions used to distribute monsters across the 3x3 grid. */
const MONSTER_GRID_POSITIONS: PartyGridPosition[] = [4, 1, 7, 3, 5, 0, 2, 6, 8];

/** Create a live monster instance from a definition. */
export function createMonsterInstance(def: MonsterDefinition, gridPosition: PartyGridPosition = 4): MonsterInstance {
  return {
    id: def.id,
    name: def.name,
    level: def.level,
    maxHp: def.hp,
    currentHp: def.hp,
    damage: def.damage,
    damageType: def.damageType,
    xp: def.xp,
    gridPosition,
    stunTurns: 0,
  };
}

/**
 * Pick a random entry from the encounter table using weighted random selection.
 */
function pickWeightedEntry(table: EncounterTableEntry[]): EncounterTableEntry {
  const totalWeight = table.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of table) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return table[table.length - 1];
}

/**
 * Create an encounter for the given zone, with optional room-level override.
 * Priority: roomEncounterTable → zone's encounterTable → goblin fallback.
 */
export function createEncounter(
  zoneId: string | undefined,
  monsters: Record<string, MonsterDefinition>,
  zones: Record<string, ZoneDefinition>,
  roomEncounterTable?: EncounterTableEntry[],
): MonsterInstance[] {
  const fallbackDef = monsters['goblin'] ?? Object.values(monsters)[0];
  if (!fallbackDef) return [];

  // Determine which encounter table to use: room override → zone default
  let encounterTable: EncounterTableEntry[] | undefined = roomEncounterTable?.length ? roomEncounterTable : undefined;

  if (!encounterTable && zoneId) {
    const zone = zones[zoneId];
    if (zone) {
      encounterTable = zone.encounterTable;
    }
  }

  if (!encounterTable || encounterTable.length === 0) {
    return [
      createMonsterInstance(fallbackDef, MONSTER_GRID_POSITIONS[0]),
      createMonsterInstance(fallbackDef, MONSTER_GRID_POSITIONS[1]),
    ];
  }

  const entry = pickWeightedEntry(encounterTable);
  const def = monsters[entry.monsterId];
  if (!def) {
    return [
      createMonsterInstance(fallbackDef, MONSTER_GRID_POSITIONS[0]),
      createMonsterInstance(fallbackDef, MONSTER_GRID_POSITIONS[1]),
    ];
  }

  const count = entry.minCount + Math.floor(Math.random() * (entry.maxCount - entry.minCount + 1));
  const result: MonsterInstance[] = [];
  for (let i = 0; i < count; i++) {
    result.push(createMonsterInstance(def, MONSTER_GRID_POSITIONS[i % MONSTER_GRID_POSITIONS.length]));
  }
  return result;
}
