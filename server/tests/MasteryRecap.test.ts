import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager, PRESENCE_GRACE_MS } from '../src/game/PlayerManager.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';
import {
  HexGrid,
  HexTile,
  offsetToCube,
  DEFAULT_MAP_ID,
  AWAY_MIN_MS,
  createMonsterInstance,
  createPartyCombatState,
  xpForNextLevel,
  recordAwayBattle,
} from '@idle-party-rpg/shared';
import type { MonsterDefinition, PartyCombatState, PartyGridPosition, ServerStateMessage, WorldTileDefinition } from '@idle-party-rpg/shared';
import WebSocket from 'ws';

const MONSTERS: Record<string, MonsterDefinition> = {
  goblin: { id: 'goblin', name: 'Goblin', hp: 10, damage: 1, damageType: 'physical', xp: 5, goldMin: 0, goldMax: 0 },
  wall: { id: 'wall', name: 'Wall', hp: 100, damage: 0, damageType: 'physical', xp: 7, goldMin: 0, goldMax: 0, passive: true },
  elder: { id: 'elder', name: 'Elder', hp: 10, damage: 1, damageType: 'physical', xp: 100, goldMin: 0, goldMax: 0, level: 1 },
  brute: { id: 'brute', name: 'Brute', hp: 10, damage: 1, damageType: 'physical', xp: 100, goldMin: 0, goldMax: 0 },
  chief: { id: 'chief', name: 'Chief', hp: 30, damage: 1, damageType: 'physical', xp: 50, goldMin: 0, goldMax: 0, tier: 'boss' },
};

