/**
 * Generalized entry gating for rooms (hex tiles) and map transitions.
 *
 * Supersedes the original item-only gate (`requiredItemId`): a gate is now a
 * record of independent requirements, every one of which every party member
 * must satisfy. The legacy scalar field is still honoured — it is folded into
 * this model at read time by {@link toRoomRequirements}, so existing content
 * and existing authoring surfaces keep working with no migration.
 *
 * Gates attach at three levels: a tile type default, a per-room override
 * ({@link mergeRoomRequirements} combines those two per field), and a
 * per-transition gate (evaluated in addition to the destination room's gate).
 *
 * This module is dependency-free so both `hex/` and `systems/` can import it.
 */

/** A room / transition entry gate. Absent fields are unconstrained. */
export interface RoomEntryRequirements {
  /** Minimum character level (inclusive) every member must have. */
  minLevel?: number;
  /** Item every member must have equipped. */
  requiredItemId?: string;
  /** Quests every member must have completed (turned in). */
  requiredQuestIds?: string[];
}

/**
 * Per-member facts needed to evaluate a gate. Pre-resolved by the caller so
 * the validator stays pure — mirrors `DungeonEntryMemberInfo`, but
 * carries whole sets because a movement path evaluates one gate *per room*
 * and the same member info is reused across the whole path.
 */
export interface RoomEntryMemberInfo {
  username: string;
  level: number;
  /** Item IDs currently equipped by this member. */
  equippedItemIds: ReadonlySet<string>;
  /** Quest IDs this member has turned in. */
  completedQuestIds: ReadonlySet<string>;
}

/** Display-name resolvers so the validator can produce player-facing prose. */
export interface RoomEntryLabels {
  itemName?: (itemId: string) => string | undefined;
  questName?: (questId: string) => string | undefined;
}

/** Which kind of requirement was unmet. */
export type RoomEntryFailureKind = 'item' | 'level' | 'quest';

/**
 * A single unmet requirement plus the members who don't satisfy it.
 * `reason` is player-facing prose and already uses "room" terminology.
 */
export interface RoomEntryFailure {
  kind: RoomEntryFailureKind;
  reason: string;
  missingPlayers: string[];
  /** Set when kind === 'item'. */
  itemId?: string;
  itemName?: string;
  /** Set when kind === 'quest'. */
  questId?: string;
  questName?: string;
  /** Set when kind === 'level'. */
  minLevel?: number;
}

/** True when a gate constrains nothing (undefined, or every field unset/empty). */
export function isRoomGateEmpty(reqs: RoomEntryRequirements | undefined): boolean {
  if (!reqs) return true;
  if (reqs.minLevel !== undefined) return false;
  if (reqs.requiredItemId) return false;
  if (reqs.requiredQuestIds && reqs.requiredQuestIds.length > 0) return false;
  return true;
}

/**
 * Fold a legacy top-level `requiredItemId` into a requirements object. The
 * object's own `requiredItemId` wins. Returns undefined when nothing is gated,
 * so callers can treat "no gate" as a single falsy case.
 */
export function toRoomRequirements(
  reqs: RoomEntryRequirements | undefined,
  legacyRequiredItemId?: string,
): RoomEntryRequirements | undefined {
  const itemId = reqs?.requiredItemId || legacyRequiredItemId || undefined;
  const questIds = reqs?.requiredQuestIds && reqs.requiredQuestIds.length > 0 ? reqs.requiredQuestIds : undefined;
  const minLevel = reqs?.minLevel;
  if (itemId === undefined && questIds === undefined && minLevel === undefined) return undefined;
  const out: RoomEntryRequirements = {};
  if (minLevel !== undefined) out.minLevel = minLevel;
  if (itemId !== undefined) out.requiredItemId = itemId;
  if (questIds !== undefined) out.requiredQuestIds = questIds;
  return out;
}

/**
 * Combine a tile-type default with a per-room override, field by field: a
 * field set on the override wins, an unset field falls through to the base.
 *
 * This generalizes the original scalar rule (`perTile ?? tileTypeDef`). Whole-
 * object replacement was rejected because adding a level requirement to one
 * room would silently drop the item requirement it inherits from its type.
 * The trade-off is that a room cannot *clear* a requirement its type sets.
 */
export function mergeRoomRequirements(
  base: RoomEntryRequirements | undefined,
  override: RoomEntryRequirements | undefined,
): RoomEntryRequirements | undefined {
  if (!base) return override;
  if (!override) return base;
  const merged: RoomEntryRequirements = {};
  const minLevel = override.minLevel ?? base.minLevel;
  const requiredItemId = override.requiredItemId ?? base.requiredItemId;
  const requiredQuestIds = override.requiredQuestIds ?? base.requiredQuestIds;
  if (minLevel !== undefined) merged.minLevel = minLevel;
  if (requiredItemId !== undefined) merged.requiredItemId = requiredItemId;
  if (requiredQuestIds !== undefined) merged.requiredQuestIds = requiredQuestIds;
  return merged;
}

/**
 * Validate whether a party may enter a gated room or take a gated transition.
 * Returns the first unmet requirement, or `null` if entry is allowed.
 *
 * ALL members must satisfy every requirement — the same semantics the item
 * gate has always had. Pure and deterministic so it can be unit-tested and
 * reused on client and server, mirroring `validateDungeonEntry`.
 *
 * Checks run item → level → quest so that a purely item-gated room produces
 * exactly the rejection it produced before this model existed.
 */
export function validateRoomEntry(
  reqs: RoomEntryRequirements | undefined,
  members: RoomEntryMemberInfo[],
  labels?: RoomEntryLabels,
): RoomEntryFailure | null {
  if (!reqs) return null;

  const itemId = reqs.requiredItemId;
  if (itemId) {
    const missingPlayers = members.filter(m => !m.equippedItemIds.has(itemId)).map(m => m.username);
    if (missingPlayers.length > 0) {
      const itemName = labels?.itemName?.(itemId) ?? itemId;
      return {
        kind: 'item',
        itemId,
        itemName,
        missingPlayers,
        reason: `${itemName} is required to enter this room.`,
      };
    }
  }

  const minLevel = reqs.minLevel;
  if (minLevel !== undefined) {
    const missingPlayers = members.filter(m => m.level < minLevel).map(m => m.username);
    if (missingPlayers.length > 0) {
      return {
        kind: 'level',
        minLevel,
        missingPlayers,
        reason: `Level ${minLevel} is required to enter this room.`,
      };
    }
  }

  for (const questId of reqs.requiredQuestIds ?? []) {
    const missingPlayers = members.filter(m => !m.completedQuestIds.has(questId)).map(m => m.username);
    if (missingPlayers.length > 0) {
      const questName = labels?.questName?.(questId) ?? questId;
      return {
        kind: 'quest',
        questId,
        questName,
        missingPlayers,
        reason: `"${questName}" must be completed to enter this room.`,
      };
    }
  }

  return null;
}
