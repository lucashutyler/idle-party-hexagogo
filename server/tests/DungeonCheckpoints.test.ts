import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';
import { HexGrid, HexTile, offsetToCube, DEFAULT_MAP_ID, DUNGEON_CHECKPOINT_TTL_MS } from '@idle-party-rpg/shared';
import type { ContentStore } from '../src/game/ContentStore.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';
import type {
  DungeonDefinition,
  DungeonRunState,
  EncounterDefinition,
  MonsterDefinition,
  PartyCombatState,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import WebSocket from 'ws';

const DUNGEON_ID = 'chief_hall';
const ENTRANCE_TILE_ID = 'tile-start';

const MONSTERS: Record<string, MonsterDefinition> = {
  chief: { id: 'chief', name: 'Chief', hp: 30, damage: 1, damageType: 'physical', xp: 100, goldMin: 40, goldMax: 60, tier: 'boss' },
  goblin: { id: 'goblin', name: 'Goblin', hp: 10, damage: 1, damageType: 'physical', xp: 5, goldMin: 0, goldMax: 0 },
};

const ENCOUNTERS: Record<string, EncounterDefinition> = {
  court: { id: 'court', name: 'Court', type: 'explicit', placements: [{ monsterId: 'chief', gridPosition: 4 }] },
  goblins: { id: 'goblins', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 },
};

function makeDungeon(over: Partial<DungeonDefinition> = {}): DungeonDefinition {
  return {
    id: DUNGEON_ID,
    name: 'Chief Hall',
    floors: [
      { floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'court', weight: 1 }], isBoss: true, checkpoints: [0.66, 0.33], maxWipes: 2 },
      { floorNumber: 2, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'goblins', weight: 1 }] },
    ],
    ...over,
  };
}

