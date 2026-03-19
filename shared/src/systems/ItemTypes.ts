// --- Types ---

export type ItemRarity = 'janky' | 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'heirloom';

export type EquipSlot = 'head' | 'shoulders' | 'chest' | 'bracers' | 'gloves' | 'mainhand' | 'offhand' | 'foot' | 'ring' | 'necklace' | 'back' | 'relic';

export interface ItemDefinition {
  id: string;
  name: string;
  rarity: ItemRarity;
  equipSlot?: EquipSlot;
  twoHanded?: boolean;
  classRestriction?: string;
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
  uncommon: 0.15,
  rare: 0.10,
  epic: 0.04,
  legendary: 0.01,
  heirloom: 0,
};

export const EQUIP_SLOTS: EquipSlot[] = ['head', 'shoulders', 'chest', 'bracers', 'gloves', 'mainhand', 'offhand', 'foot', 'ring', 'necklace', 'back', 'relic'];

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
    equipSlot: 'mainhand',
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
  tarnished_ring: {
    id: 'tarnished_ring',
    name: 'Tarnished Ring',
    rarity: 'janky',
    equipSlot: 'ring',
    bonusAttackMin: 0,
    bonusAttackMax: 1,
  },
  frayed_cord_necklace: {
    id: 'frayed_cord_necklace',
    name: 'Frayed Cord Necklace',
    rarity: 'janky',
    equipSlot: 'necklace',
    damageReductionMin: 0,
    damageReductionMax: 1,
  },
  splintered_buckler: {
    id: 'splintered_buckler',
    name: 'Splintered Buckler',
    rarity: 'janky',
    equipSlot: 'offhand',
    damageReductionMin: 0,
    damageReductionMax: 1,
    dodgeChance: 0.01,
  },
  moth_eaten_cloak: {
    id: 'moth_eaten_cloak',
    name: 'Moth-Eaten Cloak',
    rarity: 'common',
    equipSlot: 'back',
    dodgeChance: 0.02,
  },
  cracked_bracers: {
    id: 'cracked_bracers',
    name: 'Cracked Bracers',
    rarity: 'janky',
    equipSlot: 'bracers',
    damageReductionMin: 0,
    damageReductionMax: 1,
  },
  tattered_pauldrons: {
    id: 'tattered_pauldrons',
    name: 'Tattered Pauldrons',
    rarity: 'janky',
    equipSlot: 'shoulders',
    damageReductionMin: 0,
    damageReductionMax: 1,
    bonusAttackMin: 0,
    bonusAttackMax: 1,
  },
  worn_gloves: {
    id: 'worn_gloves',
    name: 'Worn Gloves',
    rarity: 'janky',
    equipSlot: 'gloves',
    bonusAttackMin: 0,
    bonusAttackMax: 1,
  },
  ancestral_blade: {
    id: 'ancestral_blade',
    name: 'Ancestral Blade',
    rarity: 'heirloom',
    equipSlot: 'mainhand',
    bonusAttackMin: 1,
    bonusAttackMax: 2,
  },
  ancestral_ward: {
    id: 'ancestral_ward',
    name: 'Ancestral Ward',
    rarity: 'heirloom',
    equipSlot: 'offhand',
    damageReductionMin: 1,
    damageReductionMax: 1,
  },
  ancestral_signet: {
    id: 'ancestral_signet',
    name: 'Ancestral Signet',
    rarity: 'heirloom',
    equipSlot: 'ring',
    bonusAttackMin: 0,
    bonusAttackMax: 1,
    dodgeChance: 0.01,
  },
  cracked_idol: {
    id: 'cracked_idol',
    name: 'Cracked Idol',
    rarity: 'janky',
    equipSlot: 'relic',
    bonusAttackMin: 0,
    bonusAttackMax: 1,
    damageReductionMin: 0,
    damageReductionMax: 1,
  },
  iron_battleaxe: {
    id: 'iron_battleaxe',
    name: 'Iron Battleaxe',
    rarity: 'uncommon',
    equipSlot: 'mainhand',
    twoHanded: true,
    classRestriction: 'Knight',
    bonusAttackMin: 3,
    bonusAttackMax: 6,
  },
  short_bow: {
    id: 'short_bow',
    name: 'Short Bow',
    rarity: 'common',
    equipSlot: 'mainhand',
    twoHanded: true,
    classRestriction: 'Archer',
    bonusAttackMin: 2,
    bonusAttackMax: 5,
  },
  prayer_beads: {
    id: 'prayer_beads',
    name: 'Prayer Beads',
    rarity: 'common',
    equipSlot: 'necklace',
    classRestriction: 'Priest',
    damageReductionMin: 1,
    damageReductionMax: 2,
  },
  gnarled_wand: {
    id: 'gnarled_wand',
    name: 'Gnarled Wand',
    rarity: 'common',
    equipSlot: 'mainhand',
    classRestriction: 'Mage',
    bonusAttackMin: 2,
    bonusAttackMax: 4,
  },
  tin_whistle: {
    id: 'tin_whistle',
    name: 'Tin Whistle',
    rarity: 'common',
    equipSlot: 'relic',
    classRestriction: 'Bard',
    bonusAttackMin: 1,
    bonusAttackMax: 2,
    dodgeChance: 0.02,
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

/** Check if an equipped item is a two-handed weapon (fills both mainhand and offhand). */
export function isTwoHandedEquipped(
  equipment: Record<string, string | null>,
  items: Record<string, ItemDefinition>,
): boolean {
  const mh = equipment.mainhand;
  if (!mh) return false;
  const def = items[mh];
  return !!def?.twoHanded;
}

/**
 * Equip an item from inventory into its slot.
 * Returns { success: true, unequippedItemId? } on success.
 * If the slot was occupied, the old item is returned to inventory.
 * Two-handed weapons fill both mainhand and offhand.
 * Equipping into mainhand or offhand when a 2H is equipped unequips the 2H first.
 */
export function equipItem(
  inventory: Record<string, number>,
  equipment: Record<string, string | null>,
  itemId: string,
  items: Record<string, ItemDefinition>,
  className?: string,
): { success: boolean; unequippedItemId?: string } {
  const def = items[itemId];
  if (!def || !def.equipSlot) return { success: false };
  if (def.classRestriction && className && def.classRestriction !== className) return { success: false };

  // Must have the item in inventory
  if ((inventory[itemId] ?? 0) <= 0) return { success: false };

  const slot = def.equipSlot;

  // If a 2H weapon is currently equipped and we're touching mainhand or offhand, unequip it first
  if ((slot === 'mainhand' || slot === 'offhand') && isTwoHandedEquipped(equipment, items)) {
    const twoHandId = equipment.mainhand!;
    if (!addItemToInventory(inventory, twoHandId)) return { success: false };
    equipment.mainhand = null;
    equipment.offhand = null;
    // Now proceed to equip the new item into the target slot
  } else {
    // Normal case: if slot is occupied, return old item to inventory
    const currentEquipped = equipment[slot];
    if (currentEquipped) {
      if (!addItemToInventory(inventory, currentEquipped)) return { success: false };
    }
  }

  // If equipping a 2H weapon, also clear offhand (return to inventory if occupied)
  if (def.twoHanded) {
    const offhandItem = equipment.offhand;
    if (offhandItem) {
      if (!addItemToInventory(inventory, offhandItem)) return { success: false };
    }
  }

  // Remove new item from inventory and equip it
  removeItemFromInventory(inventory, itemId);
  equipment[slot] = itemId;
  if (def.twoHanded) {
    equipment.offhand = itemId;
  }

  return { success: true, unequippedItemId: undefined };
}

/**
 * Unequip an item from a slot back to inventory.
 * Returns { success: true, itemId } on success.
 * If a 2H weapon is equipped, clicking either mainhand or offhand unequips both.
 */
export function unequipItem(
  inventory: Record<string, number>,
  equipment: Record<string, string | null>,
  slot: EquipSlot,
  items?: Record<string, ItemDefinition>,
): { success: boolean; itemId?: string } {
  const equipped = equipment[slot];
  if (!equipped) return { success: false };

  // Check if this is a 2H weapon (same item in both mainhand and offhand)
  if ((slot === 'mainhand' || slot === 'offhand') && items && isTwoHandedEquipped(equipment, items)) {
    const twoHandId = equipment.mainhand!;
    if ((inventory[twoHandId] ?? 0) >= MAX_STACK) return { success: false };
    addItemToInventory(inventory, twoHandId);
    equipment.mainhand = null;
    equipment.offhand = null;
    return { success: true, itemId: twoHandId };
  }

  // Check if inventory can hold the item
  if ((inventory[equipped] ?? 0) >= MAX_STACK) return { success: false };

  addItemToInventory(inventory, equipped);
  equipment[slot] = null;
  return { success: true, itemId: equipped };
}

/**
 * Compute combined equipment bonuses across all equipped items. Avoids double-counting 2H weapons.
 * Heirloom items scale their stats by player level.
 */
export function computeEquipmentBonuses(
  equipment: Record<string, string | null>,
  items: Record<string, ItemDefinition>,
  level: number = 1,
): EquipmentBonuses {
  const bonuses: EquipmentBonuses = {
    bonusAttackMin: 0,
    bonusAttackMax: 0,
    damageReductionMin: 0,
    damageReductionMax: 0,
    dodgeChance: 0,
  };

  // Skip offhand if it's the same item as mainhand (2H weapon)
  const skip2H = equipment.mainhand && equipment.mainhand === equipment.offhand;

  for (const [slot, itemId] of Object.entries(equipment)) {
    if (!itemId) continue;
    if (skip2H && slot === 'offhand') continue;
    const def = items[itemId];
    if (!def) continue;
    const scale = def.rarity === 'heirloom' ? level : 1;
    bonuses.bonusAttackMin += (def.bonusAttackMin ?? 0) * scale;
    bonuses.bonusAttackMax += (def.bonusAttackMax ?? 0) * scale;
    bonuses.damageReductionMin += (def.damageReductionMin ?? 0) * scale;
    bonuses.damageReductionMax += (def.damageReductionMax ?? 0) * scale;
    bonuses.dodgeChance += (def.dodgeChance ?? 0) * scale;
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
  let text = parts.join(', ');
  if (def.rarity === 'heirloom') text = `${text} (x Lv)`;
  if (def.classRestriction) text = `${text} [${def.classRestriction}]`;
  return text;
}

/**
 * Destroy (remove) items from inventory.
 * Returns { success, removed } where removed is the actual number destroyed.
 */
export function destroyItems(
  inventory: Record<string, number>,
  itemId: string,
  count: number,
): { success: boolean; removed: number } {
  if (count <= 0) return { success: false, removed: 0 };
  const current = inventory[itemId] ?? 0;
  if (current <= 0) return { success: false, removed: 0 };

  const removed = Math.min(count, current);
  if (removed >= current) {
    delete inventory[itemId];
  } else {
    inventory[itemId] = current - removed;
  }
  return { success: true, removed };
}

/**
 * Equip an item, destroying the currently equipped item instead of returning it to inventory.
 * Use when normal equipItem fails due to full inventory.
 * Handles 2H weapons: destroys the 2H when replacing with 1H, or destroys offhand when equipping 2H.
 */
export function equipItemForceDestroy(
  inventory: Record<string, number>,
  equipment: Record<string, string | null>,
  itemId: string,
  items: Record<string, ItemDefinition>,
  className?: string,
): { success: boolean; destroyedItemId?: string } {
  const def = items[itemId];
  if (!def || !def.equipSlot) return { success: false };
  if (def.classRestriction && className && def.classRestriction !== className) return { success: false };
  if ((inventory[itemId] ?? 0) <= 0) return { success: false };

  const slot = def.equipSlot;

  // If a 2H is equipped and we're touching mainhand/offhand, destroy the 2H and clear both slots
  if ((slot === 'mainhand' || slot === 'offhand') && isTwoHandedEquipped(equipment, items)) {
    const destroyedId = equipment.mainhand!;
    equipment.mainhand = null;
    equipment.offhand = null;
    removeItemFromInventory(inventory, itemId);
    equipment[slot] = itemId;
    if (def.twoHanded) equipment.offhand = itemId;
    return { success: true, destroyedItemId: destroyedId };
  }

  const currentEquipped = equipment[slot];

  // If equipping a 2H, also destroy/clear offhand
  if (def.twoHanded) {
    equipment.offhand = null;
  }

  removeItemFromInventory(inventory, itemId);
  equipment[slot] = itemId;
  if (def.twoHanded) equipment.offhand = itemId;

  return { success: true, destroyedItemId: currentEquipped ?? undefined };
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
