import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_MAP_ID, GAUGE_TIMING, KILL_BEAT_MS, combatRealElapsedMs, combatRealStepMs, roundToTwoFigures } from '@idle-party-rpg/shared';
import type { ClientXpGauge, DungeonDefinition, HenchmanDefinition, MonsterDefinition, PartyCombatState, ZoneDefinition } from '@idle-party-rpg/shared';
import { ForecastService } from '../src/game/ForecastService.js';
import { ENCOUNTERS, MONSTERS, START, badPack, forecastWorld, joinAlice, tileId } from './forecastFixture.js';
import type { FakeWs, ForecastWorld, Verdict, WorldOptions } from './forecastFixture.js';

/** A forecast fight of this length plus the pause after a win makes XP/hr exactly 100 × the pay for a win. */
const FIGHT_AND_PAUSE_MS = 36_000;
const AT_START = `${START.col},${START.row}`;
const NEXT = { col: 2, row: 1 };
const TOWN = { col: 3, row: 1 };
const HOUR = 3_600_000;
const { winPauseMs: WIN_PAUSE, lossPauseMs: LOSS_PAUSE, skipMs: SKIP } = GAUGE_TIMING;

MONSTERS.rat = { id: 'rat', name: 'Rat', hp: 1, damage: 0, damageType: 'physical', xp: 0, goldMin: 0, goldMax: 0 };
ENCOUNTERS.rats = { id: 'rats', name: 'Rats', type: 'explicit', placements: [{ monsterId: 'rat', gridPosition: 4 }] };
MONSTERS.wasp = { id: 'wasp', name: 'Wasp', hp: 1, damage: 0, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0 };
ENCOUNTERS.swarm = { id: 'swarm', name: 'Swarm', type: 'random', monsterPool: [{ monsterId: 'gnat', min: 1, max: 3 }, { monsterId: 'wasp', min: 0, max: 2 }] };

function verdict(entryId: string, winPct = 100, meanMs = FIGHT_AND_PAUSE_MS - GAUGE_TIMING.winPauseMs): Verdict {
  return { winPct, ci: [Math.max(0, winPct - 2), Math.min(100, winPct + 2)], sims: 200, strata: [{ entryId, label: entryId, winPct, sharePct: 100, meanMs, packFactor: 1 }] };
}

function stock(w: ForecastWorld, changes: Record<string, Partial<MonsterDefinition>>): void {
  const monsters: Record<string, MonsterDefinition> = { ...MONSTERS };
  for (const [id, change] of Object.entries(changes)) monsters[id] = { ...monsters[id], ...change };
  Object.assign(w.content, { getMonster: (id: string) => monsters[id], getAllMonsters: () => monsters });
  w.contentState.contentEpoch++;
}

async function gnatWorld(opts: WorldOptions = {}): Promise<ForecastWorld> {
  const w = await forecastWorld({ defaultEncounter: 'gnats', ...opts });
  stock(w, { gnat: { xp: 100 } });
  return w;
}

function wireForecasts(w: ForecastWorld, entryId = 'gnats'): void {
  w.stub.fallback.verdict = verdict(entryId);
  w.pm.partyBattles.setForecaster(w.svc);
}

function gauge(w: ForecastWorld, username = 'alice'): ClientXpGauge | undefined {
  return w.pm.getSessionByUsername(username)!.getState([]).xpGauge;
}

/** Reads the gauge once to queue its forecast, then again once the forecast has landed. */
function settledRead(w: ForecastWorld, username = 'alice'): ClientXpGauge | undefined {
  gauge(w, username);
  vi.advanceTimersByTime(50);
  return gauge(w, username);
}

function setLevel(w: ForecastWorld, username: string, level: number): void {
  (w.pm.getSessionByUsername(username) as unknown as { character: { level: number } }).character.level = level;
}

function xpOf(w: ForecastWorld, username = 'alice'): number {
  return w.pm.getSessionByUsername(username)!.toSaveData().character!.xp;
}

function combat(w: ForecastWorld): PartyCombatState {
  return w.entry().battleTimer.currentCombat!;
}

function waitOutPause(w: ForecastWorld): void {
  const timer = w.entry().battleTimer;
  if (!timer.isLive) vi.advanceTimersByTime(timer.regroupRemainingMs);
}