function createFakeContentStore(): ContentStore {
  const startTile: WorldTileDefinition = { id: 'tile-start', mapId: DEFAULT_MAP_ID, col: 0, row: 0, type: 'plains', zone: 'meadow', name: 'Old Mill' };
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: (id: string) => MONSTERS[id],
    getItem: (id: string) => (id ? { id, name: id, rarity: id.startsWith('rare') ? 'rare' : 'common' } : undefined),
    getAllMonsters: () => MONSTERS,
    getAllItems: () => ({}),
    getZone: () => ({ id: 'meadow', displayName: 'Meadow', encounterTable: [], levelRange: [1, 1] }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({}),
    getTileById: (id: string) => (id === startTile.id ? startTile : undefined),
    getAllShops: () => ({}),
    getShop: () => undefined,
    getWorld: () => ({ tiles: [startTile], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpc: () => undefined,
    getAllQuests: () => ({}),
    getQuest: () => undefined,
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

type FakeWs = WebSocket & { send: ReturnType<typeof vi.fn> };

function createFakeWs(): FakeWs {
  return { readyState: 1, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as FakeWs;
}

function lastState(ws: FakeWs): ServerStateMessage | undefined {
  const states = ws.send.mock.calls
    .map(([payload]) => JSON.parse(payload as string) as { type: string })
    .filter((m): m is ServerStateMessage => m.type === 'state');
  return states[states.length - 1];
}

interface PbmInternals {
  entries: Map<string, { battleTimer: ServerBattleTimer }>;
  handleBattleEnd(partyId: string, result: 'victory' | 'defeat'): void;
}

async function setup(usernames = ['alice']) {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'plains', 'meadow', 'tile-start'));
  grid.addTile(new HexTile(offsetToCube({ col: 1, row: 0 }), 'plains', 'meadow', 'tile-east'));
  const content = createFakeContentStore();
  const grids = wrapGrids(grid);
  const pm = new PlayerManager(grids, content, new GuildStore(), createFakeAccountStore(usernames), createFakeStore());
  const ws = createFakeWs();
  const session = await pm.login(ws, 'alice');
  session.setClass('Knight');
  pm.ensureParty('alice');
  const partyId = session.getPartyId()!;
  const pbm = pm.partyBattles as unknown as PbmInternals;

  /** Pay out a victory over these monsters; `dead` lists the indices that were killed. */
  const win = (ids: string[], dead: number[] = ids.map((_, i) => i)) => {
    const monsters = ids.map((id, i) => createMonsterInstance(MONSTERS[id], i as PartyGridPosition));
    const combat: PartyCombatState = createPartyCombatState(pm.partyBattles.buildPartyCombatants(partyId), monsters);
    combat.monsters.forEach(m => {
      const index = monsters.findIndex(x => x.gridPosition === m.gridPosition);
      if (dead.includes(index)) m.currentHp = 0;
    });
    (pbm.entries.get(partyId)!.battleTimer as unknown as { combatState: PartyCombatState }).combatState = combat;
    pbm.handleBattleEnd(partyId, 'victory');
  };
  const lose = () => pbm.handleBattleEnd(partyId, 'defeat');
  const setLevel = (s: PlayerSession, level: number) => {
    (s as unknown as { character: { level: number } }).character.level = level;
  };
  return { pm, ws, session, partyId, pbm, content, grids, win, lose, setLevel };
}

describe('Kill mastery', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('credits only monsters that died and are not passive, while XP still counts every monster', async () => {
    const { session, win } = await setup();
    const xp0 = session.toSaveData().character!.xp;

    win(['goblin', 'wall', 'goblin'], [0]);

    expect(session.getMonsterKills()).toEqual({ goblin: 1 });
    expect(session.toSaveData().character!.xp).toBe(xp0 + 5 + 7 + 5);
  });

  it('logs a rank-up, feeds ranks into combat and fills the bestiary', async () => {
    const { pm, session, win } = await setup();
    for (let i = 0; i < 10; i++) win(['goblin']);
    win(['elder']);

    const log = session.toSaveData().combatLog;
    expect(log.filter(l => l.type === 'mastery').map(l => l.text)).toEqual(['Mastery rank 1: Goblin (+2% against them).']);
    expect(session.getCombatInfo().mastery).toEqual({ goblin: 1 });

    const bestiary = pm.buildBestiary('alice')!;
    expect(bestiary.type).toBe('bestiary');
    expect(bestiary.version).toBe(11);
    const goblin = bestiary.entries.find(e => e.monsterId === 'goblin')!;
    expect(goblin).toMatchObject({ name: 'Goblin', kills: 10, rank: 1, nextAt: 50, tier: 'trash' });
    expect(goblin.level).toBeUndefined();
    expect(goblin.levelDerived).toBeUndefined();
    expect(bestiary.entries.find(e => e.monsterId === 'elder')).toMatchObject({ level: 1, kills: 1, rank: 0, nextAt: 10 });

    const summary = session.getState([]).character!.mastery!;
    expect(summary).toMatchObject({ discovered: 2, mastered: 0, version: 11 });
    expect(summary.recent.map(e => e.monsterId)).toEqual(['elder', 'goblin']);
  });

  it('makes a recap moment of boss rank 1 but not of trash rank 1', async () => {
    const { pm, ws, session, win } = await setup();
    pm.setPresence(ws, false);
    for (let i = 0; i < 10; i++) win(['goblin']);
    win(['chief']);
    const ledger = session.getAwayLedger()!;
    expect(ledger.masteryUps.map(m => [m.monsterId, m.rankTo])).toEqual([['goblin', 1], ['chief', 1]]);
    expect(ledger.moments.filter(m => m.kind === 'mastery').map(m => m.monsterId)).toEqual(['chief']);
    expect(ledger.kills).toBe(11);
  });
});

describe('XP by level con', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('scales each member\'s share of an authored-level monster by their own con', async () => {
    const { pm, session, partyId, win, setLevel } = await setup(['alice', 'bob']);
    const bob = await pm.login(createFakeWs(), 'bob');
    bob.setClass('Mage');
    pm.partyBattles.addMember(partyId, 'bob');
    setLevel(session, 20);
    const xpOf = (s: PlayerSession) => s.toSaveData().character!.xp;
    const [alice0, bob0] = [xpOf(session), xpOf(bob)];

    win(['elder']);
    expect(xpOf(session) - alice0).toBe(Math.ceil((100 * 0.25) / 2));
    expect(xpOf(bob) - bob0).toBe(50);

    win(['brute']);
    expect(xpOf(session) - alice0).toBe(Math.ceil((100 * 0.25) / 2) + 50);
  });

  it('pays easy monsters three quarters', async () => {
    const { session, win, setLevel } = await setup();
    setLevel(session, 5);
    const xp0 = session.toSaveData().character!.xp;
    win(['elder']);
    expect(session.toSaveData().character!.xp - xp0).toBe(75);
  });
});

describe('While you were away', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('starts when the page is hidden and delivers a recap on return after five minutes', async () => {
    const { pm, ws, session, win, lose } = await setup();
    expect(session.isAway()).toBe(false);

    pm.setPresence(ws, false);
    expect(session.isAway()).toBe(true);
    win(['goblin']);
    win(['goblin']);
    lose();
    vi.setSystemTime(Date.now() + AWAY_MIN_MS);
    ws.send.mockClear();
    pm.setPresence(ws, true);

    expect(session.isAway()).toBe(false);
    const recap = lastState(ws)?.awayRecap;
    expect(recap).toMatchObject({ battles: 3, wins: 2, losses: 1, xp: 10, kills: 2, levelFrom: 1, levelTo: 1 });
    expect(recap!.until).toBeDefined();

    expect(pm.handleAckRecap('alice', 'not-it')).toBe(false);
    expect(session.getPendingRecap()).not.toBeNull();
    ws.send.mockClear();
    expect(pm.handleAckRecap('alice', recap!.id)).toBe(true);
    expect(session.getPendingRecap()).toBeNull();
    expect(lastState(ws)?.awayRecap).toBeUndefined();
  });

  it('drops a short absence and an absence with no fights', async () => {
    const { pm, ws, session, win } = await setup();
    pm.setPresence(ws, false);
    win(['goblin']);
    vi.setSystemTime(Date.now() + AWAY_MIN_MS - 1000);
    pm.setPresence(ws, true);
    expect(session.getPendingRecap()).toBeNull();

    pm.setPresence(ws, false);
    vi.setSystemTime(Date.now() + 2 * AWAY_MIN_MS);
    pm.setPresence(ws, true);
    expect(session.getPendingRecap()).toBeNull();
  });

  it('counts sockets without presence as visible after a grace and begins when the last socket closes', async () => {
    const { pm, ws, session } = await setup();
    const second = createFakeWs();
    await pm.login(second, 'alice');
    vi.advanceTimersByTime(PRESENCE_GRACE_MS);
    pm.setPresence(ws, false);
    expect(session.isAway()).toBe(false);

    pm.removeConnection(second);
    expect(session.isAway()).toBe(true);
    pm.removeConnection(ws);
    expect(session.isAway()).toBe(true);

    await pm.login(createFakeWs(), 'alice');
    expect(session.isAway()).toBe(true);
    vi.advanceTimersByTime(PRESENCE_GRACE_MS);
    expect(session.isAway()).toBe(false);
  });

  it('keeps the absence going when a hidden tab reconnects, until the page says it is shown', async () => {
    const { pm, ws, session, win } = await setup();
    pm.setPresence(ws, false);
    win(['goblin']);
    pm.removeConnection(ws);
    vi.setSystemTime(Date.now() + 20 * 60_000);

    const hidden = createFakeWs();
    await pm.login(hidden, 'alice');
    expect(session.getPendingRecap()).toBeNull();
    expect(session.isAway()).toBe(true);
    pm.setPresence(hidden, false);
    vi.advanceTimersByTime(PRESENCE_GRACE_MS);
    expect(session.getPendingRecap()).toBeNull();
    const battles = session.getAwayLedger()!.battles;
    expect(battles).toBeGreaterThanOrEqual(1);

    hidden.send.mockClear();
    pm.setPresence(hidden, true);
    expect(session.getPendingRecap()).toMatchObject({ battles });
    expect(lastState(hidden)?.awayRecap).toMatchObject({ battles });
  });

  it('folds a later absence into an unacknowledged recap under a new id', async () => {
    const { pm, ws, session, win } = await setup();
    pm.setPresence(ws, false);
    win(['goblin']);
    vi.setSystemTime(Date.now() + AWAY_MIN_MS);
    pm.setPresence(ws, true);
    const first = session.getPendingRecap()!;

    pm.setPresence(ws, false);
    win(['goblin']);
    win(['goblin']);
    vi.setSystemTime(Date.now() + AWAY_MIN_MS);
    pm.setPresence(ws, true);

    const merged = session.getPendingRecap()!;
    expect(merged.id).not.toBe(first.id);
    expect(merged.battles).toBe(3);
    expect(merged.since).toBe(first.since);
    expect(pm.handleAckRecap('alice', first.id)).toBe(false);
  });

  it('records level-ups, rare finds and loot lost to full stacks', async () => {
    const { pm, ws, session } = await setup();
    pm.setPresence(ws, false);
    session.addToInventory('common_rock', 99);
    const tile = new HexTile(offsetToCube({ col: 0, row: 0 }), 'plains', 'meadow', 'tile-start');
    session.handleVictory({ xp: xpForNextLevel(1), gold: 3, items: ['rare_blade', 'common_rock'] }, tile, { kills: 1 });

    const ledger = session.getAwayLedger()!;
    expect(ledger).toMatchObject({ gold: 3, itemsLost: 1, items: { rare: 1 } });
    expect(ledger.notableItems).toEqual([{ itemId: 'rare_blade', count: 1, rarity: 'rare' }]);
    expect(ledger.moments.map(m => m.kind).sort()).toEqual(['level_up', 'rare_item']);

    vi.setSystemTime(Date.now() + AWAY_MIN_MS);
    ws.send.mockClear();
    pm.setPresence(ws, true);
    const state = lastState(ws)!;
    expect(state.awayRecap!.levelTo).toBe(2);
    expect(Object.keys(state.awayRecapItemDefinitions ?? {})).toEqual(['rare_blade']);
  });

  it('counts auto-retreats through the party hook', async () => {
    const { pm, ws, session, partyId } = await setup();
    pm.setPresence(ws, false);
    pm.partyBattles.recordRetreat(partyId, { at: Date.now(), kind: 'relocate', from: 'Deep Woods', to: 'Old Mill', winPct: 31 });
    pm.partyBattles.recordRetreat(partyId, { at: Date.now(), kind: 'skip', from: 'Old Mill', winPct: 20 });
    const ledger = session.getAwayLedger()!;
    expect(ledger).toMatchObject({ retreats: 2, skips: 1 });
    expect(ledger.moments.map(m => m.kind)).toEqual(['relocate']);
  });

  it('does not open a ledger for a player without a character', async () => {
    const { pm } = await setup(['alice', 'carol']);
    const ws = createFakeWs();
    const carol = await pm.login(ws, 'carol');
    pm.setPresence(ws, false);
    expect(carol.isAway()).toBe(false);
  });
});

