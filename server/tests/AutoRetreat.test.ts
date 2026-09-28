import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HexGrid, HexTile, offsetToCube, cubeToOffset, DEFAULT_MAP_ID, RESULT_PAUSE, MOVE_DURATION, RUN_AVAILABLE_MS } from '@idle-party-rpg/shared';
import type { DungeonDefinition, ForecastResult, ForecastStratum } from '@idle-party-rpg/shared';
import type WebSocket from 'ws';
import { ServerParty } from '../src/game/ServerParty.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import {
  AUTO_RETREAT_SKIPS_TO_RELOCATE,
  decideAutoRetreat,
  pickRetreatTarget,
  stratumUpperPct,
} from '../src/game/AutoRetreat.js';
import { DEADLY, SAFE, START, badPack, forecastWorld, tileId } from './forecastFixture.js';

function room(winPct: number, ci: [number, number], strata?: ForecastStratum[], sims = 200): ForecastResult {
  return {
    key: 'k', partyKey: 'pk', sims, wins: 0, losses: 0, stalemates: 0, winPct, ci,
    medianMs: null, p90Ms: null, atMs: 0, killEtaMs: null, reasons: [], ...(strata ? { strata } : {}),
  };
}

const RETREAT_CYCLE_MS = RUN_AVAILABLE_MS + RESULT_PAUSE + MOVE_DURATION + 200;

describe('auto-retreat decisions', () => {
  it('relocates only when the whole room is clearly below the threshold', () => {
    expect(decideAutoRetreat(room(10, [5, 20]), null, 25, 0)).toEqual({ kind: 'relocate', winPct: 10, cause: 'room' });
    expect(decideAutoRetreat(room(10, [2, 30]), null, 25, 0)).toEqual({ kind: 'unknown' });
    expect(decideAutoRetreat(room(10, [5, 20]), null, 0, 0)).toEqual({ kind: 'none' });
    expect(decideAutoRetreat(room(0, [0, 100], undefined, 0), null, 25, 0)).toEqual({ kind: 'unknown' });
  });

  it('skips a pack only when its own interval is clearly below the threshold', () => {
    const strata = [
      { entryId: 'bandits', label: 'Bandits', winPct: 0, sharePct: 30 },
      { entryId: 'wolves', label: 'Wolves', winPct: 100, sharePct: 70 },
    ];
    expect(decideAutoRetreat(room(70, [63, 76], strata), 'bandits', 25, 0)).toEqual({ kind: 'skip', winPct: 0 });
    expect(decideAutoRetreat(room(70, [63, 76], strata), 'wolves', 25, 0)).toEqual({ kind: 'none' });
    expect(decideAutoRetreat(room(70, [40, 90], strata, 10), 'bandits', 25, 0)).toEqual({ kind: 'none' });
    expect(stratumUpperPct(strata[0], 10)).toBeGreaterThan(25);
    expect(stratumUpperPct(strata[0], 200)).toBeLessThan(25);
  });

  it('treats a pack the forecast never sampled as unknown, never as safe or skippable', () => {
    const strata = [{ entryId: 'wolves', label: 'Wolves', winPct: 100, sharePct: 70 }];
    expect(decideAutoRetreat(room(70, [40, 100], strata), 'bandits', 25, 0)).toEqual({ kind: 'unknown' });
    expect(decideAutoRetreat(room(70, [40, 100], strata), 'bandits', 25, AUTO_RETREAT_SKIPS_TO_RELOCATE - 1)).toEqual({ kind: 'unknown' });
    expect(decideAutoRetreat(room(70, [40, 100], []), 'wolves', 25, 0)).toEqual({ kind: 'unknown' });
  });

  it('turns the third skip within ten battles into a relocation', () => {
    const strata = [{ entryId: 'bandits', label: 'Bandits', winPct: 0, sharePct: 50 }];
    expect(decideAutoRetreat(room(50, [43, 57], strata), 'bandits', 25, AUTO_RETREAT_SKIPS_TO_RELOCATE - 2).kind).toBe('skip');
    expect(decideAutoRetreat(room(50, [43, 57], strata), 'bandits', 25, AUTO_RETREAT_SKIPS_TO_RELOCATE - 1)).toEqual({ kind: 'relocate', winPct: 0, cause: 'skips' });
  });

  it('picks only rooms known to be safe: the previous room first, then the best neighbour', () => {
    const tile = (id: string) => new HexTile(offsetToCube({ col: 0, row: 0 }), 'forest', 'z', id);
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(tile);
    expect(pickRetreatTarget([
      { tile: a, forecast: room(90, [85, 95]), previous: false },
      { tile: b, forecast: room(30, [25, 35]), previous: true },
    ], 25)).toEqual({ kind: 'target', tile: b });
    expect(pickRetreatTarget([
      { tile: a, forecast: room(60, [55, 65]), previous: false },
      { tile: b, forecast: room(10, [5, 15]), previous: true },
      { tile: c, forecast: room(95, [90, 99]), previous: false },
      { tile: d, forecast: null, previous: false },
    ], 25)).toEqual({ kind: 'target', tile: c });
  });

  it('waits for unknown rooms to be forecast, and gives up when every known room is as bad', () => {
    const tile = (id: string) => new HexTile(offsetToCube({ col: 0, row: 0 }), 'forest', 'z', id);
    const [a, b, d] = ['a', 'b', 'd'].map(tile);
    const unknownPrevious = { tile: b, forecast: null, previous: true };
    const unknown = { tile: d, forecast: null, previous: false };
    expect(pickRetreatTarget([{ tile: a, forecast: room(20, [15, 26]), previous: false }, unknownPrevious, unknown], 25))
      .toEqual({ kind: 'wait', unknown: [unknownPrevious, unknown] });
    expect(pickRetreatTarget([{ tile: a, forecast: room(20, [15, 26]), previous: true }], 25)).toEqual({ kind: 'none' });
    expect(pickRetreatTarget([], 25)).toEqual({ kind: 'none' });
  });
});

