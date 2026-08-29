import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import { HexGrid, HexTile, offsetToCube, DEFAULT_MAP_ID } from '@idle-party-rpg/shared';
import type { ContentStore } from '../src/game/ContentStore.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';
import type { HenchmanDefinition, WorldTileDefinition, DungeonDefinition, PartyCombatant } from '@idle-party-rpg/shared';
import WebSocket from 'ws';

const SHOP_TILE_ID = 'tile-start';
const DUNGEON_ID = 'test_dungeon';
const HENCH_ID = 'hench_sellsword';

function makeHenchman(over: Partial<HenchmanDefinition> = {}): HenchmanDefinition {
  return {
    id: HENCH_ID,
    name: 'Grim the Sellsword',
    className: 'Knight',
    level: 3,
    maxHp: 80,
    baseDamage: 6,
    skillIds: [],
    emoji: '🗡️',
    ...over,
  };
}

const DUNGEON: DungeonDefinition = {
  id: DUNGEON_ID,
  name: 'Test Dungeon',
  floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'auto_goblin', weight: 1 }] }],
};

function createFakeGrid(): HexGrid {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'town', 'green_fields', SHOP_TILE_ID));
  grid.addTile(new HexTile(offsetToCube({ col: 1, row: 0 }), 'forest', 'green_fields', 'tile-other'));
  return grid;
}

