import type { EncounterTableEntry } from './ZoneTypes.js';
import type { ClassName } from './CharacterStats.js';

// --- Types ---

export interface DungeonGridShape {
  cols: number;
  rows: number;
}

export interface DungeonReward {
  itemId: string;
  /** Drop chance (0..1). */
  chance: number;
  /** Minimum quantity awarded on drop. Defaults to 1. */
  minQty?: number;
  /** Maximum quantity awarded on drop. Defaults to 1. */
  maxQty?: number;
}

export interface DungeonFloor {
  /** 1-indexed floor number; floors are completed in order. */
  floorNumber: number;
  /** Combat formation grid for this floor. */
  gridShape: DungeonGridShape;
  /** Weighted encounter table for combats on this floor. */
  encounterTable: EncounterTableEntry[];
  /** Marks this floor as a boss encounter (for future special handling). */
  isBoss?: boolean;
  /** Optional bonus drops awarded on floor clear, in addition to monster loot. */
  rewards?: DungeonReward[];
}

export interface DungeonEntryRequirements {
  /** Minimum character level (inclusive). */
  minLevel?: number;
  /** Maximum character level (inclusive); useful for trial dungeons. */
  maxLevel?: number;
  /** Item every party member must hold (equipped or in inventory). */
  requiredItemId?: string;
  /** Consume the required item on entry (e.g. ticket / sigil). */
  consumeRequiredItem?: boolean;
  /** Restrict to these classes only (omit/empty = any). */
  requiredClasses?: ClassName[];
  /** Minimum party size (inclusive). */
  minPartySize?: number;
  /** Maximum party size (inclusive); overrides global party cap when set. */
  maxPartySize?: number;
}

export interface DungeonDefinition {
  id: string;
  name: string;
  /** Short flavor text shown to players before entry. */
  description?: string;
  /** Sequential floors in completion order. */
  floors: DungeonFloor[];
  /** Optional gating conditions for entry. */
  entryRequirements?: DungeonEntryRequirements;
  /** Bonus rewards granted on the first ever clear, per player. */
  firstClearRewards?: DungeonReward[];
}

// --- Seed data (used as defaults when data files don't exist) ---

export const SEED_DUNGEONS: Record<string, DungeonDefinition> = {
  crystal_caves_trial: {
    id: 'crystal_caves_trial',
    name: 'Crystal Caves Trial',
    description: 'A short three-floor dive into the Crystal Caves.',
    floors: [
      {
        floorNumber: 1,
        gridShape: { cols: 3, rows: 3 },
        encounterTable: [{ encounterId: 'crystal_caves_goblins', weight: 1 }],
      },
      {
        floorNumber: 2,
        gridShape: { cols: 3, rows: 3 },
        encounterTable: [{ encounterId: 'crystal_caves_wolves', weight: 1 }],
      },
      {
        floorNumber: 3,
        gridShape: { cols: 3, rows: 3 },
        encounterTable: [
          { encounterId: 'crystal_caves_goblins', weight: 1 },
          { encounterId: 'crystal_caves_wolves', weight: 1 },
        ],
        isBoss: true,
      },
    ],
    entryRequirements: {
      minLevel: 3,
      minPartySize: 1,
      maxPartySize: 5,
    },
  },
};

// --- Functions ---

/** Look up a dungeon by ID. Returns undefined if not found. */
export function getDungeon(
  dungeonId: string,
  dungeons: Record<string, DungeonDefinition>,
): DungeonDefinition | undefined {
  return dungeons[dungeonId];
}
