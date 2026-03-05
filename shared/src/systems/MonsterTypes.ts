import { contentRegistry } from './ContentRegistry.js';
import { getZone } from './ZoneTypes.js';
import type { EncounterTableEntry } from './ZoneTypes.js';
import type { ItemDrop } from './ItemTypes.js';
import type { PartyGridPosition } from './SocialTypes.js';

// --- Types ---

export interface MonsterDefinition {
  id: string;
  name: string;
  level: number;
  hp: number;
  damage: number;
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
  xp: number;
  gridPosition: PartyGridPosition;
}

// --- Monster catalog ---
// Mutable record — ContentRegistry mutates this in-place for hot-reload.

export const MONSTERS: Record<string, MonsterDefinition> = {
  goblin: {
    id: 'goblin',
    name: 'Goblin',
    level: 1,
    hp: 15,
    damage: 4,
    xp: 5,
    goldMin: 1,
    goldMax: 2,
    drops: [
      { itemId: 'janky_helmet', chance: 0.40 },
      { itemId: 'rusty_dagger', chance: 0.40 },
    ],
  },
  wolf: {
    id: 'wolf',
    name: 'Wolf',
    level: 2,
    hp: 20,
    damage: 6,
    xp: 10,
    goldMin: 3,
    goldMax: 5,
    drops: [
      { itemId: 'mangy_pelt', chance: 0.40 },
    ],
  },
  bandit: {
    id: 'bandit',
    name: 'Bandit',
    level: 3,
    hp: 30,
    damage: 5,
    xp: 15,
    goldMin: 2,
    goldMax: 5,
    drops: [
      { itemId: 'leather_vest', chance: 0.25 },
      { itemId: 'old_leather_boots', chance: 0.40 },
    ],
  },
};

// Register with ContentRegistry for hot-reload support
contentRegistry.registerMonsters(MONSTERS);

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
    xp: def.xp,
    gridPosition,
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
 * Create an encounter for the given zone.
 * Uses the zone's encounter table for weighted random monster selection.
 * Falls back to 2x goblins if no zone is provided or zone is unknown.
 */
export function createEncounter(zoneId?: string): MonsterInstance[] {
  if (!zoneId) {
    return [
      createMonsterInstance(MONSTERS.goblin, MONSTER_GRID_POSITIONS[0]),
      createMonsterInstance(MONSTERS.goblin, MONSTER_GRID_POSITIONS[1]),
    ];
  }

  const zone = getZone(zoneId);
  if (!zone) {
    return [
      createMonsterInstance(MONSTERS.goblin, MONSTER_GRID_POSITIONS[0]),
      createMonsterInstance(MONSTERS.goblin, MONSTER_GRID_POSITIONS[1]),
    ];
  }

  const entry = pickWeightedEntry(zone.encounterTable);
  const def = MONSTERS[entry.monsterId];
  if (!def) {
    return [
      createMonsterInstance(MONSTERS.goblin, MONSTER_GRID_POSITIONS[0]),
      createMonsterInstance(MONSTERS.goblin, MONSTER_GRID_POSITIONS[1]),
    ];
  }

  const count = entry.minCount + Math.floor(Math.random() * (entry.maxCount - entry.minCount + 1));
  const monsters: MonsterInstance[] = [];
  for (let i = 0; i < count; i++) {
    monsters.push(createMonsterInstance(def, MONSTER_GRID_POSITIONS[i % MONSTER_GRID_POSITIONS.length]));
  }
  return monsters;
}
