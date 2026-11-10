import { describe, expect, it } from 'vitest';
import { createEncounter } from '../src/systems/EncounterTypes';
import type { EncounterDefinition } from '../src/systems/EncounterTypes';
import type { MonsterDefinition } from '../src/systems/MonsterTypes';
import { createMonsterInstance } from '../src/systems/MonsterTypes';
import { fightXp } from '../src/systems/XpRules';
import { createRng } from '../src/systems/combat/CombatRng';
import {
  GAUGE_FORECAST_FIGHTS,
  GAUGE_HOLD_FRACTION,
  GAUGE_LOSING_BAND,
  GAUGE_LOSING_WIN_CHANCE,
  GAUGE_MAX_PACK_ROLLS,
  GAUGE_TIMING,
  RoomTally,
  createPaysXpCheck,
  gaugeStrata,
  holdShownGauge,
  meanPackXp,
  meanWinPay,
  readRoomGauge,
  roundToTwoFigures,
  usualFightMs,
} from '../src/systems/XpGauge';
import type { GaugeEntry, GaugeForecast, GaugePayInput } from '../src/systems/XpGauge';
import { monsterDef } from './combatTestUtils';

const { winPauseMs: WIN_PAUSE, lossPauseMs: LOSS_PAUSE, skipMs: SKIP } = GAUGE_TIMING;
const HOUR = 3_600_000;
const K = GAUGE_FORECAST_FIGHTS;

function entry(entryId: string, share: number, winPay: number, forecast?: Partial<GaugeForecast>, packXp = 10): GaugeEntry {
  const e: GaugeEntry = { entryId, share, winPay, packXp };
  if (forecast) e.forecast = { win: 1, meanMs: 18_200, packFactor: 1, skip: false, ...forecast };
  return e;
}

function record(tally: RoomTally, entryId: string, fights: number, won: (i: number) => boolean, ms: number, packXp = 10): void {
  for (let i = 0; i < fights; i++) tally.record(entryId, won(i), ms, packXp);
}

const MONSTERS: Record<string, MonsterDefinition> = {
  goblin: monsterDef({ id: 'goblin', name: 'Goblin', hp: 10, xp: 4 }),
  rat: monsterDef({ id: 'rat', name: 'Rat', hp: 1, xp: 0 }),
  wolf: monsterDef({ id: 'wolf', name: 'Wolf', hp: 20, damage: 5, xp: 10 }),
  bear: monsterDef({ id: 'bear', name: 'Bear', hp: 50, damage: 8, xp: 25 }),
  elder: monsterDef({ id: 'elder', name: 'Elder', hp: 200, damage: 20, xp: 60, level: 20 }),
};

const ENCOUNTERS: Record<string, EncounterDefinition> = {
  rats: { id: 'rats', name: 'Rats', type: 'explicit', placements: [{ monsterId: 'rat', gridPosition: 4 }] },
  elder: { id: 'elder', name: 'Elder', type: 'explicit', placements: [{ monsterId: 'elder', gridPosition: 4 }, { monsterId: 'wolf', gridPosition: 1 }] },
  pack: { id: 'pack', name: 'Pack', type: 'random', monsterPool: [{ monsterId: 'wolf', min: 1, max: 3 }, { monsterId: 'bear', min: 0, max: 2 }], roomMax: 3 },
  wolves: { id: 'wolves', name: 'Wolves', type: 'random', monsterPool: [{ monsterId: 'wolf', min: 1, max: 3 }] },
  haunted: { id: 'haunted', name: 'Haunted', type: 'random', monsterPool: [{ monsterId: 'ghost', min: 0, max: 1 }, { monsterId: 'wolf', min: 1, max: 3 }] },
  maybe_rats: { id: 'maybe_rats', name: 'Maybe Rats', type: 'random', monsterPool: [{ monsterId: 'rat', min: 0, max: 1 }] },
  horde: {
    id: 'horde', name: 'Horde', type: 'random', roomMax: 9,
    monsterPool: [{ monsterId: 'wolf', min: 0, max: 9 }, { monsterId: 'bear', min: 0, max: 9 }, { monsterId: 'rat', min: 0, max: 9 }],
  },
};

