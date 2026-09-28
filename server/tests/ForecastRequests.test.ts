import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_MAP_ID } from '@idle-party-rpg/shared';
import type { DungeonDefinition, DungeonForecastInput, HenchmanDefinition, HiredHenchman, ServerForecastMessage, PartyCombatState, CombatEvent } from '@idle-party-rpg/shared';
import { FORECAST_REQUESTS_PER_WINDOW } from '../src/game/ForecastService.js';
import { LIVE_FORECAST_DEBOUNCE_MS } from '../src/game/PartyBattleManager.js';
import type { CombatFlush } from '../src/game/ServerBattleTimer.js';
import { START, createWs, forecastMessages, forecastWorld, joinAlice, tileId } from './forecastFixture.js';

const PIT: DungeonDefinition = {
  id: 'pit',
  name: 'The Pit',
  floors: [
    {
      floorNumber: 1,
      gridShape: { cols: 3, rows: 3 },
      encounterTable: [{ encounterId: 'warlord_court', weight: 1 }],
      isBoss: true,
      checkpoints: [0.66, 0.33],
    },
  ],
};

function replies() {
  const sent: ServerForecastMessage[] = [];
  return { sent, reply: (m: ServerForecastMessage) => { sent.push(m); } };
}

describe('request_forecast', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('answers pending, then the result, echoing the target', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const target = { kind: 'room' as const, tileId: tileId(START.col, START.row) };
    const { sent, reply } = replies();
    w.pm.handleForecastRequest('alice', target, reply);
    expect(sent).toEqual([{ type: 'forecast', target, key: w.roomKey(target.tileId), result: null, status: 'pending' }]);
    vi.advanceTimersByTime(50);
    expect(sent[1]).toMatchObject({ type: 'forecast', target, key: w.roomKey(target.tileId), status: 'ok' });
    expect(sent[1].result?.partyKey).toBe(w.pm.partyBattles.forecastKey(w.partyId));

    const again = replies();
    w.pm.handleForecastRequest('alice', target, again.reply);
    expect(again.sent).toEqual([{ type: 'forecast', target, key: w.roomKey(target.tileId), result: sent[1].result, status: 'ok' }]);
  });

  it('forecasts the room as fought: its own table, else its zone', async () => {
    const w = await forecastWorld({ encounters: { '2,1': 'brutes' } });
    w.pm.partyBattles.setForecaster(w.svc);
    expect(w.pm.partyBattles.resolveEncounterTable(tileId(2, 1))).toEqual([{ encounterId: 'brutes', weight: 1 }]);
    expect(w.pm.partyBattles.resolveEncounterTable('elsewhere')).toEqual([{ encounterId: 'ogres', weight: 1 }]);
    w.pm.handleForecastRequest('alice', { kind: 'room', tileId: tileId(2, 1) }, () => {});
    const job = w.stub.jobs.find(j => j.key.endsWith(`room:${tileId(2, 1)}`))!;
    expect(job.input).toMatchObject({ kind: 'room', table: [{ encounterId: 'brutes', weight: 1 }] });
  });

  it('denies rooms the player has not found or that are on another map', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const far = tileId(3, 2);
    expect(w.session.isTileIdUnlocked(far)).toBe(false);
    for (const id of [far, 'elsewhere', 'no-such-room']) {
      const { sent, reply } = replies();
      w.pm.handleForecastRequest('alice', { kind: 'room', tileId: id }, reply);
      expect(sent).toEqual([{ type: 'forecast', target: { kind: 'room', tileId: id }, key: '', result: null, status: 'denied' }]);
    }
    expect(w.stub.jobs).toEqual([]);
  });

  it('denies a dungeon whose entrance the player has not found', async () => {
    const w = await forecastWorld({ dungeon: { def: PIT, at: '3,2' } });
    w.pm.partyBattles.setForecaster(w.svc);
    const { sent, reply } = replies();
    w.pm.handleForecastRequest('alice', { kind: 'dungeon', dungeonId: 'pit' }, reply);
    w.pm.handleForecastRequest('alice', { kind: 'dungeon', dungeonId: 'nowhere' }, reply);
    expect(sent.map(m => m.status)).toEqual(['denied', 'denied']);
  });

  it("starts a dungeon forecast from the requester's checkpoint", async () => {
    const w = await forecastWorld({ dungeon: { def: PIT, at: `${START.col},${START.row}` } });
    w.pm.partyBattles.setForecaster(w.svc);
    const { sent, reply } = replies();
    w.pm.handleForecastRequest('alice', { kind: 'dungeon', dungeonId: 'pit' }, reply);
    expect(sent[0].status).toBe('pending');
    expect(sent[0].key.endsWith('|dungeon:pit:0:0:0')).toBe(true);

    w.session.setDungeonCheckpoint('pit', { floorIndex: 0, phase: 2, wipes: 1, rewardedPhases: [], at: Date.now() });
    const resumed = replies();
    w.pm.handleForecastRequest('alice', { kind: 'dungeon', dungeonId: 'pit' }, resumed.reply);
    expect(resumed.sent[0].key.endsWith('|dungeon:pit:0:2:1')).toBe(true);
    const job = w.stub.jobs.find(j => j.key === resumed.sent[0].key)!;
    const input = job.input as DungeonForecastInput;
    expect(input.start).toEqual({ floorIndex: 0, phase: 2, wipes: 1 });
    expect(input.fallbackTable).toEqual([{ encounterId: 'ogres', weight: 1 }]);
    vi.advanceTimersByTime(50);
    expect(resumed.sent[1]).toMatchObject({ status: 'ok', target: { kind: 'dungeon', dungeonId: 'pit' } });
  });

  it("starts a member's dungeon forecast from the owner's progress, since the owner or a leader takes the party in", async () => {
    const w = await forecastWorld({ dungeon: { def: PIT, at: `${START.col},${START.row}` } });
    w.pm.partyBattles.setForecaster(w.svc);
    await joinAlice(w, 'bob', 'Priest');
    const bob = w.pm.getSessionByUsername('bob')!;
    bob.setDungeonCheckpoint('pit', { floorIndex: 0, phase: 2, wipes: 1, rewardedPhases: [], at: Date.now() });
    const ask = (username: string): string => {
      const { sent, reply } = replies();
      w.pm.handleForecastRequest(username, { kind: 'dungeon', dungeonId: 'pit' }, reply);
      return sent[0].key;
    };

    expect(ask('bob').endsWith('|dungeon:pit:0:0:0')).toBe(true);
    w.session.setDungeonCheckpoint('pit', { floorIndex: 0, phase: 1, wipes: 0, rewardedPhases: [], at: Date.now() });
    expect(ask('bob').endsWith('|dungeon:pit:0:1:0')).toBe(true);
    expect(ask('alice').endsWith('|dungeon:pit:0:1:0')).toBe(true);

    const getPartyId = (u: string) => w.pm.getSessionByUsername(u)?.getPartyId() ?? null;
    expect(w.pm.parties.promoteLeader('alice', 'bob', getPartyId)).toBe(true);
    expect(ask('bob').endsWith('|dungeon:pit:0:2:1')).toBe(true);
  });

  it('forecasts a dungeon without hired henchmen, since they cannot go in', async () => {
    const w = await forecastWorld({ dungeon: { def: PIT, at: `${START.col},${START.row}` } });
    w.pm.partyBattles.setForecaster(w.svc);
    const sellsword: HenchmanDefinition = {
      id: 'sellsword', name: 'Grim', className: 'Knight', level: 3, maxHp: 80, baseDamage: 6, skillIds: [], emoji: 'x',
    };
    (w.content as unknown as { getHenchman: (id: string) => HenchmanDefinition | undefined }).getHenchman = id => (id === sellsword.id ? sellsword : undefined);
    const hired: HiredHenchman = { instanceId: 'h1', henchmanId: sellsword.id, gridPosition: 1, mapId: DEFAULT_MAP_ID };
    w.pm.partyBattles.setHenchmenCallbacks(() => [hired], () => []);
    expect(w.pm.partyBattles.buildPartyCombatants(w.partyId).some(p => p.isHenchman)).toBe(true);

    const { sent, reply } = replies();
    w.pm.handleForecastRequest('alice', { kind: 'dungeon', dungeonId: 'pit' }, reply);
    const input = w.stub.jobs.find(j => j.key === sent[0].key)!.input as DungeonForecastInput;
    expect(input.players.map(p => p.username)).toEqual(['alice']);
    expect(input.players.some(p => p.isHenchman)).toBe(false);
  });

  it("drops a player's older request when they ask for something else", async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const a = { kind: 'room' as const, tileId: tileId(START.col, START.row) };
    const b = { kind: 'room' as const, tileId: tileId(2, 1) };
    const first = replies();
    const second = replies();
    w.pm.handleForecastRequest('alice', a, first.reply);
    w.pm.handleForecastRequest('alice', b, second.reply);
    expect(first.sent.map(m => m.status)).toEqual(['pending', 'unavailable']);
    expect(w.svc.queued).toBe(1);
    vi.advanceTimersByTime(50);
    expect(second.sent.map(m => m.status)).toEqual(['pending', 'ok']);
    expect(w.svc.get(w.roomKey(a.tileId))).toBeNull();
  });

  it('allows 20 requests a minute per player, then answers unavailable', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const { sent, reply } = replies();
    const target = { kind: 'room' as const, tileId: tileId(START.col, START.row) };
    for (let i = 0; i < FORECAST_REQUESTS_PER_WINDOW + 1; i++) w.pm.handleForecastRequest('alice', target, reply);
    const last = sent[sent.length - 1];
    expect(last).toEqual({ type: 'forecast', target, key: '', result: null, status: 'unavailable' });
    expect(sent.filter(m => m.status === 'unavailable')).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    const later = replies();
    w.pm.handleForecastRequest('alice', target, later.reply);
    expect(later.sent[0].status).toBe('ok');
  });

  it('is unavailable without a forecaster', async () => {
    const w = await forecastWorld();
    const { sent, reply } = replies();
    w.pm.handleForecastRequest('alice', { kind: 'room', tileId: tileId(START.col, START.row) }, reply);
    expect(sent.map(m => m.status)).toEqual(['unavailable']);
  });

  it('a content change makes cached forecasts stale', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const target = { kind: 'room' as const, tileId: tileId(START.col, START.row) };
    w.pm.handleForecastRequest('alice', target, () => {});
    vi.advanceTimersByTime(50);
    w.contentState.contentEpoch++;
    const { sent, reply } = replies();
    w.pm.handleForecastRequest('alice', target, reply);
    expect(sent[0].status).toBe('pending');
    expect(w.stub.jobs.filter(j => j.key.endsWith(`room:${target.tileId}`))).toHaveLength(2);
  });
});