/** Waits out the pause after a fight, up to the next fight's start. */
function nextFight(w: ForecastWorld): void {
  const timer = w.entry().battleTimer;
  const before = timer.battleId;
  for (let i = 0; i < 10_000 && (timer.battleId === before || !timer.isLive); i++) vi.advanceTimersByTime(10);
  expect(timer.battleId).not.toBe(before);
}

function finishFight(w: ForecastWorld): void {
  const step = combatRealStepMs(combat(w));
  for (let i = 0; i < 1000 && !combat(w).finished; i++) vi.advanceTimersByTime(step);
  expect(combat(w).finished).toBe(true);
  vi.advanceTimersByTime(KILL_BEAT_MS);
}

/** A fresh fight, played to its payout. Returns what each named member earned from it. */
function winFight(w: ForecastWorld, usernames = ['alice']): number[] {
  w.entry().battleTimer.restartBattle();
  waitOutPause(w);
  const before = usernames.map(u => xpOf(w, u));
  finishFight(w);
  return usernames.map((u, i) => xpOf(w, u) - before[i]);
}

function walkTo(w: ForecastWorld, at: { col: number; row: number }): void {
  expect(w.pm.partyBattles.handleMove(w.partyId, at.col, at.row).success).toBe(true);
  for (let i = 0; i < 2000 && w.entry().serverParty.tile.id !== tileId(at.col, at.row); i++) vi.advanceTimersByTime(100);
  expect(w.entry().serverParty.tile.id).toBe(tileId(at.col, at.row));
}

function hireOf(id: string, level: number, skillIds: string[] = []): HenchmanDefinition {
  return { id, name: id, className: 'Knight', level, maxHp: 500, baseDamage: 1, skillIds, emoji: 'x' };
}

function hire(w: ForecastWorld, def: HenchmanDefinition): void {
  Object.assign(w.content, { getHenchman: (id: string) => (id === def.id ? def : undefined) });
  const hired = w.pm.hireHenchman('alice', def.id, DEFAULT_MAP_ID);
  if (typeof hired === 'string') throw new Error(hired);
  w.pm.partyBattles.henchmenChanged(w.partyId, [hired]);
}

/** Within `tolerance` of the truth, plus what rounding to two figures can add. */
function expectNear(read: number, truth: number, tolerance: number): void {
  const halfStep = 0.5 * 10 ** (Math.floor(Math.log10(read)) - 1);
  expect(Math.abs(read - truth)).toBeLessThanOrEqual(tolerance * truth + halfStep);
}

function roomJobs(w: ForecastWorld): string[] {
  return w.stub.jobs.map(j => j.key).filter(k => k.includes('room:'));
}

