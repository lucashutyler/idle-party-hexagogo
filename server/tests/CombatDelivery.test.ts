import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { HexGrid, HexTile, offsetToCube, DEFAULT_MAP_ID, STATE_LOG_TAIL, KILL_BEAT_MS } from '@idle-party-rpg/shared';
import type {
  DungeonDefinition,
  HenchmanDefinition,
  MonsterDefinition,
  ServerCombatMessage,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import { PlayerManager, COMBAT_BACKPRESSURE_BYTES } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';

const START_ID = 'tile-start';
const DUNGEON_ID = 'crypt';
const HENCH_ID = 'hench_sellsword';

const GOBLIN: MonsterDefinition = {
  id: 'goblin', name: 'Goblin', hp: 12, damage: 1, damageType: 'physical', xp: 5, goldMin: 1, goldMax: 1,
};

const HENCHMAN: HenchmanDefinition = {
  id: HENCH_ID, name: 'Grim the Sellsword', className: 'Knight', level: 3, maxHp: 80, baseDamage: 6, skillIds: [], emoji: '🗡️',
};

const DUNGEON: DungeonDefinition = {
  id: DUNGEON_ID,
  name: 'Crypt',
  floors: [
    { floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'goblins', weight: 1 }] },
    { floorNumber: 2, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'goblins', weight: 1 }] },
  ],
};

function createContent(): ContentStore {
  const startTile: WorldTileDefinition = {
    id: START_ID, mapId: DEFAULT_MAP_ID, col: 0, row: 0, type: 'town', zone: 'green_fields', name: 'Square', dungeonId: DUNGEON_ID,
  };
  const zone = { id: 'green_fields', displayName: 'Green Fields', encounterTable: [{ encounterId: 'goblins', weight: 1 }] };
  const encounters = { goblins: { id: 'goblins', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 } };
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: (id: string) => (id === 'goblin' ? GOBLIN : undefined),
    getAllMonsters: () => ({ goblin: GOBLIN }),
    getItem: () => undefined,
    getAllItems: () => ({}),
    getZone: () => zone,
    getAllZones: () => ({ green_fields: zone }),
    getAllEncounters: () => encounters,
    getTileById: (id: string) => (id === START_ID ? startTile : undefined),
    getAllShops: () => ({}),
    getShop: () => undefined,
    getHenchman: (id: string) => (id === HENCH_ID ? HENCHMAN : undefined),
    getAllHenchmen: () => ({ [HENCH_ID]: HENCHMAN }),
    getWorld: () => ({ tiles: [startTile], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
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
    getDungeon: (id: string) => (id === DUNGEON_ID ? DUNGEON : undefined),
    getAllDungeons: () => ({ [DUNGEON_ID]: DUNGEON }),
    ...fakeSkillContent(),
  } as unknown as ContentStore;
}

function createGrid(): HexGrid {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'town', 'green_fields', START_ID));
  grid.addTile(new HexTile(offsetToCube({ col: 1, row: 0 }), 'forest', 'green_fields', 'tile-other'));
  return grid;
}

function createAccounts(usernames: string[]): AccountStore {
  const accounts: Record<string, Account> = {};
  for (const u of usernames) accounts[u] = { username: u, email: `${u}@x.com`, deactivated: false } as unknown as Account;
  return {
    findByUsername: (u: string) => accounts[u] ?? null,
    getAllUsernames: () => usernames,
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    setDeactivated: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
}

function createStore(): GameStateStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    loadAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as GameStateStore;
}

