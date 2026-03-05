import { contentRegistry } from './ContentRegistry.js';

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

// --- Zone definitions ---

export const ZONES: Record<string, ZoneDefinition> = {
  friendly_forest: {
    id: 'friendly_forest',
    displayName: 'Friendly Forest',
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
};

// Register with ContentRegistry for hot-reload support
contentRegistry.registerZones(ZONES);

// --- Functions ---

/** Look up a zone by ID. Returns undefined if not found. */
export function getZone(zoneId: string): ZoneDefinition | undefined {
  return ZONES[zoneId];
}
