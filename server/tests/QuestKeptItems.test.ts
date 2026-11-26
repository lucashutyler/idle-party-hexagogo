import { describe, expect, it } from 'vitest';
import type {
  DungeonDefinition,
  ItemDefinition,
  MonsterDefinition,
  QuestDefinition,
  RecipeDefinition,
  ShopDefinition,
} from '@idle-party-rpg/shared';
import { questOnlyCollectItems } from '../src/game/QuestKeptItems.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';
import { enterAsKnight, itemRulesContent, itemRulesManager } from './itemRulesFixture.js';

const item = (id: string, extra: Partial<ItemDefinition> = {}): ItemDefinition => ({ id, name: `Test ${id}`, rarity: 'common', value: 3, ...extra });

const ITEMS: Record<string, ItemDefinition> = Object.fromEntries([
  item('moon_key'),
  item('wolf_fang'),
  item('iron_nail'),
  item('oat_bread'),
  item('crown_shard'),
  item('first_relic'),
  item('week_token'),
  item('star_dust'),
  item('plain_rock'),
  item('worn_hat', { equipSlot: 'head' }),
  item('new_hat', { equipSlot: 'head' }),
].map(def => [def.id, def]));

function quest(id: string, collect: string[], extra: Partial<QuestDefinition> = {}): QuestDefinition {
  return {
    id,
    name: `Quest ${id}`,
    description: '',
    scope: 'solo',
    objectives: collect.map(itemId => ({ kind: 'collect' as const, itemId, count: 1 })),
    rewards: [{ kind: 'xp', amount: 1 }],
    ...extra,
  };
}

const QUESTS: Record<string, QuestDefinition> = Object.fromEntries([
  quest('q_gate', ['moon_key', 'worn_hat']),
  quest('q_gate_again', ['moon_key']),
  quest('q_give_key', [], { rewards: [{ kind: 'item', itemId: 'moon_key', quantity: 1 }] }),
  quest('q_fangs', ['wolf_fang']),
  quest('q_nails', ['iron_nail']),
  quest('q_bread', ['oat_bread']),
  quest('q_crown', ['crown_shard', 'first_relic']),
  quest('q_tokens', ['week_token']),
  quest('q_weekly_reward', [], { repeat: 'weekly', rewards: [{ kind: 'item', itemId: 'week_token', quantity: 1 }] }),
  quest('q_weekly_collect', ['star_dust'], { repeat: 'weekly' }),
].map(def => [def.id, def]));

const MONSTERS: Record<string, MonsterDefinition> = {
  test_wolf: { id: 'test_wolf', name: 'Test Wolf', hp: 5, damage: 1, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0, drops: [{ itemId: 'wolf_fang', chance: 0.5 }] },
};

const SHOPS: Record<string, ShopDefinition> = {
  test_shop: { id: 'test_shop', name: 'Test Shop', inventory: [{ itemId: 'iron_nail', price: 2 }] },
};

const RECIPES: Record<string, RecipeDefinition> = {
  test_bread: { id: 'test_bread', name: 'Bake', durationSeconds: 1, ingredients: [], result: { itemId: 'oat_bread', quantity: 1 } },
};

const DUNGEONS: Record<string, DungeonDefinition> = {
  test_cave: {
    id: 'test_cave',
    name: 'Test Cave',
    floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [], rewards: [{ itemId: 'crown_shard', chance: 1 }] }],
    firstClearRewards: [{ itemId: 'first_relic', chance: 1 }],
  },
};

const content = () => itemRulesContent({ items: ITEMS, quests: QUESTS, monsters: MONSTERS, shops: SHOPS, recipes: RECIPES, dungeons: DUNGEONS });

function complete(session: PlayerSession, ...questIds: string[]): void {
  session.quests.loadFromSaveData({
    active: [],
    completed: questIds.map(questId => ({ questId, completedAt: new Date().toISOString() })),
    weeklyCompletions: {},
  });
}

describe('questOnlyCollectItems', () => {
  it('keeps an item only one-time quests hand out, with every one-time quest that collects it', () => {
    const kept = questOnlyCollectItems(content());
    expect(kept.get('moon_key')).toEqual(['q_gate', 'q_gate_again']);
    expect(kept.get('worn_hat')).toEqual(['q_gate']);
  });

  it.each([
    ['a monster drop', 'wolf_fang'],
    ['a shop', 'iron_nail'],
    ['a recipe', 'oat_bread'],
    ['a dungeon floor reward', 'crown_shard'],
    ['a dungeon first clear', 'first_relic'],
    ['a weekly quest reward', 'week_token'],
  ])('does not keep an item %s hands out', (_source, itemId) => {
    expect(questOnlyCollectItems(content()).has(itemId)).toBe(false);
  });

  it('does not keep an item only a weekly quest collects, nor one no quest collects', () => {
    const kept = questOnlyCollectItems(content());
    expect(kept.has('star_dust')).toBe(false);
    expect(kept.has('plain_rock')).toBe(false);
  });

  it('counts only quests some NPC offers, since no other quest can be turned in', () => {
    const offered = Object.keys(QUESTS).filter(id => id !== 'q_gate');
    const kept = questOnlyCollectItems(itemRulesContent({ items: ITEMS, quests: QUESTS, npcQuestIds: offered }));
    expect(kept.get('moon_key')).toEqual(['q_gate_again']);
    expect(kept.has('worn_hat')).toBe(false);
  });

  it('is rebuilt once the content changes', () => {
    const live = content();
    const before = questOnlyCollectItems(live);
    expect(questOnlyCollectItems(live)).toBe(before);

    SHOPS.test_shop.inventory.push({ itemId: 'moon_key', price: 9 });
    try {
      expect(questOnlyCollectItems(live).has('moon_key')).toBe(true);
      live.contentEpoch++;
      expect(questOnlyCollectItems(live).has('moon_key')).toBe(false);
    } finally {
      SHOPS.test_shop.inventory.pop();
    }
  });
});

