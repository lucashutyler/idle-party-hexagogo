import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import { GameLoop } from '../src/game/GameLoop.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';
import { HexGrid, HexTile, offsetToCube, COMBAT_PACE, COMBAT_STEP_MS, DEFAULT_MAP_ID, KILL_BEAT_MS, awayRecapStyle, createAwayLedger, paceRealMs, topAwayMoments } from '@idle-party-rpg/shared';
import type { ContentStore } from '../src/game/ContentStore.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';
import type {
  ClassName,
  DungeonDefinition,
  DungeonFloor,
  DungeonRunState,
  EncounterDefinition,
  MonsterDefinition,
  PartyCombatState,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import WebSocket from 'ws';

const DUNGEON_ID = 'chief_hall';
const ENTRANCE_TILE_ID = 'tile-start';
const ENTRANCE = { col: 0, row: 0 };
const FIRST_STEP_MS = paceRealMs(COMBAT_PACE, COMBAT_STEP_MS);
const RUN_ENDED = 'Your run in Chief Hall has ended because the party changed.';
const WIPED = 'Wiped in Chief Hall — driven back to the entrance.';

const MONSTERS: Record<string, MonsterDefinition> = {
  chief: { id: 'chief', name: 'Chief', hp: 30, damage: 1, damageType: 'physical', xp: 100, goldMin: 40, goldMax: 60, tier: 'boss' },
  doom: { id: 'doom', name: 'Doom', hp: 1e7, damage: 1e7, damageType: 'physical', xp: 100, goldMin: 40, goldMax: 60, tier: 'boss' },
  goblin: { id: 'goblin', name: 'Goblin', hp: 10, damage: 1, damageType: 'physical', xp: 5, goldMin: 0, goldMax: 0 },
};

const ENCOUNTERS: Record<string, EncounterDefinition> = {
  court: { id: 'court', name: 'Court', type: 'explicit', placements: [{ monsterId: 'chief', gridPosition: 4 }] },
  doom_room: { id: 'doom_room', name: 'Doom Room', type: 'explicit', placements: [{ monsterId: 'doom', gridPosition: 4 }] },
  goblins: { id: 'goblins', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 },
};

const OLD_FLOOR_FIELDS = { checkpoints: [0.66, 0.33], maxWipes: 2, checkpointRewardFraction: 0.5 };

function bossFloor(floorNumber: number, encounterId = 'court', extra: object = {}): DungeonFloor {
  return { floorNumber, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId, weight: 1 }], isBoss: true, ...extra };
}

function goblinFloor(floorNumber: number): DungeonFloor {
  return { floorNumber, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'goblins', weight: 1 }] };
}

function makeDungeon(over: Partial<DungeonDefinition> = {}): DungeonDefinition {
  return { id: DUNGEON_ID, name: 'Chief Hall', floors: [bossFloor(1), goblinFloor(2)], ...over };
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
    getQuestCatalog: () => ({}),
    getQuestRevision: () => 0,
    getNpcQuestIds: () => [],
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
  members: Set<string>;
}

interface PbmInternals {
  entries: Map<string, Entry>;
  handleDungeonDefeat(entry: Entry): void;
  handleDungeonFloorCleared(entry: Entry): void;
}

function logOf(player: PlayerSession): string[] {
  return player.toSaveData().combatLog.map(l => l.text);
}

function fighters(entry: Entry): string[] {
  return entry.battleTimer.currentCombat!.players.map(p => p.username).sort();
}

function earned(player: PlayerSession): { level: number; xp: number; gold: number } {
  const { level, xp, gold } = player.toSaveData().character!;
  return { level, xp, gold };
}

/** From now on, the chat lines each player receives, as `channel: text`. */
function chatTo(pm: PlayerManager): (username: string) => string[] {
  const lines = new Map<string, string[]>();
  const real = pm.sendChatToPlayer.bind(pm);
  vi.spyOn(pm, 'sendChatToPlayer').mockImplementation((username, message) => {
    lines.set(username, [...(lines.get(username) ?? []), `${message.channelType}: ${message.text}`]);
    real(username, message);
  });
  return username => lines.get(username) ?? [];
}

async function setup(dungeon = makeDungeon(), usernames = ['alice']) {
  const holder = { current: dungeon };
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube(ENTRANCE), 'dungeon', 'caves', ENTRANCE_TILE_ID));
  grid.addTile(new HexTile(offsetToCube({ col: 1, row: 0 }), 'forest', 'caves', 'tile-other'));
  const newManager = () => new PlayerManager(wrapGrids(grid), createFakeContentStore(holder), new GuildStore(), createFakeAccountStore(usernames), createFakeStore());
  const pm = newManager();
  const session = await pm.login(createFakeWs(), 'alice');
  session.setClass('Knight');
  pm.ensureParty('alice');
  const partyId = session.getPartyId()!;
  const pbm = pm.partyBattles as unknown as PbmInternals;
  const entry = () => pbm.entries.get(partyId)!;
  const log = () => logOf(session);
  const boss = (combat: PartyCombatState) => combat.monsters.find(m => m.tier === 'boss')!;
  const runOf = (party: string) => pm.partyBattles.getDungeonRunInfo(party);
  const enter = () => expect(pm.partyBattles.enterDungeon(partyId, DUNGEON_ID).success).toBe(true);
  const runUntilFinished = () => {
    for (let i = 0; i < 600; i++) {
      if (entry().battleTimer.currentCombat?.finished) return;
      vi.advanceTimersByTime(100);
    }
    throw new Error('fight never finished');
  };
  const oneHitEnemies = () => {
    for (const monster of entry().battleTimer.currentCombat!.monsters) monster.currentHp = 1;
  };
  const winFight = () => {
    oneHitEnemies();
    runUntilFinished();
    expect(entry().battleTimer.currentCombat!.result).toBe('victory');
    vi.advanceTimersByTime(KILL_BEAT_MS);
  };
  const nextFight = () => {
    const battleId = entry().battleTimer.battleId;
    for (let i = 0; i < 200 && entry().battleTimer.battleId === battleId; i++) vi.advanceTimersByTime(50);
    expect(entry().battleTimer.battleId).not.toBe(battleId);
  };
  return { pm, pbm, session, partyId, grid, holder, entry, log, boss, runOf, enter, runUntilFinished, oneHitEnemies, winFight, nextFight, newManager };
}

/** Alice owns the party and Bob joined it; everyone in `others` stands in the same room in a party of their own. */
async function setupDuo(dungeon = makeDungeon(), others: string[] = []) {
  const world = await setup(dungeon, ['alice', 'bob', ...others]);
  const { pm, pbm } = world;
  const login = async (username: string, className: ClassName) => {
    const session = await pm.login(createFakeWs(), username);
    session.setClass(className);
    pm.ensureParty(username);
    return session;
  };
  const getPartyId = (u: string) => pm.getSessionByUsername(u)?.getPartyId() ?? null;
  const sameTile = (a: string, b: string) => pm.areSameTile(a, b);
  const invite = (inviter: string, invitee: string) => {
    if (pm.parties.inviteToParty(inviter, invitee, getPartyId, sameTile) !== true) throw new Error('invite failed');
  };
  const join = (inviter: string, joiner: string) => {
    const target = getPartyId(inviter)!;
    invite(inviter, joiner);
    const refused = pm.acceptPartyInvite(joiner, target);
    if (refused) throw new Error(refused);
  };
  const leaveParty = (username: string) => {
    const refused = pm.leaveParty(username);
    if (refused) throw new Error(refused);
    return getPartyId(username)!;
  };
  const kick = (kicker: string, target: string) => {
    const refused = pm.kickPartyMember(kicker, target);
    if (refused) throw new Error(refused);
    return getPartyId(target)!;
  };
  const bob = await login('bob', 'Priest');
  join('alice', 'bob');
  const extras: PlayerSession[] = [];
  for (const username of others) extras.push(await login(username, 'Mage'));
  const beatFloor = () => pbm.handleDungeonFloorCleared(world.entry());
  return { ...world, bob, extras, getPartyId, invite, join, leaveParty, kick, beatFloor };
}

