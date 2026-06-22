import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { WorldGrids } from '../src/game/WorldGrids.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { WorldData } from '@idle-party-rpg/shared';
import { HexPathfinder, offsetToCube } from '@idle-party-rpg/shared';
import WebSocket from 'ws';

// Two-map world: an overworld with a manhole linking to a sewers map.
const MANHOLE_ID = 'overworld-manhole';
const SEWER_ENTRANCE_ID = 'sewer-entrance';

function makeWorld(): WorldData {
  return {
    startTile: { col: 0, row: 0 },
    defaultMapId: 'overworld',
    maps: [
      { id: 'overworld', name: 'Overworld', startTile: { col: 0, row: 0 } },
      { id: 'sewers', name: 'Sewers', startTile: { col: 0, row: 0 } },
    ],
    tiles: [
      { id: MANHOLE_ID, mapId: 'overworld', col: 0, row: 0, type: 'town', zone: 'town', name: 'Manhole', transitions: [{ mapId: 'sewers', tileId: SEWER_ENTRANCE_ID }, { mapId: 'sewers', tileId: 'sewer-tunnel' }] },
      { id: 'overworld-road', mapId: 'overworld', col: 1, row: 0, type: 'plains', zone: 'town', name: 'Road' },
      { id: SEWER_ENTRANCE_ID, mapId: 'sewers', col: 0, row: 0, type: 'plains', zone: 'sewer', name: 'Sewer Entrance' },
      { id: 'sewer-tunnel', mapId: 'sewers', col: 1, row: 0, type: 'plains', zone: 'sewer', name: 'Sewer Tunnel' },
    ],
  };
}

function createFakeContentStore(world: WorldData): ContentStore {
  return {
    getStartTile: () => world.startTile,
    getWorld: () => world,
    getTileType: () => undefined,
    getTileById: (id: string) => world.tiles.find(t => t.id === id),
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: () => null,
    getAllMonsters: () => ({}),
    getAllItems: () => ({}),
    getZone: () => ({ id: 'town', name: 'Town', encounterTable: [] }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({}),
    getAllShops: () => ({}),
    getShop: () => undefined,
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpc: () => undefined,
    getAllQuests: () => ({}),
    getQuest: () => undefined,
    getDungeon: () => undefined,
    getAllDungeons: () => ({}),
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

describe('WorldGrids', () => {
  it('partitions tiles into one grid per map', () => {
    const grids = new WorldGrids(createFakeContentStore(makeWorld()));
    expect(grids.mapIds().sort()).toEqual(['overworld', 'sewers']);
    expect(grids.getOrThrow('overworld').size).toBe(2);
    expect(grids.getOrThrow('sewers').size).toBe(2);
    expect(grids.totalSize()).toBe(4);
  });

  it('preserves per-map grid identity across rebuilds', () => {
    const grids = new WorldGrids(createFakeContentStore(makeWorld()));
    const overworld = grids.getOrThrow('overworld');
    grids.rebuild();
    expect(grids.getOrThrow('overworld')).toBe(overworld); // same object, repopulated in place
  });

  it('drops a grid when its map is removed from content', () => {
    const world = makeWorld();
    const grids = new WorldGrids(createFakeContentStore(world));
    expect(grids.has('sewers')).toBe(true);
    // Remove the sewers map + its tiles, then rebuild.
    world.maps = world.maps.filter(m => m.id !== 'sewers');
    world.tiles = world.tiles.filter(t => t.mapId !== 'sewers');
    grids.rebuild();
    expect(grids.has('sewers')).toBe(false);
    expect(grids.has('overworld')).toBe(true);
  });

  it('keeps maps disconnected — pathfinding never crosses maps', () => {
    const grids = new WorldGrids(createFakeContentStore(makeWorld()));
    const pathfinder = new HexPathfinder(grids.getOrThrow('overworld'));
    // The sewers' (0,0) coordinate collides with the overworld manhole, but the
    // overworld grid only knows its own tiles, so a path to a sewer-only coord fails.
    const path = pathfinder.findPath(offsetToCube({ col: 0, row: 0 }), offsetToCube({ col: 5, row: 5 }));
    expect(path).toBeNull();
  });
});

describe('Cross-map transitions', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function setup() {
    const world = makeWorld();
    const content = createFakeContentStore(world);
    const grids = new WorldGrids(content);
    const pm = new PlayerManager(grids, content, new GuildStore(), createFakeAccountStore(['alice']), createFakeStore());
    const session = await pm.login(createFakeWs(), 'alice');
    session.setClass('Knight');
    pm.ensureParty('alice'); // spawns on the default-map start (0,0) = the manhole
    return { pm, session, grids, partyId: session.getPartyId()! };
  }

  it('travels to the linked map + tile and snaps position', async () => {
    const { pm, session, partyId } = await setup();
    expect(session.getMapId()).toBe('overworld');

    const error = pm.handleEnterTransition('alice', SEWER_ENTRANCE_ID);
    expect(error).toBeNull();

    expect(session.getMapId()).toBe('sewers');
    expect(pm.partyBattles.getMapId(partyId)).toBe('sewers');
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 0, row: 0 });
    // The arrival room is revealed for the traveler.
    expect(session.getUnlockedKeys()).toContain(SEWER_ENTRANCE_ID);
  });

  it('writes the current map into save data after travelling', async () => {
    const { pm, session, partyId } = await setup();
    pm.handleEnterTransition('alice', SEWER_ENTRANCE_ID);
    const movement = pm.partyBattles.getMovementSaveData(partyId)!;
    expect(movement.mapId).toBe('sewers');
    expect(session.toSaveData(movement).mapId).toBe('sewers');
  });

  it('honors the chosen exit when a room has multiple transitions', async () => {
    const { pm, session, partyId } = await setup();
    // The manhole links to both the sewer entrance and the sewer tunnel — pick the tunnel.
    const error = pm.handleEnterTransition('alice', 'sewer-tunnel');
    expect(error).toBeNull();
    expect(session.getMapId()).toBe('sewers');
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 1, row: 0 }); // sewer-tunnel
  });

  it('rejects travel from a room with no transition', async () => {
    const { pm, grids, partyId } = await setup();
    // Place the party on the plain road room (no transition), then try to travel.
    const road = grids.getOrThrow('overworld').getTileById('overworld-road')!;
    pm.partyBattles.relocateParty(partyId, road, 'overworld');
    const error = pm.handleEnterTransition('alice', SEWER_ENTRANCE_ID);
    expect(error).toMatch(/nothing to enter/i);
  });
});
