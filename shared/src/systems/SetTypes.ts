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

/**
 * A single tier of set bonus, unlocked when the player has at least
 * `piecesRequired` set pieces equipped. The active tier replaces lower
 * tiers — bonuses do NOT stack across breakpoints within a single set.
 */
export interface SetBreakpoint {
  piecesRequired: number;
  bonuses: SetBonuses;
}

export interface SetDefinition {
  id: string;
  name: string;
  itemIds: string[];
  /**
   * Optional class restriction. If absent or empty, the set applies to all classes.
   * If present, only players of the listed classes activate the set bonus.
   */
  classRestriction?: string[];
  /**
   * Tiered bonuses. Each entry's `piecesRequired` should be 1..itemIds.length.
   * Sorted ascending by `piecesRequired`. The highest tier ≤ equipped count is active.
   */
  breakpoints: SetBreakpoint[];
}

// --- Pure helpers ---

/** Returns true if a set applies to the given class (or to any class if className is omitted). */
export function setAppliesToClass(set: SetDefinition, className?: string | null): boolean {
  if (!set.classRestriction || set.classRestriction.length === 0) return true;
  if (!className) return true;
  return set.classRestriction.includes(className);
}

/**
 * Returns the highest breakpoint whose `piecesRequired` ≤ equippedCount.
 * Returns null if no tier is unlocked (or the set has no breakpoints).
 */
export function getActiveBreakpoint(set: SetDefinition, equippedCount: number): SetBreakpoint | null {
  if (!set.breakpoints || set.breakpoints.length === 0) return null;
  let best: SetBreakpoint | null = null;
  for (const bp of set.breakpoints) {
    if (bp.piecesRequired <= equippedCount) {
      if (!best || bp.piecesRequired > best.piecesRequired) best = bp;
    }
  }
  return best;
}

/** Sort breakpoints ascending and clamp piecesRequired to [1, itemIds.length]. Pure. */
export function normalizeBreakpoints(breakpoints: SetBreakpoint[], itemCount: number): SetBreakpoint[] {
  const seen = new Set<number>();
  const result: SetBreakpoint[] = [];
  for (const bp of breakpoints) {
    const pieces = Math.max(1, Math.min(itemCount || 1, Math.floor(bp.piecesRequired)));
    if (seen.has(pieces)) continue;
    seen.add(pieces);
    result.push({ piecesRequired: pieces, bonuses: { ...bp.bonuses } });
  }
  result.sort((a, b) => a.piecesRequired - b.piecesRequired);
  return result;
}

/**
 * Detect set conflicts: an item must not belong to two sets that share at least one class.
 * Unrestricted sets count as "all classes".
 *
 * Returns a list of human-readable conflict descriptions; empty array means valid.
 *
 * Use this when adding/updating a set in the admin: pass the candidate set plus the
 * existing-set list (the candidate's existing entry is matched by id and excluded).
 */
export function findSetConflicts(
  candidate: SetDefinition,
  existingSets: SetDefinition[],
): string[] {
  const errors: string[] = [];
  const candidateClasses = candidate.classRestriction && candidate.classRestriction.length > 0
    ? new Set(candidate.classRestriction)
    : null; // null = unrestricted (all classes)

  for (const other of existingSets) {
    if (other.id === candidate.id) continue;
    const otherClasses = other.classRestriction && other.classRestriction.length > 0
      ? new Set(other.classRestriction)
      : null;

    // Compute class overlap. If either side is unrestricted, overlap is "any class
    // the other side covers" — which is non-empty unless the other side is also empty.
    let overlap: string[] | 'all';
    if (candidateClasses === null && otherClasses === null) {
      overlap = 'all';
    } else if (candidateClasses === null) {
      overlap = [...(otherClasses as Set<string>)];
    } else if (otherClasses === null) {
      overlap = [...candidateClasses];
    } else {
      overlap = [...candidateClasses].filter(c => otherClasses.has(c));
    }
    if (overlap !== 'all' && overlap.length === 0) continue;

    // Find shared items
    const otherItemIds = new Set(other.itemIds);
    const sharedItems = candidate.itemIds.filter(id => otherItemIds.has(id));
    if (sharedItems.length === 0) continue;

    const overlapDesc = overlap === 'all' ? 'all classes' : overlap.join(', ');
    errors.push(
      `Item${sharedItems.length > 1 ? 's' : ''} [${sharedItems.join(', ')}] also belong to set "${other.name}" for ${overlapDesc}. An item cannot be in two sets for the same class.`,
    );
  }
  return errors;
}