type Duo = Awaited<ReturnType<typeof setupDuo>>;

describe('A dungeon run is floors in order', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('walks the floors one win at a time, then clears and returns to the entrance room', async () => {
    const dungeon = makeDungeon({ firstClearGold: 7 });
    const { pm, session, partyId, entry, log, runOf, enter, winFight, nextFight } = await setup(dungeon);
    enter();
    expect(runOf(partyId)).toEqual({ dungeonId: DUNGEON_ID, name: 'Chief Hall', floor: 1, totalFloors: 2, isBossFloor: true });
    expect(entry().dungeonRun).toEqual({ dungeonId: DUNGEON_ID, currentFloorIndex: 0, entrance: ENTRANCE });

    winFight();
    expect(runOf(partyId)).toMatchObject({ floor: 2, isBossFloor: false });
    expect(log()).toContain('Descending to floor 2 of 2...');

    nextFight();
    winFight();
    expect(runOf(partyId)).toBeNull();
    expect(log()).toContain('Cleared Chief Hall!');
    expect(log()).toContain('First-clear bonus: +7 Gold!');
    expect(session.hasDungeonCleared(DUNGEON_ID)).toBe(true);
    expect(pm.partyBattles.getPosition(partyId)).toEqual(ENTRANCE);
  });

  it('starts every entry at floor 1 at full boss HP with nothing carried over, and spends the entry item each time', async () => {
    const { pm, session, partyId, entry, boss, log, runOf, enter, winFight, nextFight } = await setup(
      makeDungeon({ entryRequirements: { requiredItemId: 'sigil', consumeRequiredItem: true }, floors: [goblinFloor(1), bossFloor(2)] }),
    );
    session.addToInventory('sigil', 2);
    enter();
    winFight();
    expect(runOf(partyId)!.floor).toBe(2);
    nextFight();
    boss(entry().battleTimer.currentCombat!).currentHp = 1;

    expect(pm.partyBattles.leaveDungeon(partyId)).toBe(true);
    expect(log()).toContain('Left Chief Hall.');
    expect(pm.partyBattles.getDungeonSaveData(partyId)).toBeNull();
    expect(session.toSaveData()).not.toHaveProperty('dungeonCheckpoints');

    enter();
    expect(session.getInventoryCount('sigil')).toBe(0);
    expect(runOf(partyId)!.floor).toBe(1);
    expect(entry().dungeonRun).toEqual({ dungeonId: DUNGEON_ID, currentFloorIndex: 0, entrance: ENTRANCE });

    winFight();
    nextFight();
    const bossNow = boss(entry().battleTimer.currentCombat!);
    expect(bossNow.currentHp).toBe(bossNow.maxHp);
  });

  it('starts over at floor 1 after a wipe too', async () => {
    const { pbm, partyId, entry, runOf, enter } = await setup();
    enter();
    pbm.handleDungeonFloorCleared(entry());
    pbm.handleDungeonDefeat(entry());
    expect(runOf(partyId)).toBeNull();
    enter();
    expect(runOf(partyId)!.floor).toBe(1);
  });

  it('brings overworld combat back at once when the party walks out', async () => {
    const { pm, partyId, entry, runOf, enter } = await setup();
    enter();
    const battleId = entry().battleTimer.battleId;

    pm.partyBattles.leaveDungeon(partyId);

    expect(runOf(partyId)).toBeNull();
    expect(pm.partyBattles.getPosition(partyId)).toEqual(ENTRANCE);
    expect(entry().battleTimer.battleId).not.toBe(battleId);
    expect(entry().battleTimer.isFighting(entry().battleTimer.battleId)).toBe(true);
  });

  it('records a left run in the recap, with nothing but the outcome', async () => {
    const { pm, session, partyId, enter } = await setup();
    session.beginAway();
    enter();
    vi.advanceTimersByTime(FIRST_STEP_MS);

    pm.partyBattles.leaveDungeon(partyId);

    expect(session.getAwayLedger()!.dungeons).toEqual([{ dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'left' }]);
    expect(session.getAwayLedger()!.moments).toEqual([]);
  });

  it('gives the rest of the party a recap moment when a leader walks out', async () => {
    const w = await setupDuo();
    w.bob.beginAway();
    w.enter();

    w.pm.partyBattles.leaveDungeon(w.partyId);

    const ledger = w.bob.getAwayLedger()!;
    expect(ledger.moments.map(m => [m.kind, m.text])).toEqual([['run_ended', 'Left Chief Hall']]);
    expect(awayRecapStyle(ledger, Date.now())).toBe('modal');
    expect(logOf(w.bob)).toContain('Left Chief Hall.');
  });
});

describe('A wipe ends the run on any floor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each<[string, DungeonFloor]>([
    ['a boss floor', bossFloor(1, 'doom_room')],
    ['a boss floor still carrying the old fields', bossFloor(1, 'doom_room', OLD_FLOOR_FIELDS)],
  ])('on %s: no second attempt, nothing paid for damage done, back in the entrance room', async (_name, floor) => {
    const { pm, session, partyId, entry, log, runOf, enter, runUntilFinished } = await setup(makeDungeon({ floors: [floor] }));
    session.beginAway();
    enter();
    const before = earned(session);
    const boss = entry().battleTimer.currentCombat!.monsters[0];
    boss.currentHp = Math.ceil(boss.maxHp / 10);

    runUntilFinished();
    expect(entry().battleTimer.currentCombat!.result).toBe('defeat');
    const defeated = entry().battleTimer.battleId;
    vi.advanceTimersByTime(KILL_BEAT_MS);

    expect(runOf(partyId)).toBeNull();
    expect(entry().dungeonRun).toBeUndefined();
    expect(pm.partyBattles.getPosition(partyId)).toEqual(ENTRANCE);
    expect(log()).toContain('Defeat...');
    expect(log()).toContain(WIPED);
    expect(log().filter(t => /regroup|checkpoint|retry|retries/i.test(t))).toEqual([]);
    expect(earned(session)).toEqual(before);
    const ledger = session.getAwayLedger()!;
    expect(ledger.dungeons).toEqual([{ dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'ejected' }]);
    expect(ledger.moments.map(m => [m.kind, m.text])).toEqual([['eject', 'Driven out of Chief Hall']]);

    vi.advanceTimersByTime(5000);
    expect(entry().battleTimer.battleId).not.toBe(defeated);
    expect(entry().battleTimer.currentCombat!.monsters.map(m => m.id)).not.toContain('doom');
  });

  it('on an ordinary floor, with the same line and outcome', async () => {
    const { pbm, session, partyId, entry, log, runOf, enter } = await setup(makeDungeon({ floors: [goblinFloor(1)] }));
    session.beginAway();
    enter();
    pbm.handleDungeonDefeat(entry());
    expect(runOf(partyId)).toBeNull();
    expect(log()).toContain(WIPED);
    expect(session.getAwayLedger()!.dungeons.at(-1)).toEqual({ dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'ejected' });
  });

  it('still ends the run when the dungeon has gone from content', async () => {
    const { pbm, partyId, holder, entry, log, runOf, enter } = await setup();
    enter();
    holder.current = { ...makeDungeon(), id: 'another' };
    pbm.handleDungeonDefeat(entry());
    expect(runOf(partyId)).toBeNull();
    expect(log()).toContain('Wiped in the dungeon — driven back to the entrance.');
  });

  it('closes the recap\'s open run record even when the dungeon has gone from content', async () => {
    const { pbm, session, holder, entry, enter } = await setup();
    session.beginAway();
    enter();
    holder.current = { ...makeDungeon(), id: 'another' };
    pbm.handleDungeonDefeat(entry());
    expect(session.getAwayLedger()!.dungeons).toEqual([{ dungeonId: DUNGEON_ID, name: 'the dungeon', outcome: 'ejected' }]);
  });
});