interface FakeWs {
  readyState: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function createWs(): FakeWs {
  return { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn(), close: vi.fn(), on: vi.fn() };
}

function asWs(ws: FakeWs): WebSocket {
  return ws as unknown as WebSocket;
}

function sent(ws: FakeWs): { raw: string; msg: { type: string } }[] {
  return ws.send.mock.calls.map(c => ({ raw: c[0] as string, msg: JSON.parse(c[0] as string) }));
}

function combatMessages(ws: FakeWs): ServerCombatMessage[] {
  return sent(ws).map(s => s.msg).filter((m): m is ServerCombatMessage => m.type === 'combat');
}

function newManager(usernames: string[], content: ContentStore = createContent()): PlayerManager {
  return new PlayerManager(wrapGrids(createGrid()), content, new GuildStore(), createAccounts(usernames), createStore());
}

function contentWithGoblinDrops(): ContentStore {
  const looter: MonsterDefinition = { ...GOBLIN, drops: [{ itemId: 'gem', chance: 1 }] };
  const content = createContent() as unknown as Record<string, unknown>;
  content.getMonster = (id: string) => (id === 'goblin' ? looter : undefined);
  content.getAllMonsters = () => ({ goblin: looter });
  return content as unknown as ContentStore;
}

/** Replays a socket's combat messages the way the client's live log does: resyncs replace, streams append. */
function clientLiveLog(ws: FakeWs, resyncCalls: ReadonlySet<number>): string[] {
  let battleId = -1;
  let lines: string[] = [];
  ws.send.mock.calls.forEach((call, i) => {
    const msg = JSON.parse(call[0] as string) as { type: string };
    if (msg.type !== 'combat') return;
    const combat = msg as ServerCombatMessage;
    if (combat.battleId !== battleId) {
      battleId = combat.battleId;
      lines = [];
    }
    lines = resyncCalls.has(i) ? [...combat.log] : [...lines, ...combat.log];
  });
  return lines;
}

async function loginKnight(pm: PlayerManager, username: string, ws: FakeWs = createWs()): Promise<FakeWs> {
  const session = await pm.login(asWs(ws), username);
  session.setClass('Knight');
  pm.applyClassChange(username);
  return ws;
}

function joinParty(pm: PlayerManager, leader: string, joiner: string): void {
  const getPartyId = (u: string) => pm.getSessionByUsername(u)?.getPartyId() ?? null;
  const setPartyId = (u: string, id: string | null) => { pm.getSessionByUsername(u)?.setPartyId(id); };
  const partyId = getPartyId(leader)!;
  const oldPartyId = getPartyId(joiner);
  const invited = pm.parties.inviteToParty(leader, joiner, getPartyId, (a, b) => pm.areSameTile(a, b));
  if (invited !== true) throw new Error(String(invited));
  const accepted = pm.parties.acceptInvite(joiner, partyId, getPartyId, setPartyId, (a, b) => pm.areSameTile(a, b));
  if (typeof accepted === 'string') throw new Error(accepted);
  pm.handlePartyJoin(joiner, partyId, oldPartyId);
}

function timerOf(pm: PlayerManager, partyId: string): ServerBattleTimer {
  const entries = (pm.partyBattles as unknown as { entries: Map<string, { battleTimer: ServerBattleTimer }> }).entries;
  return entries.get(partyId)!.battleTimer;
}

function partyOf(pm: PlayerManager, username: string): string {
  return pm.getSessionByUsername(username)!.getPartyId()!;
}

function combatStringifyCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(c => (c[0] as { type?: string } | null)?.type === 'combat').length;
}

/** Step until the party's current fight has finished (kill beat pending). */
function runUntilFinished(pm: PlayerManager, partyId: string): void {
  for (let i = 0; i < 600; i++) {
    if (timerOf(pm, partyId).currentCombat?.finished) return;
    vi.advanceTimersByTime(100);
  }
  throw new Error('fight never finished');
}

function battleCount(pm: PlayerManager, username: string): number {
  return pm.getSessionByUsername(username)!.getState([]).battleCount;
}

function saveFor(username: string, over: Partial<PlayerSaveData> = {}): PlayerSaveData {
  return {
    username,
    battleCount: 0,
    combatLog: [],
    unlockedKeys: [START_ID],
    position: { col: 0, row: 0 },
    target: null,
    movementQueue: [],
    character: { className: 'Knight', level: 5, xp: 0 },
    ...over,
  };
}