describe('ServerParty.previousTile', () => {
  function line(): { grid: HexGrid; tiles: HexTile[] } {
    const grid = new HexGrid();
    const tiles = [0, 1, 2, 3].map(col => new HexTile(offsetToCube({ col, row: 0 }), 'forest', 'z', `t${col}`));
    for (const t of tiles) grid.addTile(t);
    return { grid, tiles };
  }

  it('remembers the room the party walked in from', () => {
    const { grid, tiles } = line();
    const party = new ServerParty(grid, tiles[0], DEFAULT_MAP_ID);
    expect(party.previousTile).toBeNull();
    party.setDestination(tiles[2]);
    party.moveToNextTile();
    expect(party.previousTile?.id).toBe('t0');
    party.moveToNextTile();
    expect(party.previousTile?.id).toBe('t1');
  });

  it('a retreat step is never remembered as the room the party came from', () => {
    const { grid, tiles } = line();
    const party = new ServerParty(grid, tiles[0], DEFAULT_MAP_ID);
    party.setDestination(tiles[1]);
    party.moveToNextTile();
    party.retreatTo(tiles[0]);
    expect(party.remainingPath.map(t => t.id)).toEqual(['t0']);
    party.moveToNextTile();
    expect(party.tile.id).toBe('t0');
    expect(party.previousTile).toBeNull();
  });

  it('relocation and map changes forget it', () => {
    const { grid, tiles } = line();
    const party = new ServerParty(grid, tiles[0], DEFAULT_MAP_ID);
    party.setDestination(tiles[1]);
    party.moveToNextTile();
    party.relocateTo(tiles[3]);
    expect(party.previousTile).toBeNull();
    party.setDestination(tiles[2]);
    party.moveToNextTile();
    expect(party.previousTile?.id).toBe('t3');
    party.switchMap(grid, tiles[0], 'other');
    expect(party.previousTile).toBeNull();
  });
});

