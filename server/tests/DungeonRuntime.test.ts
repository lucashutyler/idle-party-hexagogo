import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { DungeonDefinition, WorldTileDefinition, ClassName } from '@idle-party-rpg/shared';
import WebSocket from 'ws';

// The entrance room (0,0) is linked to this dungeon.
const DUNGEON_ID = 'test_dungeon';
const ENTRANCE_TILE_ID = 'tile-start';

function makeDungeon(over: Partial<DungeonDefinition> = {}): DungeonDefinition {
  return {
    id: DUNGEON_ID,
    name: 'Test Dungeon',
    floors: [
      { floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'auto_goblin', weight: 1 }] },
      { floorNumber: 2, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'auto_goblin', weight: 1 }], isBoss: true },
    ],
    firstClearRewards: [{ itemId: 'trophy', chance: 1 }],
    firstClearXp: 500,
    firstClearGold: 100,
    ...over,
  };
}

function createFakeGrid(): HexGrid {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'dungeon', 'crystal_caves', ENTRANCE_TILE_ID));
  grid.addTile(new HexTile(offsetToCube({ col: 1, row: 0 }), 'forest', 'crystal_caves', 'tile-other'));
  return grid;
}

function createFakeContentStore(dungeon: DungeonDefinition): ContentStore {
  const entranceTile: WorldTileDefinition = { id: ENTRANCE_TILE_ID, col: 0, row: 0, type: 'dungeon', zone: 'crystal_caves', name: 'Cave Entrance', dungeonId: DUNGEON_ID };
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: (id: string) => (id ? { id, name: id } : null),
    getAllMonsters: () => ({}),
    getAllItems: () => ({}),
    getZone: () => ({ id: 'crystal_caves', name: 'Crystal Caves', encounterTable: [{ encounterId: 'auto_goblin', weight: 1 }] }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({ auto_goblin: { id: 'auto_goblin', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 } }),
    getTileById: (id: string) => (id === ENTRANCE_TILE_ID ? entranceTile : undefined),
    getAllShops: () => ({}),
    getShop: () => undefined,
    getWorld: () => ({ tiles: [entranceTile], startTile: { col: 0, row: 0 } }),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpc: () => undefined,
    getAllQuests: () => ({}),
    getQuest: () => undefined,
    getDungeon: (id: string) => (id === dungeon.id ? dungeon : undefined),
    getAllDungeons: () => ({ [dungeon.id]: dungeon }),
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

function createFakeGuildStore(): GuildStore {
  return new GuildStore();
}

function createFakeWs(): WebSocket {
  return { readyState: 1, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as WebSocket;
}

/** Spin up a manager with one player (default Knight) standing on the dungeon entrance room. */
async function setup(dungeon = makeDungeon(), className: ClassName = 'Knight'): Promise<{ pm: PlayerManager; partyId: string; grid: HexGrid }> {
  const grid = createFakeGrid();
  const content = createFakeContentStore(dungeon);
  const pm = new PlayerManager(grid, content, createFakeGuildStore(), createFakeAccountStore(['alice']), createFakeStore());
  const session = await pm.login(createFakeWs(), 'alice');
  session.setClass(className);
  pm.ensureParty('alice');
  return { pm, partyId: session.getPartyId()!, grid };
}

describe('Dungeon runtime (PartyBattleManager via PlayerManager)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('enters a dungeon from its entrance room and reports floor 1', async () => {
    const { pm, partyId } = await setup();
    const result = pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    expect(result.success).toBe(true);

    const info = pm.partyBattles.getDungeonRunInfo(partyId);
    expect(info).not.toBeNull();
    expect(info!.floor).toBe(1);
    expect(info!.totalFloors).toBe(2);
    expect(info!.isBossFloor).toBe(false);
  });

  it('blocks entry when not standing on the dungeon entrance', async () => {
    const { pm, partyId, grid } = await setup();
    // Relocate the party to a non-entrance room.
    pm.partyBattles.relocateParty(partyId, grid.getTile(offsetToCube({ col: 1, row: 0 }))!);
    const result = pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/entrance/i);
  });

  it('enforces a minimum level requirement', async () => {
    const { pm, partyId } = await setup(makeDungeon({ entryRequirements: { minLevel: 5 } }));
    const result = pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/level 5/i);
  });

  it('enforces a class restriction', async () => {
    const { pm, partyId } = await setup(makeDungeon({ entryRequirements: { requiredClasses: ['Mage'] } }));
    const result = pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/class/i);
  });

  it('consumes the entry item when required', async () => {
    const { pm, partyId } = await setup(makeDungeon({ entryRequirements: { requiredItemId: 'key', consumeRequiredItem: true } }));
    const session = pm.getSessionByUsername('alice')!;

    // Without the key, entry is blocked.
    expect(pm.partyBattles.enterDungeon(partyId, DUNGEON_ID).success).toBe(false);

    // With the key, entry succeeds and the key is consumed.
    session.addToInventory('key', 1);
    expect(session.getInventoryCount('key')).toBe(1);
    expect(pm.partyBattles.enterDungeon(partyId, DUNGEON_ID).success).toBe(true);
    expect(session.getInventoryCount('key')).toBe(0);
  });

  it('blocks overworld movement while inside a dungeon', async () => {
    const { pm, partyId } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    const move = pm.partyBattles.handleMove(partyId, 1, 0);
    expect(move.success).toBe(false);
  });

  it('advances floors on victory and grants one-time first-clear rewards (item + XP + gold) on completion', async () => {
    const { pm, partyId } = await setup();
    const session = pm.getSessionByUsername('alice')!;
    const baseGold = session.getGold();
    const baseXp = session.getState([]).character?.xp ?? 0;
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);

    const entry = (pm.partyBattles as unknown as { entries: Map<string, unknown> }).entries.get(partyId);
    const floorCleared = (pm.partyBattles as unknown as { handleDungeonFloorCleared: (e: unknown) => void }).handleDungeonFloorCleared.bind(pm.partyBattles);

    // Clear floor 1 → advance to floor 2.
    floorCleared(entry);
    expect(pm.partyBattles.getDungeonRunInfo(partyId)!.floor).toBe(2);

    // Clear floor 2 (final) → run completes, ejected to entrance, first-clear granted.
    floorCleared(entry);
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
    expect(session.hasDungeonCleared(DUNGEON_ID)).toBe(true);
    expect(session.getInventoryCount('trophy')).toBe(1);
    expect(session.getGold()).toBe(baseGold + 100);
    expect(session.getState([]).character?.xp).toBe(baseXp + 500);

    // Second clear does NOT grant the first-clear rewards again.
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    const entry2 = (pm.partyBattles as unknown as { entries: Map<string, unknown> }).entries.get(partyId);
    floorCleared(entry2);
    floorCleared(entry2);
    expect(session.getInventoryCount('trophy')).toBe(1);
    expect(session.getGold()).toBe(baseGold + 100);
    expect(session.getState([]).character?.xp).toBe(baseXp + 500);
  });

  it('routes class-restricted first-clear rewards to matching classes only', async () => {
    const rewards = [
      { itemId: 'knight_blade', chance: 1, classRestriction: ['Knight'] as ClassName[] },
      { itemId: 'bard_lute', chance: 1, classRestriction: ['Bard'] as ClassName[] },
    ];

    const clearDungeon = (pm: PlayerManager, partyId: string): void => {
      pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
      const entry = (pm.partyBattles as unknown as { entries: Map<string, unknown> }).entries.get(partyId);
      const floorCleared = (pm.partyBattles as unknown as { handleDungeonFloorCleared: (e: unknown) => void }).handleDungeonFloorCleared.bind(pm.partyBattles);
      floorCleared(entry);
      floorCleared(entry);
    };

    // Knight clears → gets the blade, never the lute.
    const knight = await setup(makeDungeon({ firstClearRewards: rewards }), 'Knight');
    clearDungeon(knight.pm, knight.partyId);
    const knightSession = knight.pm.getSessionByUsername('alice')!;
    expect(knightSession.getInventoryCount('knight_blade')).toBe(1);
    expect(knightSession.getInventoryCount('bard_lute')).toBe(0);

    // Bard clears the same dungeon → gets the lute, never the blade.
    const bard = await setup(makeDungeon({ firstClearRewards: rewards }), 'Bard');
    clearDungeon(bard.pm, bard.partyId);
    const bardSession = bard.pm.getSessionByUsername('alice')!;
    expect(bardSession.getInventoryCount('bard_lute')).toBe(1);
    expect(bardSession.getInventoryCount('knight_blade')).toBe(0);
  });

  it('ejects the party to the entrance on a wipe', async () => {
    const { pm, partyId } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    const entry = (pm.partyBattles as unknown as { entries: Map<string, unknown> }).entries.get(partyId);
    (pm.partyBattles as unknown as { handleDungeonDefeat: (e: unknown) => void }).handleDungeonDefeat(entry);

    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
    const pos = pm.partyBattles.getPosition(partyId);
    expect(pos).toEqual({ col: 0, row: 0 });
  });

  it('bails out of a dungeon on leaveDungeon', async () => {
    const { pm, partyId } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).not.toBeNull();
    expect(pm.partyBattles.leaveDungeon(partyId)).toBe(true);
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
  });

  it('refuses to flee (escapeBattle) while inside a dungeon', async () => {
    const { pm, partyId } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    expect(pm.partyBattles.escapeBattle(partyId)).toBe(false);
    // Still in the dungeon — escape did nothing.
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).not.toBeNull();
  });

  it('ends the dungeon run when the party is force-relocated (content deploy)', async () => {
    const { pm, partyId, grid } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    // While in the dungeon, movement is locked.
    expect(pm.partyBattles.handleMove(partyId, 1, 0).success).toBe(false);

    pm.partyBattles.relocateParty(partyId, grid.getTile(offsetToCube({ col: 1, row: 0 }))!);
    // The run is cleared, so the party is no longer dungeon-locked.
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
  });

  it('surfaces inDungeon + dungeonName to other players via getOtherPlayers', async () => {
    const grid = createFakeGrid();
    const content = createFakeContentStore(makeDungeon());
    const pm = new PlayerManager(grid, content, createFakeGuildStore(), createFakeAccountStore(['alice', 'bob']), createFakeStore());
    const alice = await pm.login(createFakeWs(), 'alice');
    alice.setClass('Knight');
    pm.ensureParty('alice');
    const bob = await pm.login(createFakeWs(), 'bob');
    bob.setClass('Mage');
    pm.ensureParty('bob');

    // Before entering, alice reads as a normal overworld party to bob.
    let aliceView = pm.getOtherPlayers('bob').find(p => p.username === 'alice');
    expect(aliceView?.inDungeon).toBeFalsy();

    // After entering, bob sees alice flagged as delving the dungeon.
    pm.partyBattles.enterDungeon(alice.getPartyId()!, DUNGEON_ID);
    aliceView = pm.getOtherPlayers('bob').find(p => p.username === 'alice');
    expect(aliceView?.inDungeon).toBe(true);
    expect(aliceView?.dungeonName).toBe('Test Dungeon');
  });

  it('round-trips an active run through save data and restore', async () => {
    const { pm, partyId } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);

    const saved = pm.partyBattles.getDungeonSaveData(partyId);
    expect(saved).toEqual({ dungeonId: DUNGEON_ID, currentFloorIndex: 0, entrance: { col: 0, row: 0 } });

    // Leave, then restore the saved run — back on floor 1.
    pm.partyBattles.leaveDungeon(partyId);
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
    pm.partyBattles.restoreDungeonRun(partyId, saved!);
    expect(pm.partyBattles.getDungeonRunInfo(partyId)!.floor).toBe(1);
  });
});
