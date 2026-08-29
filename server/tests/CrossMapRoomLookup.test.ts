import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { WorldGrids } from '../src/game/WorldGrids.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { ShopDefinition, NpcDefinition, QuestDefinition, WorldData } from '@idle-party-rpg/shared';
import WebSocket from 'ws';
import { fakeSkillContent } from './testGrids.js';

// `world.tiles` is flat across maps: a col/row room lookup can return the other map's room.
const OVERWORLD_HUB = 'overworld-hub';
const SEWER_HUB = 'sewer-hub';

const OVERWORLD_SHOP: ShopDefinition = {
  id: 'shop_general', name: 'General Store',
  inventory: [{ itemId: 'bread', price: 5 }],
};
const SEWER_SHOP: ShopDefinition = {
  id: 'shop_blackmarket', name: 'Black Market',
  inventory: [{ itemId: 'lockpick', price: 50 }],
};
const OVERWORLD_NPC: NpcDefinition = {
  id: 'npc_smith', name: 'Blacksmith', emoji: '🔨', greeting: 'Need steel?', questIds: ['q_smith'],
};
const SEWER_NPC: NpcDefinition = {
  id: 'npc_fence', name: 'Fence', emoji: '🕶️', greeting: 'Keep it quiet.', questIds: ['q_fence'],
};

// The state message carries no NPC; `offeredQuestIds` is how getCurrentNpc() is observable.
const QUESTS: Record<string, QuestDefinition> = {
  q_smith: { id: 'q_smith', name: 'Smith Errand', description: '', scope: 'party_shared', objectives: [], rewards: [] },
  q_fence: { id: 'q_fence', name: 'Fence Errand', description: '', scope: 'party_shared', objectives: [], rewards: [] },
};

function makeWorld(): WorldData {
  return {
    startTile: { col: 0, row: 0 },
    defaultMapId: 'overworld',
    maps: [
      { id: 'overworld', name: 'Overworld', startTile: { col: 0, row: 0 } },
      { id: 'sewers', name: 'Sewers', startTile: { col: 0, row: 0 } },
    ],
    tiles: [
      {
        id: OVERWORLD_HUB, mapId: 'overworld', col: 0, row: 0, type: 'town', zone: 'town',
        name: 'Town Square', shopId: OVERWORLD_SHOP.id, npcId: OVERWORLD_NPC.id,
        transitions: [{ mapId: 'sewers', tileId: SEWER_HUB }],
      },
      { id: 'overworld-road', mapId: 'overworld', col: 1, row: 0, type: 'plains', zone: 'town', name: 'Road' },
      {
        id: SEWER_HUB, mapId: 'sewers', col: 0, row: 0, type: 'plains', zone: 'sewer',
        name: 'Sewer Junction', shopId: SEWER_SHOP.id, npcId: SEWER_NPC.id,
      },
      { id: 'sewer-tunnel', mapId: 'sewers', col: 1, row: 0, type: 'plains', zone: 'sewer', name: 'Sewer Tunnel' },
    ],
  };
}

function createFakeContentStore(world: WorldData): ContentStore {
  const shops: Record<string, ShopDefinition> = {
    [OVERWORLD_SHOP.id]: OVERWORLD_SHOP,
    [SEWER_SHOP.id]: SEWER_SHOP,
  };
  const npcs: Record<string, NpcDefinition> = {
    [OVERWORLD_NPC.id]: OVERWORLD_NPC,
    [SEWER_NPC.id]: SEWER_NPC,
  };
  return {
    getStartTile: () => world.startTile,
    getWorld: () => world,
    getTileType: () => undefined,
    getTileById: (id: string) => world.tiles.find(t => t.id === id),
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: (id: string) => (id ? { id, name: id, value: 1 } : null),
    getAllMonsters: () => ({}),
    getAllItems: () => ({}),
    getZone: () => ({ id: 'town', name: 'Town', encounterTable: [] }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({}),
    getAllShops: () => shops,
    getShop: (id: string) => shops[id],
    getHenchman: () => undefined,
    getAllHenchmen: () => ({}),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => npcs,
    getNpc: (id: string) => npcs[id],
    getAllQuests: () => QUESTS,
    getQuest: (id: string) => QUESTS[id],
    getDungeon: () => undefined,
    getAllDungeons: () => ({}),
    ...fakeSkillContent(),
  } as unknown as ContentStore;
}

function createFakeAccountStore(usernames: string[]): AccountStore {
  const accounts: Record<string, Account> = {};
  for (const u of usernames) accounts[u] = { username: u, email: `${u}@x.com`, deactivated: false } as unknown as Account;
  return {
    findByUsername: (u: string) => accounts[u] ?? null,
    getAllUsernames: () => usernames,
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    setDeactivated: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
}

function createFakeStore(): GameStateStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    loadAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as GameStateStore;
}

function createFakeWs(): WebSocket {
  return { readyState: 1, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as WebSocket;
}

async function setup() {
  const world = makeWorld();
  const content = createFakeContentStore(world);
  const grids = new WorldGrids(content);
  const pm = new PlayerManager(grids, content, new GuildStore(), createFakeAccountStore(['alice']), createFakeStore());
  const session = await pm.login(createFakeWs(), 'alice');
  session.setClass('Knight');
  pm.ensureParty('alice');
  return { pm, session, partyId: session.getPartyId()! };
}

describe('Cross-map room lookup', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resolves the shop of the map the party is actually on, not a same-coordinate room elsewhere', async () => {
    const { pm, session, partyId } = await setup();

    expect(session.getMapId()).toBe('overworld');
    expect(session.getCurrentShop()?.id).toBe(OVERWORLD_SHOP.id);

    const moved = pm.partyBattles.enterTransition(partyId, SEWER_HUB);
    expect(moved.success).toBe(true);
    expect(session.getMapId()).toBe('sewers');
    expect(session.getPosition()).toEqual({ col: 0, row: 0 });

    expect(session.getCurrentShop()?.id).toBe(SEWER_SHOP.id);
    expect(session.getCurrentShop()?.name).toBe('Black Market');
  });

  it('pushes the correct map\'s shop in the player state', async () => {
    const { pm, session, partyId } = await setup();
    expect(session.getState([]).shopDefinition?.id).toBe(OVERWORLD_SHOP.id);

    pm.partyBattles.enterTransition(partyId, SEWER_HUB);

    expect(session.getState([]).shopDefinition?.id).toBe(SEWER_SHOP.id);
  });

  it('offers the quests of the NPC standing on this map\'s room, not the other map\'s', async () => {
    const { pm, session, partyId } = await setup();
    expect(session.getState([]).offeredQuestIds).toEqual(['q_smith']);

    pm.partyBattles.enterTransition(partyId, SEWER_HUB);

    expect(session.getState([]).offeredQuestIds).toEqual(['q_fence']);
  });

  it('refuses a quest offered by the other map\'s NPC at the same coordinates', async () => {
    const { pm, session, partyId } = await setup();
    pm.partyBattles.enterTransition(partyId, SEWER_HUB);

    const result = session.handleAcceptQuest('q_smith', 1);
    expect(result.success).toBe(false);
    expect(session.handleAcceptQuest('q_fence', 1).success).toBe(true);
  });
});