describe('auto-retreat in the overworld', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('skips bad packs in place, then holds with nowhere safer to go instead of looping', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const notify = vi.spyOn(w.pm.notify, 'notify');
    const here = tileId(START.col, START.row);
    const neighbours = w.grid.getAllNeighbors(w.tileAt(START.col, START.row).coord).map(t => t.id);
    w.stub.verdicts.set(here, badPack('ogres'));
    for (const id of neighbours) w.stub.verdicts.set(id, DEADLY);
    w.prefill(neighbours);

    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(4 * RETREAT_CYCLE_MS);
    for (let i = 0; i < 3; i++) {
      w.entry().battleTimer.restartBattle();
      vi.advanceTimersByTime(RETREAT_CYCLE_MS);
    }

    const log = w.journal();
    expect(log.filter(l => l === 'Avoided Ogre (win chance 0%)')).toHaveLength(2);
    expect(log.filter(l => l === `Nowhere safer to retreat from Room ${START.col}-${START.row} — fighting on`)).toHaveLength(1);
    expect(log.some(l => l.startsWith('Auto-retreat moved'))).toBe(false);
    expect(w.entry().serverParty.tile.id).toBe(here);
    expect(w.entry().retreatHold).toEqual({ tileId: here });
    expect(w.entry().battleTimer.isFighting(w.entry().battleTimer.battleId)).toBe(true);

    expect(notify.mock.calls.filter(c => c[1] === 'auto_retreat')).toHaveLength(1);
    expect(notify.mock.calls.find(c => c[1] === 'auto_retreat')![2].body)
      .toBe('Auto-retreat kept your party out of a losing fight. Change it in Options.');
    expect(w.session.toSaveData().autoRetreatNotified).toBe(true);
  });

  it("the owner's setting change lifts the hold", async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const here = tileId(START.col, START.row);
    w.stub.fallback.verdict = DEADLY;
    const neighbours = w.grid.getAllNeighbors(w.tileAt(START.col, START.row).coord).map(t => t.id);
    w.prefill([here, ...neighbours]);
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(100);
    expect(w.entry().retreatHold).toEqual({ tileId: here });

    w.pm.handleSetCombatPrefs('alice', 40);
    expect(w.entry().retreatHold).toBeUndefined();
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(100);
    expect(w.entry().retreatHold).toEqual({ tileId: here });
    expect(w.journal().filter(l => l.startsWith('Nowhere safer'))).toHaveLength(1);
  });

  it('does not repeat "Nowhere safer" when the hold is lost, e.g. across a restart', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const here = tileId(START.col, START.row);
    w.stub.fallback.verdict = DEADLY;
    const neighbours = w.grid.getAllNeighbors(w.tileAt(START.col, START.row).coord).map(t => t.id);
    w.prefill([here, ...neighbours]);
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(100);
    expect(w.journal().filter(l => l.startsWith('Nowhere safer'))).toHaveLength(1);

    for (let i = 0; i < 5; i++) w.session.addLogEntry('Defeat...', 'defeat');
    w.entry().retreatHold = undefined;
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(100);
    expect(w.entry().retreatHold).toEqual({ tileId: here });
    expect(w.journal().filter(l => l.startsWith('Nowhere safer'))).toHaveLength(1);

    w.session.addLogEntry('Avoided Ogre (win chance 0%)', 'retreat');
    w.entry().retreatHold = undefined;
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(100);
    expect(w.journal().filter(l => l.startsWith('Nowhere safer'))).toHaveLength(2);
  });

  it('two dangerous rooms side by side: it forecasts the way back first, skips meanwhile, then stays put', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    w.stub.fallback.verdict = DEADLY;
    const start = w.tileAt(START.col, START.row);
    const next = w.grid.getAllNeighbors(start.coord).find(t => t.id !== start.id)!;
    const party = w.entry().serverParty;
    party.setDestination(next);
    party.moveToNextTile();
    expect(party.previousTile?.id).toBe(start.id);

    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(3 * RETREAT_CYCLE_MS);
    for (let i = 0; i < 3; i++) {
      w.entry().battleTimer.restartBattle();
      vi.advanceTimersByTime(RETREAT_CYCLE_MS);
    }

    const log = w.journal();
    const nextName = `Room ${cubeToOffset(next.coord).col}-${cubeToOffset(next.coord).row}`;
    expect(w.stub.jobs.some(j => j.key.endsWith(`room:${start.id}`))).toBe(true);
    expect(log.some(l => l.startsWith('Auto-retreat moved'))).toBe(false);
    expect(log.filter(l => l === 'Avoided Ogre (win chance 0%)')).toHaveLength(1);
    expect(log.filter(l => l.startsWith('Nowhere safer'))).toEqual([`Nowhere safer to retreat from ${nextName} — fighting on`]);
    expect(party.tile.id).toBe(next.id);
    expect(w.entry().retreatHold).toEqual({ tileId: next.id });
  });

  it('relocates once a neighbour is forecast safe, naming the room it left as the dangerous one', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    w.stub.fallback.verdict = DEADLY;
    const start = w.tileAt(START.col, START.row);
    const next = w.grid.getAllNeighbors(start.coord).find(t => t.id !== start.id)!;
    w.stub.verdicts.set(start.id, SAFE);
    const party = w.entry().serverParty;
    party.setDestination(next);
    party.moveToNextTile();

    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(RETREAT_CYCLE_MS);
    expect(party.tile.id).toBe(next.id);
    expect(w.journal().filter(l => l.startsWith('Avoided'))).toHaveLength(1);
    vi.advanceTimersByTime(RETREAT_CYCLE_MS);

    const nextName = `Room ${cubeToOffset(next.coord).col}-${cubeToOffset(next.coord).row}`;
    expect(w.journal().filter(l => l.startsWith('Auto-retreat moved'))).toEqual([
      `Auto-retreat moved your party from ${nextName} to Room ${START.col}-${START.row} — ${nextName} was too dangerous (win chance 0%)`,
    ]);
    expect(party.tile.id).toBe(start.id);
    expect(w.entry().retreatHold).toEqual({ tileId: start.id });
  });

  it('says lost-cause fights kept coming up when repeated skips move the party', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const here = tileId(START.col, START.row);
    const neighbours = w.grid.getAllNeighbors(w.tileAt(START.col, START.row).coord).map(t => t.id);
    w.stub.verdicts.set(here, badPack('ogres'));
    for (const id of neighbours) w.stub.verdicts.set(id, DEADLY);
    w.stub.verdicts.set(neighbours[0], SAFE);
    w.prefill(neighbours);

    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(3 * RETREAT_CYCLE_MS);

    const safeTile = w.grid.getTileById(neighbours[0])!;
    const safeName = `Room ${cubeToOffset(safeTile.coord).col}-${cubeToOffset(safeTile.coord).row}`;
    expect(w.journal().filter(l => l.startsWith('Avoided'))).toHaveLength(2);
    expect(w.journal().filter(l => l.startsWith('Auto-retreat moved'))).toEqual([
      `Auto-retreat moved your party from Room ${START.col}-${START.row} to ${safeName} (lost-cause fights kept coming up)`,
    ]);
  });

  it('a relocation clears the queued route', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const start = w.tileAt(START.col, START.row);
    const next = w.grid.getAllNeighbors(start.coord)[0];
    w.stub.verdicts.set(start.id, DEADLY);
    w.stub.verdicts.set(next.id, SAFE);
    w.prefill([next.id]);
    const far = w.tileAt(3, 2);
    w.entry().serverParty.setDestination(far);
    const route = w.entry().serverParty.remainingPath.map(t => t.id);
    expect(route.length).toBeGreaterThan(1);

    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 100);
    expect(w.entry().serverParty.remainingPath.map(t => t.id)).toEqual([next.id]);
    vi.advanceTimersByTime(RESULT_PAUSE + MOVE_DURATION);
    expect(w.entry().serverParty.tile.id).toBe(next.id);
    expect(w.entry().serverParty.remainingPath).toEqual([]);
  });

  it("a player's move calls off a retreat already scheduled for the fight", async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const start = w.tileAt(START.col, START.row);
    const next = w.grid.getAllNeighbors(start.coord)[0];
    w.stub.verdicts.set(start.id, DEADLY);
    w.stub.verdicts.set(next.id, SAFE);
    w.prefill([start.id, next.id]);
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(1000);
    expect(w.entry().pendingRetreat).toBeDefined();

    expect(w.pm.partyBattles.handleMove(w.partyId, 3, 2)).toEqual({ success: true });
    const route = w.entry().serverParty.remainingPath.map(t => t.id);
    vi.advanceTimersByTime(RETREAT_CYCLE_MS);

    expect(w.entry().pendingRetreat).toBeUndefined();
    expect(w.entry().serverParty.remainingPath.map(t => t.id)).toEqual(route);
    expect(w.journal().some(l => l.startsWith('Auto-retreat moved'))).toBe(false);
  });

  it('turning auto-retreat off calls off a retreat already scheduled for the fight', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const start = w.tileAt(START.col, START.row);
    const next = w.grid.getAllNeighbors(start.coord)[0];
    w.stub.verdicts.set(start.id, DEADLY);
    w.stub.verdicts.set(next.id, SAFE);
    w.prefill([start.id, next.id]);
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(1000);
    expect(w.entry().pendingRetreat).toBeDefined();

    w.pm.handleSetCombatPrefs('alice', 0);
    vi.advanceTimersByTime(RETREAT_CYCLE_MS);

    expect(w.entry().serverParty.tile.id).toBe(start.id);
    expect(w.journal().some(l => l.startsWith('Auto-retreat moved'))).toBe(false);
  });

  it('a restart in the pause after a relocation walks on instead of retreating again', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    w.pm.setPresence(w.ws as unknown as WebSocket, false);
    const start = w.tileAt(START.col, START.row);
    const next = w.grid.getAllNeighbors(start.coord)[0];
    w.stub.verdicts.set(start.id, DEADLY);
    w.stub.verdicts.set(next.id, SAFE);
    w.prefill([start.id, next.id]);
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 100);
    expect(w.entry().serverParty.remainingPath.map(t => t.id)).toEqual([next.id]);

    w.pm.partyBattles.restartBattle(w.partyId);
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 100);

    expect(w.journal().filter(l => l.startsWith('Auto-retreat moved'))).toHaveLength(1);
    const ledger = w.session.getAwayLedger()!;
    expect(ledger.retreats).toBe(1);
    expect(ledger.routeStopped).toBeUndefined();
    expect(w.pm.partyBattles.escapeBattle(w.partyId)).toBe(true);
    vi.advanceTimersByTime(RESULT_PAUSE + MOVE_DURATION);
    expect(w.entry().serverParty.tile.id).toBe(next.id);
  });

  it('a forced relocation forgets the previous room', async () => {
    const w = await forecastWorld();
    const party = w.entry().serverParty;
    party.setDestination(w.tileAt(2, 1));
    party.moveToNextTile();
    expect(party.previousTile).not.toBeNull();
    w.pm.partyBattles.relocateParty(w.partyId, w.tileAt(0, 0), DEFAULT_MAP_ID);
    expect(party.previousTile).toBeNull();
  });

  it('a forecast that lands after the fight is decided does nothing', async () => {
    const w = await forecastWorld({ defaultEncounter: 'gnats' });
    w.pm.partyBattles.setForecaster(w.svc);
    const here = tileId(START.col, START.row);
    w.stub.verdicts.set(here, badPack('gnats'));
    w.stub.gated.add('room:');

    w.entry().battleTimer.restartBattle();
    const battleId = w.entry().battleTimer.battleId;
    for (let i = 0; i < 100 && w.entry().battleTimer.isFighting(battleId); i++) vi.advanceTimersByTime(100);
    expect(w.entry().battleTimer.isFighting(battleId)).toBe(false);
    expect(w.entry().battleTimer.battleId).toBe(battleId);

    w.stub.gated.clear();
    vi.advanceTimersByTime(30);
    expect(w.svc.get(w.roomKey(here))).not.toBeNull();
    expect(w.entry().pendingRetreat).toBeUndefined();

    vi.advanceTimersByTime(60_000);
    const log = w.journal();
    expect(log.filter(l => l === 'Victory!').length).toBeGreaterThan(3);
    expect(log.some(l => l.startsWith('Avoided'))).toBe(false);
  });

  it('a forecast that lands after the party is gone does nothing', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    w.stub.fallback.verdict = DEADLY;
    w.stub.gated.add('room:');
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(100);
    w.pm.partyBattles.destroyEntry(w.partyId);
    w.stub.gated.clear();
    vi.advanceTimersByTime(RETREAT_CYCLE_MS);
    expect(w.journal().some(l => l.includes('retreat') || l.startsWith('Avoided') || l.startsWith('Nowhere'))).toBe(false);
  });

  it('a fight from a pack the forecast never sampled neither skips nor pushes earlier skips out', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    const here = tileId(START.col, START.row);
    const skips = w.entry() as unknown as { recentSkips: boolean[] };
    const fightWith = (strata: ForecastStratum[]): void => {
      w.contentState.contentEpoch++;
      w.stub.verdicts.set(here, { winPct: 60, ci: [53, 67], sims: 200, strata });
      w.prefill([here]);
      skips.recentSkips = [true, true];
      w.entry().battleTimer.restartBattle();
      vi.advanceTimersByTime(100);
    };

    fightWith([{ entryId: 'gnats', label: 'Gnats', winPct: 100, sharePct: 100 }]);
    expect(skips.recentSkips).toEqual([true, true]);
    expect(w.entry().pendingRetreat).toBeUndefined();

    fightWith([{ entryId: 'ogres', label: 'Ogres', winPct: 100, sharePct: 100 }]);
    expect(skips.recentSkips).toEqual([true, true, false]);
    expect(w.journal().some(l => l.startsWith('Avoided') || l.startsWith('Auto-retreat'))).toBe(false);
  });

  it('does nothing when auto-retreat is off', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    w.stub.fallback.verdict = DEADLY;
    w.pm.handleSetCombatPrefs('alice', 0);
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(3 * RETREAT_CYCLE_MS);
    expect(w.stub.jobs.filter(j => j.key.includes('room:'))).toEqual([]);
    expect(w.entry().serverParty.tile.id).toBe(tileId(START.col, START.row));
  });

  it('never acts inside a dungeon', async () => {
    const dungeon: DungeonDefinition = {
      id: 'pit',
      name: 'The Pit',
      floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'ogres', weight: 1 }] }],
    };
    const w = await forecastWorld({ dungeon: { def: dungeon, at: `${START.col},${START.row}` } });
    w.pm.partyBattles.setForecaster(w.svc);
    w.stub.fallback.verdict = DEADLY;
    expect(w.pm.partyBattles.enterDungeon(w.partyId, 'pit', 'alice').success).toBe(true);
    const before = w.stub.jobs.filter(j => j.key.includes('room:')).length;

    vi.advanceTimersByTime(3 * RETREAT_CYCLE_MS);
    w.entry().battleTimer.restartBattle();
    vi.advanceTimersByTime(RETREAT_CYCLE_MS);

    expect(w.stub.jobs.filter(j => j.key.includes('room:'))).toHaveLength(before);
    expect(w.pm.partyBattles.getDungeonRunInfo(w.partyId)).not.toBeNull();
    const log = w.journal();
    expect(log.some(l => l.startsWith('Avoided') || l.startsWith('Auto-retreat') || l.startsWith('Nowhere'))).toBe(false);
    expect(w.entry().battleTimer.isFighting(w.entry().battleTimer.battleId)).toBe(true);
  });
});