describe('readRoomGauge', () => {
  it('sums pay over time across the table, and a lost fight costs the same pause as a win', () => {
    const entries = [
      entry('pack', 0.9, 100, { win: 1, meanMs: 18_200 }),
      entry('boss', 0.1, 2000, { win: 0.8, meanMs: 118_200 }),
    ];
    const reading = readRoomGauge(entries, new RoomTally());
    const pay = 0.9 * 100 + 0.1 * 0.8 * 2000;
    const time = 0.9 * (18_200 + WIN_PAUSE) + 0.1 * (118_200 + 0.8 * WIN_PAUSE + 0.2 * LOSS_PAUSE);
    expect(reading.perHour).toBeCloseTo((pay / time) * HOUR, 6);
    expect(reading.basis).toBe('estimate');
    expect(reading.winChance).toBeCloseTo(0.98, 9);
    expect(LOSS_PAUSE).toBe(WIN_PAUSE);
  });

  it.each([
    [0, 'estimate'],
    [1, 'settling'],
    [10, 'steady'],
    [100, 'steady'],
  ] as const)('blends the forecast, worth five fights, with %i fights seen', (fights, basis) => {
    const entries = [entry('pack', 1, 100, { win: 1, meanMs: 10_000 })];
    const tally = new RoomTally();
    record(tally, 'pack', fights, () => true, 20_000);
    const ms = (K * 10_000 + fights * 20_000) / (K + fights);
    const reading = readRoomGauge(entries, tally);
    expect(reading.perHour).toBeCloseTo((100 / (ms + WIN_PAUSE)) * HOUR, 6);
    expect(reading.basis).toBe(basis);
    expect(usualFightMs(entries, tally, 'pack')).toBeCloseTo(ms, 6);
  });

  it('stays settling in a room won under 90 % until it has seen 100 fights', () => {
    const entries = [entry('pack', 1, 100, { win: 0.4 })];
    const tally = new RoomTally();
    record(tally, 'pack', 50, i => i % 3 === 0, 18_200);
    const settling = readRoomGauge(entries, tally);
    expect(settling.basis).toBe('settling');
    expect(settling.winChance).toBeLessThan(0.5);
    record(tally, 'pack', 50, i => i % 3 === 0, 18_200);
    expect(readRoomGauge(entries, tally).basis).toBe('steady');
  });

  it('settles from a wrong forecast on the fights it sees', () => {
    const entries = [entry('pack', 1, 100, { win: 1, meanMs: 10_000 })];
    const truth = ((0.5 * 100) / (30_000 + 0.5 * WIN_PAUSE + 0.5 * LOSS_PAUSE)) * HOUR;
    const tally = new RoomTally();
    expect(readRoomGauge(entries, tally).perHour! / truth).toBeGreaterThan(5);
    record(tally, 'pack', 400, i => i % 2 === 0, 30_000);
    const settled = readRoomGauge(entries, tally).perHour! / truth;
    expect(settled).toBeGreaterThan(0.98);
    expect(settled).toBeLessThan(1.04);
  });

  it('charges a pack auto-retreat skips its time and no pay', () => {
    const entries = [
      entry('easy', 0.5, 100, { win: 1, meanMs: 18_200 }),
      entry('deadly', 0.5, 9000, { win: 0.05, meanMs: 40_000, skip: true }),
    ];
    const tally = new RoomTally();
    record(tally, 'deadly', 3, () => true, 40_000);
    const expected = ((0.5 * 100) / (0.5 * (18_200 + WIN_PAUSE) + 0.5 * SKIP)) * HOUR;
    expect(readRoomGauge(entries, tally).perHour).toBeCloseTo(expected, 6);
    expect(usualFightMs(entries, tally, 'deadly')).toBeNull();
  });

  it('scales pay by the pack factor and learns it from the packs won', () => {
    const entries = [entry('pool', 1, 300, { win: 0.5, packFactor: 0.8 }, 30)];
    const tally = new RoomTally();
    expect(readRoomGauge(entries, tally).perHour).toBeCloseTo(((0.5 * 300 * 0.8) / (18_200 + 0.5 * WIN_PAUSE + 0.5 * LOSS_PAUSE)) * HOUR, 6);
    record(tally, 'pool', 200, i => i % 2 === 0, 18_200, 15);
    const factor = (K * 0.8 + 100 * 0.5) / (K + 100);
    const win = (K * 0.5 + 100) / (K + 200);
    expect(readRoomGauge(entries, tally).perHour).toBeCloseTo(((win * 300 * factor) / (18_200 + win * WIN_PAUSE + (1 - win) * LOSS_PAUSE)) * HOUR, 6);
  });

  it('reads nothing without a forecast until a fight is won, then the fights seen alone', () => {
    const entries = [entry('a', 0.5, 100), entry('b', 0.5, 300)];
    const tally = new RoomTally();
    expect(readRoomGauge(entries, tally).perHour).toBeNull();
    tally.record('a', false, 10_000, 10);
    expect(readRoomGauge(entries, tally).perHour).toBeNull();
    tally.record('a', true, 18_200, 10);
    const reading = readRoomGauge(entries, tally);
    expect(reading.perHour).toBeCloseTo(((0.25 * 100 + 0.25 * 300) / (14_100 + 0.5 * WIN_PAUSE + 0.5 * LOSS_PAUSE)) * HOUR, 6);
    expect(reading.winChance).toBeCloseTo(0.5, 9);
    expect(usualFightMs(entries, tally, 'b')).toBeCloseTo(14_100, 6);
    expect(usualFightMs(entries, tally, 'missing')).toBeNull();
  });

  it('counts the forecast as five fights', () => {
    const entries = [entry('pack', 1, 100, { win: 1, meanMs: 10_000 })];
    const tally = new RoomTally();
    record(tally, 'pack', 5, () => true, 20_000);
    expect(usualFightMs(entries, tally, 'pack')).toBeCloseTo(15_000, 9);
  });

  it('reads a room that pays nothing as zero', () => {
    const reading = readRoomGauge([entry('rats', 1, 0, { win: 1, meanMs: 900 })], new RoomTally());
    expect(reading.perHour).toBe(0);
  });
});

