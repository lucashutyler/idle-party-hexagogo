// --- Types ---

export interface EncounterTableEntry {
  encounterId: string;
  weight: number;
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
      { encounterId: 'hatchetmill_goblins', weight: 1 },
    ],
    levelRange: [1, 1],
  },
  darkwood: {
    id: 'darkwood',
    displayName: 'Darkwood',
    encounterTable: [
      { encounterId: 'darkwood_goblins', weight: 3 },
      { encounterId: 'darkwood_wolves', weight: 4 },
      { encounterId: 'darkwood_bandits', weight: 3 },
    ],
    levelRange: [2, 3],
  },
  crystal_caves: {
    id: 'crystal_caves',
    displayName: 'Crystal Caves',
    encounterTable: [
      { encounterId: 'crystal_caves_goblins', weight: 2 },
      { encounterId: 'crystal_caves_wolves', weight: 3 },
    ],
    levelRange: [1, 2],
  },
};

// --- Functions ---

/** Look up a zone by ID. Returns undefined if not found. */
export function getZone(zoneId: string, zones: Record<string, ZoneDefinition>): ZoneDefinition | undefined {
  return zones[zoneId];
}
