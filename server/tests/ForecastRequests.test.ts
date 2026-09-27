import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DungeonDefinition, DungeonForecastInput, ServerForecastMessage, PartyCombatState, CombatEvent } from '@idle-party-rpg/shared';
import { FORECAST_REQUESTS_PER_WINDOW } from '../src/game/ForecastService.js';
import { LIVE_FORECAST_DEBOUNCE_MS } from '../src/game/PartyBattleManager.js';
import type { CombatFlush } from '../src/game/ServerBattleTimer.js';
import { START, forecastMessages, forecastWorld, tileId } from './forecastFixture.js';

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
