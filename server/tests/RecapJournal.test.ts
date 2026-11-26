import { describe, it, expect } from 'vitest';
import { MAX_STACK } from '@idle-party-rpg/shared';
import type { ItemDefinition, QuestDefinition } from '@idle-party-rpg/shared';
import { PlayerSession } from '../src/game/PlayerSession.js';
import type { WorldGrids } from '../src/game/WorldGrids.js';
import { journal, recapContent, recapSession, room } from './recapFixture.js';

const ITEMS: Record<string, ItemDefinition> = {
  pelt: { id: 'pelt', name: 'Wolf Pelt', rarity: 'common', value: 4 },
  tooth: { id: 'tooth', name: 'Wolf Tooth', rarity: 'common', value: 2 },
  bar: { id: 'bar', name: 'Iron Bar', rarity: 'common', value: 9 },
  ore: { id: 'ore', name: 'Iron Ore', rarity: 'common', value: 1 },
};

const PELTS: QuestDefinition = {
  id: 'pelts', name: 'Pelts for the Tanner', description: '', scope: 'party_shared',
  objectives: [{ kind: 'collect', itemId: 'pelt', count: 3 }],
  rewards: [{ kind: 'gold', amount: 5 }],
};

const TEETH: QuestDefinition = {
  id: 'teeth', name: 'A Bag of Teeth', description: '', scope: 'party_shared',
  objectives: [{ kind: 'visit', tileId: 'start' }],
  rewards: [{ kind: 'item', itemId: 'tooth', quantity: 3 }],
};

function setup() {
  const content = recapContent({
    tiles: [
      room('start', 0, 0, { name: 'Old Mill', npcId: 'tanner' }),
      room('east', 1, 0),
      room('far', 5, 0),
      room('farWest', 4, 0),
      room('farEast', 6, 0),
    ],
    items: ITEMS,
    quests: { pelts: PELTS, teeth: TEETH },
    npcs: { tanner: { id: 'tanner', name: 'Tanner', emoji: '🧔', greeting: 'Hi', questIds: ['pelts', 'teeth'] } },
    recipes: {
      smelt: {
        id: 'smelt', name: 'Smelt Iron', durationSeconds: 10,
        ingredients: [{ itemId: 'ore', quantity: 1 }], result: { itemId: 'bar', quantity: 2 },
      },
    },
  });
  return { content, ...recapSession(content) };
}

const LEFT_BEHIND = /^Bags full: /;

describe('Full bags', () => {
  it('writes one line per fight that left items behind and counts them for the recap, without paying for them', () => {
    const { session, hex } = setup();
    session.addToInventory('pelt', MAX_STACK);
    session.addToInventory('tooth', MAX_STACK);
    session.beginAway();
    const gold = session.getGold();

    session.handleVictory({ xp: 3, gold: 2, items: ['pelt', 'tooth', 'bar'] }, hex('start'), { unlockTiles: false });

    expect(journal(session).filter(t => LEFT_BEHIND.test(t))).toEqual([
      'Bags full: 2 items couldn\'t be carried. Sell some from the Hero screen.',
    ]);
    expect(journal(session)).toContain('Found Iron Bar!');
    expect(session.getAwayLedger()).toMatchObject({ itemsLost: 2, gold: 2 });
    expect(session.getGold()).toBe(gold + 2);
    expect(session.getInventoryCount('pelt')).toBe(MAX_STACK);

    session.handleVictory({ xp: 3, gold: 0, items: ['bar'] }, hex('start'), { unlockTiles: false });
    expect(journal(session).filter(t => LEFT_BEHIND.test(t))).toHaveLength(1);
  });

  it('says so for one item, and for dungeon rewards by name', () => {
    const { session, hex } = setup();
    session.addToInventory('pelt', MAX_STACK);
    session.handleVictory({ xp: 3, gold: 0, items: ['pelt'] }, hex('start'), { unlockTiles: false });
    expect(journal(session).slice(-2)).toEqual([
      'Bags full: 1 item couldn\'t be carried. Sell some from the Hero screen.',
      '+3 XP',
    ]);

    session.beginAway();
    expect(session.grantRewardItem('pelt')).toBe(false);
    expect(journal(session).slice(-1)).toEqual(['Bags full: Wolf Pelt couldn\'t be carried. Sell some from the Hero screen.']);
    expect(session.getAwayLedger()!.itemsLost).toBe(1);
    expect(session.grantRewardItem('bar')).toBe(true);
  });

  it('journals crafted items that did not fit and counts them while away', () => {
    const { session } = setup();
    session.addToInventory('ore', 1);
    session.addToInventory('bar', MAX_STACK - 1);
    expect(session.handleCraftQueue('smelt', 0)).toEqual({ ok: true });
    session.beginAway();

    expect(session.processCraftCompletions(10_000)).toBe(true);

    expect(journal(session).slice(-2)).toEqual([
      'Crafted Iron Bar.',
      'Bags full: Iron Bar from crafting couldn\'t be carried. Sell some from the Hero screen.',
    ]);
    expect(session.getInventoryCount('bar')).toBe(MAX_STACK);
    expect(session.getAwayLedger()!.itemsLost).toBe(1);

    session.addToInventory('ore', 1);
    expect(session.handleCraftQueue('smelt', 20_000)).toEqual({ ok: true });
    session.processCraftCompletions(30_000);
    expect(journal(session).slice(-1)).toEqual(['Bags full: Iron Bar x2 from crafting couldn\'t be carried. Sell some from the Hero screen.']);
    expect(session.getAwayLedger()!.itemsLost).toBe(3);
  });

  it('journals quest reward items that did not fit', () => {
    const { session } = setup();
    session.addToInventory('tooth', MAX_STACK - 1);
    session.quests.accept(TEETH, { playerLevel: 1, partySize: 1, currentTileId: 'start' });

    expect(session.handleTurnInQuest('teeth')).toEqual({ success: true });

    const log = journal(session);
    expect(log.filter(t => t === 'Quest reward: Wolf Tooth')).toHaveLength(1);
    expect(log).toContain('Bags full: 2 quest rewards couldn\'t be carried. Sell some from the Hero screen.');
    expect(session.getInventoryCount('tooth')).toBe(MAX_STACK);
  });
});