describe('A boss pays on the kill and nowhere else', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each<[string, DungeonFloor]>([
    ['a plain boss floor', bossFloor(1)],
    ['a boss floor still carrying the old fields', bossFloor(1, 'court', OLD_FLOOR_FIELDS)],
  ])('on %s: nothing until the boss falls, then the kill', async (_name, floor) => {
    const { session, entry, log, enter, winFight, boss } = await setup(makeDungeon({ floors: [floor, goblinFloor(2)] }));
    enter();
    const before = earned(session);
    const fight = boss(entry().battleTimer.currentCombat!);
    fight.maxHp = 1000;
    fight.currentHp = 100;
    vi.advanceTimersByTime(FIRST_STEP_MS * 20);
    expect(fight.currentHp).toBeGreaterThan(0);
    expect(earned(session)).toEqual(before);
    expect(log().filter(t => /XP|Gold/.test(t))).toEqual([]);

    winFight();

    const after = earned(session);
    expect(after.gold).toBeGreaterThan(before.gold);
    expect([after.level, after.xp]).not.toEqual([before.level, before.xp]);
    expect(log().filter(t => t === 'Victory!')).toHaveLength(1);
    expect(log().filter(t => /checkpoint/i.test(t))).toEqual([]);
  });

  it('gives the fight the boss bar\'s inputs and no thresholds', async () => {
    const { entry, enter } = await setup();
    enter();
    const combat = entry().battleTimer.currentCombat!;
    expect(combat).not.toHaveProperty('bossPhases');
    expect(combat.monsters.map(m => m.tier)).toEqual(['boss']);
  });
});

describe('A forced relocation ends the run', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('moves the party on, says why, and leaves nothing to come back to', async () => {
    const { pm, session, partyId, grid, entry, log, runOf, enter } = await setup();
    session.beginAway();
    enter();
    const battleId = entry().battleTimer.battleId;

    pm.partyBattles.relocateParty(partyId, grid.getTile(offsetToCube({ col: 1, row: 0 }))!, DEFAULT_MAP_ID);

    expect(runOf(partyId)).toBeNull();
    expect(pm.partyBattles.getDungeonSaveData(partyId)).toBeNull();
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 1, row: 0 });
    expect(entry().battleTimer.battleId).not.toBe(battleId);
    expect(log()).toContain('Your run in Chief Hall has ended because the world changed.');
    const ledger = session.getAwayLedger()!;
    expect(ledger.moments.map(m => `${m.kind}: ${m.text}`)).toContain('run_ended: Left Chief Hall when the world changed');
    expect(ledger.dungeons.at(-1)).toEqual({ dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'left' });

    pm.partyBattles.relocateParty(partyId, grid.getTile(offsetToCube(ENTRANCE))!, DEFAULT_MAP_ID);
    enter();
    expect(runOf(partyId)!.floor).toBe(1);
  });

  it('leaves a party outside a dungeon with no run line', async () => {
    const { pm, partyId, grid, log } = await setup();
    pm.partyBattles.relocateParty(partyId, grid.getTile(offsetToCube({ col: 1, row: 0 }))!, DEFAULT_MAP_ID);
    expect(log().filter(t => t.includes('has ended'))).toEqual([]);
  });

  it('pays a win still in its kill beat first, counting a last-floor win as a clear', async () => {
    const { pm, session, partyId, grid, entry, log, runOf, enter, oneHitEnemies, runUntilFinished } = await setup(makeDungeon({ floors: [bossFloor(1)], firstClearGold: 7 }));
    enter();
    oneHitEnemies();
    runUntilFinished();
    expect(entry().battleTimer.currentCombat!.result).toBe('victory');
    const goldBefore = earned(session).gold;

    pm.partyBattles.relocateParty(partyId, grid.getTile(offsetToCube({ col: 1, row: 0 }))!, DEFAULT_MAP_ID);

    expect(log()).toContain('Victory!');
    expect(log()).toContain('Cleared Chief Hall!');
    expect(log()).toContain('First-clear bonus: +7 Gold!');
    expect(log().filter(t => t.includes('has ended'))).toEqual([]);
    expect(session.hasDungeonCleared(DUNGEON_ID)).toBe(true);
    expect(earned(session).gold).toBeGreaterThan(goldBefore + 7);
    expect(runOf(partyId)).toBeNull();
    expect(pm.partyBattles.getPosition(partyId)).toEqual({ col: 1, row: 0 });
  });

  it('pushes state to the party once a displaced party is moved, with the room already re-seated', async () => {
    const { pm, session, partyId, grid, holder, log, runOf } = await setup();
    const island = new HexTile(offsetToCube({ col: 9, row: 9 }), 'forest', 'caves', 'tile-island');
    grid.addTile(island);
    pm.partyBattles.relocateParty(partyId, island, DEFAULT_MAP_ID);
    pm.partyBattles.restoreDungeonRun(partyId, { dungeonId: DUNGEON_ID, currentFloorIndex: 0, entrance: { col: 9, row: 9 } });
    const pushed: boolean[] = [];
    vi.spyOn(pm, 'sendStateToPlayer').mockImplementation(() => { pushed.push(log().includes('World updated — relocated to a safe room.')); });

    expect(pm.relocateDisplacedParties(wrapGrids(grid), createFakeContentStore(holder))).toBe(1);

    expect(runOf(partyId)).toBeNull();
    expect(pushed.at(-1)).toBe(true);
    expect(session.getPartyId()).toBe(partyId);
  });
});

