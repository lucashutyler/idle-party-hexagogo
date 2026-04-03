import { describe, it, expect } from 'vitest';
import {
  destroyItems,
  equipItem,
  equipItemForceDestroy,
  unequipItem,
  computeEquipmentBonuses,
  isTwoHandedEquipped,
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

describe('equipItem - duplication prevention', () => {
  const items: Record<string, ItemDefinition> = {
    ...SEED_ITEMS,
    big_rock: { id: 'big_rock', name: 'Big Rock', rarity: 'common', equipSlot: 'twohanded' as EquipSlot },
    small_shield: { id: 'small_shield', name: 'Small Shield', rarity: 'common', equipSlot: 'offhand' as EquipSlot },
  };

  it('does not duplicate mainhand item when equipping 2H fails due to full offhand stack', () => {
    const inv: Record<string, number> = { big_rock: 1, small_shield: MAX_STACK };
    const equip: Record<string, string | null> = {
      mainhand: 'rusty_dagger',
      offhand: 'small_shield',
      head: null, chest: null, foot: null,
    };

    // Equipping 2H big_rock should fail because small_shield is at MAX_STACK
    const result = equipItem(inv, equip, 'big_rock', items);
    expect(result.success).toBe(false);

    // CRITICAL: mainhand item must NOT be duplicated in inventory
    expect(inv['rusty_dagger']).toBeUndefined();
    expect(equip.mainhand).toBe('rusty_dagger');
    expect(equip.offhand).toBe('small_shield');
    // big_rock should still be in inventory untouched
    expect(inv['big_rock']).toBe(1);
  });

  it('correctly equips 2H weapon when both slots can be returned', () => {
    const inv: Record<string, number> = { big_rock: 1 };
    const equip: Record<string, string | null> = {
      mainhand: 'rusty_dagger',
      offhand: 'small_shield',
      head: null, chest: null, foot: null,
    };

    const result = equipItem(inv, equip, 'big_rock', items);
    expect(result.success).toBe(true);
    expect(equip.mainhand).toBe('big_rock');
    expect(equip.offhand).toBe('big_rock');
    expect(inv['rusty_dagger']).toBe(1);
    expect(inv['small_shield']).toBe(1);
    expect(inv['big_rock']).toBeUndefined();
  });

  it('rejects items with invalid equipSlot', () => {
    const badItems: Record<string, ItemDefinition> = {
      fake: { id: 'fake', name: 'Fake', rarity: 'common', equipSlot: 'bogus' as EquipSlot },
    };
    const inv: Record<string, number> = { fake: 1 };
    const equip: Record<string, string | null> = { mainhand: null };

    const result = equipItem(inv, equip, 'fake', badItems);
    expect(result.success).toBe(false);
    expect(inv['fake']).toBe(1);
  });
});

describe('unequipItem - stale 2H state', () => {
  it('treats same item in both mainhand and offhand as 2H even without definition', () => {
    const inv: Record<string, number> = {};
    const equip: Record<string, string | null> = {
      mainhand: 'old_weapon',
      offhand: 'old_weapon',
      head: null, chest: null, foot: null,
    };

    // Unequip mainhand — should clear BOTH slots and return only 1 copy
    const result = unequipItem(inv, equip, 'mainhand');
    expect(result.success).toBe(true);
    expect(result.itemId).toBe('old_weapon');
    expect(equip.mainhand).toBeNull();
    expect(equip.offhand).toBeNull();
    expect(inv['old_weapon']).toBe(1);
  });

  it('prevents double-counting when unequipping offhand of stale 2H', () => {
    const inv: Record<string, number> = {};
    const equip: Record<string, string | null> = {
      mainhand: 'old_weapon',
      offhand: 'old_weapon',
    };

    const result = unequipItem(inv, equip, 'offhand');
    expect(result.success).toBe(true);
    expect(equip.mainhand).toBeNull();
    expect(equip.offhand).toBeNull();
    expect(inv['old_weapon']).toBe(1);
  });
});

// --- Shared test items for new suites ---
const testItems: Record<string, ItemDefinition> = {
  ...SEED_ITEMS,
  big_axe: { id: 'big_axe', name: 'Big Axe', rarity: 'common', equipSlot: 'twohanded' as EquipSlot, bonusAttackMin: 3, bonusAttackMax: 6, value: 1 },
  small_shield: { id: 'small_shield', name: 'Small Shield', rarity: 'common', equipSlot: 'offhand' as EquipSlot, damageReductionMin: 1, damageReductionMax: 2, value: 1 },
  sharp_sword: { id: 'sharp_sword', name: 'Sharp Sword', rarity: 'common', equipSlot: 'mainhand' as EquipSlot, bonusAttackMin: 2, bonusAttackMax: 4, value: 1 },
  magic_ring: { id: 'magic_ring', name: 'Magic Ring', rarity: 'uncommon', equipSlot: 'ring' as EquipSlot, magicReductionMin: 1, magicReductionMax: 2, value: 1 },
  knight_sword: { id: 'knight_sword', name: 'Knight Sword', rarity: 'rare', equipSlot: 'mainhand' as EquipSlot, classRestriction: ['Knight'], bonusAttackMin: 5, bonusAttackMax: 8, value: 1 },
  hybrid_weapon: { id: 'hybrid_weapon', name: 'Hybrid Weapon', rarity: 'rare', equipSlot: 'mainhand' as EquipSlot, classRestriction: ['Knight', 'Archer'], bonusAttackMin: 4, bonusAttackMax: 7, value: 1 },
};

describe('equipItem - twohanded slot', () => {
  it('equip a twohanded item fills mainhand + offhand', () => {
    const inv: Record<string, number> = { big_axe: 1 };
    const equip: Record<string, string | null> = { mainhand: null, offhand: null, head: null, chest: null, foot: null };

    const result = equipItem(inv, equip, 'big_axe', testItems);
    expect(result.success).toBe(true);
    expect(equip.mainhand).toBe('big_axe');
    expect(equip.offhand).toBe('big_axe');
    expect(inv['big_axe']).toBeUndefined();
  });

  it('equip twohanded when mainhand occupied returns mainhand to inventory', () => {
    const inv: Record<string, number> = { big_axe: 1 };
    const equip: Record<string, string | null> = { mainhand: 'sharp_sword', offhand: null, head: null, chest: null, foot: null };

    const result = equipItem(inv, equip, 'big_axe', testItems);
    expect(result.success).toBe(true);
    expect(equip.mainhand).toBe('big_axe');
    expect(equip.offhand).toBe('big_axe');
    expect(inv['sharp_sword']).toBe(1);
    expect(inv['big_axe']).toBeUndefined();
  });

  it('equip twohanded when offhand (shield) occupied returns offhand to inventory', () => {
    const inv: Record<string, number> = { big_axe: 1 };
    const equip: Record<string, string | null> = { mainhand: null, offhand: 'small_shield', head: null, chest: null, foot: null };

    const result = equipItem(inv, equip, 'big_axe', testItems);
    expect(result.success).toBe(true);
    expect(equip.mainhand).toBe('big_axe');
    expect(equip.offhand).toBe('big_axe');
    expect(inv['small_shield']).toBe(1);
    expect(inv['big_axe']).toBeUndefined();
  });

  it('equip twohanded when both mainhand + offhand occupied returns both to inventory', () => {
    const inv: Record<string, number> = { big_axe: 1 };
    const equip: Record<string, string | null> = { mainhand: 'sharp_sword', offhand: 'small_shield', head: null, chest: null, foot: null };

    const result = equipItem(inv, equip, 'big_axe', testItems);
    expect(result.success).toBe(true);
    expect(equip.mainhand).toBe('big_axe');
    expect(equip.offhand).toBe('big_axe');
    expect(inv['sharp_sword']).toBe(1);
    expect(inv['small_shield']).toBe(1);
    expect(inv['big_axe']).toBeUndefined();
  });

  it('equip twohanded when another twohanded is equipped returns old 2H', () => {
    const items2: Record<string, ItemDefinition> = {
      ...testItems,
      big_axe_2: { id: 'big_axe_2', name: 'Big Axe 2', rarity: 'uncommon', equipSlot: 'twohanded' as EquipSlot, bonusAttackMin: 5, bonusAttackMax: 10, value: 1 },
    };
    const inv: Record<string, number> = { big_axe_2: 1 };
    const equip: Record<string, string | null> = { mainhand: 'big_axe', offhand: 'big_axe', head: null, chest: null, foot: null };

    const result = equipItem(inv, equip, 'big_axe_2', items2);
    expect(result.success).toBe(true);
    expect(equip.mainhand).toBe('big_axe_2');
    expect(equip.offhand).toBe('big_axe_2');
    expect(inv['big_axe']).toBe(1);
    expect(inv['big_axe_2']).toBeUndefined();
  });

  it('equip a mainhand item when 2H equipped clears both slots, returns 2H', () => {
    const inv: Record<string, number> = { sharp_sword: 1 };
    const equip: Record<string, string | null> = { mainhand: 'big_axe', offhand: 'big_axe', head: null, chest: null, foot: null };

    const result = equipItem(inv, equip, 'sharp_sword', testItems);
    expect(result.success).toBe(true);
    expect(equip.mainhand).toBe('sharp_sword');
    expect(equip.offhand).toBeNull();
    expect(inv['big_axe']).toBe(1);
    expect(inv['sharp_sword']).toBeUndefined();
  });

  it('equip an offhand item when 2H equipped clears both slots, returns 2H', () => {
    const inv: Record<string, number> = { small_shield: 1 };
    const equip: Record<string, string | null> = { mainhand: 'big_axe', offhand: 'big_axe', head: null, chest: null, foot: null };

    const result = equipItem(inv, equip, 'small_shield', testItems);
    expect(result.success).toBe(true);
    expect(equip.mainhand).toBeNull();
    expect(equip.offhand).toBe('small_shield');
    expect(inv['big_axe']).toBe(1);
    expect(inv['small_shield']).toBeUndefined();
  });

  it('unequip mainhand when 2H equipped clears both slots, returns 1 item', () => {
    const inv: Record<string, number> = {};
    const equip: Record<string, string | null> = { mainhand: 'big_axe', offhand: 'big_axe', head: null, chest: null, foot: null };

    const result = unequipItem(inv, equip, 'mainhand', testItems);
    expect(result.success).toBe(true);
    expect(result.itemId).toBe('big_axe');
    expect(equip.mainhand).toBeNull();
    expect(equip.offhand).toBeNull();
    expect(inv['big_axe']).toBe(1);
  });

  it('unequip offhand when 2H equipped clears both slots, returns 1 item', () => {
    const inv: Record<string, number> = {};
    const equip: Record<string, string | null> = { mainhand: 'big_axe', offhand: 'big_axe', head: null, chest: null, foot: null };

    const result = unequipItem(inv, equip, 'offhand', testItems);
    expect(result.success).toBe(true);
    expect(result.itemId).toBe('big_axe');
    expect(equip.mainhand).toBeNull();
    expect(equip.offhand).toBeNull();
    expect(inv['big_axe']).toBe(1);
  });

  it('ring with equipSlot ring cannot affect mainhand/offhand', () => {
    const inv: Record<string, number> = { magic_ring: 1 };
    const equip: Record<string, string | null> = { mainhand: 'sharp_sword', offhand: 'small_shield', ring: null, head: null, chest: null, foot: null };

    const result = equipItem(inv, equip, 'magic_ring', testItems);
    expect(result.success).toBe(true);
    expect(equip.ring).toBe('magic_ring');
    // mainhand and offhand must remain untouched
    expect(equip.mainhand).toBe('sharp_sword');
    expect(equip.offhand).toBe('small_shield');
    expect(inv['magic_ring']).toBeUndefined();
  });
});

describe('equipItemForceDestroy - twohanded', () => {
  it('force equip 1H when 2H is equipped destroys 2H', () => {
    const inv: Record<string, number> = { sharp_sword: 1 };
    const equip: Record<string, string | null> = { mainhand: 'big_axe', offhand: 'big_axe', head: null, chest: null, foot: null };

    const result = equipItemForceDestroy(inv, equip, 'sharp_sword', testItems);
    expect(result.success).toBe(true);
    expect(result.destroyedItemId).toBe('big_axe');
    expect(equip.mainhand).toBe('sharp_sword');
    expect(equip.offhand).toBeNull();
    // big_axe was destroyed, not in inventory
    expect(inv['big_axe']).toBeUndefined();
    expect(inv['sharp_sword']).toBeUndefined();
  });

  it('force equip 2H when 1H + shield equipped destroys mainhand', () => {
    const inv: Record<string, number> = { big_axe: 1 };
    const equip: Record<string, string | null> = { mainhand: 'sharp_sword', offhand: 'small_shield', head: null, chest: null, foot: null };

    const result = equipItemForceDestroy(inv, equip, 'big_axe', testItems);
    expect(result.success).toBe(true);
    // destroys mainhand item (sharp_sword)
    expect(result.destroyedItemId).toBe('sharp_sword');
    expect(equip.mainhand).toBe('big_axe');
    expect(equip.offhand).toBe('big_axe');
    expect(inv['big_axe']).toBeUndefined();
    // sharp_sword was destroyed
    expect(inv['sharp_sword']).toBeUndefined();
  });
});

describe('computeEquipmentBonuses', () => {
  it('does not double-count 2H weapon stats', () => {
    const equip: Record<string, string | null> = { mainhand: 'big_axe', offhand: 'big_axe', head: null, chest: null, foot: null };

    const bonuses = computeEquipmentBonuses(equip, testItems);
    // big_axe has bonusAttackMin: 3, bonusAttackMax: 6 — should only count once
    expect(bonuses.bonusAttackMin).toBe(3);
    expect(bonuses.bonusAttackMax).toBe(6);
  });

  it('includes MR from equipment', () => {
    const equip: Record<string, string | null> = { ring: 'magic_ring', mainhand: null, offhand: null, head: null, chest: null, foot: null };

    const bonuses = computeEquipmentBonuses(equip, testItems);
    expect(bonuses.magicReductionMin).toBe(1);
    expect(bonuses.magicReductionMax).toBe(2);
    // physical DR should be zero
    expect(bonuses.damageReductionMin).toBe(0);
    expect(bonuses.damageReductionMax).toBe(0);
  });

  it('heirloom scaling works with MR', () => {
    const heirloomItems: Record<string, ItemDefinition> = {
      ...testItems,
      heirloom_amulet: {
        id: 'heirloom_amulet',
        name: 'Heirloom Amulet',
        rarity: 'heirloom',
        equipSlot: 'necklace' as EquipSlot,
        magicReductionMin: 1,
        magicReductionMax: 2,
        bonusAttackMin: 1,
        bonusAttackMax: 1,
        value: 1,
      },
    };
    const equip: Record<string, string | null> = { necklace: 'heirloom_amulet', mainhand: null, offhand: null, head: null, chest: null, foot: null };

    const bonuses = computeEquipmentBonuses(equip, heirloomItems, 10);
    // Heirloom scales by level: 1*10 = 10, 2*10 = 20
    expect(bonuses.magicReductionMin).toBe(10);
    expect(bonuses.magicReductionMax).toBe(20);
    expect(bonuses.bonusAttackMin).toBe(10);
    expect(bonuses.bonusAttackMax).toBe(10);
  });
});

describe('classRestriction as array', () => {
  it('item with classRestriction: [Knight] can be equipped by Knight', () => {
    const inv: Record<string, number> = { knight_sword: 1 };
    const equip: Record<string, string | null> = { mainhand: null, offhand: null, head: null, chest: null, foot: null };

    const result = equipItem(inv, equip, 'knight_sword', testItems, 'Knight');
    expect(result.success).toBe(true);
    expect(equip.mainhand).toBe('knight_sword');
  });

  it('item with classRestriction: [Knight] cannot be equipped by Archer', () => {
    const inv: Record<string, number> = { knight_sword: 1 };
    const equip: Record<string, string | null> = { mainhand: null, offhand: null, head: null, chest: null, foot: null };

    const result = equipItem(inv, equip, 'knight_sword', testItems, 'Archer');
    expect(result.success).toBe(false);
    expect(equip.mainhand).toBeNull();
    expect(inv['knight_sword']).toBe(1);
  });

  it('item with classRestriction: [Knight, Archer] can be equipped by either', () => {
    // Knight
    const inv1: Record<string, number> = { hybrid_weapon: 1 };
    const equip1: Record<string, string | null> = { mainhand: null, offhand: null, head: null, chest: null, foot: null };
    const result1 = equipItem(inv1, equip1, 'hybrid_weapon', testItems, 'Knight');
    expect(result1.success).toBe(true);
    expect(equip1.mainhand).toBe('hybrid_weapon');

    // Archer
    const inv2: Record<string, number> = { hybrid_weapon: 1 };
    const equip2: Record<string, string | null> = { mainhand: null, offhand: null, head: null, chest: null, foot: null };
    const result2 = equipItem(inv2, equip2, 'hybrid_weapon', testItems, 'Archer');
    expect(result2.success).toBe(true);
    expect(equip2.mainhand).toBe('hybrid_weapon');

    // Mage should fail
    const inv3: Record<string, number> = { hybrid_weapon: 1 };
    const equip3: Record<string, string | null> = { mainhand: null, offhand: null, head: null, chest: null, foot: null };
    const result3 = equipItem(inv3, equip3, 'hybrid_weapon', testItems, 'Mage');
    expect(result3.success).toBe(false);
  });
});