function pushedGauges(ws: FakeWs): (ClientXpGauge | undefined)[] {
  return ws.send.mock.calls
    .map(([payload]) => JSON.parse(String(payload)) as { type: string; xpGauge?: ClientXpGauge })
    .filter(m => m.type === 'state')
    .map(m => m.xpGauge);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('XP gauge, read from what a win pays', () => {
  it('reads Measuring until the forecast lands, then the forecast\'s figure before any fight ends', async () => {
    const w = await gnatWorld();
    wireForecasts(w);
    expect(gauge(w)).toEqual({ basis: 'measuring' });
    vi.advanceTimersByTime(50);
    const read = gauge(w)!;
    expect(read.basis).toBe('estimate');
    expect(read.perHour).toBe(roundToTwoFigures(winFight(w)[0] * 100));
  });

  it('matches what real fights pay, from a real forecast, before the first kill and once steady', async () => {
    const w = await gnatWorld({ defaultEncounter: 'swarm' });
    stock(w, { gnat: { xp: 10 } });
    setLevel(w, 'alice', 30);
    w.entry().battleTimer.restartBattle();
    w.pm.partyBattles.setForecaster(new ForecastService());
    for (let i = 0; i < 30 && gauge(w)!.basis === 'measuring'; i++) vi.advanceTimersByTime(100);
    const first = gauge(w)!;
    expect(first.basis).toBe('estimate');
    const xp0 = xpOf(w);
    const t0 = Date.now();
    vi.advanceTimersByTime(60 * 60_000);
    const measured = ((xpOf(w) - xp0) / (Date.now() - t0)) * 3_600_000;
    expectNear(first.perHour!, measured, 0.15);
    const later = gauge(w)!;
    expect(later.basis).toBe('steady');
    expectNear(later.perHour!, measured, 0.03);
  });

  it('pays a hire\'s share through the same rule as the fight', async () => {
    const w = await gnatWorld();
    hire(w, hireOf('sellsword', 1));
    wireForecasts(w);
    const read = settledRead(w)!;
    const paid = winFight(w)[0];
    expect(paid).toBe(Math.ceil(100 * 1.8 * 0.91));
    expect(read.perHour).toBe(roundToTwoFigures(paid * 100));
  });

  it('reads each member\'s own level gap', async () => {
    const w = await gnatWorld();
    stock(w, { gnat: { xp: 100, level: 20 } });
    setLevel(w, 'alice', 10);
    await joinAlice(w, 'bob', 'Mage');
    setLevel(w, 'bob', 25);
    wireForecasts(w);
    const reads = [settledRead(w)!, gauge(w, 'bob')!];
    const paid = winFight(w, ['alice', 'bob']);
    expect(paid[0]).toBeGreaterThan(paid[1] * 2);
    expect(reads.map(r => r.perHour)).toEqual(paid.map(xp => roundToTwoFigures(xp * 100)));
  });

  it('pays a carried friend as the carrier is paid', async () => {
    const w = await gnatWorld();
    stock(w, { gnat: { xp: 100, level: 14, hp: 2, damage: 2 } });
    setLevel(w, 'alice', 3);
    await joinAlice(w, 'bob', 'Mage');
    setLevel(w, 'bob', 12);
    wireForecasts(w);
    const reads = [settledRead(w)!, gauge(w, 'bob')!];
    const paid = winFight(w, ['alice', 'bob']);
    expect(paid[0]).toBe(paid[1]);
    expect(paid[0]).toBeGreaterThan(Math.ceil(100 * 1.8 * 0.91));
    expect(reads.map(r => r.perHour)).toEqual(paid.map(xp => roundToTwoFigures(xp * 100)));
  });

  it('keeps the starter zone rule for a player alone', async () => {
    const w = await gnatWorld();
    const zone: ZoneDefinition = { id: 'z', displayName: 'Zed', encounterTable: [], levelRange: [1, 5], starterZone: true };
    Object.assign(w.content, { getAllZones: () => ({ z: zone }), getZone: () => zone });
    w.contentState.contentEpoch++;
    wireForecasts(w);
    const read = settledRead(w)!;
    const paid = winFight(w)[0];
    expect(paid).toBe(Math.ceil(100 * 1.8 * 0.8));
    expect(read.perHour).toBe(roundToTwoFigures(paid * 100));
  });

  it('reads every table entry from its own forecast with the party\'s XP bonus, and charges what auto-retreat skips unless held', async () => {
    const w = await gnatWorld();
    const here = tileId(START.col, START.row);
    w.tiles.find(t => t.id === here)!.encounterTable = [{ encounterId: 'gnats', weight: 1 }, { encounterId: 'ogres', weight: 1 }];
    w.contentState.contentEpoch++;
    hire(w, hireOf('bard', 1, ['bard_inspiration']));
    w.stub.fallback.verdict = {
      winPct: 50, ci: [43, 57], sims: 200, strata: [
        { entryId: 'ogres', label: 'Ogres', winPct: 0, sharePct: 50, meanMs: 20_000, packFactor: 1 },
        { entryId: 'gnats', label: 'Gnats', winPct: 100, sharePct: 50, meanMs: 30_000, packFactor: 1 },
      ],
    };
    w.pm.partyBattles.setForecaster(w.svc);
    const pay = Math.ceil(100 * 1.2 * 1.8 * 0.91);

    const skipping = settledRead(w)!;
    expect(skipping.perHour).toBe(roundToTwoFigures(((0.5 * pay) / (0.5 * (30_000 + WIN_PAUSE) + 0.5 * SKIP)) * HOUR));

    w.entry().retreatHold = { tileId: here };
    const held = gauge(w)!;
    expect(held.perHour).toBe(roundToTwoFigures(((0.5 * pay) / (0.5 * (30_000 + WIN_PAUSE) + 0.5 * (20_000 + LOSS_PAUSE))) * HOUR));
  });

  it('counts a lost fight against the win chance, and says so once most are lost', async () => {
    const w = await forecastWorld();
    stock(w, { ogre: { damage: 1_000_000 } });
    w.stub.fallback.verdict = verdict('ogres', 100, 10_000);
    w.pm.partyBattles.setForecaster(w.svc);
    w.pm.handleSetCombatPrefs('alice', 0);
    w.entry().battleTimer.restartBattle();
    waitOutPause(w);
    expect(settledRead(w)!.basis).toBe('estimate');

    finishFight(w);
    expect(combat(w).result).toBe('defeat');
    const win = 5 / 6;
    const ms = (5 * 10_000 + combatRealElapsedMs(combat(w))) / 6;
    expect(gauge(w)).toEqual({ basis: 'settling', perHour: roundToTwoFigures(((win * 2) / (ms + win * WIN_PAUSE + (1 - win) * LOSS_PAUSE)) * HOUR) });

    for (let i = 0; i < 5; i++) {
      waitOutPause(w);
      finishFight(w);
    }
    expect(gauge(w)!.losing).toBeUndefined();
    waitOutPause(w);
    finishFight(w);
    expect(gauge(w)!.losing).toBe(true);
  });

  it('charges a lost fight the wipe wait', async () => {
    const w = await forecastWorld();
    w.stub.fallback.verdict = verdict('ogres', 50, 10_000);
    w.pm.partyBattles.setForecaster(w.svc);
    w.pm.handleSetCombatPrefs('alice', 0);
    const read = settledRead(w)!;
    const pay = Math.ceil(1 * 1.8);
    const time = 10_000 + 0.5 * GAUGE_TIMING.winPauseMs + 0.5 * GAUGE_TIMING.lossPauseMs;
    expect(read.perHour).toBe(roundToTwoFigures(((0.5 * pay) / time) * 3_600_000));
    expect(read.losing).toBeUndefined();
  });

  it('holds what each member was sent through small moves', async () => {
    const w = await forecastWorld();
    w.stub.fallback.verdict = verdict('ogres', 50, 10_000);
    w.pm.partyBattles.setForecaster(w.svc);
    w.pm.handleSetCombatPrefs('alice', 0);
    settledRead(w);
    const raw = ((0.5 * Math.ceil(1 * 1.8)) / (10_000 + 0.5 * WIN_PAUSE + 0.5 * LOSS_PAUSE)) * HOUR;
    const shown = (w.entry() as unknown as { gauge: { shown: Map<string, { perHour: number; losing: boolean }> } }).gauge.shown;
    expect(shown.get('alice')).toEqual({ perHour: roundToTwoFigures(raw), losing: false });

    shown.set('alice', { perHour: raw * 1.04, losing: true });
    expect(gauge(w)).toMatchObject({ perHour: raw * 1.04, losing: true });

    shown.set('alice', { perHour: raw * 1.06, losing: false });
    const moved = gauge(w)!;
    expect(moved.perHour).toBe(roundToTwoFigures(raw));
    expect(moved.losing).toBeUndefined();
  });
});

describe('XP gauge, one tally per party and room', () => {
  async function farmed(): Promise<ForecastWorld> {
    const w = await gnatWorld();
    wireForecasts(w);
    gauge(w);
    vi.advanceTimersByTime(60_000);
    expect(gauge(w)!.basis).toBe('steady');
    return w;
  }

  it('starts over in a new room, and again on the way back', async () => {
    const w = await farmed();
    walkTo(w, NEXT);
    expect(gauge(w)).toEqual({ basis: 'measuring' });
    vi.advanceTimersByTime(50);
    expect(gauge(w)!.basis).toBe('estimate');
    vi.advanceTimersByTime(10_000);
    expect(gauge(w)!.basis).toBe('settling');
    walkTo(w, START);
    expect(gauge(w)!.basis).toBe('estimate');
  });

  it('starts over when the party changes', async () => {
    const w = await farmed();
    await joinAlice(w, 'bob', 'Mage');
    expect(settledRead(w)!.basis).toBe('estimate');
  });

  it('never counts a quest or gift lump, which only the reset counter sees', async () => {
    const w = await farmed();
    const session = w.pm.getSessionByUsername('alice')!;
    const before = { gauge: gauge(w), counter: session.getState([]).character!.xpRate.totalXp, level: session.getLevel() };
    session.grantXp(5000, 'Quest reward');
    expect(session.getLevel()).toBe(before.level);
    expect(session.getState([]).character!.xpRate.totalXp).toBe(before.counter + 5000);
    expect(gauge(w)).toEqual(before.gauge);
  });
});

describe('XP gauge, rooms and fights', () => {
  it('reads 0 at once in a room that pays nothing, without forecasting it, and flags it in the world data', async () => {
    const w = await gnatWorld({ encounters: { [`${TOWN.col},${TOWN.row}`]: 'rats' } });
    wireForecasts(w);
    w.pm.handleSetCombatPrefs('alice', 0);
    walkTo(w, TOWN);
    expect(gauge(w)).toEqual({ basis: 'steady', perHour: 0, noXp: true });
    vi.advanceTimersByTime(30_000);
    expect(roomJobs(w)).not.toContain(w.roomKey(tileId(TOWN.col, TOWN.row)));

    const tiles = w.session.getWorldData().tiles;
    expect(tiles.filter(t => t.noXp).map(t => t.id)).toEqual([tileId(TOWN.col, TOWN.row)]);
  });

  it('forecasts only the room a party stops in, and nothing extra when auto-retreat already does', async () => {
    const off = await gnatWorld();
    wireForecasts(off);
    off.pm.handleSetCombatPrefs('alice', 0);
    walkTo(off, TOWN);
    vi.advanceTimersByTime(50);
    expect(roomJobs(off)).toEqual([off.roomKey(tileId(START.col, START.row)), off.roomKey(tileId(TOWN.col, TOWN.row))]);

    const on = await gnatWorld();
    wireForecasts(on);
    on.entry().battleTimer.restartBattle();
    for (let i = 0; i < 20; i++) settledRead(on);
    expect(roomJobs(on)).toEqual([on.roomKey(tileId(START.col, START.row))]);
  });

  it('pushes the new figure to the members when its own forecast lands', async () => {
    const w = await gnatWorld();
    wireForecasts(w);
    w.pm.handleSetCombatPrefs('alice', 0);
    expect(gauge(w)).toEqual({ basis: 'measuring' });
    w.ws.send.mockClear();
    vi.advanceTimersByTime(50);
    const pushed = pushedGauges(w.ws);
    expect(pushed[pushed.length - 1]?.basis).toBe('estimate');
  });

  it('asks for its room forecast once per stay, however often it is read', async () => {
    const w = await gnatWorld();
    w.stub.gated.add('room:');
    wireForecasts(w);
    const request = vi.spyOn(w.svc, 'request');
    w.pm.handleSetCombatPrefs('alice', 0);
    for (let i = 0; i < 5; i++) expect(gauge(w)).toEqual({ basis: 'measuring' });
    expect(request.mock.calls.filter(([req]) => req.key.includes('room:'))).toHaveLength(1);
  });

  it('reads the roster of the fight under way rather than building another', async () => {
    const w = await gnatWorld();
    wireForecasts(w);
    w.entry().battleTimer.restartBattle();
    waitOutPause(w);
    settledRead(w);
    const build = vi.spyOn(w.pm.partyBattles, 'buildPartyCombatants');
    expect(w.pm.partyBattles.getXpGauge(w.partyId, 'alice')!.basis).toBe('estimate');
    expect(build).not.toHaveBeenCalled();
    finishFight(w);
    build.mockClear();
    w.pm.partyBattles.getXpGauge(w.partyId, 'alice');
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('charges a skipped pack what the battle loop takes to skip it', async () => {
    const w = await forecastWorld();
    w.stub.fallback.verdict = badPack('ogres');
    w.pm.partyBattles.setForecaster(w.svc);
    w.entry().battleTimer.restartBattle();
    waitOutPause(w);
    const startedAt = Date.now();
    const step = combatRealStepMs(combat(w));
    nextFight(w);
    expect(w.journal()).toContain('Avoided Ogre (win chance 0%)');
    expect(Math.abs(Date.now() - startedAt - SKIP)).toBeLessThanOrEqual(step);
  });

  it('flags a room by its zone\'s table when it has none of its own, once content changes', async () => {
    const w = await gnatWorld();
    const flagged = () => w.session.getWorldData().tiles.filter(t => t.noXp).map(t => t.id);
    expect(flagged()).toEqual([]);
    const zone: ZoneDefinition = { id: 'z', displayName: 'Zed', encounterTable: [{ encounterId: 'rats', weight: 1 }], levelRange: [1, 5] };
    Object.assign(w.content, { getAllZones: () => ({ z: zone }), getZone: () => zone });
    w.contentState.contentEpoch++;
    expect(flagged()).toEqual(['elsewhere']);
  });

  it('only times a fight while it is under way', async () => {
    const w = await gnatWorld();
    wireForecasts(w);
    w.entry().battleTimer.restartBattle();
    waitOutPause(w);
    expect(settledRead(w)!.longFightInMs).toBeGreaterThan(0);
    finishFight(w);
    expect(gauge(w)!.longFightInMs).toBeUndefined();
  });

  it('says when the fight under way has run three times as long as usual', async () => {
    const w = await forecastWorld();
    w.stub.fallback.verdict = verdict('ogres', 0, 3000);
    w.pm.partyBattles.setForecaster(w.svc);
    w.pm.handleSetCombatPrefs('alice', 0);
    w.entry().battleTimer.restartBattle();
    waitOutPause(w);
    const first = settledRead(w)!;
    expect(first.losing).toBe(true);
    expect(first.longFightInMs).toBeGreaterThan(8000);
    expect(first.longFightInMs).toBeLessThanOrEqual(9000);
    vi.advanceTimersByTime(first.longFightInMs!);
    expect(gauge(w)!.longFightInMs).toBe(0);
  });
});

describe('XP gauge in a dungeon', () => {
  const den: DungeonDefinition = {
    id: 'den',
    name: 'Den',
    floors: [
      { floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'gnats', weight: 1 }], xpFactor: 0.5 },
      { floorNumber: 2, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'ogres', weight: 1 }] },
    ],
  };

  const halls: DungeonDefinition = {
    id: 'halls',
    name: 'Halls',
    floors: [1, 2, 3].map(floorNumber => ({ floorNumber, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'gnats', weight: 1 }] })),
  };

  it('shows what this run has paid since it began, measuring until the first floor is cleared', async () => {
    const w = await gnatWorld({ dungeon: { def: den, at: AT_START } });
    wireForecasts(w);
    const enteredAt = Date.now();
    expect(w.pm.partyBattles.enterDungeon(w.partyId, 'den').success).toBe(true);
    expect(gauge(w)).toEqual({ basis: 'run' });
    waitOutPause(w);
    const before = xpOf(w);
    finishFight(w);
    const paid = xpOf(w) - before;
    expect(paid).toBe(Math.ceil(50 * 1.8));
    expect(gauge(w)).toEqual({ basis: 'run', perHour: roundToTwoFigures((paid * 3_600_000) / (Date.now() - enteredAt)) });

    expect(w.pm.partyBattles.leaveDungeon(w.partyId)).toBe(true);
    expect(gauge(w)!.basis).not.toBe('run');
  });

  it('adds up every floor the run has cleared', async () => {
    const w = await gnatWorld({ dungeon: { def: halls, at: AT_START } });
    wireForecasts(w);
    const enteredAt = Date.now();
    expect(w.pm.partyBattles.enterDungeon(w.partyId, 'halls').success).toBe(true);
    waitOutPause(w);
    let paid = 0;
    for (let floor = 0; floor < 2; floor++) {
      if (floor > 0) nextFight(w);
      const before = xpOf(w);
      finishFight(w);
      paid += xpOf(w) - before;
    }
    expect(paid).toBe(2 * Math.ceil(100 * 1.8));
    expect(gauge(w)).toEqual({ basis: 'run', perHour: roundToTwoFigures((paid * HOUR) / (Date.now() - enteredAt)) });
  });

  it('measures a restored run from the restore', async () => {
    const w = await gnatWorld({ dungeon: { def: halls, at: AT_START } });
    wireForecasts(w);
    const restoredAt = Date.now();
    w.pm.partyBattles.restoreDungeonRun(w.partyId, { dungeonId: 'halls', currentFloorIndex: 1, entrance: { ...START } });
    expect(gauge(w)).toEqual({ basis: 'run' });
    waitOutPause(w);
    const before = xpOf(w);
    finishFight(w);
    const paid = xpOf(w) - before;
    expect(paid).toBe(Math.ceil(100 * 1.8));
    expect(gauge(w)).toEqual({ basis: 'run', perHour: roundToTwoFigures((paid * HOUR) / (Date.now() - restoredAt)) });
  });
});