describe('party auto-retreat policy', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("uses the owner's setting and shows it with the forecast key on the party", async () => {
    const w = await forecastWorld();
    const bobWs = { readyState: 1, OPEN: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn(), on: vi.fn() };
    const bob = await w.pm.login(bobWs as never, 'bob');
    bob.setClass('Priest');
    w.pm.applyClassChange('bob');
    const getPartyId = (u: string) => w.pm.getSessionByUsername(u)?.getPartyId() ?? null;
    const setPartyId = (u: string, id: string | null) => { w.pm.getSessionByUsername(u)?.setPartyId(id); };
    const oldParty = getPartyId('bob');
    expect(w.pm.parties.inviteToParty('alice', 'bob', getPartyId, (a, b) => w.pm.areSameTile(a, b))).toBe(true);
    expect(typeof w.pm.parties.acceptInvite('bob', w.partyId, getPartyId, setPartyId, (a, b) => w.pm.areSameTile(a, b))).not.toBe('string');
    w.pm.handlePartyJoin('bob', w.partyId, oldParty);

    w.pm.handleSetCombatPrefs('bob', 60);
    expect(w.pm.autoRetreatPolicy(w.partyId)).toEqual({ belowPct: 25, setBy: 'alice' });
    w.pm.handleSetCombatPrefs('alice', 40);
    expect(w.pm.getSocialState('bob').party?.autoRetreat).toEqual({ belowPct: 40, setBy: 'alice' });

    expect(w.pm.getSocialState('alice').party?.forecastKey).toBeUndefined();
    w.pm.partyBattles.setForecaster(w.svc);
    const key = w.pm.getSocialState('alice').party?.forecastKey;
    expect(key).toMatch(/^pk[0-9a-f]{14}$/);
    expect(w.pm.getSocialState('bob').party?.forecastKey).toBe(key);
  });

  it('computes the forecast key without recursing when a grid slot is unknown', async () => {
    const w = await forecastWorld();
    w.pm.partyBattles.setForecaster(w.svc);
    w.pm.partyBattles.setGridPositionLookup(() => undefined);
    expect(w.pm.getSocialState('alice').party?.forecastKey).toMatch(/^pk/);
  });

  it('remembers the one-time notice across a save', async () => {
    const w = await forecastWorld();
    expect(w.session.noteAutoRetreat()).toBe(true);
    expect(w.session.noteAutoRetreat()).toBe(false);
    const saved = w.session.toSaveData();
    expect(saved.autoRetreatNotified).toBe(true);
    const restored = PlayerSession.fromSaveData(saved, (w.pm as unknown as { grids: never }).grids, (w.pm as unknown as { content: never }).content);
    expect(restored.noteAutoRetreat()).toBe(false);
    const fresh = PlayerSession.fromSaveData({ ...saved, autoRetreatNotified: undefined }, (w.pm as unknown as { grids: never }).grids, (w.pm as unknown as { content: never }).content);
    expect(fresh.noteAutoRetreat()).toBe(true);
  });
});