describe('A content change that removes the run ends it', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const WORLD_ENDED = 'Your run in the dungeon has ended because the world changed.';

  it('ends a run at once when its dungeon goes, says why, and restarts overworld combat', async () => {
    const { pm, session, partyId, entry, holder, log, enter } = await setup();
    session.beginAway();
    enter();
    const battleId = entry().battleTimer.battleId;
    holder.current = { ...makeDungeon(), id: 'another' };
    const pushed = vi.spyOn(pm, 'sendStateToPlayer');

    pm.partyBattles.endOrphanedRuns();

    expect(pm.partyBattles.isInDungeonRun(partyId)).toBe(false);
    expect(entry().battleTimer.battleId).not.toBe(battleId);
    expect(entry().battleTimer.isFighting(entry().battleTimer.battleId)).toBe(true);
    expect(pushed).toHaveBeenCalledWith('alice');
    expect(log()).toContain(WORLD_ENDED);
    const ledger = session.getAwayLedger()!;
    expect(ledger.moments.map(m => [m.kind, m.text])).toEqual([['run_ended', 'Left the dungeon when the world changed']]);
    expect(ledger.dungeons).toEqual([{ dungeonId: DUNGEON_ID, name: 'the dungeon', outcome: 'left' }]);
  });

  it('is part of every grid rebuild, which a deploy and a room edit both go through', async () => {
    const { pm, grid, holder, partyId, log, enter } = await setup();
    enter();
    holder.current = { ...makeDungeon(), id: 'another' };

    const relocated = GameLoop.prototype.rebuildGridAndRelocate.call({
      grids: wrapGrids(grid),
      playerManager: pm,
      contentStore: createFakeContentStore(holder),
    } as unknown as GameLoop);

    expect(relocated).toBe(0);
    expect(pm.partyBattles.isInDungeonRun(partyId)).toBe(false);
    expect(log()).toContain(WORLD_ENDED);
  });

  it('does not bring the run back when the dungeon is restored afterwards', async () => {
    const { pm, partyId, holder, runOf, enter } = await setup();
    enter();
    const original = holder.current;
    holder.current = { ...makeDungeon(), id: 'another' };

    pm.partyBattles.endOrphanedRuns();
    holder.current = original;
    pm.partyBattles.endOrphanedRuns();

    expect(runOf(partyId)).toBeNull();
    expect(pm.partyBattles.isInDungeonRun(partyId)).toBe(false);
  });

  it('ends a run whose floor has gone, naming the dungeon that is still there', async () => {
    const { pm, session, pbm, partyId, entry, holder, log, enter } = await setup();
    session.beginAway();
    enter();
    pbm.handleDungeonFloorCleared(entry());
    holder.current = makeDungeon({ floors: [bossFloor(1)] });

    pm.partyBattles.endOrphanedRuns();

    expect(pm.partyBattles.isInDungeonRun(partyId)).toBe(false);
    expect(log()).toContain('Your run in Chief Hall has ended because the world changed.');
    expect(session.getAwayLedger()!.dungeons.at(-1)).toEqual({ dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'left' });
  });

  it('leaves alone a run whose dungeon and floor are still there, and a party outside any run', async () => {
    const { pm, partyId, entry, log, runOf, enter } = await setup();
    const overworld = entry().battleTimer.battleId;
    pm.partyBattles.endOrphanedRuns();
    expect(entry().battleTimer.battleId).toBe(overworld);

    enter();
    const battleId = entry().battleTimer.battleId;
    pm.partyBattles.endOrphanedRuns();

    expect(entry().battleTimer.battleId).toBe(battleId);
    expect(runOf(partyId)).toMatchObject({ floor: 1 });
    expect(log().filter(t => t.includes('has ended'))).toEqual([]);
  });

  it('pays a win still in its kill beat before ending the run', async () => {
    const { pm, session, partyId, entry, holder, log, enter, oneHitEnemies, runUntilFinished } = await setup();
    enter();
    oneHitEnemies();
    runUntilFinished();
    const goldBefore = earned(session).gold;
    holder.current = { ...makeDungeon(), id: 'another' };

    pm.partyBattles.endOrphanedRuns();

    expect(earned(session).gold).toBeGreaterThan(goldBefore);
    expect(log()).toContain(WORLD_ENDED);
    expect(pm.partyBattles.isInDungeonRun(partyId)).toBe(false);
    expect(entry().battleTimer.isFighting(entry().battleTimer.battleId)).toBe(true);
  });

  it('counts a win still in its kill beat toward the run before looking at what has gone', async () => {
    const { pm, pbm, session, partyId, entry, holder, log, enter, oneHitEnemies, runUntilFinished } = await setup();
    enter();
    pbm.handleDungeonFloorCleared(entry());
    entry().battleTimer.restartBattle();
    oneHitEnemies();
    runUntilFinished();
    holder.current = makeDungeon({ floors: [bossFloor(1)] });

    pm.partyBattles.endOrphanedRuns();

    expect(log()).toContain('Cleared Chief Hall!');
    expect(log().filter(t => t.includes('has ended'))).toEqual([]);
    expect(session.hasDungeonCleared(DUNGEON_ID)).toBe(true);
    expect(pm.partyBattles.isInDungeonRun(partyId)).toBe(false);
  });

  it('says why at the next fight when nothing swept the run first', async () => {
    const { session, partyId, entry, holder, log, runOf, enter, pm } = await setup();
    session.beginAway();
    enter();
    holder.current = makeDungeon({ floors: [] });

    entry().battleTimer.restartBattle();

    expect(runOf(partyId)).toBeNull();
    expect(pm.partyBattles.isInDungeonRun(partyId)).toBe(false);
    expect(log()).toContain('Your run in Chief Hall has ended because the world changed.');
    const ledger = session.getAwayLedger()!;
    expect(ledger.dungeons).toEqual([{ dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'left' }]);
    expect(ledger.moments.map(m => m.kind)).toEqual(['run_ended']);
  });

  it('says why when a floor is won with the dungeon gone', async () => {
    const { pbm, session, partyId, entry, holder, log, enter, pm } = await setup();
    session.beginAway();
    enter();
    holder.current = { ...makeDungeon(), id: 'another' };

    pbm.handleDungeonFloorCleared(entry());

    expect(pm.partyBattles.isInDungeonRun(partyId)).toBe(false);
    expect(log()).toContain(WORLD_ENDED);
    expect(session.getAwayLedger()!.dungeons).toEqual([{ dungeonId: DUNGEON_ID, name: 'the dungeon', outcome: 'left' }]);
  });

  it('says why when a restart restores a run whose dungeon has gone', async () => {
    const { pm, holder, newManager } = await setup();
    const old = { ...JSON.parse(JSON.stringify(pm.getAllSaveData()[0])), dungeonRun: { dungeonId: DUNGEON_ID, currentFloorIndex: 0, entrance: ENTRANCE } } as PlayerSaveData;
    holder.current = { ...makeDungeon(), id: 'another' };

    const restarted = newManager();
    restarted.restoreFromSaveData([old]);

    const session = restarted.getSessionByUsername('alice')!;
    expect(restarted.partyBattles.isInDungeonRun(session.getPartyId()!)).toBe(false);
    expect(logOf(session)).toContain(WORLD_ENDED);
  });
});

