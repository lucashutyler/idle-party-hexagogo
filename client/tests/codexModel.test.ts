import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexMonster } from '@idle-party-rpg/shared';
import type { WorldCache } from '../src/network/WorldCache';
import {
  buildCodexIndex,
  closestRooms,
  itemQuestLines,
  monsterKills,
  newRecentKeys,
  roomGroups,
  searchCodex,
  sortItems,
  sortMonsters,
  sortShops,
  travelBlock,
} from '../src/ui/codex/codexModel';
import { codexReply, codexState, loadCodexWorld } from './codexFixture';

let world: WorldCache;

beforeEach(async () => {
  world = await loadCodexWorld();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildCodexIndex', () => {
  it('lists found walkable rooms in the order found, skipping unknown and unwalkable ids', () => {
    const index = buildCodexIndex(codexReply(), codexState(), world);
    expect([...index.rooms.keys()]).toEqual(['g_dock', 'g_field', 'g_wood', 'g_far', 'c_mouth']);
  });

  it('links a monster to the found rooms whose table spawns it, and a room with its own table keeps to it', () => {
    const index = buildCodexIndex(codexReply(), codexState(), world);
    expect(index.roomsOfMonster.get('goblin')).toEqual(['g_dock', 'g_field', 'g_wood']);
    expect(index.roomsOfMonster.get('wolf')).toEqual(['g_wood', 'g_far']);
    expect(index.roomsOfMonster.has('wall')).toBe(false);
  });

  it('gives each room its known fights and the other met monsters that live there', () => {
    const index = buildCodexIndex(codexReply(), codexState(), world);
    expect(index.fightsOfRoom('g_dock')).toEqual({ fights: [['goblin']], others: [] });
    expect(index.fightsOfRoom('g_wood')).toEqual({ fights: [['goblin', 'wolf']], others: [] });
    expect(index.fightsOfRoom('g_far')).toEqual({ fights: [], others: ['wolf'] });
    expect(index.fightsOfRoom('c_mouth')).toEqual({ fights: [], others: [] });
    expect(index.fightsOfRoom('g_secret')).toEqual({ fights: [], others: [] });
  });

  it('merges identical fight lines and drops monsters with no entry', () => {
    const reply = codexReply({
      fights: [['goblin'], ['goblin'], ['ghost']],
      tables: [{ key: 'z:shore', monsters: ['goblin', 'ghost'], fights: [0, 1, 2] }],
    });
    const index = buildCodexIndex(reply, codexState(), world);
    expect(index.fightsOfRoom('g_dock')).toEqual({ fights: [['goblin']], others: [] });
  });

  it('knows where an item comes from: drops, shops, recipes both ways and dungeon rewards', () => {
    const index = buildCodexIndex(codexReply(), codexState(), world);
    expect(index.droppedBy.get('fang')).toEqual([{ monsterId: 'goblin', seen: 9 }]);
    expect(index.soldAt.get('pelt')).toEqual([{ shopId: 'mill_post', price: 12 }]);
    expect(index.recipesMaking.get('cloak')!.map(r => r.id)).toEqual(['r_cloak']);
    expect(index.recipesUsing.get('pelt')!.map(r => r.id)).toEqual(['r_cloak']);
    expect(index.dungeonsRewarding.get('fang')).toEqual(['damp_trial']);
    expect(index.dungeonsRewarding.get('cloak')).toEqual(['damp_trial']);
    expect(index.dungeonsOfMonster.get('wolf')).toEqual(['damp_trial']);
    expect(index.entrancesOfDungeon.get('damp_trial')).toEqual(['g_wood']);
    expect(index.roomsOfShop.get('mill_post')).toEqual(['g_dock']);
    expect(index.roomsOfShop.has('tannery')).toBe(false);
  });

  it('adds recipe items as not found and owned items as found', () => {
    const index = buildCodexIndex(codexReply(), codexState(), world);
    expect(index.items.get('thread')).toMatchObject({ found: false });
    expect(index.items.get('cloak')).toMatchObject({ found: false });
    expect(index.items.get('potion')).toMatchObject({ found: true });
    expect(index.items.get('blade')).toMatchObject({ found: true });
    expect(index.items.get('rope')).toMatchObject({ found: false });
    expect([...index.items.keys()]).toEqual(['pelt', 'fang', 'rope', 'cloak', 'thread', 'potion', 'blade']);
  });

  it('keeps only recent refs that still have an entry', () => {
    const index = buildCodexIndex(codexReply(), codexState(), world);
    expect(index.recent).toEqual([{ kind: 'monster', id: 'wolf' }, { kind: 'item', id: 'fang' }, { kind: 'shop', id: 'mill_post' }]);
  });

  it('never changes the reply or the state it reads', () => {
    const reply = codexReply();
    const state = codexState();
    const before = JSON.stringify([reply, state]);
    const index = buildCodexIndex(reply, state, world);
    sortMonsters([...index.monsters.values()], 'name');
    sortItems([...index.items.values()], 'rarity');
    sortShops([...index.shops.values()], 'newest');
    expect(JSON.stringify([reply, state])).toBe(before);
  });

  it('without a reply holds only rooms, recipe items and what the player owns', () => {
    const index = buildCodexIndex(null, codexState(), world);
    expect(index.monsters.size).toBe(0);
    expect(index.shops.size).toBe(0);
    expect(index.rooms.size).toBe(5);
    expect([...index.items.keys()]).toEqual(['cloak', 'pelt', 'thread', 'potion', 'blade']);
    expect(index.items.get('pelt')).toMatchObject({ found: true });
  });
});