describe('live battle forecasts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('pushes a forecast of an elite fight to the players watching it', async () => {
    const w = await forecastWorld({ defaultEncounter: 'brutes' });
    w.pm.partyBattles.setForecaster(w.svc);
    w.entry().battleTimer.restartBattle();
    const battleId = w.entry().battleTimer.battleId;
    vi.advanceTimersByTime(50);
    const live = forecastMessages(w.ws).filter(m => m.target.kind === 'battle');
    expect(live.map(m => m.status)).toEqual(['pending', 'ok']);
    expect(live.every(m => m.target.battleId === battleId)).toBe(true);
    expect(live[1].key).toBe(`battle:${battleId}:0`);
    expect(w.svc.get(live[1].key)).toBeNull();
    expect(w.stub.jobs.find(j => j.key === live[1].key)?.input).toMatchObject({ kind: 'battle', henchmenAllowed: true });
  });

  it('sends live forecasts only to sockets showing the battle', async () => {
    const w = await forecastWorld({ defaultEncounter: 'brutes' });
    w.pm.partyBattles.setForecaster(w.svc);
    const mapTab = createWs();
    await w.pm.login(mapTab as never, 'alice');
    w.pm.setCombatView(mapTab as never, false);
    const bobWs = await joinAlice(w, 'bob', 'Priest');
    w.pm.setCombatView(bobWs as never, false);

    w.entry().battleTimer.restartBattle();
    const battleId = w.entry().battleTimer.battleId;
    vi.advanceTimersByTime(50);
    const forThisFight = (ws: typeof w.ws) => forecastMessages(ws).filter(m => m.target.battleId === battleId).map(m => m.status);
    expect(forThisFight(w.ws)).toEqual(['pending', 'ok']);
    expect(forThisFight(mapTab)).toEqual([]);
    expect(forThisFight(bobWs)).toEqual([]);
  });

  it('skips trash fights and fights nobody is watching', async () => {
    const trash = await forecastWorld();
    trash.pm.partyBattles.setForecaster(trash.svc);
    trash.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(50);
    expect(forecastMessages(trash.ws).filter(m => m.target.kind === 'battle')).toEqual([]);

    const unseen = await forecastWorld({ defaultEncounter: 'brutes' });
    unseen.pm.partyBattles.setForecaster(unseen.svc);
    unseen.pm.setCombatView(unseen.ws as never, false);
    unseen.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(50);
    expect(unseen.stub.jobs.filter(j => j.key.startsWith('battle:'))).toEqual([]);
  });

  it('drops a live result once its fight is over', async () => {
    const w = await forecastWorld({ defaultEncounter: 'frail_brutes' });
    w.pm.partyBattles.setForecaster(w.svc);
    w.stub.gated.add('battle:');
    w.entry().battleTimer.restartBattle();
    const battleId = w.entry().battleTimer.battleId;
    for (let i = 0; i < 100 && w.entry().battleTimer.isFighting(battleId); i++) vi.advanceTimersByTime(100);
    expect(w.entry().battleTimer.isFighting(battleId)).toBe(false);
    w.stub.gated.clear();
    vi.advanceTimersByTime(30);
    const mine = forecastMessages(w.ws).filter(m => m.target.battleId === battleId);
    expect(mine.map(m => m.status)).toEqual(['pending']);
  });

  it('withdraws a live forecast once its fight ends, a calmer fight starts or the party is gone', async () => {
    const w = await forecastWorld({ defaultEncounter: 'frail_brutes' });
    w.pm.partyBattles.setForecaster(w.svc);
    w.pm.handleSetCombatPrefs('alice', 0);
    w.stub.gated.add('battle:');
    w.entry().battleTimer.restartBattle();
    const battleId = w.entry().battleTimer.battleId;
    expect(w.svc.queued).toBe(1);
    for (let i = 0; i < 100 && w.entry().battleTimer.isFighting(battleId); i++) vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(1000);
    expect(w.svc.queued).toBe(0);

    for (const t of w.tiles) t.encounterTable = [{ encounterId: 'brutes', weight: 1 }];
    w.entry().battleTimer.restartBattle();
    expect(w.svc.queued).toBe(1);
    for (const t of w.tiles) t.encounterTable = [{ encounterId: 'ogres', weight: 1 }];
    w.entry().battleTimer.restartBattle();
    expect(w.svc.queued).toBe(0);

    for (const t of w.tiles) t.encounterTable = [{ encounterId: 'brutes', weight: 1 }];
    w.entry().battleTimer.restartBattle();
    expect(w.svc.queued).toBe(1);
    w.pm.partyBattles.destroyEntry(w.partyId);
    expect(w.svc.queued).toBe(0);
  });

  it('a newer fight replaces the older one\'s queued forecast', async () => {
    const w = await forecastWorld({ defaultEncounter: 'brutes' });
    w.pm.partyBattles.setForecaster(w.svc);
    w.stub.gated.add('battle:');
    w.entry().battleTimer.restartBattle();
    const first = w.entry().battleTimer.battleId;
    w.entry().battleTimer.restartBattle();
    const second = w.entry().battleTimer.battleId;
    w.stub.gated.clear();
    vi.advanceTimersByTime(50);
    const statuses = (id: number) => forecastMessages(w.ws).filter(m => m.target.battleId === id).map(m => m.status);
    expect(statuses(first)).toEqual(['pending']);
    expect(statuses(second)).toEqual(['pending', 'ok']);
  });

  it('re-forecasts a few seconds after a party member falls or a checkpoint is reached', async () => {
    const w = await forecastWorld({ defaultEncounter: 'brutes' });
    w.pm.partyBattles.setForecaster(w.svc);
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(2000);
    const battleId = w.entry().battleTimer.battleId;
    const combat = w.entry().battleTimer.currentCombat as PartyCombatState;
    const watch = (events: Partial<CombatEvent>[]) => (w.pm.partyBattles as unknown as {
      watchLiveForecastTriggers(partyId: string, flush: CombatFlush): void;
    }).watchLiveForecastTriggers(w.partyId, { battleId, combat, events: events as CombatEvent[], log: [], snapshot: null });
    const liveJobs = () => w.stub.jobs.filter(j => j.key.startsWith(`battle:${battleId}:`)).map(j => j.key);

    watch([{ id: 1, t: 0, kind: 'death', dst: { side: 'monster', pos: 4 } }]);
    vi.advanceTimersByTime(LIVE_FORECAST_DEBOUNCE_MS + 100);
    expect(liveJobs()).toEqual([`battle:${battleId}:0`]);

    watch([{ id: 2, t: 0, kind: 'death', dst: { side: 'player', pos: 4 } }]);
    watch([{ id: 3, t: 0, kind: 'phase', amount: 1 }]);
    vi.advanceTimersByTime(LIVE_FORECAST_DEBOUNCE_MS - 200);
    expect(liveJobs()).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(liveJobs()).toHaveLength(2);
    const at = Number(liveJobs()[1].split(':')[2]);
    expect(at).toBeGreaterThan(2000 + LIVE_FORECAST_DEBOUNCE_MS);
    expect(at).toBeLessThanOrEqual(combat.elapsedMs);
  });
});