function createFakeContentStore(dungeon: { current: DungeonDefinition }): ContentStore {
  const entranceTile: WorldTileDefinition = { id: ENTRANCE_TILE_ID, mapId: DEFAULT_MAP_ID, col: 0, row: 0, type: 'dungeon', zone: 'caves', name: 'Hall Gate', dungeonId: DUNGEON_ID };
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: (id: string) => MONSTERS[id],
    getItem: (id: string) => (id ? { id, name: id } : undefined),
    getAllMonsters: () => MONSTERS,
    getAllItems: () => ({}),
    getZone: () => ({ id: 'caves', displayName: 'Caves', encounterTable: [{ encounterId: 'goblins', weight: 1 }], levelRange: [1, 1] }),
    getAllZones: () => ({}),
    getAllEncounters: () => ENCOUNTERS,
    getTileById: (id: string) => (id === ENTRANCE_TILE_ID ? entranceTile : undefined),
    getAllShops: () => ({}),
    getShop: () => undefined,
    getWorld: () => ({ tiles: [entranceTile], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpc: () => undefined,
    getAllQuests: () => ({}),
    getQuest: () => undefined,
    getDungeon: (id: string) => (id === dungeon.current.id ? dungeon.current : undefined),
    getAllDungeons: () => ({ [dungeon.current.id]: dungeon.current }),
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

interface Entry {
  battleTimer: ServerBattleTimer;
  dungeonRun?: DungeonRunState;
}

interface PbmInternals {
  entries: Map<string, Entry>;
  handleDungeonDefeat(entry: Entry): void;
  handleDungeonFloorCleared(entry: Entry): void;
  handleBossPhase(partyId: string, battleId: number, phase: number): void;
  createCombatForParty(partyId: string): PartyCombatState;
}

async function setup(dungeon = makeDungeon()) {
  const holder = { current: dungeon };
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'dungeon', 'caves', ENTRANCE_TILE_ID));
  grid.addTile(new HexTile(offsetToCube({ col: 1, row: 0 }), 'forest', 'caves', 'tile-other'));
  const pm = new PlayerManager(wrapGrids(grid), createFakeContentStore(holder), new GuildStore(), createFakeAccountStore(['alice']), createFakeStore());
  const session = await pm.login(createFakeWs(), 'alice');
  session.setClass('Knight');
  pm.ensureParty('alice');
  const partyId = session.getPartyId()!;
  const pbm = pm.partyBattles as unknown as PbmInternals;
  const entry = () => pbm.entries.get(partyId)!;
  const log = () => session.toSaveData().combatLog.map(l => l.text);
  const boss = (combat: PartyCombatState) => combat.monsters.find(m => m.id === 'chief')!;
  /** The live fight's own phase callback, as the battle step fires it. */
  const reachPhase = (phase: number) => pbm.handleBossPhase(partyId, entry().battleTimer.battleId, phase);
  return { pm, pbm, session, partyId, grid, holder, entry, log, boss, reachPhase };
}

describe('Dungeon boss checkpoints', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('records the checkpoint from the battle step, while the boss is still fighting', async () => {
    const { pm, partyId, entry, log } = await setup();
    expect(pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice').success).toBe(true);
    expect(entry().battleTimer.currentCombat!.bossPhases!.thresholds).toEqual([0.66, 0.33]);

    for (let i = 0; i < 600 && !pm.partyBattles.getDungeonRunInfo(partyId)?.checkpointPhase; i++) {
      vi.advanceTimersByTime(100);
    }

    const info = pm.partyBattles.getDungeonRunInfo(partyId)!;
    expect(info.checkpointPhase).toBe(1);
    expect(info.checkpoints).toEqual([0.66, 0.33]);
    expect(info.maxWipes).toBe(2);
    expect(entry().battleTimer.currentCombat!.finished).toBe(false);
    expect(log().some(t => t.startsWith('Checkpoint 1 of 2 reached'))).toBe(true);
  });

  it('pays each checkpoint once per run, split like the kill', async () => {
    const { pm, partyId, session, entry, log, reachPhase } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice');
    const gold0 = session.getGold();

    reachPhase(1);
    expect(session.getGold()).toBe(gold0 + 7);
    expect(log()).toContain('Checkpoint 1 reward: +15 XP, +7 Gold');
    expect(entry().dungeonRun!.rewardedPhases).toEqual(['0:1']);

    // A regroup resumes at checkpoint 1; crossing it again pays nothing, reaching 2 pays once.
    (pm.partyBattles as unknown as PbmInternals).handleDungeonDefeat(entry());
    entry().battleTimer.restartBattle();
    reachPhase(2);
    expect(session.getGold()).toBe(gold0 + 14);
    expect(entry().dungeonRun!.rewardedPhases).toEqual(['0:1', '0:2']);
    reachPhase(2);
    expect(session.getGold()).toBe(gold0 + 14);
  });

  it('ignores a phase report from a battle that is no longer current', async () => {
    const { pm, pbm, partyId, entry } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice');
    pbm.handleBossPhase(partyId, entry().battleTimer.battleId - 1, 1);
    expect(pm.partyBattles.getDungeonRunInfo(partyId)!.checkpointPhase).toBe(0);
  });

  it('regroups at the checkpoint while wipes last, then ejects and loses the checkpoint', async () => {
    const { pm, pbm, partyId, session, entry, log, boss, reachPhase } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice');
    reachPhase(1);
    session.setDungeonCheckpoint(DUNGEON_ID, { floorIndex: 0, phase: 1, wipes: 0, rewardedPhases: [], at: Date.now() });

    pbm.handleDungeonDefeat(entry());
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toMatchObject({ checkpointPhase: 1, wipes: 1 });
    expect(log()).toContain('Your party regroups at checkpoint 1 — 1 retry left.');
    const resumed = pbm.createCombatForParty(partyId);
    expect(boss(resumed).currentHp).toBe(Math.ceil(30 * 0.66));
    expect(resumed.bossPhases!.phase).toBe(1);

    pbm.handleDungeonDefeat(entry());
    expect(log()).toContain('Your party regroups at checkpoint 1 — no retries left.');
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).not.toBeNull();

    pbm.handleDungeonDefeat(entry());
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
    expect(log()).toContain('The boss recovers — your checkpoint is lost.');
    expect(session.getDungeonCheckpoint(DUNGEON_ID)).toBeUndefined();
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 0, row: 0 });
  });

  it('ejects as before on a wipe away from the checkpoint floor', async () => {
    const { pm, pbm, partyId, entry, log } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice');
    pbm.handleDungeonFloorCleared(entry());
    expect(pm.partyBattles.getDungeonRunInfo(partyId)!.floor).toBe(2);
    pbm.handleDungeonDefeat(entry());
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
    expect(log()).toContain('Wiped in Chief Hall — driven back to the entrance.');
  });

  it('keeps wipes and paid phases across Leave and re-entry, which consumes the entry item again', async () => {
    const { pm, pbm, partyId, session, entry, boss, reachPhase } = await setup(
      makeDungeon({ entryRequirements: { requiredItemId: 'sigil', consumeRequiredItem: true } }),
    );
    session.addToInventory('sigil', 2);
    expect(pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice').success).toBe(true);
    reachPhase(1);
    pbm.handleDungeonDefeat(entry());

    expect(pm.partyBattles.leaveDungeon(partyId)).toBe(true);
    const stored = session.getDungeonCheckpoint(DUNGEON_ID)!;
    expect(stored).toMatchObject({ floorIndex: 0, phase: 1, wipes: 1, rewardedPhases: ['0:1'] });

    expect(pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice').success).toBe(true);
    expect(session.getInventoryCount('sigil')).toBe(0);
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toMatchObject({ floor: 1, checkpointPhase: 1, wipes: 1 });
    expect(boss(entry().battleTimer.currentCombat!).currentHp).toBe(Math.ceil(30 * 0.66));

    // One retry was used before leaving: the next wipe is the last regroup, the one after ejects.
    pbm.handleDungeonDefeat(entry());
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).not.toBeNull();
    pbm.handleDungeonDefeat(entry());
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
    expect(session.getDungeonCheckpoint(DUNGEON_ID)).toBeUndefined();
  });

  it('stores the checkpoint when a content deploy relocates the party', async () => {
    const { pm, partyId, session, grid, reachPhase } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice');
    reachPhase(2);
    pm.partyBattles.relocateParty(partyId, grid.getTile(offsetToCube({ col: 1, row: 0 }))!, DEFAULT_MAP_ID);
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
    expect(session.getDungeonCheckpoint(DUNGEON_ID)).toMatchObject({ floorIndex: 0, phase: 2, wipes: 0 });
  });

  it('starts fresh when the checkpoint is expired or its floor lost its boss', async () => {
    const { pm, partyId, session, holder } = await setup();
    session.setDungeonCheckpoint(DUNGEON_ID, { floorIndex: 0, phase: 2, wipes: 1, rewardedPhases: [], at: Date.now() - DUNGEON_CHECKPOINT_TTL_MS - 1 });
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice');
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toMatchObject({ floor: 1, checkpointPhase: 0, wipes: 0 });
    expect(session.getDungeonCheckpoint(DUNGEON_ID)).toBeUndefined();
    pm.partyBattles.leaveDungeon(partyId);

    holder.current = makeDungeon();
    holder.current.floors[0].encounterTable = [{ encounterId: 'goblins', weight: 1 }];
    session.setDungeonCheckpoint(DUNGEON_ID, { floorIndex: 0, phase: 1, wipes: 0, rewardedPhases: [], at: Date.now() });
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice');
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toMatchObject({ checkpointPhase: 0 });
    expect(session.getDungeonCheckpoint(DUNGEON_ID)).toBeUndefined();
  });

  it('only resumes from the checkpoint of the player who enters', async () => {
    const { pm, partyId, session } = await setup();
    session.setDungeonCheckpoint(DUNGEON_ID, { floorIndex: 0, phase: 2, wipes: 0, rewardedPhases: [], at: Date.now() });
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID);
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toMatchObject({ checkpointPhase: 0 });
  });

  it('clamps a stale phase to the floor as authored now, never producing NaN HP', async () => {
    const { pm, pbm, partyId, holder, boss } = await setup();
    const run = (checkpointPhase: number): DungeonRunState => ({ dungeonId: DUNGEON_ID, currentFloorIndex: 0, entrance: { col: 0, row: 0 }, checkpointPhase });

    pm.partyBattles.restoreDungeonRun(partyId, run(9));
    let combat = pbm.createCombatForParty(partyId);
    expect(boss(combat).currentHp).toBe(Math.ceil(30 * 0.33));
    expect(pm.partyBattles.getDungeonSaveData(partyId)!.checkpointPhase).toBe(2);

    pm.partyBattles.restoreDungeonRun(partyId, run(Number.NaN));
    combat = pbm.createCombatForParty(partyId);
    expect(boss(combat).currentHp).toBe(30);

    // An author shortened the checkpoint list after the run was saved.
    holder.current = makeDungeon();
    holder.current.floors[0].checkpoints = [0.5];
    pm.partyBattles.restoreDungeonRun(partyId, run(2));
    combat = pbm.createCombatForParty(partyId);
    expect(boss(combat).currentHp).toBe(15);
    expect(Number.isFinite(boss(combat).currentHp)).toBe(true);
    expect(combat.finished).toBe(false);

    // The floor lost its checkpoints entirely: a plain fight.
    holder.current.floors[0].checkpoints = undefined;
    pm.partyBattles.restoreDungeonRun(partyId, run(1));
    combat = pbm.createCombatForParty(partyId);
    expect(boss(combat).currentHp).toBe(30);
    expect(combat.bossPhases!.thresholds).toEqual([]);
  });

  it('drops a run whose floor index is out of range or malformed', async () => {
    const { pm, partyId } = await setup();
    pm.partyBattles.restoreDungeonRun(partyId, { dungeonId: DUNGEON_ID, currentFloorIndex: 5, entrance: { col: 0, row: 0 } });
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
    pm.partyBattles.restoreDungeonRun(partyId, { dungeonId: DUNGEON_ID, currentFloorIndex: 0.5, entrance: { col: 0, row: 0 } });
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
  });

  it('round-trips checkpoint progress through the saved run', async () => {
    const { pm, pbm, partyId, entry, reachPhase } = await setup();
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice');
    reachPhase(1);
    pbm.handleDungeonDefeat(entry());
    const saved = pm.partyBattles.getDungeonSaveData(partyId)!;
    expect(saved).toMatchObject({ checkpointPhase: 1, wipes: 1, rewardedPhases: ['0:1'] });

    pm.partyBattles.leaveDungeon(partyId);
    pm.partyBattles.restoreDungeonRun(partyId, saved);
    expect(pm.partyBattles.getDungeonSaveData(partyId)).toEqual(saved);
  });

  it('clears the stored checkpoint once the checkpoint floor is beaten', async () => {
    const { pm, pbm, partyId, session, entry } = await setup();
    session.setDungeonCheckpoint(DUNGEON_ID, { floorIndex: 0, phase: 1, wipes: 0, rewardedPhases: [], at: Date.now() });
    pm.partyBattles.enterDungeon(partyId, DUNGEON_ID, 'alice');
    pbm.handleDungeonFloorCleared(entry());
    expect(session.getDungeonCheckpoint(DUNGEON_ID)).toBeUndefined();
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toMatchObject({ floor: 2 });
    expect(pm.partyBattles.getDungeonRunInfo(partyId)!.checkpointPhase).toBeUndefined();
  });
});
