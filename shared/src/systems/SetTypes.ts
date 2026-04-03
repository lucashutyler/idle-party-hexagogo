import type { EquipmentBonuses } from './ItemTypes.js';

// --- Types ---

export interface SetBonuses {
  /** Lower active skill cooldown by X ticks. */
  cooldownReduction?: number;
  /** X% increased damage (applied after flat damage calc, stacks additively). */
  damagePercent?: number;
  /** X% damage resistance (applied before DR/MR, stacks additively). */
  damageResistancePercent?: number;
  /** Flat DR min bonus. */
  damageReductionMin?: number;
  /** Flat DR max bonus. */
  damageReductionMax?: number;
  /** Flat MR min bonus. */
  magicReductionMin?: number;
  /** Flat MR max bonus. */
  magicReductionMax?: number;
  /** Flat attack min bonus. */
  bonusAttackMin?: number;
  /** Flat attack max bonus. */
  bonusAttackMax?: number;
  /** Flat HP bonus. */
  flatHp?: number;
  /** Percent HP bonus (applied after flat HP, stacks additively). */
  percentHp?: number;
}

export interface SetDefinition {
  id: string;
  name: string;
  itemIds: string[];
  bonuses: SetBonuses;
}

// --- Pure functions ---

/**
 * Compute which sets are fully equipped and return their combined bonuses.
 * Returns active set IDs and merged flat bonuses (for merging into EquipmentBonuses)
 * plus percentage bonuses (for combat calculations).
 */
export function computeActiveSetBonuses(
  equipment: Record<string, string | null>,
  sets: Record<string, SetDefinition>,
): { activeSetIds: string[]; bonuses: SetBonuses } {
  const equippedItemIds = new Set<string>();
  for (const itemId of Object.values(equipment)) {
    if (itemId) equippedItemIds.add(itemId);
  }

  const activeSetIds: string[] = [];
  const combined: Required<SetBonuses> = {
    cooldownReduction: 0,
    damagePercent: 0,
    damageResistancePercent: 0,
    damageReductionMin: 0,
    damageReductionMax: 0,
    magicReductionMin: 0,
    magicReductionMax: 0,
    bonusAttackMin: 0,
    bonusAttackMax: 0,
    flatHp: 0,
    percentHp: 0,
  };

  for (const set of Object.values(sets)) {
    if (set.itemIds.length === 0) continue;
    const allEquipped = set.itemIds.every(id => equippedItemIds.has(id));
    if (!allEquipped) continue;

    activeSetIds.push(set.id);
    const b = set.bonuses;
    combined.cooldownReduction += b.cooldownReduction ?? 0;
    combined.damagePercent += b.damagePercent ?? 0;
    combined.damageResistancePercent += b.damageResistancePercent ?? 0;
    combined.damageReductionMin += b.damageReductionMin ?? 0;
    combined.damageReductionMax += b.damageReductionMax ?? 0;
    combined.magicReductionMin += b.magicReductionMin ?? 0;
    combined.magicReductionMax += b.magicReductionMax ?? 0;
    combined.bonusAttackMin += b.bonusAttackMin ?? 0;
    combined.bonusAttackMax += b.bonusAttackMax ?? 0;
    combined.flatHp += b.flatHp ?? 0;
    combined.percentHp += b.percentHp ?? 0;
  }

  return { activeSetIds, bonuses: combined };
}

/**
 * Merge set flat bonuses into equipment bonuses.
 * Returns a new EquipmentBonuses with set bonuses added.
 */
export function mergeSetBonusesIntoEquip(
  equipBonuses: EquipmentBonuses,
  setBonuses: SetBonuses,
): EquipmentBonuses {
  return {
    bonusAttackMin: equipBonuses.bonusAttackMin + (setBonuses.bonusAttackMin ?? 0),
    bonusAttackMax: equipBonuses.bonusAttackMax + (setBonuses.bonusAttackMax ?? 0),
    damageReductionMin: equipBonuses.damageReductionMin + (setBonuses.damageReductionMin ?? 0),
    damageReductionMax: equipBonuses.damageReductionMax + (setBonuses.damageReductionMax ?? 0),
    magicReductionMin: equipBonuses.magicReductionMin + (setBonuses.magicReductionMin ?? 0),
    magicReductionMax: equipBonuses.magicReductionMax + (setBonuses.magicReductionMax ?? 0),
  };
}

/**
 * Get set info for a specific item (for UI display).
 * Returns null if the item doesn't belong to any set.
 */
export function getSetInfoForItem(
  itemId: string,
  sets: Record<string, SetDefinition>,
  ownedItemIds?: Set<string>,
  equippedItemIds?: Set<string>,
): { set: SetDefinition; ownedCount: number; equippedCount: number } | null {
  for (const set of Object.values(sets)) {
    if (!set.itemIds.includes(itemId)) continue;
    let ownedCount = 0;
    let equippedCount = 0;
    for (const id of set.itemIds) {
      if (ownedItemIds?.has(id) || equippedItemIds?.has(id)) ownedCount++;
      if (equippedItemIds?.has(id)) equippedCount++;
    }
    return { set, ownedCount, equippedCount };
  }
  return null;
}

/** Get a human-readable description of set bonuses. */
export function getSetBonusText(bonuses: SetBonuses): string {
  const parts: string[] = [];
  if (bonuses.cooldownReduction) parts.push(`-${bonuses.cooldownReduction} Active CD`);
  if (bonuses.damagePercent) parts.push(`+${bonuses.damagePercent}% Damage`);
  if (bonuses.damageResistancePercent) parts.push(`${bonuses.damageResistancePercent}% Damage Resistance`);
  if (bonuses.damageReductionMin || bonuses.damageReductionMax) {
    parts.push(`+${bonuses.damageReductionMin ?? 0}-${bonuses.damageReductionMax ?? 0} DR`);
  }
  if (bonuses.magicReductionMin || bonuses.magicReductionMax) {
    parts.push(`+${bonuses.magicReductionMin ?? 0}-${bonuses.magicReductionMax ?? 0} MR`);
  }
  if (bonuses.bonusAttackMin || bonuses.bonusAttackMax) {
    parts.push(`+${bonuses.bonusAttackMin ?? 0}-${bonuses.bonusAttackMax ?? 0} Attack`);
  }
  if (bonuses.flatHp) parts.push(`+${bonuses.flatHp} HP`);
  if (bonuses.percentHp) parts.push(`+${bonuses.percentHp}% HP`);
  return parts.join(', ') || 'No bonus';
}
