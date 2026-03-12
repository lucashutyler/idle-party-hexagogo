// --- Types ---

export interface EncounterTableEntry {
  monsterId: string;
  weight: number;
  minCount: number;
  maxCount: number;
}

export interface ZoneDefinition {
  id: string;
  displayName: string;
  encounterTable: EncounterTableEntry[];
  levelRange: [number, number];
}

// --- Seed data (used as defaults when data files don't exist) ---

export const SEED_ZONES: Record<string, ZoneDefinition> = {
  hatchetmill: {
    id: 'hatchetmill',
    displayName: 'Hatchetmill',
    encounterTable: [
      { monsterId: 'goblin', weight: 1, minCount: 1, maxCount: 2 },
    ],
    levelRange: [1, 1],
  },
  darkwood: {
    id: 'darkwood',
    displayName: 'Darkwood',
    encounterTable: [
      { monsterId: 'goblin', weight: 3, minCount: 2, maxCount: 3 },
      { monsterId: 'wolf', weight: 4, minCount: 1, maxCount: 3 },
      { monsterId: 'bandit', weight: 3, minCount: 1, maxCount: 2 },
    ],
    levelRange: [2, 3],
  },
  crystal_caves: {
    id: 'crystal_caves',
    displayName: 'Crystal Caves',
    encounterTable: [
      { monsterId: 'goblin', weight: 2, minCount: 1, maxCount: 2 },
      { monsterId: 'wolf', weight: 3, minCount: 1, maxCount: 2 },
    ],
    levelRange: [1, 2],
  },
};

// --- Functions ---

/** Look up a zone by ID. Returns undefined if not found. */
export function getZone(zoneId: string, zones: Record<string, ZoneDefinition>): ZoneDefinition | undefined {
  return zones[zoneId];
}