describe('Victory lines', () => {
  it('leaves out +0 XP but keeps the victory, gold and finds', () => {
    const { session, hex } = setup();
    session.handleVictory({ xp: 0, gold: 4, items: ['bar'] }, hex('start'), { unlockTiles: false });
    expect(journal(session).slice(-3)).toEqual(['Victory!', '+4 Gold', 'Found Iron Bar!']);

    session.handleVictory({ xp: 6, gold: 0, items: [] }, hex('start'), { unlockTiles: false });
    expect(journal(session).slice(-2)).toEqual(['Victory!', '+6 XP']);
  });

  it('says new rooms were discovered', () => {
    const { session, hex } = setup();
    session.handleVictory({ xp: 1, gold: 0, items: [] }, hex('far'));
    expect(journal(session, 'unlock')).toEqual(['2 new rooms discovered']);
    session.handleVictory({ xp: 1, gold: 0, items: [] }, hex('farEast'));
    expect(journal(session, 'unlock')).toEqual(['2 new rooms discovered', '1 new room discovered']);
    expect(journal(session).some(t => /unlocked/i.test(t))).toBe(false);
  });
});

describe('Quests ready to turn in', () => {
  it('journals a collect quest that a drop completes, once, with a recap moment while away', () => {
    const { session, hex } = setup();
    session.quests.accept(PELTS, { playerLevel: 1, partySize: 1 });
    session.addToInventory('pelt', 2);
    session.beginAway();

    session.handleVictory({ xp: 1, gold: 0, items: ['pelt'] }, hex('start'), { unlockTiles: false });
    session.handleVictory({ xp: 1, gold: 0, items: ['pelt'] }, hex('start'), { unlockTiles: false });
    session.getState([]);

    expect(journal(session, 'unlock')).toEqual(['Quest ready to turn in: Pelts for the Tanner']);
    expect(session.getAwayLedger()!.moments.filter(m => m.kind === 'quest_ready').map(m => m.text))
      .toEqual(['Quest ready to turn in: Pelts for the Tanner']);
  });

  it('journals through a restored session and still forwards quest events to the caller', () => {
    const { session, content } = setup();
    const grids = (session as unknown as { grids: WorldGrids }).grids;
    const events: string[] = [];
    const restored = PlayerSession.fromSaveData(JSON.parse(JSON.stringify(session.toSaveData())), grids, content, e => events.push(e.type));

    restored.quests.accept(TEETH, { playerLevel: 1, partySize: 1, currentTileId: 'start' });

    expect(events).toEqual(['accepted', 'ready']);
    expect(journal(restored, 'unlock')).toEqual(['Quest ready to turn in: A Bag of Teeth']);
  });

  it('forwards quest events from a new session too', () => {
    const { session, content } = setup();
    const grids = (session as unknown as { grids: WorldGrids }).grids;
    const events: string[] = [];
    const fresh = new PlayerSession('bob', grids, content, e => events.push(e.type));
    fresh.setClass('Mage');
    fresh.quests.accept(TEETH, { playerLevel: 1, partySize: 1, currentTileId: 'start' });
    expect(events).toEqual(['accepted', 'ready']);
    expect(journal(fresh, 'unlock')).toEqual(['Quest ready to turn in: A Bag of Teeth']);
  });
});