describe('items a quest still needs', () => {
  async function knight(inventory: Record<string, number>) {
    const pm = itemRulesManager(content(), ['hero', 'friend']);
    const session = await enterAsKnight(pm, 'hero', inventory);
    await enterAsKnight(pm, 'friend');
    return { pm, session };
  }

  const protectedRefusal = { type: 'error', message: 'Test moon_key is needed for a quest.', code: 'item_protected' };

  it('lists kept items the player holds, until every quest that collects them is done', async () => {
    const { session } = await knight({ moon_key: 1, wolf_fang: 2 });
    expect(session.getState([]).character?.questKeptItemIds).toEqual(['moon_key']);

    complete(session, 'q_gate');
    expect(session.getState([]).character?.questKeptItemIds).toEqual(['moon_key']);

    complete(session, 'q_gate', 'q_gate_again');
    expect(session.getState([]).character?.questKeptItemIds).toBeUndefined();
    expect(session.protectedItemRefusal('moon_key')).toBeNull();
  });

  it('refuses to destroy a kept item', async () => {
    const { session } = await knight({ moon_key: 2 });
    expect(session.handleDestroyItems('moon_key', 1)).toEqual(protectedRefusal);
    expect(session.getInventoryCount('moon_key')).toBe(2);
  });

  it('refuses to sell a kept item', async () => {
    const { session } = await knight({ moon_key: 2 });
    expect(session.handleSellItems('moon_key', 1)).toEqual(protectedRefusal);
    expect(session.getInventoryCount('moon_key')).toBe(2);
    expect(session.getGold()).toBe(0);
  });

  it('refuses to gift a kept item', async () => {
    const { pm, session } = await knight({ moon_key: 2 });
    expect(pm.sendGift('hero', 'friend', 'moon_key', 1)).toEqual(protectedRefusal);
    expect(session.getInventoryCount('moon_key')).toBe(2);
    expect(pm.mailboxes.getMailbox('friend')).toEqual([]);
  });

  it('refuses to offer a kept item in a trade', async () => {
    const { pm } = await knight({ moon_key: 2, wolf_fang: 1 });
    expect(pm.tradeOffer('hero', [{ itemId: 'wolf_fang', quantity: 1 }, { itemId: 'moon_key', quantity: 1 }])).toEqual(protectedRefusal);
    expect(pm.tradeOffer('hero', [{ itemId: 'wolf_fang', quantity: 1 }])).toEqual([{ itemId: 'wolf_fang', quantity: 1 }]);
  });

  it('refuses to destroy a kept item that is equipped to make room, but lets one be equipped', async () => {
    const { session } = await knight({ worn_hat: 1, new_hat: 1 });
    expect(session.handleEquipItem('worn_hat')).toBe(true);

    expect(session.handleEquipItemForceDestroy('new_hat')).toEqual({
      type: 'error', message: 'Test worn_hat is needed for a quest.', code: 'item_protected',
    });
    expect(session.getEquippedItemIds()).toEqual(new Set(['worn_hat']));

    complete(session, 'q_gate');
    expect(session.handleEquipItemForceDestroy('new_hat')).toBeNull();
    expect(session.getEquippedItemIds()).toEqual(new Set(['new_hat']));
  });

  it('still destroys, sells and gifts items with another source', async () => {
    const { pm, session } = await knight({ wolf_fang: 5 });
    expect(session.handleDestroyItems('wolf_fang', 1)).toBeNull();
    expect(session.handleSellItems('wolf_fang', 2)).toBeNull();
    expect(session.getGold()).toBe(6);
    expect(pm.sendGift('hero', 'friend', 'wolf_fang', 1)).toBeNull();
    expect(session.getInventoryCount('wolf_fang')).toBe(1);
  });
});

describe('selling', () => {
  it.each([0, -1, 1.5, 1e-20])('refuses to sell %s items', async (quantity) => {
    const pm = itemRulesManager(content(), ['hero']);
    const session = await enterAsKnight(pm, 'hero', { wolf_fang: 3 });
    expect(session.handleSellItems('wolf_fang', quantity)).toEqual({ type: 'error', message: 'Invalid quantity' });
    expect(session.getInventoryCount('wolf_fang')).toBe(3);
  });

  it('pays the floored sell value per item, with no shop in the room', async () => {
    const pm = itemRulesManager(itemRulesContent({ items: { pebble: item('pebble', { value: 2.9 }) } }), ['hero']);
    const session = await enterAsKnight(pm, 'hero', { pebble: 4 });
    expect(session.getCurrentShop()).toBeUndefined();
    expect(session.handleSellItems('pebble', 3)).toBeNull();
    expect(session.getGold()).toBe(6);
    expect(session.getInventoryCount('pebble')).toBe(1);
  });
});