describe('Persistence of the new player state', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('round-trips kills, combat prefs, checkpoints, the open ledger and the pending recap', async () => {
    const { pm, ws, session, win, grids, content } = await setup();
    for (let i = 0; i < 3; i++) win(['goblin']);
    pm.handleSetCombatPrefs('alice', 40);
    session.setDungeonCheckpoint('hall', { floorIndex: 2, phase: 1, wipes: 2, rewardedPhases: ['2:1'], at: 1234 });
    pm.setPresence(ws, false);
    win(['goblin']);
    vi.setSystemTime(Date.now() + AWAY_MIN_MS);
    pm.setPresence(ws, true);
    pm.setPresence(ws, false);
    win(['goblin']);

    const saved = JSON.parse(JSON.stringify(session.toSaveData()));
    const restored = PlayerSession.fromSaveData(saved, grids, content);

    expect(restored.getMonsterKills()).toEqual({ goblin: 5 });
    expect(restored.getCombatInfo(4).mastery).toBeUndefined();
    expect(restored.getCombatPrefs()).toEqual({ autoRetreatBelowPct: 40 });
    expect(restored.getDungeonCheckpoint('hall')).toEqual({ floorIndex: 2, phase: 1, wipes: 2, rewardedPhases: ['2:1'], at: 1234 });
    expect(restored.getPendingRecap()).toEqual(session.getPendingRecap());
    expect(restored.isAway()).toBe(true);
    expect(restored.getAwayLedger()).toEqual(session.getAwayLedger());
  });

  it('restores defaults for absent or malformed fields', async () => {
    const { session, grids, content } = await setup();
    const saved = session.toSaveData();
    const restored = PlayerSession.fromSaveData({
      ...saved,
      monsterKills: { goblin: -3, wolf: 2.5, bandit: 4 } as Record<string, number>,
      combatPrefs: { autoRetreatBelowPct: 33 } as unknown as { autoRetreatBelowPct: 25 },
      dungeonCheckpoints: { hall: { floorIndex: -1 } } as never,
      awayLedger: { nonsense: true } as never,
      pendingRecap: undefined,
    }, grids, content);

    expect(restored.getMonsterKills()).toEqual({ bandit: 4 });
    expect(restored.getCombatPrefs()).toEqual({ autoRetreatBelowPct: 25 });
    expect(restored.getDungeonCheckpoints()).toEqual({});
    expect(restored.isAway()).toBe(false);
    expect(restored.getPendingRecap()).toBeNull();
  });

  it('rebuilds a partial or malformed saved ledger with safe defaults', async () => {
    const { session, grids, content } = await setup();
    const saved = session.toSaveData();
    const restored = PlayerSession.fromSaveData({
      ...saved,
      awayLedger: { id: 'x', since: 1 } as never,
      pendingRecap: {
        id: 'y', since: 1, battles: 'many', wins: -2, xp: Number.NaN, items: { rare: 2, bogus: 5, epic: 'x' },
        notableItems: [{ itemId: 'blade', count: 1, rarity: 'rare' }, { itemId: 7 }, null],
        masteryUps: 'nope', dungeons: [{ dungeonId: 'd', name: 'D', outcome: 'exploded', wipes: 1 }],
        retreatLog: [{ at: 5, kind: 'skip', from: 'Here', winPct: 250 }], moments: [{ at: 1, kind: 'party', text: 'x' }],
        routeStopped: { at: 'soon' }, closestCall: { hpPct: 3, vs: 'Ogre', where: 'Den' },
      } as never,
    }, grids, content);

    const ledger = restored.getAwayLedger()!;
    expect(ledger).toMatchObject({ id: 'x', since: 1, battles: 0, levelFrom: 1, levelTo: 1, items: {}, masteryUps: [], moments: [] });
    expect(() => restored.recordKills([{ id: 'chief', name: 'Chief', tier: 'boss' }])).not.toThrow();
    restored.recordAway(l => recordAwayBattle(l, { won: true, xp: 3, kills: 1 }));
    expect(restored.getAwayLedger()).toMatchObject({ battles: 1, wins: 1, xp: 3, kills: 1 });
    expect(restored.getAwayLedger()!.masteryUps.map(m => m.monsterId)).toEqual(['chief']);

    expect(restored.getPendingRecap()).toEqual({
      id: 'y', since: 1, battles: 0, wins: 0, losses: 0, retreats: 0, skips: 0, xp: 0, gold: 0,
      levelFrom: 1, levelTo: 1, xpFracFrom: 0, xpFracTo: 0, items: { rare: 2 },
      notableItems: [{ itemId: 'blade', count: 1, rarity: 'rare' }], itemsLost: 0, kills: 0, masteryUps: [], dungeons: [],
      retreatLog: [{ at: 5, kind: 'skip', from: 'Here', winPct: 100 }], moments: [],
      closestCall: { hpPct: 3, vs: 'Ogre', where: 'Den' },
    });
  });

  it('counts kills of monsters whose ids are built-in object keys', async () => {
    const { session, grids, content } = await setup();
    session.recordKills([{ id: 'constructor', name: 'Odd', tier: 'trash' }, { id: '__proto__', name: 'Odder', tier: 'trash' }]);
    session.recordKills([{ id: 'constructor', name: 'Odd', tier: 'trash' }]);
    expect(Object.entries(session.getMonsterKills()).sort()).toEqual([['__proto__', 1], ['constructor', 2]]);
    expect(session.getMasterySummary().version).toBe(3);

    const restored = PlayerSession.fromSaveData(JSON.parse(JSON.stringify(session.toSaveData())), grids, content);
    expect(Object.entries(restored.getMonsterKills()).sort()).toEqual([['__proto__', 1], ['constructor', 2]]);
    restored.recordKills([{ id: 'toString', name: 'Odd', tier: 'trash' }]);
    expect(restored.getMonsterKills().toString).toBe(1);
  });

  it('gives the mastery bonus against monsters whose ids are built-in object keys', async () => {
    const { session } = await setup();
    for (let i = 0; i < 10; i++) session.recordKills([{ id: '__proto__', name: 'Odder', tier: 'trash' }]);
    const mastery = session.getCombatInfo().mastery!;
    expect(Object.entries(mastery)).toEqual([['__proto__', 1]]);
    expect(mastery.constructor).toBeUndefined();
  });

  it('defaults auto-retreat to 25 % and sends the owner\'s change in state', async () => {
    const { pm, ws, session } = await setup();
    expect(session.getCombatPrefs()).toEqual({ autoRetreatBelowPct: 25 });
    ws.send.mockClear();
    expect(pm.handleSetCombatPrefs('alice', 60)).toBe(true);
    expect(lastState(ws)?.character?.combatPrefs).toEqual({ autoRetreatBelowPct: 60 });
    expect(pm.handleSetCombatPrefs('alice', 60)).toBe(false);
  });

  it('master reset clears kills, checkpoints and recaps but keeps combat prefs', async () => {
    const { pm, ws, session, win } = await setup();
    win(['goblin']);
    pm.handleSetCombatPrefs('alice', 0);
    session.setDungeonCheckpoint('hall', { floorIndex: 0, phase: 1, wipes: 0, rewardedPhases: [], at: Date.now() });
    pm.setPresence(ws, false);
    win(['goblin']);
    vi.setSystemTime(Date.now() + AWAY_MIN_MS);
    pm.setPresence(ws, true);
    pm.setPresence(ws, false);
    expect(session.getPendingRecap()).not.toBeNull();

    pm.masterReset();

    expect(session.getMonsterKills()).toEqual({});
    expect(session.getDungeonCheckpoints()).toEqual({});
    expect(session.getPendingRecap()).toBeNull();
    expect(session.getAwayLedger()?.battles ?? 0).toBe(0);
    expect(session.getCombatPrefs()).toEqual({ autoRetreatBelowPct: 0 });
  });

  it('master reset reopens the ledger of a player who is offline', async () => {
    const { pm, ws, session } = await setup();
    pm.removeConnection(ws);
    expect(session.isAway()).toBe(true);

    pm.masterReset();

    expect(session.isAway()).toBe(true);
    expect(session.getAwayLedger()!.battles).toBe(0);
  });

  it('opens a ledger at boot for a restored character with none saved', async () => {
    const { session, grids, content } = await setup();
    const saved = { ...session.toSaveData(), awayLedger: null, pendingRecap: null };
    const pm = new PlayerManager(grids, content, new GuildStore(), createFakeAccountStore(['alice']), createFakeStore());
    pm.restoreFromSaveData([saved]);
    expect(pm.getSessionByUsername('alice')!.isAway()).toBe(true);
  });
});