describe('packs and pay', () => {
  it('lists every pack a random entry can roll, as createEncounter rolls them', () => {
    const [stratum] = gaugeStrata([{ encounterId: 'pack', weight: 1 }], MONSTERS, ENCOUNTERS);
    expect(stratum.packs.reduce((sum, p) => sum + p.chance, 0)).toBeCloseTo(1, 9);
    expect(Math.max(...stratum.packs.map(p => p.monsters.length))).toBe(3);

    const rng = createRng(7);
    const counts = new Map<string, number>();
    const rolls = 20_000;
    for (let i = 0; i < rolls; i++) {
      const key = createEncounter(undefined, MONSTERS, {}, ENCOUNTERS, [{ encounterId: 'pack', weight: 1 }], rng).map(m => m.id).sort().join('|');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const pack of stratum.packs) {
      const key = pack.monsters.map(m => m.id).sort().join('|');
      expect(Math.abs((counts.get(key) ?? 0) / rolls - pack.chance)).toBeLessThan(0.015);
    }
    expect(counts.size).toBe(stratum.packs.length);
  });

  it('splits a table like the room forecast and falls back like createEncounter', () => {
    const strata = gaugeStrata([{ encounterId: 'wolves', weight: 3 }, { encounterId: 'rats', weight: 1 }, { encounterId: 'wolves', weight: 0 }], MONSTERS, ENCOUNTERS);
    expect(strata.map(s => [s.entryId, s.share])).toEqual([['wolves', 0.75], ['rats', 0.25]]);
    const [fallback] = gaugeStrata([], MONSTERS, ENCOUNTERS);
    expect(fallback.entryId).toBe('');
    expect(fallback.packs).toHaveLength(1);
    expect(fallback.packs[0].monsters.map(m => m.id)).toEqual(['goblin', 'goblin']);
    expect(gaugeStrata([{ encounterId: 'missing', weight: 1 }], MONSTERS, ENCOUNTERS)[0].packs[0].monsters.map(m => m.id)).toEqual(['goblin', 'goblin']);
    const maybe = gaugeStrata([{ encounterId: 'maybe_rats', weight: 1 }], MONSTERS, ENCOUNTERS)[0];
    expect(maybe.packs.map(p => [p.monsters.map(m => m.id).join('|'), p.chance])).toEqual([['goblin|goblin', 0.5], ['rat', 0.5]]);
  });

  it('rolls past a pool monster that is missing from content, as createEncounter does', () => {
    const [stratum] = gaugeStrata([{ encounterId: 'haunted', weight: 1 }], MONSTERS, ENCOUNTERS);
    const byCount = stratum.packs.map(p => [p.monsters.length, p.chance]).sort((a, b) => a[0] - b[0]);
    expect(byCount.map(([n]) => n)).toEqual([1, 2, 3]);
    byCount.forEach(([, chance]) => expect(chance).toBeCloseTo(1 / 3, 9));
    expect(stratum.packs.every(p => p.monsters.every(m => m.id === 'wolf'))).toBe(true);
  });

  it('samples a pool with too many rolls to list, the same way every time', () => {
    const a = gaugeStrata([{ encounterId: 'horde', weight: 1 }], MONSTERS, ENCOUNTERS)[0];
    const b = gaugeStrata([{ encounterId: 'horde', weight: 1 }], MONSTERS, ENCOUNTERS)[0];
    expect(10 ** 3).toBeGreaterThan(GAUGE_MAX_PACK_ROLLS);
    expect(a.packs.reduce((sum, p) => sum + p.chance, 0)).toBeCloseTo(1, 9);
    expect(a.packs.map(p => p.chance)).toEqual(b.packs.map(p => p.chance));
    expect(meanPackXp(a)).toBeCloseTo(meanPackXp(b), 9);
  });

  it('pays a win through fightXp, with hires, level gaps, starter zones and floors', () => {
    const [stratum] = gaugeStrata([{ encounterId: 'elder', weight: 1 }], MONSTERS, ENCOUNTERS);
    const pack = [createMonsterInstance(MONSTERS.elder, 4), createMonsterInstance(MONSTERS.wolf, 1)];
    const inputs: GaugePayInput[] = [
      { memberLevel: 20, topHumanLevel: 20, bodies: 1, rewardMultiplier: 1.8 },
      { memberLevel: 20, topHumanLevel: 20, bodies: 3, rewardMultiplier: 1.8 },
      { memberLevel: 10, topHumanLevel: 25, bodies: 2, rewardMultiplier: 1.8 },
      { memberLevel: 30, topHumanLevel: 30, bodies: 2, rewardMultiplier: 1.8 },
      { memberLevel: 10, topHumanLevel: 12, bodies: 2, rewardMultiplier: 1.8 },
      { memberLevel: 20, topHumanLevel: 20, bodies: 1, starterZone: true, rewardMultiplier: 1.8 },
      { memberLevel: 20, topHumanLevel: 20, bodies: 2, starterZone: true, xpBonus: 1.2, rewardMultiplier: 1.8 },
      { memberLevel: 20, topHumanLevel: 20, bodies: 1, floorXpFactor: 0.5, xpBonus: 1.1, rewardMultiplier: 1.8 },
    ];
    const pays = inputs.map(input => meanWinPay(stratum, input));
    pays.forEach((pay, i) => expect(pay).toBe(fightXp({ ...inputs[i], monsters: pack })));
    expect(new Set(pays).size).toBe(pays.length);
  });

  it('averages a random entry\'s pay over its packs', () => {
    const [stratum] = gaugeStrata([{ encounterId: 'wolves', weight: 1 }], MONSTERS, ENCOUNTERS);
    const input: GaugePayInput = { memberLevel: 5, topHumanLevel: 5, bodies: 2, rewardMultiplier: 1.8 };
    const byCount = [1, 2, 3].map(n => fightXp({ ...input, monsters: Array.from({ length: n }, () => createMonsterInstance(MONSTERS.wolf)) }));
    expect(meanWinPay(stratum, input)).toBeCloseTo(byCount.reduce((a, b) => a + b, 0) / 3, 9);
    expect(meanPackXp(stratum)).toBeCloseTo(20, 9);
  });

  it('knows a table that pays nobody any XP', () => {
    const paysXp = createPaysXpCheck(MONSTERS, ENCOUNTERS);
    expect(paysXp([{ encounterId: 'rats', weight: 1 }])).toBe(false);
    expect(paysXp([{ encounterId: 'rats', weight: 5 }, { encounterId: 'wolves', weight: 1 }])).toBe(true);
    expect(paysXp([{ encounterId: 'rats', weight: 1 }, { encounterId: 'wolves', weight: 0 }])).toBe(false);
    expect(paysXp([])).toBe(true);
    expect(paysXp([{ encounterId: 'maybe_rats', weight: 1 }])).toBe(true);
    const noFallbackPay = createPaysXpCheck({ ...MONSTERS, goblin: { ...MONSTERS.goblin, xp: 0 } }, ENCOUNTERS);
    expect(noFallbackPay([])).toBe(false);
    expect(noFallbackPay([{ encounterId: 'maybe_rats', weight: 1 }])).toBe(false);
  });
});

