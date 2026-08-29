import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { WorldGrids } from '../src/game/WorldGrids.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';
import type { QuestDefinition, WorldData } from '@idle-party-rpg/shared';
import { HexPathfinder, offsetToCube } from '@idle-party-rpg/shared';
import WebSocket from 'ws';
import { fakeSkillContent } from './testGrids.js';

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

// Gated content used only by the transition-gating cases. The manhole gains two
// more exits: a quest-gated link into the vault, and an ungated link into a
// level-gated room (the destination's own gate must still be enforced).
const SEWER_VAULT_ID = 'sewer-vault';
const SEWER_DEPTHS_ID = 'sewer-depths';
const PERMIT_QUEST_ID = 'sewer_permit';

const SEWER_PERMIT: QuestDefinition = {
  id: PERMIT_QUEST_ID,
  name: 'Sewer Permit',
  description: 'Get clearance for the vault.',
  scope: 'party_shared',
  objectives: [{ kind: 'visit', tileId: SEWER_ENTRANCE_ID }],
  rewards: [],
};

function makeGatedWorld(): WorldData {
  const world = makeWorld();
  world.tiles.push(
    { id: SEWER_VAULT_ID, mapId: 'sewers', col: 2, row: 0, type: 'plains', zone: 'sewer', name: 'Sewer Vault' },
    { id: SEWER_DEPTHS_ID, mapId: 'sewers', col: 3, row: 0, type: 'plains', zone: 'sewer', name: 'Sewer Depths', entryRequirements: { minLevel: 5 } },
  );
  const manhole = world.tiles.find(t => t.id === MANHOLE_ID)!;
  manhole.transitions = [
    ...manhole.transitions!,
    { mapId: 'sewers', tileId: SEWER_VAULT_ID, entryRequirements: { requiredQuestIds: [PERMIT_QUEST_ID] } },
    { mapId: 'sewers', tileId: SEWER_DEPTHS_ID },
  ];
  return world;
}

function createFakeContentStore(world: WorldData, quests: Record<string, QuestDefinition> = {}): ContentStore {
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
    getAllQuests: () => quests,
    getQuest: (id: string) => quests[id],
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

    const result = pm.handleEnterTransition('alice', SEWER_ENTRANCE_ID);
    expect(result.success).toBe(true);

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
    const result = pm.handleEnterTransition('alice', 'sewer-tunnel');
    expect(result.success).toBe(true);
    expect(session.getMapId()).toBe('sewers');
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 1, row: 0 }); // sewer-tunnel
  });

  it('rejects travel from a room with no transition', async () => {
    const { pm, grids, partyId } = await setup();
    // Place the party on the plain road room (no transition), then try to travel.
    const road = grids.getOrThrow('overworld').getTileById('overworld-road')!;
    pm.partyBattles.relocateParty(partyId, road, 'overworld');
    const result = pm.handleEnterTransition('alice', SEWER_ENTRANCE_ID);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(/nothing to enter/i);
  });
});

describe('Cross-map transition gating', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Tests-only level override — the party spawns at level 1. */
  function setLevel(session: PlayerSession, level: number): void {
    (session as unknown as { character: { level: number } }).character.level = level;
  }

  /** Tests-only quest completion — the gate only reads completed quest IDs. */
  function completeQuest(session: PlayerSession, questId: string): void {
    session.quests.loadFromSaveData({
      active: [],
      completed: [{ questId, completedAt: new Date().toISOString() }],
      weeklyCompletions: {},
    });
  }

  async function setup() {
    const world = makeGatedWorld();
    const content = createFakeContentStore(world, { [PERMIT_QUEST_ID]: SEWER_PERMIT });
    const grids = new WorldGrids(content);
    const pm = new PlayerManager(grids, content, new GuildStore(), createFakeAccountStore(['alice']), createFakeStore());
    const session = await pm.login(createFakeWs(), 'alice');
    session.setClass('Knight');
    pm.ensureParty('alice'); // spawns on the manhole
    return { pm, session, grids, partyId: session.getPartyId()! };
  }

  it('blocks travel when the transition link is gated', async () => {
    const { pm, session, partyId } = await setup();
    const result = pm.handleEnterTransition('alice', SEWER_VAULT_ID);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.blocked?.kind).toBe('quest');
      expect(result.blocked?.questId).toBe(PERMIT_QUEST_ID);
      expect(result.blocked?.missingPlayers).toEqual(['alice']);
      // The rejection is the gate's own player-facing prose, using the quest's display name.
      expect(result.error).toBe(result.blocked!.reason);
      expect(result.error).toMatch(/sewer permit/i);
    }

    // The party never left the overworld manhole.
    expect(session.getMapId()).toBe('overworld');
    expect(pm.partyBattles.getMapId(partyId)).toBe('overworld');
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 0, row: 0 });
  });

  it('blocks travel when the destination room is gated but the link is not', async () => {
    const { pm, session, partyId } = await setup();
    const result = pm.handleEnterTransition('alice', SEWER_DEPTHS_ID);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.blocked?.kind).toBe('level');
      expect(result.blocked?.minLevel).toBe(5);
      expect(result.blocked?.missingPlayers).toEqual(['alice']);
      expect(result.error).toMatch(/level 5/i);
    }

    expect(session.getMapId()).toBe('overworld');
    expect(pm.partyBattles.getMapId(partyId)).toBe('overworld');
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 0, row: 0 });
  });

  it('travels through a gated link once the quest is completed', async () => {
    const { pm, session, partyId } = await setup();
    completeQuest(session, PERMIT_QUEST_ID);

    const result = pm.handleEnterTransition('alice', SEWER_VAULT_ID);
    expect(result.success).toBe(true);

    expect(session.getMapId()).toBe('sewers');
    expect(pm.partyBattles.getMapId(partyId)).toBe('sewers');
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 2, row: 0 }); // sewer-vault
    expect(session.getUnlockedKeys()).toContain(SEWER_VAULT_ID);
  });

  it('travels into a gated destination room once the level requirement is met', async () => {
    const { pm, session, partyId } = await setup();
    setLevel(session, 5);

    const result = pm.handleEnterTransition('alice', SEWER_DEPTHS_ID);
    expect(result.success).toBe(true);

    expect(session.getMapId()).toBe('sewers');
    expect(pm.partyBattles.getMapId(partyId)).toBe('sewers');
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 3, row: 0 }); // sewer-depths
  });

  it('leaves ungated exits alone', async () => {
    const { pm, session, partyId } = await setup();
    const result = pm.handleEnterTransition('alice', SEWER_ENTRANCE_ID);
    expect(result.success).toBe(true);
    expect(session.getMapId()).toBe('sewers');
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 0, row: 0 });
  });
});

