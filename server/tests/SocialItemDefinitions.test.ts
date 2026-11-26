import { describe, expect, it } from 'vitest';
import type { ItemDefinition } from '@idle-party-rpg/shared';
import { enterAsKnight, itemRulesContent, itemRulesManager } from './itemRulesFixture.js';

const ITEMS: Record<string, ItemDefinition> = {
  test_gem: { id: 'test_gem', name: 'Test Gem', rarity: 'rare' },
  test_ruby: { id: 'test_ruby', name: 'Test Ruby', rarity: 'epic' },
  test_pearl: { id: 'test_pearl', name: 'Test Pearl', rarity: 'uncommon' },
};

describe('item definitions for gifts and trades', () => {
  it('include a gift waiting in the mailbox that the player does not own', async () => {
    const pm = itemRulesManager(itemRulesContent({ items: ITEMS }), ['giver', 'taker']);
    await enterAsKnight(pm, 'giver', { test_gem: 2 });
    const taker = await enterAsKnight(pm, 'taker');

    expect(taker.getState([]).itemDefinitions?.test_gem).toBeUndefined();
    expect(pm.sendGift('giver', 'taker', 'test_gem', 2)).toBeNull();

    expect(taker.getInventoryCount('test_gem')).toBe(0);
    expect(taker.getState([]).itemDefinitions?.test_gem).toEqual(ITEMS.test_gem);
  });

  it('include both sides of a pending trade', async () => {
    const pm = itemRulesManager(itemRulesContent({ items: ITEMS }), ['alice', 'bob']);
    const alice = await enterAsKnight(pm, 'alice', { test_ruby: 1 });
    const bob = await enterAsKnight(pm, 'bob', { test_pearl: 1 });
    const has = (u: string, itemId: string, qty: number) => pm.hasItemInInventory(u, itemId, qty);

    const proposed = pm.trades.proposeTrade('alice', 'bob', [{ itemId: 'test_ruby', quantity: 1 }], has, () => false);
    if (typeof proposed === 'string') throw new Error(proposed);
    expect(bob.getState([]).itemDefinitions?.test_ruby).toEqual(ITEMS.test_ruby);

    pm.trades.counterTrade(proposed.id, 'bob', [{ itemId: 'test_pearl', quantity: 1 }], has);
    expect(alice.getState([]).itemDefinitions?.test_pearl).toEqual(ITEMS.test_pearl);
    expect(bob.getState([]).itemDefinitions).toMatchObject({ test_ruby: ITEMS.test_ruby, test_pearl: ITEMS.test_pearl });
  });
});