describe('A run lasts only while the party stays together', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** Alice, Bob and Carol in one party with a fight under way; Dave stands by outside it. */
  async function trioInRun() {
    const world = await setupDuo(makeDungeon(), ['carol', 'dave']);
    world.join('alice', 'carol');
    world.enter();
    vi.advanceTimersByTime(FIRST_STEP_MS);
    return { ...world, carol: world.extras[0], dave: world.extras[1] };
  }

  it.each<[string, (w: Duo) => unknown]>([
    ['a member leaving', w => w.leaveParty('bob')],
    ['a kick', w => w.kick('alice', 'bob')],
    ['an accepted invite', w => w.join('dave', 'bob')],
    ['a ban', w => w.pm.banPlayer('bob')],
  ])('%s ends the run for everyone left, with overworld combat restarted without them', async (_cause, act) => {
    const w = await trioInRun();
    const { session, carol, partyId, entry } = w;
    session.beginAway();
    carol.beginAway();
    const pushed = vi.spyOn(w.pm, 'sendStateToPlayer');
    const battleId = entry().battleTimer.battleId;
    expect(fighters(entry())).toEqual(['alice', 'bob', 'carol']);

    await act(w);

    expect(w.runOf(partyId)).toBeNull();
    expect(entry().dungeonRun).toBeUndefined();
    expect(w.pm.partyBattles.getDungeonSaveData(partyId)).toBeNull();
    expect(w.pm.partyBattles.getPosition(partyId)).toEqual(ENTRANCE);
    expect(entry().battleTimer.battleId).not.toBe(battleId);
    expect(entry().battleTimer.isFighting(entry().battleTimer.battleId)).toBe(true);
    expect(fighters(entry())).toEqual(['alice', 'carol']);
    expect(entry().members).toEqual(new Set(['alice', 'carol']));
    expect(pushed).toHaveBeenCalledWith('alice');
    expect(pushed).toHaveBeenCalledWith('carol');

    for (const left of [session, carol]) {
      expect(left.toSaveData().combatLog.find(l => l.text === RUN_ENDED)?.type).toBe('retreat');
      const ledger = left.getAwayLedger()!;
      expect(ledger.moments.map(m => m.kind)).toEqual(['run_ended']);
      expect(ledger.moments[0].text).toBe('Left Chief Hall when the party changed');
      expect(ledger.dungeons.at(-1)).toEqual({ dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'left' });
    }

    vi.advanceTimersByTime(5000);
    expect(fighters(entry())).toEqual(['alice', 'carol']);
  });

  it('leaves everyone free to enter again from floor 1', async () => {
    const w = await trioInRun();
    w.beatFloor();
    w.leaveParty('bob');

    w.enter();
    expect(w.runOf(w.partyId)).toMatchObject({ floor: 1 });
  });

  it('tells the player who left why their run ended, and sets them up in the entrance room', async () => {
    const w = await trioInRun();
    w.bob.beginAway();

    const bobParty = w.leaveParty('bob');

    expect(logOf(w.bob)).toContain(RUN_ENDED);
    expect(w.bob.getAwayLedger()!.moments.map(m => m.text)).toContain('Left Chief Hall when the party changed');
    expect(bobParty).not.toBe(w.partyId);
    expect(w.runOf(bobParty)).toBeNull();
    expect(w.pm.partyBattles.getPosition(bobParty)).toEqual(ENTRANCE);
    expect(fighters(w.pbm.entries.get(bobParty)!)).toEqual(['bob']);
  });

  it('tells a kicked player the same, and hands the party to a new owner when the owner goes', async () => {
    const w = await trioInRun();
    const carolParty = w.kick('alice', 'carol');
    expect(logOf(w.carol)).toContain(RUN_ENDED);
    expect(w.runOf(carolParty)).toBeNull();

    w.enter();
    w.leaveParty('alice');
    expect(w.pm.parties.getParty(w.partyId)!.members.map(m => [m.username, m.role])).toEqual([['bob', 'owner']]);
    expect(w.runOf(w.partyId)).toBeNull();
    expect(fighters(w.entry())).toEqual(['bob']);
  });

  it('returns the party to the run\'s entrance room', async () => {
    const w = await trioInRun();
    w.entry().dungeonRun!.entrance = { col: 1, row: 0 };
    w.kick('alice', 'bob');
    expect(w.pm.partyBattles.getPosition(w.partyId)).toEqual({ col: 1, row: 0 });
  });

  it('still ends the run when its dungeon has gone from content', async () => {
    const w = await trioInRun();
    w.holder.current = { ...makeDungeon(), id: 'another' };
    w.leaveParty('bob');
    expect(w.entry().dungeonRun).toBeUndefined();
    expect(logOf(w.session)).toContain('Your run in the dungeon has ended because the party changed.');
    expect(fighters(w.entry())).toEqual(['alice', 'carol']);
  });

  it('pays a win still in its kill beat to the roster that fought it, then ends the run', async () => {
    const w = await setupDuo();
    w.enter();
    w.oneHitEnemies();
    w.runUntilFinished();
    expect(w.entry().battleTimer.currentCombat!.result).toBe('victory');
    const victories = (player: PlayerSession) => logOf(player).filter(t => t === 'Victory!').length;
    const before = { alice: victories(w.session), bob: victories(w.bob), bobGold: earned(w.bob).gold };

    w.leaveParty('bob');

    expect(victories(w.session)).toBe(before.alice + 1);
    expect(victories(w.bob)).toBe(before.bob + 1);
    expect(earned(w.bob).gold).toBeGreaterThan(before.bobGold);
    expect(w.runOf(w.partyId)).toBeNull();
    const log = logOf(w.session);
    expect(log.indexOf('Descending to floor 2 of 2...')).toBeGreaterThan(-1);
    expect(log.indexOf('Descending to floor 2 of 2...')).toBeLessThan(log.indexOf(RUN_ENDED));
    expect(w.entry().battleTimer.isFighting(w.entry().battleTimer.battleId)).toBe(true);
    expect(fighters(w.entry())).toEqual(['alice']);

    vi.advanceTimersByTime(KILL_BEAT_MS);
    expect(victories(w.session)).toBe(before.alice + 1);
    expect(victories(w.bob)).toBe(before.bob + 1);
  });

  it('counts a win that clears the last floor as a clear, not as a broken run, and fights on without the leaver', async () => {
    const w = await setupDuo();
    w.enter();
    w.beatFloor();
    w.entry().battleTimer.restartBattle();
    w.oneHitEnemies();
    w.runUntilFinished();
    expect(w.entry().battleTimer.currentCombat!.result).toBe('victory');

    w.leaveParty('bob');

    for (const player of [w.session, w.bob]) {
      expect(logOf(player)).toContain('Cleared Chief Hall!');
      expect(logOf(player)).not.toContain(RUN_ENDED);
      expect(player.hasDungeonCleared(DUNGEON_ID)).toBe(true);
    }
    expect(w.runOf(w.partyId)).toBeNull();
    expect(w.entry().battleTimer.isFighting(w.entry().battleTimer.battleId)).toBe(true);
    expect(fighters(w.entry())).toEqual(['alice']);
  });

  it('counts a wipe still in its kill beat as the wipe, not as a broken run', async () => {
    const w = await setupDuo(makeDungeon({ floors: [bossFloor(1, 'doom_room')] }));
    w.enter();
    w.runUntilFinished();
    expect(w.entry().battleTimer.currentCombat!.result).toBe('defeat');

    w.leaveParty('bob');

    expect(logOf(w.session)).toContain(WIPED);
    expect(logOf(w.bob)).toContain(WIPED);
    expect(logOf(w.session)).not.toContain(RUN_ENDED);
    expect(w.runOf(w.partyId)).toBeNull();
    expect(fighters(w.entry())).toEqual(['alice']);
  });

  it('gives a lone player leaving the ordinary left line', async () => {
    const { pm, session, partyId, log, enter } = await setup();
    session.beginAway();
    enter();

    expect(pm.leaveParty('alice')).toBeNull();

    expect(log()).toContain('Left Chief Hall.');
    expect(log()).not.toContain(RUN_ENDED);
    expect(session.getAwayLedger()!.moments.map(m => m.kind)).not.toContain('run_ended');
    expect(session.getAwayLedger()!.dungeons.at(-1)).toMatchObject({ outcome: 'left' });
    expect(pm.partyBattles.getAllPartyIds()).not.toContain(partyId);
    const newParty = session.getPartyId()!;
    expect(pm.partyBattles.getDungeonRunInfo(newParty)).toBeNull();
    expect(pm.partyBattles.getPosition(newParty)).toEqual(ENTRANCE);

    expect(pm.partyBattles.enterDungeon(newParty, DUNGEON_ID).success).toBe(true);
    expect(pm.partyBattles.getDungeonRunInfo(newParty)).toMatchObject({ floor: 1 });
  });

  it('gives a lone player accepting an invite the left line too, and takes them into the new party', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    const carol = w.extras[0];
    const carolParty = carol.getPartyId()!;
    expect(w.pm.partyBattles.enterDungeon(carolParty, DUNGEON_ID).success).toBe(true);

    w.join('alice', 'carol');

    expect(logOf(carol)).toContain('Left Chief Hall.');
    expect(logOf(carol)).not.toContain(RUN_ENDED);
    expect(w.pm.partyBattles.getAllPartyIds()).not.toContain(carolParty);
    expect(carol.getPartyId()).toBe(w.partyId);
    expect(w.entry().members.has('carol')).toBe(true);
  });

  it('keeps the old party fighting when a member accepts another party\'s invite outside a dungeon', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    const battleId = w.entry().battleTimer.battleId;

    w.join('carol', 'bob');

    expect(w.pbm.entries.get(w.partyId)).toBeDefined();
    expect(w.entry().members).toEqual(new Set(['alice']));
    expect(w.entry().battleTimer.battleId).toBe(battleId);
    expect(w.bob.getPartyId()).toBe(w.extras[0].getPartyId());
    const ticks = w.entry().battleTimer.currentCombat!.tickCount;
    vi.advanceTimersByTime(FIRST_STEP_MS * 2);
    expect(w.entry().battleTimer.currentCombat!.tickCount).toBeGreaterThan(ticks);
  });

  it.each<[string, (w: Duo) => unknown]>([
    ['an accepted invite', w => w.join('carol', 'alice')],
    ['a plain leave', w => w.leaveParty('alice')],
  ])('tells those left behind by %s that the player has gone, and who owns the party now', async (_cause, act) => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    expect(w.pm.partyDeparture('alice')).toEqual({ partyId: w.partyId, others: ['bob'], wasOwner: true });
    const notify = vi.spyOn(w.pm.notify, 'notify').mockImplementation(() => {});
    const pushed = vi.spyOn(w.pm, 'sendStateToPlayer');
    const chat = chatTo(w.pm);

    act(w);

    expect(w.pm.parties.getParty(w.partyId)!.members.map(m => [m.username, m.role])).toEqual([['bob', 'owner']]);
    expect(notify).toHaveBeenCalledWith('bob', 'party_ownership_transferred', expect.objectContaining({ body: 'You became the new party owner.' }));
    expect(notify).toHaveBeenCalledWith('bob', 'party_member_left', expect.objectContaining({ body: 'alice left your party.', payload: { leftUsername: 'alice' } }));
    expect(pushed).toHaveBeenCalledWith('bob');
    expect(chat('bob')).toEqual(['party: alice left the party.', 'party: You became the new party owner.']);
    expect(chat('alice').at(-1)).toBe('server: You left your old party.');
  });

  it('tells the others by name who left, in party chat, even with default notification settings', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    w.join('alice', 'carol');
    const chat = chatTo(w.pm);

    w.leaveParty('carol');

    expect(chat('alice')).toEqual(['party: carol left the party.']);
    expect(chat('bob')).toEqual(['party: carol left the party.']);
  });

  it('names who left inside a run as well, beside the neutral run line', async () => {
    const w = await trioInRun();
    const chat = chatTo(w.pm);

    w.leaveParty('bob');

    expect(chat('alice')).toEqual(['party: bob left the party.']);
    expect(logOf(w.session)).toContain(RUN_ENDED);
  });

  it('gives an accepter their joined line, then says they left the old party', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    const chat = chatTo(w.pm);

    w.join('carol', 'bob');

    expect(chat('bob')).toEqual(['party: You joined the party.', 'server: You left your old party.']);
    expect(chat('carol')).toEqual(['party: bob joined the party.']);
    expect(chat('alice')).toEqual(['party: bob left the party.']);
  });

  it('names no new owner when a plain member accepts an invite, and has nobody to tell for a lone player', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    const carol = w.extras[0];
    expect(w.pm.partyDeparture('carol')).toBeNull();
    expect(w.pm.partyDeparture('bob')!.wasOwner).toBe(false);
    const notify = vi.spyOn(w.pm.notify, 'notify').mockImplementation(() => {});
    const chat = chatTo(w.pm);

    w.join('carol', 'bob');

    expect(notify).toHaveBeenCalledWith('alice', 'party_member_left', expect.objectContaining({ payload: { leftUsername: 'bob' } }));
    expect(notify).not.toHaveBeenCalledWith(expect.anything(), 'party_ownership_transferred', expect.anything());
    expect(carol.getPartyId()).toBe(w.bob.getPartyId());
    expect(chat('alice')).toEqual(['party: bob left the party.']);

    w.pm.leaveParty('alice');
    expect(chat('alice')).toEqual(['party: bob left the party.']);
  });

  it('notifies the joined party and pushes state to everyone in it', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    const notify = vi.spyOn(w.pm.notify, 'notify').mockImplementation(() => {});
    const pushed = vi.spyOn(w.pm, 'sendStateToPlayer');

    w.join('carol', 'bob');

    expect(notify).toHaveBeenCalledWith('carol', 'party_member_joined', expect.objectContaining({ body: 'bob joined your party.', payload: { joinedUsername: 'bob' } }));
    expect(notify).not.toHaveBeenCalledWith('bob', 'party_member_joined', expect.anything());
    expect(pushed).toHaveBeenCalledWith('carol');
    expect(pushed).toHaveBeenCalledWith('bob');
  });

  it('sends a joiner the fight they arrive in as a full snapshot, so a boss-tier monster is known to them', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    const carolWs = createFakeWs();
    await w.pm.login(carolWs, 'carol');
    const sent = carolWs.send as unknown as { mockClear(): void; mock: { calls: string[][] } };
    sent.mockClear();

    w.join('alice', 'carol');

    const full = sent.mock.calls.map(([raw]) => JSON.parse(raw)).filter(m => m.type === 'combat' && m.snapshot?.full);
    expect(full).toHaveLength(1);
    expect(full[0].battleId).toBe(w.entry().battleTimer.battleId);
  });

  it('refuses a join while a run stands, even with its dungeon missing, and keeps the invite for after', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    const carol = w.extras[0];
    const carolParty = carol.getPartyId();
    w.invite('alice', 'carol');
    w.enter();
    expect(w.pm.acceptPartyInvite('carol', w.partyId)).toBe('That party is in a dungeon right now.');

    w.holder.current = { ...makeDungeon(), id: 'another' };
    expect(w.runOf(w.partyId)).toBeNull();
    expect(w.pm.partyBattles.isInDungeonRun(w.partyId)).toBe(true);
    expect(w.pm.acceptPartyInvite('carol', w.partyId)).toBe('That party is in a dungeon right now.');
    expect(w.entry().members.has('carol')).toBe(false);
    expect(carol.getPartyId()).toBe(carolParty);

    w.pm.partyBattles.endOrphanedRuns();
    expect(w.pm.acceptPartyInvite('carol', w.partyId)).toBeNull();
    expect(carol.getPartyId()).toBe(w.partyId);
    expect(w.entry().members.has('carol')).toBe(true);
  });

  it('leaves a refused accept with the player where they were', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    const carol = w.extras[0];
    const carolParty = carol.getPartyId();

    expect(w.pm.acceptPartyInvite('carol', w.partyId)).toBe('Invite not found or expired');

    expect(carol.getPartyId()).toBe(carolParty);
    expect(w.pm.partyBattles.getMembers(carolParty!)).toEqual(new Set(['carol']));
  });

  it('treats a second accept of the invite just used as nothing to do', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    w.join('alice', 'carol');
    const chat = chatTo(w.pm);

    expect(w.pm.acceptPartyInvite('carol', w.partyId)).toBeNull();

    expect(chat('carol')).toEqual([]);
    expect(w.extras[0].getPartyId()).toBe(w.partyId);
  });

  it('kicks through the whole path: the line, the new solo party, the notice and the rosters', async () => {
    const w = await setupDuo(makeDungeon(), ['carol']);
    w.join('alice', 'carol');
    const notify = vi.spyOn(w.pm.notify, 'notify').mockImplementation(() => {});
    const pushed = vi.spyOn(w.pm, 'sendStateToPlayer');
    const chat = chatTo(w.pm);

    const carolParty = w.kick('alice', 'carol');

    expect(carolParty).not.toBe(w.partyId);
    expect(w.pm.partyBattles.getMembers(carolParty)).toEqual(new Set(['carol']));
    expect(w.entry().members).toEqual(new Set(['alice', 'bob']));
    expect(chat('bob')).toEqual(['party: carol was kicked from the party.']);
    expect(chat('carol')).toEqual(['server: You were kicked from the party.']);
    expect(notify).toHaveBeenCalledWith('carol', 'party_kicked', expect.objectContaining({ body: 'You were removed from your party.' }));
    for (const member of ['alice', 'bob', 'carol']) expect(pushed).toHaveBeenCalledWith(member);
  });

  it('refuses a kick from someone who may not, changing nothing', async () => {
    const w = await setupDuo();

    expect(w.pm.kickPartyMember('bob', 'alice')).toEqual(expect.any(String));

    expect(w.entry().members).toEqual(new Set(['alice', 'bob']));
  });

  it('announces a banned owner\'s departure and the new owner, and saves the run\'s end for those left', async () => {
    const w = await trioInRun();
    const notify = vi.spyOn(w.pm.notify, 'notify').mockImplementation(() => {});
    const chat = chatTo(w.pm);
    const store = createFakeStore();
    const save = store.saveAll as unknown as { mock: { calls: PlayerSaveData[][][] } };

    await w.pm.banPlayer('alice', store);

    expect(w.pm.parties.getParty(w.partyId)!.members.find(m => m.role === 'owner')!.username).toBe('bob');
    expect(chat('bob')).toEqual(['party: alice left the party.', 'party: You became the new party owner.']);
    expect(chat('carol')).toEqual(['party: alice left the party.', 'party: bob became the new party owner.']);
    expect(notify).toHaveBeenCalledWith('bob', 'party_ownership_transferred', expect.anything());

    const [frozen, after] = save.mock.calls.map(([saves]) => saves);
    expect(frozen.map(s => s.username).sort()).toContain('alice');
    expect(frozen.find(s => s.username === 'bob')!.dungeonRun).toBeTruthy();
    expect(after.map(s => s.username)).not.toContain('alice');
    for (const username of ['bob', 'carol']) expect(after.find(s => s.username === username)!.dungeonRun).toBeFalsy();
  });

  it('ignores removing a player who is not in the party', async () => {
    const w = await setupDuo();
    w.leaveParty('bob');
    w.enter();
    w.beatFloor();
    const battleId = w.entry().battleTimer.battleId;

    w.pm.partyBattles.removeMember(w.partyId, 'bob');

    expect(w.runOf(w.partyId)).toMatchObject({ floor: 2 });
    expect(w.entry().battleTimer.battleId).toBe(battleId);
    expect(logOf(w.session)).not.toContain(RUN_ENDED);
    expect(w.pm.partyBattles.getAllPartyIds()).toContain(w.partyId);
    expect(() => w.pm.partyBattles.removeMember('no-such-party', 'bob')).not.toThrow();
  });
});