/**
 * `relocateDisplacedParties` walks each grid from a start tile to decide what
 * is reachable. That premise only holds on the map players spawn and walk on —
 * anywhere else a room is reached through a transition, so a legitimately
 * occupied room can be unreachable by any walk from that map's start tile.
 */
describe('Displaced-party sweep and multi-map reachability', () => {
  const ISLAND_ID = 'sewer-island';
  const ORPHAN_ID = 'overworld-orphan';

  /** The two-map world plus one isolated room on each map. */
  function makeIslandWorld(): WorldData {
    const world = makeWorld();
    // Reachable only via a transition — no walking route from (0,0).
    world.tiles.push(
      { id: ISLAND_ID, mapId: 'sewers', col: 5, row: 5, type: 'plains', zone: 'sewer', name: 'Flooded Island' },
      { id: ORPHAN_ID, mapId: 'overworld', col: 7, row: 7, type: 'plains', zone: 'town', name: 'Marooned Clearing' },
    );
    world.tiles.find(t => t.id === MANHOLE_ID)!.transitions!.push({ mapId: 'sewers', tileId: ISLAND_ID });
    return world;
  }

  async function setup() {
    const world = makeIslandWorld();
    const content = createFakeContentStore(world);
    const grids = new WorldGrids(content);
    const pm = new PlayerManager(grids, content, new GuildStore(), createFakeAccountStore(['alice']), createFakeStore());
    const session = await pm.login(createFakeWs(), 'alice');
    session.setClass('Knight');
    pm.ensureParty('alice');
    return { pm, session, grids, content, partyId: session.getPartyId()! };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('leaves a party on a non-default map alone even when its room is unwalkable from that map start', async () => {
    const { pm, grids, content, partyId } = await setup();

    expect(pm.handleEnterTransition('alice', ISLAND_ID).success).toBe(true);
    expect(pm.partyBattles.getMapId(partyId)).toBe('sewers');

    // The island is nowhere near the sewers' own start tile, but the party got
    // there legitimately — the sweep must not uproot them.
    expect(pm.relocateDisplacedParties(grids, content)).toBe(0);
    expect(pm.partyBattles.getTile(partyId)!.id).toBe(ISLAND_ID);
    expect(pm.partyBattles.getMapId(partyId)).toBe('sewers');
  });

  it('relocates a party on a non-default map when its room is DELETED', async () => {
    // The reachability exemption above must not swallow this case: existence IS
    // decidable on any map, and refreshAllPartyTiles deliberately leaves the
    // stale HexTile in place when a room vanishes — so skipping the branch
    // outright strands the party on a room that no longer exists.
    const { pm, grids, content, partyId } = await setup();

    expect(pm.handleEnterTransition('alice', ISLAND_ID).success).toBe(true);
    expect(pm.partyBattles.getTile(partyId)!.id).toBe(ISLAND_ID);

    // Delete the island room and rebuild, exactly as a content deploy does.
    const world = content.getWorld();
    world.tiles = world.tiles.filter(t => t.id !== ISLAND_ID);
    grids.rebuild();
    pm.partyBattles.refreshAllPartyTiles(grids);

    expect(pm.relocateDisplacedParties(grids, content)).toBe(1);
    // Relocated within their own map, not yanked back to the overworld.
    expect(pm.partyBattles.getMapId(partyId)).toBe('sewers');
    expect(pm.partyBattles.getTile(partyId)!.id).not.toBe(ISLAND_ID);
    expect(grids.getOrThrow('sewers').getTileById(pm.partyBattles.getTile(partyId)!.id)).toBeTruthy();
  });

  it('still relocates a party stranded on the map that holds the world start tile', async () => {
    const { pm, grids, content, partyId } = await setup();

    const orphan = grids.getOrThrow('overworld').getTileById(ORPHAN_ID)!;
    pm.partyBattles.relocateParty(partyId, orphan, 'overworld');

    expect(pm.relocateDisplacedParties(grids, content)).toBe(1);
    expect(pm.partyBattles.getTile(partyId)!.id).not.toBe(ORPHAN_ID);
  });
});