// --- Set bonus computation ---

/**
 * Compute aggregated set bonuses across every set the player's class can activate.
 *
 * Each set contributes its highest unlocked breakpoint (one tier per set, no stacking
 * between tiers within the same set). Bonuses across DIFFERENT sets stack additively.
 *
 * If `className` is provided, sets restricted to other classes are skipped. If omitted,
 * every set is considered applicable (legacy / admin preview behavior).
 */
export function computeActiveSetBonuses(
  equipment: Record<string, string | null>,
  sets: Record<string, SetDefinition>,
  className?: string | null,
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
    if (!setAppliesToClass(set, className)) continue;

    let count = 0;
    for (const id of set.itemIds) {
      if (equippedItemIds.has(id)) count++;
    }
    if (count === 0) continue;

    const bp = getActiveBreakpoint(set, count);
    if (!bp) continue;

    activeSetIds.push(set.id);
    const b = bp.bonuses;
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
 *
 * If `className` is provided, returns the (single) set applicable to that class
 * containing the item — there can only be one because of the per-class-uniqueness rule.
 * If omitted, returns the first matching set (legacy fallback).
 *
 * Returns null if the item does not belong to any applicable set.
 */
export function getSetInfoForItem(
  itemId: string,
  sets: Record<string, SetDefinition>,
  ownedItemIds?: Set<string>,
  equippedItemIds?: Set<string>,
  className?: string | null,
): { set: SetDefinition; ownedCount: number; equippedCount: number } | null {
  const matches = getSetsForItem(itemId, sets, className);
  if (matches.length === 0) return null;
  const set = matches[0];
  let ownedCount = 0;
  let equippedCount = 0;
  for (const id of set.itemIds) {
    if (ownedItemIds?.has(id) || equippedItemIds?.has(id)) ownedCount++;
    if (equippedItemIds?.has(id)) equippedCount++;
  }
  return { set, ownedCount, equippedCount };
}

/** Return every set containing the item, optionally filtered to applicable-to-className. */
export function getSetsForItem(
  itemId: string,
  sets: Record<string, SetDefinition>,
  className?: string | null,
): SetDefinition[] {
  const result: SetDefinition[] = [];
  for (const set of Object.values(sets)) {
    if (!set.itemIds.includes(itemId)) continue;
    if (className !== undefined && !setAppliesToClass(set, className)) continue;
    result.push(set);
  }
  return result;
}

/** Format a set's display name with the class suffix when class-restricted. */
export function getSetDisplayName(set: SetDefinition): string {
  if (!set.classRestriction || set.classRestriction.length === 0) return set.name;
  return `${set.name} (${set.classRestriction.join(', ')})`;
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

/**
 * Migrate a legacy set shape (`{ bonuses: SetBonuses }`) to the new shape
 * (`{ breakpoints: [...] }`). Returns the migrated set (or the original if already new-shape).
 *
 * Legacy sets get a single breakpoint at `piecesRequired = itemIds.length`, preserving
 * the prior "all pieces required" behavior.
 */
export function migrateLegacySet(set: SetDefinition | (Omit<SetDefinition, 'breakpoints'> & { bonuses?: SetBonuses; breakpoints?: SetBreakpoint[] })): SetDefinition {
  const raw = set as { id: string; name: string; itemIds: string[]; classRestriction?: string[]; bonuses?: SetBonuses; breakpoints?: SetBreakpoint[] };

  if (raw.breakpoints && raw.breakpoints.length > 0) {
    const itemCount = raw.itemIds.length;
    return {
      id: raw.id,
      name: raw.name,
      itemIds: [...raw.itemIds],
      classRestriction: raw.classRestriction ? [...raw.classRestriction] : undefined,
      breakpoints: normalizeBreakpoints(raw.breakpoints, itemCount),
    };
  }

  const itemCount = raw.itemIds.length;
  const breakpoints: SetBreakpoint[] = raw.bonuses && itemCount > 0
    ? [{ piecesRequired: itemCount, bonuses: { ...raw.bonuses } }]
    : [];

  return {
    id: raw.id,
    name: raw.name,
    itemIds: [...raw.itemIds],
    classRestriction: raw.classRestriction ? [...raw.classRestriction] : undefined,
    breakpoints,
  };
}