describe('monsterKills', () => {
  it('takes the fresher count from the state', () => {
    const [goblin, wolf] = codexReply().monsters;
    expect(monsterKills(goblin, codexState())).toBe(15);
    expect(monsterKills(wolf, codexState())).toBe(0);
  });
});

describe('searchCodex', () => {
  it('groups name matches by kind, matching rooms by zone too', () => {
    const index = buildCodexIndex(codexReply(), codexState(), world);
    expect(searchCodex(index, '  WOLF ')).toEqual({
      monster: [{ kind: 'monster', id: 'wolf' }],
      item: [{ kind: 'item', id: 'pelt' }],
      room: [],
      shop: [],
    });
    expect(searchCodex(index, 'pinefold').room.map(r => r.id)).toEqual(['g_far', 'g_wood']);
    expect(searchCodex(index, 'mill', 'shop').shop).toEqual([{ kind: 'shop', id: 'mill_post' }]);
    expect(searchCodex(index, 'mill', 'monster').shop).toEqual([]);
    expect(searchCodex(index, '   ')).toEqual({ monster: [], item: [], room: [], shop: [] });
  });

  it('never finds what has no entry', () => {
    const index = buildCodexIndex(codexReply(), codexState(), world);
    expect(searchCodex(index, 'hidden').room).toEqual([]);
    expect(searchCodex(index, 'ghost').monster).toEqual([]);
    expect(searchCodex(index, 'tannery').shop).toEqual([]);
  });
});

describe('sorting', () => {
  const monsters: CodexMonster[] = codexReply().monsters;

  it('puts monsters newest first, by name or by authored level', () => {
    expect(sortMonsters(monsters, 'newest').map(m => m.id)).toEqual(['wall', 'wolf', 'goblin']);
    expect(sortMonsters(monsters, 'name').map(m => m.id)).toEqual(['goblin', 'wall', 'wolf']);
    expect(sortMonsters(monsters, 'level').map(m => m.id)).toEqual(['goblin', 'wall', 'wolf']);
  });

  it('puts held items first when newest, rarest first by rarity', () => {
    const index = buildCodexIndex(codexReply(), codexState(), world);
    const items = [...index.items.values()];
    expect(sortItems(items, 'newest').map(i => i.def.id)).toEqual(['blade', 'potion', 'fang', 'pelt', 'rope', 'cloak', 'thread']);
    expect(sortItems(items, 'rarity').map(i => i.def.id).slice(0, 2)).toEqual(['fang', 'blade']);
  });
});

describe('roomGroups', () => {
  it('groups by map in world order, then zone and room by name', () => {
    const index = buildCodexIndex(codexReply(), codexState(), world);
    const groups = roomGroups(index.rooms.values(), world);
    expect(groups.map(g => [g.mapName, g.count])).toEqual([['Gull Isle', 4], ['Damp Cave', 1]]);
    expect(groups[0].zones.map(z => [z.zoneName, z.rooms.map(r => r.id)])).toEqual([
      ['Pinefold', ['g_far', 'g_wood']],
      ['Shore', ['g_dock', 'g_field']],
    ]);
  });
});

describe('closestRooms', () => {
  it('orders the party\'s own area by distance, then the rest of its map, then other maps', () => {
    const order = closestRooms(['c_mouth', 'g_far', 'g_wood', 'g_dock', 'gone'], codexState(), world);
    expect(order).toEqual(['g_dock', 'g_wood', 'g_far', 'c_mouth']);
  });

  it('falls back to world order without a known party room', () => {
    const state = codexState({ currentMapId: 'nowhere' });
    expect(closestRooms(['c_mouth', 'g_wood', 'g_dock'], state, world)).toEqual(['g_dock', 'g_wood', 'c_mouth']);
  });
});

describe('travelBlock', () => {
  const party = (role: string) => ({ party: { members: [{ username: 'me', role }, { username: 'bob', role: 'owner' }] } });

  it.each([
    ['in a dungeon', codexState({ dungeon: { dungeonId: 'damp_trial' } }), 'dungeon'],
    ['a plain member', codexState({ social: party('member') }), 'not_leader'],
    ['a leader', codexState({ social: party('leader') }), null],
    ['the owner', codexState({ social: party('owner') }), null],
    ['with no party', codexState({ social: null }), null],
  ])('%s', (_name, state, expected) => {
    expect(travelBlock(state)).toBe(expected);
  });
});

describe('newRecentKeys', () => {
  it('keeps refs this device has not shown yet', () => {
    const keys = newRecentKeys([{ kind: 'monster', id: 'wolf' }, { kind: 'item', id: 'fang' }], ['item:fang']);
    expect([...keys]).toEqual(['monster:wolf']);
  });
});

describe('itemQuestLines', () => {
  it('names quests that give the item, marking active ones, and active ones that collect it', () => {
    const state = codexState();
    expect(itemQuestLines('fang', state)).toEqual([
      { title: 'Fangs for Fern', kind: 'reward', active: true },
      { title: 'Old Debts', kind: 'reward', active: false },
    ]);
    expect(itemQuestLines('pelt', state)).toEqual([{ title: 'Fangs for Fern', kind: 'needed', active: true }]);
    expect(itemQuestLines('rope', state)).toEqual([]);
  });
});
