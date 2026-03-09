// --- Types ---

export type ItemRarity = 'janky' | 'common';

export type EquipSlot = 'head' | 'chest' | 'hand' | 'foot';

export interface ItemDefinition {
  id: string;
  name: string;
  rarity: ItemRarity;
  equipSlot?: EquipSlot;
  bonusAttackMin?: number;
  bonusAttackMax?: number;
  damageReductionMin?: number;
  damageReductionMax?: number;
  dodgeChance?: number;
}

export interface ItemDrop {
  itemId: string;
  chance: number;
}

export interface EquipmentBonuses {
  bonusAttackMin: number;
  bonusAttackMax: number;
  damageReductionMin: number;
  damageReductionMax: number;
  dodgeChance: number;
}

// --- Constants ---

export const MAX_STACK = 99;

export const RARITY_DROP_RATES: Record<ItemRarity, number> = {
  janky: 0.40,
  common: 0.25,
};

export const EQUIP_SLOTS: EquipSlot[] = ['head', 'chest', 'hand', 'foot'];

export const SEED_ITEMS: Record<string, ItemDefinition> = {
  janky_helmet: {
    id: 'janky_helmet',
    name: 'Janky Helmet',
    rarity: 'janky',
    equipSlot: 'head',
    damageReductionMin: 0,
    damageReductionMax: 1,
  },
  rusty_dagger: {
    id: 'rusty_dagger',
    name: 'Rusty Dagger',
    rarity: 'janky',
    equipSlot: 'hand',
    bonusAttackMin: 1,
    bonusAttackMax: 3,
  },
  leather_vest: {
    id: 'leather_vest',
    name: 'Leather Vest',
    rarity: 'common',
    equipSlot: 'chest',
    damageReductionMin: 1,
    damageReductionMax: 2,
  },
  old_leather_boots: {
    id: 'old_leather_boots',
    name: 'Old Leather Boots',
    rarity: 'janky',
    equipSlot: 'foot',
    dodgeChance: 0.02,
  },
  mangy_pelt: {
    id: 'mangy_pelt',
    name: 'Mangy Pelt',
    rarity: 'janky',
  },
};

// --- Pure functions ---

/** Add one item to inventory. Returns false if stack is already at MAX_STACK. */
export function addItemToInventory(inventory: Record<string, number>, itemId: string): boolean {
  const current = inventory[itemId] ?? 0;
  if (current >= MAX_STACK) return false;
  inventory[itemId] = current + 1;
  return true;
}

/** Remove one item from inventory. Returns false if item not in inventory. */
export function removeItemFromInventory(inventory: Record<string, number>, itemId: string): boolean {
  const current = inventory[itemId] ?? 0;
  if (current <= 0) return false;
  if (current === 1) {
    delete inventory[itemId];
  } else {
    inventory[itemId] = current - 1;
  }
  return true;
}

/**
 * Equip an item from inventory into its slot.
 * Returns { success: true, unequippedItemId? } on success.
 * If the slot was occupied, the old item is returned to inventory.
 */
export function equipItem(
  inventory: Record<string, number>,
  equipment: Record<string, string | null>,
  itemId: string,
  items: Record<string, ItemDefinition>,
): { success: boolean; unequippedItemId?: string } {
  const def = items[itemId];
  if (!def || !def.equipSlot) return { success: false };

  // Must have the item in inventory
  if ((inventory[itemId] ?? 0) <= 0) return { success: false };

  const slot = def.equipSlot;
  const currentEquipped = equipment[slot];

  // If slot is occupied, return old item to inventory
  if (currentEquipped) {
    if (!addItemToInventory(inventory, currentEquipped)) {
      // Inventory full for old item — can't swap
      return { success: false };
    }
  }

  // Remove new item from inventory and equip it
  removeItemFromInventory(inventory, itemId);
  equipment[slot] = itemId;

  return { success: true, unequippedItemId: currentEquipped ?? undefined };
}

/**
 * Unequip an item from a slot back to inventory.
 * Returns { success: true, itemId } on success.
 */
export function unequipItem(
  inventory: Record<string, number>,
  equipment: Record<string, string | null>,
  slot: EquipSlot,
): { success: boolean; itemId?: string } {
  const equipped = equipment[slot];
  if (!equipped) return { success: false };

  // Check if inventory can hold the item
  if ((inventory[equipped] ?? 0) >= MAX_STACK) return { success: false };

  addItemToInventory(inventory, equipped);
  equipment[slot] = null;
  return { success: true, itemId: equipped };
}

/** Compute combined equipment bonuses across all equipped items. */
export function computeEquipmentBonuses(
  equipment: Record<string, string | null>,
  items: Record<string, ItemDefinition>,
): EquipmentBonuses {
  const bonuses: EquipmentBonuses = {
    bonusAttackMin: 0,
    bonusAttackMax: 0,
    damageReductionMin: 0,
    damageReductionMax: 0,
    dodgeChance: 0,
  };

  for (const itemId of Object.values(equipment)) {
    if (!itemId) continue;
    const def = items[itemId];
    if (!def) continue;
    bonuses.bonusAttackMin += def.bonusAttackMin ?? 0;
    bonuses.bonusAttackMax += def.bonusAttackMax ?? 0;
    bonuses.damageReductionMin += def.damageReductionMin ?? 0;
    bonuses.damageReductionMax += def.damageReductionMax ?? 0;
    bonuses.dodgeChance += def.dodgeChance ?? 0;
  }

  return bonuses;
}

/** Get a human-readable description of an item's effects. */
export function getItemEffectText(def: ItemDefinition): string {
  const parts: string[] = [];
  if (def.bonusAttackMin != null && def.bonusAttackMax != null && def.bonusAttackMax > 0) {
    parts.push(`+${def.bonusAttackMin}-${def.bonusAttackMax} Attack`);
  }
  if (def.damageReductionMin != null && def.damageReductionMax != null && def.damageReductionMax > 0) {
    parts.push(`Blocks ${def.damageReductionMin}-${def.damageReductionMax} damage`);
  }
  if (def.dodgeChance != null && def.dodgeChance > 0) {
    parts.push(`${Math.round(def.dodgeChance * 100)}% Dodge`);
  }
  if (parts.length === 0) {
    return def.equipSlot ? 'No bonus' : 'Material';
  }
  return parts.join(', ');
}

/** Roll drops for a list of possible drops. Returns item IDs that dropped. */
export function rollDrops(drops: ItemDrop[]): string[] {
  const result: string[] = [];
  for (const drop of drops) {
    if (Math.random() < drop.chance) {
      result.push(drop.itemId);
    }
  }
  return result;
}