describe('Old data keeps working', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('loads a save that still carries dungeonCheckpoints, ignores it and never writes it back', async () => {
    const { pm, grid, holder, newManager } = await setup();
    const old = {
      ...JSON.parse(JSON.stringify(pm.getAllSaveData()[0])),
      dungeonCheckpoints: { [DUNGEON_ID]: { floorIndex: 1, phase: 2, wipes: 1, rewardedPhases: ['0:1', '0:2'], at: Date.now() } },
    } as PlayerSaveData;

    const session = PlayerSession.fromSaveData(old, wrapGrids(grid), createFakeContentStore(holder));
    expect(session.toSaveData()).not.toHaveProperty('dungeonCheckpoints');

    const restarted = newManager();
    restarted.restoreFromSaveData([old]);
    expect(JSON.stringify(restarted.getAllSaveData())).not.toContain('dungeonCheckpoints');

    const partyId = restarted.getSessionByUsername('alice')!.getPartyId()!;
    expect(restarted.partyBattles.enterDungeon(partyId, DUNGEON_ID).success).toBe(true);
    expect(restarted.partyBattles.getDungeonRunInfo(partyId)).toMatchObject({ floor: 1 });
  });

  it('survives a malformed dungeonCheckpoints in an old save', async () => {
    const { pm, newManager } = await setup();
    const old = { ...JSON.parse(JSON.stringify(pm.getAllSaveData()[0])), dungeonCheckpoints: 'nonsense' } as PlayerSaveData;
    const restarted = newManager();
    restarted.restoreFromSaveData([old]);
    expect(restarted.getSessionByUsername('alice')).toBeDefined();
    expect(restarted.getAllSaveData()[0]).not.toHaveProperty('dungeonCheckpoints');
  });

  const OLD_RUN = { dungeonId: DUNGEON_ID, currentFloorIndex: 1, entrance: ENTRANCE, checkpointPhase: 2, wipes: 1, rewardedPhases: ['1:1', '1:2'] };

  it('restores a solo run saved with flags, retries and paid phases on its floor, at full boss HP, with those fields dropped', async () => {
    const dungeon = makeDungeon({ floors: [goblinFloor(1), bossFloor(2, 'court', OLD_FLOOR_FIELDS)] });
    const { pm, newManager } = await setup(dungeon);
    const old = { ...JSON.parse(JSON.stringify(pm.getAllSaveData()[0])), dungeonRun: OLD_RUN } as PlayerSaveData;

    const restarted = newManager();
    restarted.restoreFromSaveData([old]);

    const partyId = restarted.getSessionByUsername('alice')!.getPartyId()!;
    expect(restarted.partyBattles.getDungeonRunInfo(partyId)).toEqual({ dungeonId: DUNGEON_ID, name: 'Chief Hall', floor: 2, totalFloors: 2, isBossFloor: true });
    expect(restarted.partyBattles.getDungeonSaveData(partyId)).toEqual({ dungeonId: DUNGEON_ID, currentFloorIndex: 1, entrance: ENTRANCE });
    const entry = (restarted.partyBattles as unknown as PbmInternals).entries.get(partyId)!;
    const boss = entry.battleTimer.currentCombat!.monsters[0];
    expect(boss.id).toBe('chief');
    expect(boss.currentHp).toBe(boss.maxHp);
    expect(restarted.getAllSaveData()[0].dungeonRun).toEqual({ dungeonId: DUNGEON_ID, currentFloorIndex: 1, entrance: ENTRANCE });
  });

  it('restores such a run for a whole party, and a wipe there still ends it', async () => {
    const dungeon = makeDungeon({ floors: [goblinFloor(1), bossFloor(2)] });
    const w = await setupDuo(dungeon);
    w.enter();
    const saves = (JSON.parse(JSON.stringify(w.pm.getAllSaveData())) as PlayerSaveData[]).map(save => ({ ...save, dungeonRun: OLD_RUN }));

    const restarted = w.newManager();
    restarted.restoreFromSaveData(saves as PlayerSaveData[]);

    const partyId = restarted.getSessionByUsername('alice')!.getPartyId()!;
    expect(restarted.getSessionByUsername('bob')!.getPartyId()).toBe(partyId);
    const pbm = restarted.partyBattles as unknown as PbmInternals;
    const entry = pbm.entries.get(partyId)!;
    expect(entry.dungeonRun).toEqual({ dungeonId: DUNGEON_ID, currentFloorIndex: 1, entrance: ENTRANCE });
    expect(fighters(entry)).toEqual(['alice', 'bob']);

    pbm.handleDungeonDefeat(entry);
    expect(restarted.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
  });

  it('drops a run whose floor index is out of range or malformed', async () => {
    const { pm, partyId } = await setup();
    pm.partyBattles.restoreDungeonRun(partyId, { dungeonId: DUNGEON_ID, currentFloorIndex: 5, entrance: { col: 0, row: 0 } });
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
    pm.partyBattles.restoreDungeonRun(partyId, { dungeonId: DUNGEON_ID, currentFloorIndex: 0.5, entrance: { col: 0, row: 0 } });
    expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
  });

  it('round-trips a live run through a restart by floor index alone', async () => {
    const w = await setupDuo();
    w.enter();
    w.beatFloor();

    const restarted = w.newManager();
    restarted.restoreFromSaveData(JSON.parse(JSON.stringify(w.pm.getAllSaveData())) as PlayerSaveData[]);

    const partyId = restarted.getSessionByUsername('alice')!.getPartyId()!;
    expect(restarted.partyBattles.getDungeonRunInfo(partyId)).toMatchObject({ floor: 2 });
  });

  it('loads away ledgers with old moments and dungeon records, dropping the old moments and fields', async () => {
    const { pm, grid, holder } = await setup();
    const base = createAwayLedger('old', 1000, { level: 1, xpFrac: 0 });
    const oldLedger = {
      ...base,
      battles: 3,
      moments: [
        { at: 1200, kind: 'checkpoint', text: 'Reached checkpoint 1 of 2 in Chief Hall' },
        { at: 1300, kind: 'level_up', text: 'Reached level 2' },
      ],
      dungeons: [
        { dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'left', wipes: 2, checkpoint: 1 },
        { dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'ejected', wipes: 3 },
      ],
    };
    const saved = JSON.parse(JSON.stringify(pm.getAllSaveData()[0])) as PlayerSaveData;
    const restored = PlayerSession.fromSaveData(
      { ...saved, awayLedger: oldLedger, pendingRecap: { ...oldLedger, id: 'older' } } as unknown as PlayerSaveData,
      wrapGrids(grid),
      createFakeContentStore(holder),
    );

    for (const ledger of [restored.getAwayLedger()!, restored.getPendingRecap()!]) {
      expect(ledger.moments.map(m => m.kind)).toEqual(['level_up']);
      expect(ledger.dungeons).toEqual([
        { dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'left' },
        { dungeonId: DUNGEON_ID, name: 'Chief Hall', outcome: 'ejected' },
      ]);
      expect(topAwayMoments(ledger, 3).map(m => m.kind)).toEqual(['level_up']);
    }
    expect(JSON.stringify(restored.toSaveData())).not.toContain('checkpoint');
  });

  it('loads old log lines typed checkpoint as ordinary lines, keeping their ids', async () => {
    const { pm, grid, holder } = await setup();
    const saved = JSON.parse(JSON.stringify(pm.getAllSaveData()[0])) as PlayerSaveData;
    const oldLog = [
      { id: 4, text: 'Your party regroups at checkpoint 1 — 1 retry left.', type: 'checkpoint' },
      { id: 5, text: 'Victory!', type: 'victory' },
    ];

    const restored = PlayerSession.fromSaveData(
      { ...saved, combatLog: oldLog } as unknown as PlayerSaveData,
      wrapGrids(grid),
      createFakeContentStore(holder),
    );

    expect(restored.toSaveData().combatLog.slice(0, 2)).toEqual([
      { id: 4, text: oldLog[0].text, type: 'battle' },
      { id: 5, text: 'Victory!', type: 'victory' },
    ]);
    expect(restored.toSaveData().combatLog.map(l => l.type)).not.toContain('checkpoint');
  });

  it('runs a stored dungeon whose floors still carry the old fields exactly as floors in order', async () => {
    const dungeon = makeDungeon({ floors: [bossFloor(1, 'court', OLD_FLOOR_FIELDS), bossFloor(2, 'doom_room', { maxWipes: 9 })] });
    const { partyId, entry, boss, log, runOf, enter, winFight, nextFight, runUntilFinished } = await setup(dungeon);
    enter();
    expect(runOf(partyId)).toEqual({ dungeonId: DUNGEON_ID, name: 'Chief Hall', floor: 1, totalFloors: 2, isBossFloor: true });
    expect(boss(entry().battleTimer.currentCombat!).currentHp).toBe(30);

    winFight();
    expect(runOf(partyId)!.floor).toBe(2);
    nextFight();

    runUntilFinished();
    vi.advanceTimersByTime(KILL_BEAT_MS);
    expect(runOf(partyId)).toBeNull();
    expect(log()).toContain(WIPED);
  });
});
