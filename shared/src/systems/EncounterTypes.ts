import type { PartyGridPosition } from './SocialTypes.js';
import type { MonsterDefinition, MonsterInstance } from './MonsterTypes.js';
import { createMonsterInstance } from './MonsterTypes.js';
import type { EncounterTableEntry, ZoneDefinition } from './ZoneTypes.js';

// --- Types ---

export interface RandomMonsterEntry {
  monsterId: string;
  min: number;
  max: number;
}

export interface ExplicitPlacement {
  monsterId: string;
  gridPosition: PartyGridPosition;
}

export interface EncounterDefinition {
  id: string;
  name: string;
  type: 'random' | 'explicit';
  monsterPool?: RandomMonsterEntry[];
  roomMax?: number;
  placements?: ExplicitPlacement[];
}

// --- Seed data ---

export const SEED_ENCOUNTERS: Record<string, EncounterDefinition> = {
  hatchetmill_goblins: {
    id: 'hatchetmill_goblins',
    name: 'Hatchetmill Goblins',
    type: 'random',
    monsterPool: [{ monsterId: 'goblin', min: 1, max: 2 }],
    roomMax: 9,
  },
  darkwood_goblins: {
    id: 'darkwood_goblins',
    name: 'Darkwood Goblins',
    type: 'random',
    monsterPool: [{ monsterId: 'goblin', min: 2, max: 3 }],
    roomMax: 9,
  },
  darkwood_wolves: {
    id: 'darkwood_wolves',
    name: 'Darkwood Wolves',
    type: 'random',
    monsterPool: [{ monsterId: 'wolf', min: 1, max: 3 }],
    roomMax: 9,
  },
  darkwood_bandits: {
    id: 'darkwood_bandits',
    name: 'Darkwood Bandits',
    type: 'random',
    monsterPool: [{ monsterId: 'bandit', min: 1, max: 2 }],
    roomMax: 9,
  },
  crystal_caves_goblins: {
    id: 'crystal_caves_goblins',
    name: 'Crystal Caves Goblins',
    type: 'random',
    monsterPool: [{ monsterId: 'goblin', min: 1, max: 2 }],
    roomMax: 9,
  },
  crystal_caves_wolves: {
    id: 'crystal_caves_wolves',
    name: 'Crystal Caves Wolves',
    type: 'random',
    monsterPool: [{ monsterId: 'wolf', min: 1, max: 2 }],
    roomMax: 9,
  },
};

// --- Functions ---

/**
 * Resolve an encounter definition into concrete monster instances.
 * Handles both 'random' (pool with min/max + roomMax cap) and 'explicit' (fixed placements).
 */
export function resolveEncounter(
  encounter: EncounterDefinition,
  monsters: Record<string, MonsterDefinition>,
): MonsterInstance[] {
  if (encounter.type === 'explicit') {
    return resolveExplicit(encounter, monsters);
  }
  return resolveRandom(encounter, monsters);
}

function resolveExplicit(
  encounter: EncounterDefinition,
  monsters: Record<string, MonsterDefinition>,
): MonsterInstance[] {
  if (!encounter.placements?.length) return [];

  const result: MonsterInstance[] = [];
  for (const placement of encounter.placements) {
    const def = monsters[placement.monsterId];
    if (def) {
      result.push(createMonsterInstance(def, placement.gridPosition));
    }
  }
  return result;
}

function resolveRandom(
  encounter: EncounterDefinition,
  monsters: Record<string, MonsterDefinition>,
): MonsterInstance[] {
  if (!encounter.monsterPool?.length) return [];

  const roomMax = encounter.roomMax ?? 9;

  // Roll counts for each entry
  const rolled: { monsterId: string; count: number }[] = [];
  for (const entry of encounter.monsterPool) {
    const def = monsters[entry.monsterId];
    if (!def) continue;
    const count = entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1));
    if (count > 0) {
      rolled.push({ monsterId: entry.monsterId, count });
    }
  }

  // Trim to roomMax (remove from entries with largest count first)
  let total = rolled.reduce((sum, r) => sum + r.count, 0);
  while (total > roomMax && rolled.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < rolled.length; i++) {
      if (rolled[i].count > rolled[maxIdx].count) maxIdx = i;
    }
    rolled[maxIdx].count--;
    total--;
    if (rolled[maxIdx].count <= 0) {
      rolled.splice(maxIdx, 1);
    }
  }

  if (total === 0) return [];

  // Flatten into individual monster IDs
  const pool: string[] = [];
  for (const entry of rolled) {
    for (let i = 0; i < entry.count; i++) {
      pool.push(entry.monsterId);
    }
  }

  // Shuffle (Fisher-Yates)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  // Generate random unique grid positions
  const allPositions: PartyGridPosition[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = allPositions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allPositions[i], allPositions[j]] = [allPositions[j], allPositions[i]];
  }

  // Create instances
  const result: MonsterInstance[] = [];
  for (let i = 0; i < pool.length; i++) {
    const def = monsters[pool[i]];
    if (def) {
      result.push(createMonsterInstance(def, allPositions[i]));
    }
  }
  return result;
}

// --- Encounter Table Resolution ---

/** Pick a random entry from a weighted encounter table. */
function pickWeightedEncounter(table: EncounterTableEntry[]): EncounterTableEntry {
  const totalWeight = table.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of table) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return table[table.length - 1];
}

/** Default grid positions for fallback encounters. */
const FALLBACK_POSITIONS: PartyGridPosition[] = [4, 1];

/**
 * Create an encounter for the given zone, with optional room-level override.
 * Priority: roomEncounterTable → zone's encounterTable → goblin fallback.
 */
export function createEncounter(
  zoneId: string | undefined,
  monsters: Record<string, MonsterDefinition>,
  zones: Record<string, ZoneDefinition>,
  encounters: Record<string, EncounterDefinition>,
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
      createMonsterInstance(fallbackDef, FALLBACK_POSITIONS[0]),
      createMonsterInstance(fallbackDef, FALLBACK_POSITIONS[1]),
    ];
  }

  const entry = pickWeightedEncounter(encounterTable);
  const encounterDef = encounters[entry.encounterId];
  if (!encounterDef) {
    return [
      createMonsterInstance(fallbackDef, FALLBACK_POSITIONS[0]),
      createMonsterInstance(fallbackDef, FALLBACK_POSITIONS[1]),
    ];
  }

  const result = resolveEncounter(encounterDef, monsters);
  if (result.length === 0) {
    return [
      createMonsterInstance(fallbackDef, FALLBACK_POSITIONS[0]),
      createMonsterInstance(fallbackDef, FALLBACK_POSITIONS[1]),
    ];
  }

  return result;
}