function createFakeContentStore(henchmen: Record<string, HenchmanDefinition>): ContentStore {
  const shopTile: WorldTileDefinition = {
    id: SHOP_TILE_ID, mapId: DEFAULT_MAP_ID, col: 0, row: 0, type: 'town',
    zone: 'green_fields', name: 'Hiring Hall', shopId: 'shop_hire', dungeonId: DUNGEON_ID,
  };
  const otherTile: WorldTileDefinition = {
    id: 'tile-other', mapId: DEFAULT_MAP_ID, col: 1, row: 0, type: 'forest',
    zone: 'green_fields', name: 'Woods',
  };
  const shop = { id: 'shop_hire', name: 'Hiring Hall', inventory: [], henchmanIds: [HENCH_ID] };
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: (id: string) => (id ? { id, name: id } : null),
    getAllMonsters: () => ({}),
    getAllItems: () => ({}),
    getZone: () => ({ id: 'green_fields', name: 'Green Fields', encounterTable: [{ encounterId: 'auto_goblin', weight: 1 }] }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({ auto_goblin: { id: 'auto_goblin', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 } }),
    getTileById: (id: string) => (id === SHOP_TILE_ID ? shopTile : id === 'tile-other' ? otherTile : undefined),
    getAllShops: () => ({ shop_hire: shop }),
    getShop: (id: string) => (id === 'shop_hire' ? shop : undefined),
    getHenchman: (id: string) => henchmen[id],
    getAllHenchmen: () => henchmen,
    getWorld: () => ({ tiles: [shopTile, otherTile], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpc: () => undefined,
    getAllQuests: () => ({}),
    getQuest: () => undefined,
    getDungeon: (id: string) => (id === DUNGEON_ID ? DUNGEON : undefined),
    getAllDungeons: () => ({ [DUNGEON_ID]: DUNGEON }),
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

async function setup(henchmen: Record<string, HenchmanDefinition> = { [HENCH_ID]: makeHenchman() }) {
  const grid = createFakeGrid();
  const content = createFakeContentStore(henchmen);
  const pm = new PlayerManager(wrapGrids(grid), content, createFakeGuildStore(), createFakeAccountStore(['alice']), createFakeStore());
  const session = await pm.login(createFakeWs(), 'alice');
  session.setClass('Knight');
  pm.ensureParty('alice');
  return { pm, partyId: session.getPartyId()!, grid, content };
}

function createFakeGuildStore(): GuildStore {
  return new GuildStore();
}

function combatPlayers(pm: PlayerManager, partyId: string): PartyCombatant[] {
  const combat = (pm.partyBattles as unknown as {
    createCombatForParty: (id: string) => { players: PartyCombatant[] };
  }).createCombatForParty.bind(pm.partyBattles)(partyId);
  return combat.players;
}

function hire(pm: PlayerManager, henchmanId = HENCH_ID) {
  const result = pm.parties.hireHenchman(
    'alice',
    henchmanId,
    DEFAULT_MAP_ID,
    (u) => pm.getSessionByUsername(u)?.getPartyId() ?? null,
  );
  if (typeof result === 'string') throw new Error(result);
  return result;
}

describe('Henchmen runtime (PartyBattleManager via PlayerManager)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('puts a hired henchman into the party combat array alongside the player', async () => {
    const { pm, partyId } = await setup();
    expect(combatPlayers(pm, partyId).map(p => p.username)).toEqual(['alice']);

    hire(pm);

    const players = combatPlayers(pm, partyId);
    // The engine orders combatants by grid position, so compare sorted.
    expect(players.map(p => p.username).sort()).toEqual(['Grim the Sellsword', 'alice']);
    const henchman = players.find(p => p.isHenchman)!;
    expect(henchman.isHenchman).toBe(true);
    expect(henchman.maxHp).toBe(80);
    expect(henchman.baseDamage).toBe(6);
  });

  it('gives two hires of the same definition distinct combat names', async () => {
    const { pm, partyId } = await setup();
    hire(pm);
    hire(pm);

    expect(combatPlayers(pm, partyId).map(p => p.username).sort())
      .toEqual(['Grim the Sellsword', 'Grim the Sellsword #2', 'alice']);
  });

  it('places henchmen on squares no player occupies', async () => {
    const { pm, partyId } = await setup();
    hire(pm);
    hire(pm);

    const positions = combatPlayers(pm, partyId).map(p => p.gridPosition);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('drops a henchman whose definition a content deploy removed, without throwing', async () => {
    // createCombatForParty runs in the battle timer's interval callback — no try/catch above it.
    const henchmen: Record<string, HenchmanDefinition> = { [HENCH_ID]: makeHenchman() };
    const { pm, partyId } = await setup(henchmen);
    hire(pm);
    expect(combatPlayers(pm, partyId)).toHaveLength(2);

    delete henchmen[HENCH_ID];

    expect(() => combatPlayers(pm, partyId)).not.toThrow();
    expect(combatPlayers(pm, partyId).map(p => p.username)).toEqual(['alice']);
  });

  it('refuses dungeon entry while the party holds a henchman', async () => {
    const { pm, partyId } = await setup();
    expect(pm.partyBattles.enterDungeon(partyId, DUNGEON_ID).success).toBe(true);

    const fresh = await setup();
    hire(fresh.pm);
    const result = fresh.pm.partyBattles.enterDungeon(fresh.partyId, DUNGEON_ID);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/dismiss your henchmen/i);
  });

  it('allows dungeon entry again once the henchman is dismissed', async () => {
    const { pm, partyId } = await setup();
    const hired = hire(pm);
    expect(pm.partyBattles.enterDungeon(partyId, DUNGEON_ID).success).toBe(false);

    pm.parties.dismissHenchman('alice', hired.instanceId, (u) => pm.getSessionByUsername(u)?.getPartyId() ?? null);

    expect(pm.partyBattles.enterDungeon(partyId, DUNGEON_ID).success).toBe(true);
  });

  it('a henchman does not block movement into a level-gated room', async () => {
    // buildMemberInfos scores a session-less member as level 0, failing every gate.
    const { pm, partyId } = await setup();
    hire(pm);

    const move = pm.partyBattles.handleMove(partyId, 1, 0);
    expect(move.success).toBe(true);
  });

  it('keeps the party roster free of henchmen so member loops stay account-only', async () => {
    const { pm, partyId } = await setup();
    hire(pm);

    const party = pm.parties.getParty(partyId)!;
    expect(party.members.map(m => m.username)).toEqual(['alice']);
    expect(pm.partyBattles.getMembers(partyId)).toEqual(new Set(['alice']));
    expect(party.henchmen).toHaveLength(1);
  });

  it('resolves display fields for the client without storing them on the roster', async () => {
    const { pm, partyId } = await setup();
    hire(pm);

    const stored = pm.parties.getHenchmen(partyId)[0];
    expect(stored.name).toBeUndefined();

    const sent = pm.getSocialState('alice').party!.henchmen![0];
    expect(sent.name).toBe('Grim the Sellsword');
    expect(sent.emoji).toBe('🗡️');
    expect(sent.level).toBe(3);
  });

  it('survives its definition being renamed — names resolve at send time', async () => {
    const henchmen: Record<string, HenchmanDefinition> = { [HENCH_ID]: makeHenchman() };
    const { pm } = await setup(henchmen);
    hire(pm);

    henchmen[HENCH_ID] = makeHenchman({ name: 'Grim the Renamed' });

    expect(pm.getSocialState('alice').party!.henchmen![0].name).toBe('Grim the Renamed');
  });

  it('persists hires into the player save and restores them owner-authoritatively', async () => {
    const { pm, partyId } = await setup();
    const hired = hire(pm);

    const saved = pm.getAllSaveData();
    expect(saved[0].partyHenchmen).toHaveLength(1);
    expect(saved[0].partyHenchmen![0].instanceId).toBe(hired.instanceId);
    expect(saved[0].partyHenchmen![0].mapId).toBe(DEFAULT_MAP_ID);

    // Ids only: a persisted display name would go stale when the definition is renamed.
    expect(saved[0].partyHenchmen![0].name).toBeUndefined();
    expect(pm.parties.getHenchmen(partyId)).toHaveLength(1);
  });

  it('omits partyHenchmen from the save when the party holds none', async () => {
    const { pm } = await setup();
    expect(pm.getAllSaveData()[0].partyHenchmen).toBeUndefined();
  });
});