describe('roundToTwoFigures', () => {
  it('keeps two significant figures and whole numbers below ten', () => {
    expect(roundToTwoFigures(12_345)).toBe(12_000);
    expect(roundToTwoFigures(987)).toBe(990);
    expect(roundToTwoFigures(995)).toBe(1000);
    expect(roundToTwoFigures(1_250_000)).toBe(1_300_000);
    expect(roundToTwoFigures(7.4)).toBe(7);
    expect(roundToTwoFigures(0)).toBe(0);
    expect(roundToTwoFigures(Number.NaN)).toBe(0);
    expect(roundToTwoFigures(-5)).toBe(0);
  });
});

describe('holdShownGauge', () => {
  it('shows the first reading as it is, losing under half', () => {
    expect(holdShownGauge(undefined, 12_345, 0.49)).toEqual({ perHour: 12_000, losing: true });
    expect(holdShownGauge(undefined, 812, 0.5)).toEqual({ perHour: 810, losing: false });
  });

  it('holds the figure until a reading moves past the band around it', () => {
    const shown = { perHour: 800, losing: false };
    const band = GAUGE_HOLD_FRACTION * 800;
    expect(holdShownGauge(shown, 800 + band, 1).perHour).toBe(800);
    expect(holdShownGauge(shown, 800 - band, 1).perHour).toBe(800);
    expect(holdShownGauge(shown, 800 + band + 1, 1).perHour).toBe(roundToTwoFigures(800 + band + 1));
    expect(holdShownGauge(shown, 700, 1).perHour).toBe(700);
    expect(holdShownGauge({ perHour: 0, losing: false }, 3, 1).perHour).toBe(3);
  });

  it('moves the losing note only once the win chance passes the band either side of half', () => {
    const on = { perHour: 100, losing: true };
    const off = { perHour: 100, losing: false };
    expect(holdShownGauge(on, 100, GAUGE_LOSING_WIN_CHANCE + GAUGE_LOSING_BAND - 0.01).losing).toBe(true);
    expect(holdShownGauge(on, 100, GAUGE_LOSING_WIN_CHANCE + GAUGE_LOSING_BAND).losing).toBe(false);
    expect(holdShownGauge(off, 100, GAUGE_LOSING_WIN_CHANCE - GAUGE_LOSING_BAND).losing).toBe(false);
    expect(holdShownGauge(off, 100, GAUGE_LOSING_WIN_CHANCE - GAUGE_LOSING_BAND - 0.01).losing).toBe(true);
  });
});