describe('Combat delivery (PartyBattleManager ↔ PlayerManager)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('live stream', () => {
    it('serialises each flush once per party and sends the same payload to every online member', async () => {
      const pm = newManager(['alice', 'bob']);
      const aliceWs = await loginKnight(pm, 'alice');
      const bobWs = await loginKnight(pm, 'bob');
      joinParty(pm, 'alice', 'bob');
      pm.partyBattles.restartBattle(partyOf(pm, 'alice'));
      aliceWs.send.mockClear();
      bobWs.send.mockClear();

      const stringify = vi.spyOn(JSON, 'stringify');
      vi.advanceTimersByTime(3000);

      const aliceRaw = sent(aliceWs).filter(s => s.msg.type === 'combat').map(s => s.raw);
      const bobRaw = sent(bobWs).filter(s => s.msg.type === 'combat').map(s => s.raw);
      expect(aliceRaw.length).toBeGreaterThan(3);
      expect(bobRaw).toEqual(aliceRaw);
      expect(combatStringifyCount(stringify)).toBe(aliceRaw.length);
    });

    it('carries per-hit lines in combat messages and keeps them out of the journal', async () => {
      const pm = newManager(['alice']);
      const ws = await loginKnight(pm, 'alice');
      vi.advanceTimersByTime(20_000);

      const session = pm.getSessionByUsername('alice')!;
      const journal = session.getState([]).combatLog;
      expect(journal.some(e => e.type === 'damage')).toBe(false);
      expect(journal.some(e => e.text === 'Battle begins!')).toBe(false);
      expect(journal.some(e => e.text === 'Victory!')).toBe(true);
      expect(session.getState([]).battleCount).toBeGreaterThan(1);

      const liveLines = combatMessages(ws).flatMap(m => m.log);
      expect(liveLines.some(l => l.includes('alice'))).toBe(true);
      expect(liveLines.every(l => !journal.some(e => e.text === l))).toBe(true);
    });

    it('opens every battle with a full-snapshot combat message for its battle id', async () => {
      const pm = newManager(['alice']);
      const ws = await loginKnight(pm, 'alice');
      const partyId = partyOf(pm, 'alice');
      ws.send.mockClear();
      pm.partyBattles.restartBattle(partyId);

      const [first] = combatMessages(ws);
      const battleId = timerOf(pm, partyId).battleId;
      expect(first.battleId).toBe(battleId);
      expect(first.snapshot?.full).toBe(true);
      expect(first.snapshot?.battleId).toBe(battleId);
      expect(first.events).toEqual([]);
      expect(first.snapshot?.units.find(u => u.side === 'player')?.name).toBe('alice');
    });

    it('builds nothing for a party with nobody online', () => {
      const pm = newManager(['alice', 'bob']);
      const stringify = vi.spyOn(JSON, 'stringify');
      pm.restoreFromSaveData([
        saveFor('alice', { partyId: 'p1', partyRole: 'owner', partyGridPosition: 4 }),
        saveFor('bob', { partyId: 'p1', partyRole: 'member', partyGridPosition: 1 }),
      ]);
      vi.advanceTimersByTime(10_000);
      expect(combatStringifyCount(stringify)).toBe(0);
      expect(battleCount(pm, 'alice')).toBeGreaterThan(1);
    });

    it('builds nothing when every socket of every member has the combat view hidden', async () => {
      const pm = newManager(['alice']);
      const ws = await loginKnight(pm, 'alice');
      pm.setCombatView(asWs(ws), false);
      ws.send.mockClear();
      const stringify = vi.spyOn(JSON, 'stringify');
      vi.advanceTimersByTime(5000);
      expect(combatStringifyCount(stringify)).toBe(0);
      expect(combatMessages(ws)).toHaveLength(0);
    });
  });

  describe('per-socket delivery', () => {
    it('skips sockets whose combat view is hidden and resyncs one when it becomes visible again', async () => {
      const pm = newManager(['alice']);
      const shown = await loginKnight(pm, 'alice');
      const hidden = createWs();
      await pm.login(asWs(hidden), 'alice');
      pm.setCombatView(asWs(hidden), false);
      shown.send.mockClear();
      hidden.send.mockClear();

      vi.advanceTimersByTime(3000);
      expect(combatMessages(shown).length).toBeGreaterThan(0);
      expect(combatMessages(hidden)).toHaveLength(0);

      const partyId = partyOf(pm, 'alice');
      while (!timerOf(pm, partyId).isLive) vi.advanceTimersByTime(100);
      pm.setCombatView(asWs(hidden), true);
      const [resync] = combatMessages(hidden);
      expect(resync.snapshot?.full).toBe(true);
      expect(resync.events).toEqual([]);
      expect(resync.battleId).toBe(timerOf(pm, partyId).battleId);

      hidden.send.mockClear();
      pm.setCombatView(asWs(hidden), true);
      expect(combatMessages(hidden)).toHaveLength(0);
    });

    it('drops droppable combat messages for a congested socket but still delivers full snapshots', async () => {
      const pm = newManager(['alice']);
      const ws = await loginKnight(pm, 'alice');
      const partyId = partyOf(pm, 'alice');
      ws.bufferedAmount = COMBAT_BACKPRESSURE_BYTES + 1;
      ws.send.mockClear();

      vi.advanceTimersByTime(600);
      expect(combatMessages(ws)).toHaveLength(0);

      pm.partyBattles.restartBattle(partyId);
      const messages = combatMessages(ws);
      expect(messages).toHaveLength(1);
      expect(messages[0].snapshot?.full).toBe(true);

      ws.bufferedAmount = 0;
      vi.advanceTimersByTime(600);
      expect(combatMessages(ws).length).toBeGreaterThan(1);
    });

    it('never sends combat to a closed socket', async () => {
      const pm = newManager(['alice']);
      const ws = await loginKnight(pm, 'alice');
      ws.readyState = WebSocket.CLOSED;
      ws.send.mockClear();
      vi.advanceTimersByTime(3000);
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('resync', () => {
    it('sends the requesting socket a full snapshot plus the live log ring', async () => {
      const pm = newManager(['alice']);
      const ws = await loginKnight(pm, 'alice');
      const other = createWs();
      await pm.login(asWs(other), 'alice');
      const partyId = partyOf(pm, 'alice');
      vi.advanceTimersByTime(1500);
      while (!timerOf(pm, partyId).isLive) vi.advanceTimersByTime(100);
      ws.send.mockClear();
      other.send.mockClear();

      pm.sendCombatResync(asWs(ws));

      const resync = combatMessages(ws).at(-1)!;
      const timer = timerOf(pm, partyId);
      expect(resync).toEqual({
        type: 'combat',
        battleId: timer.battleId,
        snapshot: expect.objectContaining({ full: true, battleId: timer.battleId, elapsedMs: timer.currentCombat!.elapsedMs }),
        events: [],
        log: timer.recentLog,
      });
      expect(combatMessages(other).some(m => m.snapshot?.full)).toBe(false);
    });

    it('never makes the client show a line twice when a resync lands between flushes', async () => {
      const pm = newManager(['alice', 'bob']);
      const resyncing = await loginKnight(pm, 'alice');
      const streaming = await loginKnight(pm, 'bob');
      joinParty(pm, 'alice', 'bob');
      const partyId = partyOf(pm, 'alice');
      resyncing.send.mockClear();
      streaming.send.mockClear();
      pm.partyBattles.restartBattle(partyId);

      const resyncCalls = new Set<number>();
      for (let step = 0; step < 60; step++) {
        vi.advanceTimersByTime(100);
        if (!timerOf(pm, partyId).isLive) continue;
        pm.sendCombatResync(asWs(resyncing));
        resyncCalls.add(resyncing.send.mock.calls.length - 1);

        const shown = clientLiveLog(resyncing, resyncCalls);
        const reference = clientLiveLog(streaming, new Set());
        expect(shown).toEqual(reference.slice(reference.length - shown.length));
        expect(shown).toEqual(timerOf(pm, partyId).recentLog);
      }
      expect(resyncCalls.size).toBeGreaterThan(10);
    });

    it('sends nothing between battles or to a hidden socket', async () => {
      const pm = newManager(['alice']);
      const ws = await loginKnight(pm, 'alice');
      const partyId = partyOf(pm, 'alice');
      runUntilFinished(pm, partyId);
      vi.advanceTimersByTime(KILL_BEAT_MS);
      expect(timerOf(pm, partyId).currentState).toBe('result');
      ws.send.mockClear();
      pm.sendCombatResync(asWs(ws));
      expect(ws.send).not.toHaveBeenCalled();

      pm.partyBattles.restartBattle(partyId);
      pm.setCombatView(asWs(ws), false);
      ws.send.mockClear();
      pm.sendCombatResync(asWs(ws));
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('state messages', () => {
    it('embed a full snapshot of the live fight under battle.combat', async () => {
      const pm = newManager(['alice']);
      await loginKnight(pm, 'alice');
      const partyId = partyOf(pm, 'alice');
      vi.advanceTimersByTime(300);
      const battle = pm.partyBattles.getBattleState(partyId)!;
      expect(battle.combat?.full).toBe(true);
      expect(battle.combat?.battleId).toBe(timerOf(pm, partyId).battleId);
      expect(battle.duration).toBe(300);
    });

    it('carry only the last STATE_LOG_TAIL journal entries while saves keep the rest', async () => {
      const pm = newManager(['alice']);
      await loginKnight(pm, 'alice');
      const session = pm.getSessionByUsername('alice')!;
      for (let i = 0; i < STATE_LOG_TAIL + 50; i++) session.addLogEntry(`line ${i}`, 'move');

      const tail = session.getState([]).combatLog;
      expect(tail).toHaveLength(STATE_LOG_TAIL);
      expect(tail[tail.length - 1].text).toBe(`line ${STATE_LOG_TAIL + 49}`);
      expect(session.toSaveData().combatLog.length).toBeGreaterThan(STATE_LOG_TAIL + 49);
    });
  });

  describe('battle lifecycle wiring', () => {
    it('restores a party with every member, its dungeon floor and henchman in the very first fight', () => {
      const pm = newManager(['alice', 'bob']);
      pm.restoreFromSaveData([
        saveFor('alice', {
          partyId: 'p1', partyRole: 'owner', partyGridPosition: 4,
          partyHenchmen: [{ instanceId: 'h1', henchmanId: HENCH_ID, gridPosition: 0, mapId: DEFAULT_MAP_ID }],
        }),
        saveFor('bob', { partyId: 'p1', partyRole: 'member', partyGridPosition: 1 }),
      ]);

      const partyId = partyOf(pm, 'alice');
      const units = pm.partyBattles.getBattleState(partyId)!.combat!.units.filter(u => u.side === 'player');
      expect(units.map(u => u.name).sort()).toEqual(['Grim the Sellsword', 'alice', 'bob']);
      expect(battleCount(pm, 'alice')).toBe(1);
      expect(battleCount(pm, 'bob')).toBe(1);
    });

    it('restores a solo dungeon run with one battle on the saved floor, not a phantom overworld fight', () => {
      const pm = newManager(['alice']);
      pm.restoreFromSaveData([
        saveFor('alice', { dungeonRun: { dungeonId: DUNGEON_ID, currentFloorIndex: 1, entrance: { col: 0, row: 0 } } }),
      ]);
      const partyId = partyOf(pm, 'alice');
      expect(pm.partyBattles.getDungeonRunInfo(partyId)!.floor).toBe(2);
      expect(battleCount(pm, 'alice')).toBe(1);
      expect(pm.partyBattles.getBattleState(partyId)!.combat!.units.some(u => u.side === 'player' && u.name === 'alice')).toBe(true);
    });

    it('gives a brand-new character exactly one battle, already using the chosen class', async () => {
      const pm = newManager(['alice']);
      const ws = createWs();
      const session = await pm.login(asWs(ws), 'alice');
      ws.send.mockClear();
      session.setClass('Mage');
      pm.applyClassChange('alice');

      expect(session.getState([]).battleCount).toBe(1);
      const starts = combatMessages(ws).filter(m => m.snapshot?.full);
      expect(starts).toHaveLength(1);
      const me = starts[0].snapshot!.units.find(u => u.side === 'player' && u.name === 'alice');
      expect(me?.className).toBe('Mage');
    });

    it('restarts the fight when a character that already has a party changes class', async () => {
      const pm = newManager(['alice']);
      await loginKnight(pm, 'alice');
      const session = pm.getSessionByUsername('alice')!;
      const partyId = partyOf(pm, 'alice');
      const before = timerOf(pm, partyId).battleId;

      session.forceSetClass('Priest');
      pm.applyClassChange('alice');

      expect(timerOf(pm, partyId).battleId).not.toBe(before);
      expect(session.getState([]).battleCount).toBe(2);
    });

    it('pays out a won-but-unshown fight when a restart lands in the kill beat', async () => {
      const pm = newManager(['alice']);
      await loginKnight(pm, 'alice');
      const session = pm.getSessionByUsername('alice')!;
      const partyId = partyOf(pm, 'alice');
      runUntilFinished(pm, partyId);
      expect(timerOf(pm, partyId).currentCombat!.result).toBe('victory');
      const victories = () => session.getState([]).combatLog.filter(e => e.text === 'Victory!').length;
      expect(victories()).toBe(0);

      pm.partyBattles.restartBattle(partyId);
      expect(victories()).toBe(1);
      vi.advanceTimersByTime(KILL_BEAT_MS);
      expect(victories()).toBe(1);
    });

    it('pays out a won-but-unshown fight when the entry is destroyed (e.g. joining another party)', async () => {
      const pm = newManager(['alice']);
      await loginKnight(pm, 'alice');
      const session = pm.getSessionByUsername('alice')!;
      const partyId = partyOf(pm, 'alice');
      runUntilFinished(pm, partyId);
      pm.partyBattles.destroyEntry(partyId);
      expect(session.getState([]).combatLog.filter(e => e.text === 'Victory!')).toHaveLength(1);
    });

    it('pays the last member who leaves during the kill beat exactly once, loot included', async () => {
      const pm = newManager(['alice'], contentWithGoblinDrops());
      await loginKnight(pm, 'alice');
      const session = pm.getSessionByUsername('alice')!;
      const partyId = partyOf(pm, 'alice');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      runUntilFinished(pm, partyId);
      const victories = () => session.getState([]).combatLog.filter(e => e.text === 'Victory!').length;
      expect(victories()).toBe(0);

      pm.partyBattles.removeMember(partyId, 'alice');
      expect(victories()).toBe(1);
      expect(pm.partyBattles.getAllPartyIds()).not.toContain(partyId);

      vi.advanceTimersByTime(KILL_BEAT_MS + 5000);
      expect(victories()).toBe(1);
      expect(errors).not.toHaveBeenCalled();
    });

    it('pays a member who leaves a party during the kill beat, and the rest only once', async () => {
      const pm = newManager(['alice', 'bob'], contentWithGoblinDrops());
      await loginKnight(pm, 'alice');
      await loginKnight(pm, 'bob');
      joinParty(pm, 'alice', 'bob');
      const partyId = partyOf(pm, 'alice');
      pm.partyBattles.restartBattle(partyId);
      const victories = (u: string) => pm.getSessionByUsername(u)!.getState([]).combatLog.filter(e => e.text === 'Victory!').length;
      const before = { alice: victories('alice'), bob: victories('bob') };
      runUntilFinished(pm, partyId);
      expect(timerOf(pm, partyId).currentCombat!.result).toBe('victory');

      pm.partyBattles.removeMember(partyId, 'bob');
      vi.advanceTimersByTime(KILL_BEAT_MS);
      expect(victories('bob')).toBe(before.bob + 1);
      expect(victories('alice')).toBe(before.alice + 1);
    });

    it('settles a won fight against an emptied roster without throwing', async () => {
      const pm = newManager(['alice'], contentWithGoblinDrops());
      await loginKnight(pm, 'alice');
      const partyId = partyOf(pm, 'alice');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      runUntilFinished(pm, partyId);
      const entries = (pm.partyBattles as unknown as { entries: Map<string, { members: Set<string> }> }).entries;
      entries.get(partyId)!.members.clear();

      pm.partyBattles.destroyEntry(partyId);
      expect(errors).not.toHaveBeenCalled();
    });

    it('settles a pending floor clear before entering or leaving a dungeon', async () => {
      const pm = newManager(['alice']);
      await loginKnight(pm, 'alice');
      const partyId = partyOf(pm, 'alice');
      expect(pm.partyBattles.enterDungeon(partyId, DUNGEON_ID).success).toBe(true);
      runUntilFinished(pm, partyId);
      expect(pm.partyBattles.getDungeonRunInfo(partyId)!.floor).toBe(1);

      expect(pm.partyBattles.leaveDungeon(partyId)).toBe(true);
      const log = pm.getSessionByUsername('alice')!.getState([]).combatLog.map(e => e.text);
      expect(log.indexOf('Descending to floor 2 of 2...')).toBeGreaterThan(-1);
      expect(log.indexOf('Descending to floor 2 of 2...')).toBeLessThan(log.indexOf('Left Crypt.'));
      expect(pm.partyBattles.getDungeonRunInfo(partyId)).toBeNull();
    });

    it('enforces the Run gate in PartyBattleManager itself', async () => {
      const pm = newManager(['alice']);
      await loginKnight(pm, 'alice');
      const partyId = partyOf(pm, 'alice');
      expect(pm.partyBattles.canEscape(partyId)).toBe(false);
      expect(pm.partyBattles.escapeBattle(partyId)).toBe(false);
    });
  });
});
