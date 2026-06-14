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
  /**
   * Restrict this reward to these classes — only members of a listed class roll
   * for it (omit/empty = any class). Lets a dungeon hand different loot to
   * different classes, e.g. a blade for Knights and a lute for Bards.
   */
  classRestriction?: ClassName[];
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
  /** Bonus item rewards granted on the first ever clear, per player. */
  firstClearRewards?: DungeonReward[];
  /** Flat XP granted once per player on the first ever clear. */
  firstClearXp?: number;
  /** Flat gold granted once per player on the first ever clear. */
  firstClearGold?: number;
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

// --- Runtime types (server → client) ---

/**
 * Live state of a party's active dungeon run, surfaced to the client so it can
 * render the in-dungeon HUD (floor progress, leave button). Absent when the
 * party is on the overworld.
 */
export interface DungeonRunInfo {
  dungeonId: string;
  name: string;
  /** 1-indexed current floor. */
  floor: number;
  /** Total number of floors in the dungeon. */
  totalFloors: number;
  /** Whether the current floor is flagged as a boss floor. */
  isBossFloor: boolean;
}

/** Per-member info needed to evaluate dungeon entry requirements. */
export interface DungeonEntryMemberInfo {
  username: string;
  level: number;
  className: ClassName;
  /**
   * Whether this member satisfies the dungeon's `requiredItemId` (if any).
   * The caller decides the exact semantics — inventory-only when the item is
   * consumed on entry, otherwise inventory-or-equipped.
   */
  hasRequiredItem: boolean;
}

// --- Functions ---

/** Look up a dungeon by ID. Returns undefined if not found. */
export function getDungeon(
  dungeonId: string,
  dungeons: Record<string, DungeonDefinition>,
): DungeonDefinition | undefined {
  return dungeons[dungeonId];
}

/**
 * Validate whether a party may enter a dungeon. Returns a human-readable
 * rejection reason, or `null` if entry is allowed. Pure and deterministic so
 * it can be unit-tested and reused on both client (preview eligibility) and
 * server (authoritative gate).
 */
export function validateDungeonEntry(
  dungeon: DungeonDefinition,
  members: DungeonEntryMemberInfo[],
  requiredItemName?: string,
): string | null {
  if (dungeon.floors.length === 0) {
    return 'This dungeon is not ready yet.';
  }
  if (members.length === 0) {
    return 'You need a party to enter.';
  }

  const req = dungeon.entryRequirements;
  if (!req) return null;

  const partySize = members.length;
  if (req.minPartySize !== undefined && partySize < req.minPartySize) {
    return `Need at least ${req.minPartySize} party member${req.minPartySize === 1 ? '' : 's'} to enter.`;
  }
  if (req.maxPartySize !== undefined && partySize > req.maxPartySize) {
    return `Party too large — this dungeon allows at most ${req.maxPartySize}.`;
  }

  for (const m of members) {
    if (req.minLevel !== undefined && m.level < req.minLevel) {
      return `${m.username} must be at least level ${req.minLevel} to enter.`;
    }
    if (req.maxLevel !== undefined && m.level > req.maxLevel) {
      return `${m.username} is above the level cap (${req.maxLevel}) for this dungeon.`;
    }
    if (req.requiredClasses && req.requiredClasses.length > 0 && !req.requiredClasses.includes(m.className)) {
      return `${m.username}'s class cannot enter this dungeon.`;
    }
    if (req.requiredItemId && !m.hasRequiredItem) {
      const itemLabel = requiredItemName ?? 'a required item';
      return `${m.username} needs ${itemLabel} to enter.`;
    }
  }

  return null;
}

/**
 * Whether a reward is available to a given class. Unrestricted rewards (no
 * `classRestriction`, or an empty list) apply to everyone; a null className
 * (characterless) only matches unrestricted rewards.
 */
export function rewardAppliesToClass(reward: DungeonReward, className: ClassName | null): boolean {
  if (!reward.classRestriction || reward.classRestriction.length === 0) return true;
  return className !== null && reward.classRestriction.includes(className);
}

/**
 * Roll a dungeon reward table into concrete item grants. Each reward drops
 * independently at its `chance` (0..1), with a quantity in `[minQty, maxQty]`
 * (both default to 1). `rng` is injectable for deterministic tests. Filter the
 * table with `rewardAppliesToClass` first if class-restricted rewards apply.
 */
export function rollDungeonRewards(
  rewards: DungeonReward[] | undefined,
  rng: () => number = Math.random,
): { itemId: string; quantity: number }[] {
  if (!rewards || rewards.length === 0) return [];
  const granted: { itemId: string; quantity: number }[] = [];
  for (const reward of rewards) {
    if (rng() < reward.chance) {
      const min = reward.minQty ?? 1;
      const max = Math.max(min, reward.maxQty ?? min);
      const quantity = min + Math.floor(rng() * (max - min + 1));
      if (quantity > 0) granted.push({ itemId: reward.itemId, quantity });
    }
  }
  return granted;
}