describe('live forecasts for viewers who arrive mid-fight', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('re-sends the latest result to a socket that connects or opens the battle view', async () => {
    const w = await forecastWorld({ defaultEncounter: 'brutes' });
    w.pm.partyBattles.setForecaster(w.svc);
    w.entry().battleTimer.restartBattle();
    const battleId = w.entry().battleTimer.battleId;
    vi.advanceTimersByTime(50);
    const delivered = forecastMessages(w.ws).find(m => m.target.battleId === battleId && m.status === 'ok')!;

    const reload = createWs();
    await w.pm.login(reload as never, 'alice');
    w.pm.sendCombatResync(reload as never);
    expect(forecastMessages(reload)).toEqual([{ type: 'forecast', target: { kind: 'battle', battleId }, key: delivered.key, result: delivered.result, status: 'ok' }]);

    w.pm.setCombatView(reload as never, false);
    w.pm.setCombatView(reload as never, true);
    expect(forecastMessages(reload).map(m => m.status)).toEqual(['ok', 'ok']);
    expect(w.stub.jobs.filter(j => j.key.startsWith(`battle:${battleId}:`))).toHaveLength(1);
  });

  it('says a re-forecast is running alongside the last result', async () => {
    const w = await forecastWorld({ defaultEncounter: 'brutes' });
    w.pm.partyBattles.setForecaster(w.svc);
    w.entry().battleTimer.restartBattle();
    const battleId = w.entry().battleTimer.battleId;
    vi.advanceTimersByTime(2000);
    w.stub.gated.add('battle:');
    const combat = w.entry().battleTimer.currentCombat as PartyCombatState;
    (w.pm.partyBattles as unknown as { watchLiveForecastTriggers(partyId: string, flush: CombatFlush): void })
      .watchLiveForecastTriggers(w.partyId, { battleId, combat, events: [{ id: 1, t: 0, kind: 'phase', amount: 1 }] as CombatEvent[], log: [], snapshot: null });
    vi.advanceTimersByTime(LIVE_FORECAST_DEBOUNCE_MS + 100);

    const late = createWs();
    await w.pm.login(late as never, 'alice');
    w.pm.sendCombatResync(late as never);
    const got = forecastMessages(late);
    expect(got.map(m => m.status)).toEqual(['ok', 'pending']);
    expect(got[0].key).toBe(`battle:${battleId}:0`);
    expect(got[1].key).not.toBe(got[0].key);
  });

  it('queues a forecast when nobody was watching as the fight began', async () => {
    const w = await forecastWorld({ defaultEncounter: 'brutes' });
    w.pm.partyBattles.setForecaster(w.svc);
    w.pm.setCombatView(w.ws as never, false);
    w.entry().battleTimer.restartBattle();
    const battleId = w.entry().battleTimer.battleId;
    vi.advanceTimersByTime(1500);
    expect(w.stub.jobs.filter(j => j.key.startsWith('battle:'))).toEqual([]);

    w.pm.setCombatView(w.ws as never, true);
    vi.advanceTimersByTime(50);
    const live = forecastMessages(w.ws).filter(m => m.target.battleId === battleId);
    expect(live.map(m => m.status)).toEqual(['pending', 'ok']);
    expect(Number(live[1].key.split(':')[2])).toBeGreaterThan(0);
  });

  it('sends nothing for trash fights or between fights', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    w.entry().battleTimer.restartBattle();
    const late = createWs();
    await w.pm.login(late as never, 'alice');
    w.pm.sendCombatResync(late as never);
    expect(forecastMessages(late)).toEqual([]);
    expect(w.pm.partyBattles.liveForecastResync('no-such-party')).toEqual([]);
  });

  it('forecasts a boss fight entered from a saved checkpoint', async () => {
    const w = await forecastWorld({ dungeon: { def: PIT, at: `${START.col},${START.row}` } });
    w.pm.partyBattles.setForecaster(w.svc);
    w.session.setDungeonCheckpoint('pit', { floorIndex: 0, phase: 1, wipes: 0, rewardedPhases: [], at: Date.now() });
    expect(w.pm.partyBattles.enterDungeon(w.partyId, 'pit', 'alice').success).toBe(true);
    const battleId = w.entry().battleTimer.battleId;
    expect(w.entry().battleTimer.currentCombat?.bossPhases?.phase).toBe(1);
    vi.advanceTimersByTime(50);
    expect(forecastMessages(w.ws).filter(m => m.target.battleId === battleId).map(m => m.status)).toEqual(['pending', 'ok']);
    expect(w.stub.jobs.find(j => j.key.startsWith(`battle:${battleId}:`))?.input).toMatchObject({ kind: 'battle', henchmenAllowed: false });
  });

  it('forecasts a resumed boss fight entered from the map once the player opens the battle', async () => {
    const w = await forecastWorld({ dungeon: { def: PIT, at: `${START.col},${START.row}` } });
    w.pm.partyBattles.setForecaster(w.svc);
    w.session.setDungeonCheckpoint('pit', { floorIndex: 0, phase: 1, wipes: 0, rewardedPhases: [], at: Date.now() });
    w.pm.setCombatView(w.ws as never, false);
    expect(w.pm.partyBattles.enterDungeon(w.partyId, 'pit', 'alice').success).toBe(true);
    const battleId = w.entry().battleTimer.battleId;
    vi.advanceTimersByTime(500);
    expect(forecastMessages(w.ws)).toEqual([]);

    w.pm.setCombatView(w.ws as never, true);
    vi.advanceTimersByTime(50);
    expect(forecastMessages(w.ws).filter(m => m.target.battleId === battleId).map(m => m.status)).toEqual(['pending', 'ok']);
  });
});

describe('state after a build change', () => {
  it('reaches every socket of the player and of their party', async () => {
    const w = await forecastWorld();
    const secondTab = createWs();
    await w.pm.login(secondTab as never, 'alice');
    const bobWs = await joinAlice(w, 'bob', 'Priest');
    for (const ws of [w.ws, secondTab, bobWs]) ws.send.mockClear();
    w.pm.sendStateToParty('bob');
    const states = (ws: typeof w.ws) => ws.send.mock.calls.map(([p]) => JSON.parse(String(p))).filter((m: { type: string }) => m.type === 'state');
    for (const ws of [w.ws, secondTab, bobWs]) expect(states(ws)).toHaveLength(1);
  });
});
