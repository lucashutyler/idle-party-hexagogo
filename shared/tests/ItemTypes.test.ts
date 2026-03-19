import { describe, it, expect } from 'vitest';
import {
  destroyItems,
  equipItemForceDestroy,
  MAX_STACK,
  SEED_ITEMS,
} from '../src/systems/ItemTypes';
import type { EquipSlot, ItemDefinition } from '../src/systems/ItemTypes';

describe('destroyItems', () => {
  it('removes items from inventory', () => {
    const inv: Record<string, number> = { rusty_dagger: 5 };
    const result = destroyItems(inv, 'rusty_dagger', 3);
    expect(result).toEqual({ success: true, removed: 3 });
    expect(inv.rusty_dagger).toBe(2);
  });

  it('removes all items and deletes key when destroying full stack', () => {
    const inv: Record<string, number> = { rusty_dagger: 3 };
    const result = destroyItems(inv, 'rusty_dagger', 3);
    expect(result).toEqual({ success: true, removed: 3 });
    expect(inv.rusty_dagger).toBeUndefined();
  });

  it('clamps to available count when destroying more than available', () => {
    const inv: Record<string, number> = { rusty_dagger: 2 };
    const result = destroyItems(inv, 'rusty_dagger', 10);
    expect(result).toEqual({ success: true, removed: 2 });
    expect(inv.rusty_dagger).toBeUndefined();
  });

  it('fails for nonexistent item', () => {
    const inv: Record<string, number> = {};
    const result = destroyItems(inv, 'rusty_dagger', 1);
    expect(result).toEqual({ success: false, removed: 0 });
  });

  it('fails for zero count', () => {
    const inv: Record<string, number> = { rusty_dagger: 5 };
    const result = destroyItems(inv, 'rusty_dagger', 0);
    expect(result).toEqual({ success: false, removed: 0 });
  });

  it('fails for negative count', () => {
    const inv: Record<string, number> = { rusty_dagger: 5 };
    const result = destroyItems(inv, 'rusty_dagger', -1);
    expect(result).toEqual({ success: false, removed: 0 });
  });
});

describe('equipItemForceDestroy', () => {
  it('equips item and destroys old equipped item', () => {
    const inv: Record<string, number> = { rusty_dagger: MAX_STACK, janky_helmet: 1 };
    const equip: Record<string, string | null> = { mainhand: 'rusty_dagger', head: null, chest: null, foot: null };
    // Try to equip another rusty_dagger — normally blocked because the unequipped one can't go back (stack=99)
    // But we have a janky_helmet we could equip in a different slot — let's test with the mainhand slot
    // Put a different mainhand item in inventory
    const items: Record<string, ItemDefinition> = {
      ...SEED_ITEMS,
      sharp_sword: { id: 'sharp_sword', name: 'Sharp Sword', rarity: 'common', equipSlot: 'mainhand' as EquipSlot },
    };
    inv['sharp_sword'] = 1;

    const result = equipItemForceDestroy(inv, equip, 'sharp_sword', items);
    expect(result).toEqual({ success: true, destroyedItemId: 'rusty_dagger' });
    expect(equip.mainhand).toBe('sharp_sword');
    expect(inv['sharp_sword']).toBeUndefined();
    // Old item was destroyed, not added to inventory
    expect(inv['rusty_dagger']).toBe(MAX_STACK);
  });

  it('equips item when slot is empty', () => {
    const inv: Record<string, number> = { rusty_dagger: 1 };
    const equip: Record<string, string | null> = { mainhand: null, head: null, chest: null, foot: null };

    const result = equipItemForceDestroy(inv, equip, 'rusty_dagger', SEED_ITEMS);
    expect(result).toEqual({ success: true, destroyedItemId: undefined });
    expect(equip.mainhand).toBe('rusty_dagger');
    expect(inv['rusty_dagger']).toBeUndefined();
  });

  it('fails for non-equippable item', () => {
    const inv: Record<string, number> = { mangy_pelt: 5 };
    const equip: Record<string, string | null> = { mainhand: null, head: null, chest: null, foot: null };

    const result = equipItemForceDestroy(inv, equip, 'mangy_pelt', SEED_ITEMS);
    expect(result).toEqual({ success: false });
    expect(inv['mangy_pelt']).toBe(5);
  });

  it('fails for item not in inventory', () => {
    const inv: Record<string, number> = {};
    const equip: Record<string, string | null> = { mainhand: null, head: null, chest: null, foot: null };

    const result = equipItemForceDestroy(inv, equip, 'rusty_dagger', SEED_ITEMS);
    expect(result).toEqual({ success: false });
  });
});
