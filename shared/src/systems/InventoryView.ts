/**
 * InventoryView — read-only views over inventory + equipment for any character.
 *
 * A character's items live in two places that are mutually exclusive:
 *   - `inventory: Record<string, number>` — unequipped copies, keyed by item ID
 *   - `equipment: Record<string, string | null>` — slot → equipped item ID
 *
 * `equipItem`/`unequipItem` move items between them, so an equipped item is
 * NEVER counted in `inventory`. Several past bugs came from forgetting that
 * invariant (filtering inventory by "is this ID equipped?", or subtracting
 * an equipped count from an inventory count). Use these helpers instead of
 * iterating the maps directly so the rule lives in one place.
 *
 * These functions take their data as arguments and have no global state, so
 * they work for the current player AND for any other player whose data you
 * have a reference to (e.g. a remote player's profile equipment in the
 * `view_player` response). Helpers that only need `equipment` are the ones
 * to use for remote profiles, since `inventory` is private and not shared
 * across players.
 *
 * Pure functions, no state. Safe to call from client or server.
 */

type Inventory = Record<string, number>;
type Equipment = Record<string, string | null>;

// ── Counts ───────────────────────────────────────────────────────────────────

/** Number of equipped slots holding `itemId` (a 2H weapon counts once per slot it occupies). */
export function getEquippedCount(itemId: string, equipment: Equipment): number {
  let n = 0;
  for (const id of Object.values(equipment)) {
    if (id === itemId) n++;
  }
  return n;
}

/** Number of unequipped copies of `itemId` (i.e. how many can be traded, sold, or destroyed). */
export function getUnequippedCount(itemId: string, inventory: Inventory): number {
  return inventory[itemId] ?? 0;
}

/** Total copies of `itemId` the player has (unequipped + equipped slots). */
export function getOwnedCount(itemId: string, inventory: Inventory, equipment: Equipment): number {
  return getUnequippedCount(itemId, inventory) + getEquippedCount(itemId, equipment);
}

// ── Booleans ─────────────────────────────────────────────────────────────────

/** True iff any slot holds `itemId`. Works on the current player's or any other player's equipment. */
export function hasItemEquipped(itemId: string, equipment: Equipment): boolean {
  return getEquippedCount(itemId, equipment) > 0;
}

/** True iff the player has at least one unequipped copy of `itemId` (i.e. tradeable / sellable). */
export function hasUnequipped(itemId: string, inventory: Inventory): boolean {
  return getUnequippedCount(itemId, inventory) > 0;
}

/** True iff the player owns at least one copy of `itemId`, whether equipped or not. */
export function ownsItem(itemId: string, inventory: Inventory, equipment: Equipment): boolean {
  return hasUnequipped(itemId, inventory) || hasItemEquipped(itemId, equipment);
}

// ── Sets ─────────────────────────────────────────────────────────────────────

/** Set of distinct item IDs currently equipped (deduped across slots). */
export function getEquippedItemIds(equipment: Equipment): Set<string> {
  const ids = new Set<string>();
  for (const id of Object.values(equipment)) {
    if (id) ids.add(id);
  }
  return ids;
}

/** Set of distinct item IDs the player owns (unequipped + equipped). */
export function getOwnedItemIds(inventory: Inventory, equipment: Equipment): Set<string> {
  const ids = new Set<string>();
  for (const [id, count] of Object.entries(inventory)) {
    if (count > 0) ids.add(id);
  }
  for (const id of Object.values(equipment)) {
    if (id) ids.add(id);
  }
  return ids;
}

// ── Lists ────────────────────────────────────────────────────────────────────

/**
 * Entries `[itemId, count]` for every unequipped item with count > 0.
 * Use this for trade pickers, shop sell lists, drop pickers, etc.
 * The returned counts are the number of copies eligible for the action —
 * do NOT subtract equipped counts from these.
 */
export function listUnequippedEntries(inventory: Inventory): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [id, count] of Object.entries(inventory)) {
    if (count > 0) out.push([id, count]);
  }
  return out;
}
