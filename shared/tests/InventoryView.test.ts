import { describe, it, expect } from 'vitest';
import {
  getEquippedCount,
  getUnequippedCount,
  getOwnedCount,
  hasItemEquipped,
  hasUnequipped,
  ownsItem,
  getEquippedItemIds,
  getOwnedItemIds,
  listUnequippedEntries,
} from '../src/systems/InventoryView';

const emptyEquipment = {
  head: null,
  chest: null,
  hand: null,
  foot: null,
  mainhand: null,
  offhand: null,
} as Record<string, string | null>;

describe('InventoryView — counts', () => {
  describe('getEquippedCount', () => {
    it('returns 0 when item is not equipped', () => {
      expect(getEquippedCount('sword', emptyEquipment)).toBe(0);
    });

    it('returns 1 when item is equipped in one slot', () => {
      expect(getEquippedCount('helm', { ...emptyEquipment, head: 'helm' })).toBe(1);
    });

    it('returns 2 when a 2H weapon fills both mainhand and offhand', () => {
      expect(getEquippedCount('greatsword', { ...emptyEquipment, mainhand: 'greatsword', offhand: 'greatsword' })).toBe(2);
    });
  });

  describe('getUnequippedCount', () => {
    it('returns 0 for missing items', () => {
      expect(getUnequippedCount('sword', {})).toBe(0);
    });

    it('returns the inventory count', () => {
      expect(getUnequippedCount('potion', { potion: 7 })).toBe(7);
    });

    it('does not consult equipment (callers must not mix the two)', () => {
      // The whole point: inventory already excludes equipped copies.
      // The function must return inventory[id] verbatim, never adjusting for equipment.
      expect(getUnequippedCount('helm', { helm: 1 })).toBe(1);
    });
  });

  describe('getOwnedCount', () => {
    it('sums inventory and equipped slots', () => {
      const inv = { helm: 2 };
      const eq = { ...emptyEquipment, head: 'helm' };
      expect(getOwnedCount('helm', inv, eq)).toBe(3);
    });

    it('counts only equipped when none in inventory', () => {
      expect(getOwnedCount('helm', {}, { ...emptyEquipment, head: 'helm' })).toBe(1);
    });

    it('counts only inventory when none equipped', () => {
      expect(getOwnedCount('helm', { helm: 4 }, emptyEquipment)).toBe(4);
    });

    it('returns 0 when neither inventory nor equipment has the item', () => {
      expect(getOwnedCount('helm', {}, emptyEquipment)).toBe(0);
    });

    it('counts a 2H weapon twice (one for each occupied slot)', () => {
      const eq = { ...emptyEquipment, mainhand: 'greatsword', offhand: 'greatsword' };
      expect(getOwnedCount('greatsword', {}, eq)).toBe(2);
    });
  });
});

describe('InventoryView — booleans', () => {
  describe('hasItemEquipped', () => {
    it('false when not equipped', () => {
      expect(hasItemEquipped('sword', emptyEquipment)).toBe(false);
    });

    it('true when equipped', () => {
      expect(hasItemEquipped('sword', { ...emptyEquipment, mainhand: 'sword' })).toBe(true);
    });
  });

  describe('hasUnequipped', () => {
    it('false for missing items', () => {
      expect(hasUnequipped('sword', {})).toBe(false);
    });

    it('false for zero-count items (stale empty stack)', () => {
      expect(hasUnequipped('sword', { sword: 0 })).toBe(false);
    });

    it('true when count > 0', () => {
      expect(hasUnequipped('sword', { sword: 1 })).toBe(true);
    });

    it('true when player has 1 unequipped + 1 equipped of the same item (regression for trade-picker bug)', () => {
      // The buggy code excluded any inventory item whose ID was also equipped.
      // hasUnequipped must trust the inventory count alone.
      const inv = { helm: 1 };
      expect(hasUnequipped('helm', inv)).toBe(true);
    });
  });

  describe('ownsItem', () => {
    it('true if equipped only', () => {
      expect(ownsItem('helm', {}, { ...emptyEquipment, head: 'helm' })).toBe(true);
    });

    it('true if in inventory only', () => {
      expect(ownsItem('helm', { helm: 1 }, emptyEquipment)).toBe(true);
    });

    it('true if both', () => {
      expect(ownsItem('helm', { helm: 1 }, { ...emptyEquipment, head: 'helm' })).toBe(true);
    });

    it('false if neither', () => {
      expect(ownsItem('helm', {}, emptyEquipment)).toBe(false);
    });

    it('false if inventory has a stale 0-count entry and not equipped', () => {
      expect(ownsItem('helm', { helm: 0 }, emptyEquipment)).toBe(false);
    });
  });
});

describe('InventoryView — sets', () => {
  describe('getEquippedItemIds', () => {
    it('returns an empty set for empty equipment', () => {
      expect(getEquippedItemIds(emptyEquipment).size).toBe(0);
    });

    it('returns one ID per distinct equipped item, deduping 2H', () => {
      const eq = { ...emptyEquipment, head: 'helm', mainhand: 'gs', offhand: 'gs' };
      const set = getEquippedItemIds(eq);
      expect(set.size).toBe(2);
      expect(set.has('helm')).toBe(true);
      expect(set.has('gs')).toBe(true);
    });

    it('skips null slots', () => {
      const eq = { ...emptyEquipment, head: 'helm', chest: null };
      expect(getEquippedItemIds(eq).size).toBe(1);
    });
  });

  describe('getOwnedItemIds', () => {
    it('combines inventory + equipment', () => {
      const inv = { potion: 3, scroll: 1 };
      const eq = { ...emptyEquipment, head: 'helm', mainhand: 'sword' };
      const set = getOwnedItemIds(inv, eq);
      expect(set.size).toBe(4);
      expect(set.has('potion')).toBe(true);
      expect(set.has('scroll')).toBe(true);
      expect(set.has('helm')).toBe(true);
      expect(set.has('sword')).toBe(true);
    });

    it('dedupes when an item is both equipped and held in inventory', () => {
      const inv = { helm: 1 };
      const eq = { ...emptyEquipment, head: 'helm' };
      const set = getOwnedItemIds(inv, eq);
      expect(set.size).toBe(1);
      expect(set.has('helm')).toBe(true);
    });

    it('omits zero-count inventory entries', () => {
      const inv = { ghost: 0 };
      expect(getOwnedItemIds(inv, emptyEquipment).size).toBe(0);
    });
  });
});

describe('InventoryView — lists', () => {
  describe('listUnequippedEntries', () => {
    it('returns inventory entries with count > 0', () => {
      const inv = { potion: 2, scroll: 1 };
      const entries = listUnequippedEntries(inv);
      expect(entries.length).toBe(2);
      expect(entries).toContainEqual(['potion', 2]);
      expect(entries).toContainEqual(['scroll', 1]);
    });

    it('skips zero-count entries', () => {
      const inv = { potion: 2, ghost: 0 };
      const entries = listUnequippedEntries(inv);
      expect(entries.length).toBe(1);
      expect(entries[0][0]).toBe('potion');
    });

    it('returns full count even when an equipped copy of the same ID exists (regression for trade-picker bug)', () => {
      // The buggy trade UI subtracted equipped counts from inventory and hid the item entirely.
      // The list must report the unequipped count verbatim — equipment is not its concern.
      const inv = { helm: 1 };
      const entries = listUnequippedEntries(inv);
      expect(entries).toContainEqual(['helm', 1]);
    });

    it('returns empty array for empty inventory', () => {
      expect(listUnequippedEntries({})).toEqual([]);
    });
  });
});
