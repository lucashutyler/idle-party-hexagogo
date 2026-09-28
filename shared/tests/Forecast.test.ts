import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  FORECAST_HORIZON_AFTER_ENRAGE_MS,
  FORECAST_HORIZON_WITHOUT_ENRAGE_MS,
  FORECAST_MAX_REASONS,
  FORECAST_MIN_SIMS,
  FORECAST_SIM_BUDGET,
  createForecastJob,
  defaultHorizonMs,
  forecastReasons,
  formatForecastClock,
  killEtaFor,
  partyKey,
  quantile,
  runForecast,
  seedFromKey,
  simulateToEnd,
  summarize,
  wilsonInterval,
} from '../src/systems/Forecast';
import type { DungeonForecastInput, ForecastReasonInput, RoomForecastInput, SimOutcome } from '../src/systems/Forecast';
import { cloneCombatState, createPartyCombatState, processCombatStep } from '../src/systems/CombatEngine';
import { ENRAGE_TIER_DEFAULTS } from '../src/systems/CombatScaling';
import type { PartyCombatantInit } from '../src/systems/CombatEngine';
import { createRng } from '../src/systems/combat/CombatRng';
import type { EncounterDefinition } from '../src/systems/EncounterTypes';
import type { MonsterDefinition } from '../src/systems/MonsterTypes';
import type { DungeonDefinition, DungeonFloor } from '../src/systems/DungeonTypes';
import type { EncounterTableEntry } from '../src/systems/ZoneTypes';
import { SEED_SKILLS } from '../src/systems/SkillTypes';
import { makeMonster, makePlayer, monsterDef } from './combatTestUtils';

afterEach(() => {
  vi.restoreAllMocks();
});

const MONSTERS: Record<string, MonsterDefinition> = {
  weakling: monsterDef({ id: 'weakling', name: 'Weakling', hp: 10, damage: 1 }),
  killer: monsterDef({ id: 'killer', name: 'Killer', hp: 1e9, damage: 100000 }),
  healer: monsterDef({ id: 'healer', name: 'Healer', hp: 1e6, damage: 1, skills: [{ skillId: 'heal', value: 1e6, cooldown: 0, castTime: 0 }] }),
  caster: monsterDef({ id: 'caster', name: 'Caster', hp: 1e9, damage: 100000, skills: [{ skillId: 'fireball', value: 5, cooldown: 3 }] }),
  boss_killer: monsterDef({ id: 'boss_killer', name: 'Doom', hp: 1e9, damage: 100000, tier: 'boss' }),
  raid_killer: monsterDef({ id: 'raid_killer', name: 'Ruin', hp: 1e9, damage: 100000, tier: 'raid' }),
  chief: monsterDef({ id: 'chief', name: 'Chief', hp: 2400, damage: 100, tier: 'boss' }),
};

function explicit(id: string, monsterId: string): EncounterDefinition {
  return { id, name: `${MONSTERS[monsterId].name}s`, type: 'explicit', placements: [{ monsterId, gridPosition: 4 }] };
}

const ENCOUNTERS: Record<string, EncounterDefinition> = {
  easy: explicit('easy', 'weakling'),
  deadly: explicit('deadly', 'killer'),
  stall: explicit('stall', 'healer'),
  casters: explicit('casters', 'caster'),
  boss_deadly: explicit('boss_deadly', 'boss_killer'),
  raid_deadly: explicit('raid_deadly', 'raid_killer'),
  chief_room: explicit('chief_room', 'chief'),
};

const hero = (): PartyCombatantInit => makePlayer('Hero', 2, { hp: 1000, baseDamage: 100 });

function room(table: EncounterTableEntry[], players: PartyCombatantInit[] = [hero()]): RoomForecastInput {
  return { kind: 'room', players, table, monsters: MONSTERS, encounters: ENCOUNTERS };
}

function entry(encounterId: string, weight = 1): EncounterTableEntry {
  return { encounterId, weight };
}

function floor(floorNumber: number, table: EncounterTableEntry[], extra: Partial<DungeonFloor> = {}): DungeonFloor {
  return { floorNumber, gridShape: { cols: 3, rows: 3 }, encounterTable: table, ...extra };
}

function dungeon(floors: DungeonFloor[], extra: Partial<DungeonForecastInput> = {}): DungeonForecastInput {
  const def: DungeonDefinition = { id: 'd', name: 'Den', floors };
  return { kind: 'dungeon', players: [hero()], dungeon: def, monsters: MONSTERS, encounters: ENCOUNTERS, ...extra };
}

const CHIEF_FLOOR = floor(2, [entry('chief_room')], { isBoss: true, checkpoints: [0.66, 0.33], maxWipes: 3 });

describe('simulateToEnd', () => {
  const fight = (monster: Partial<MonsterDefinition>) => createPartyCombatState([hero()], [makeMonster(4, monster)]);

  it('classifies wins, wipes, stalemates and timeouts', () => {
    expect(simulateToEnd(fight({ hp: 10 }), createRng(1), 60000)).toEqual({ result: 'victory', elapsedMs: 1000 });
    expect(simulateToEnd(fight({ hp: 1e9, damage: 1e6 }), createRng(1), 60000)).toEqual({ result: 'defeat', elapsedMs: 1400 });
    const stall = fight({ hp: 1e6, skills: [{ skillId: 'heal', value: 1e6, cooldown: 0, castTime: 0 }] });
    const stalled = simulateToEnd(stall, createRng(1), 600000);
    expect(stalled.result).toBe('stalemate');
    expect(stall.players[0].currentHp).toBeGreaterThan(0);
    expect(simulateToEnd(fight({ hp: 1e9 }), createRng(1), 5000)).toEqual({ result: 'timeout', elapsedMs: 5000 });
  });

  it('advances the given state in place', () => {
    const state = fight({ hp: 10 });
    simulateToEnd(state, createRng(1), 60000);
    expect(state.finished).toBe(true);
  });

  it('reports the share of boss HP dealt, from which a kill ETA extrapolates', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random used');
    });
    const outcome = simulateToEnd(fight({ hp: 1000, tier: 'boss' }), () => 0.4, 3000);
    expect(outcome).toEqual({ result: 'timeout', elapsedMs: 3000, bossDamageFrac: 0.3 });
    expect(killEtaFor(outcome)).toBe(10000);
    expect(killEtaFor({ result: 'victory', elapsedMs: 5000 })).toBeNull();
    expect(killEtaFor({ result: 'defeat', elapsedMs: 5000, bossDamageFrac: 0 })).toBe(Infinity);
    expect(killEtaFor({ result: 'defeat', elapsedMs: 100000, bossDamageFrac: 0.5 }, 60000)).toBe(140000);
  });
});

describe('forecast statistics', () => {
  it('computes Wilson 95 % intervals', () => {
    const [lo, hi] = wilsonInterval(0.6, 20);
    expect(lo).toBeCloseTo(0.3866, 3);
    expect(hi).toBeCloseTo(0.7812, 3);
    expect(wilsonInterval(0, 30)[0]).toBe(0);
    expect(wilsonInterval(0, 30)[1]).toBeCloseTo(0.1135, 3);
    expect(wilsonInterval(1, 30)[0]).toBeCloseTo(0.8865, 3);
    expect(wilsonInterval(1, 30)[1]).toBe(1);
    expect(wilsonInterval(0.5, 0)).toEqual([0, 1]);
    expect(wilsonInterval(7, 10)).toEqual(wilsonInterval(1, 10));
  });

  it('uses nearest-rank quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.9)).toBe(4);
    expect(quantile([5], 0.5)).toBe(5);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it('summarises counts, interval and victory times', () => {
    const outcomes: SimOutcome[] = [
      { result: 'victory', elapsedMs: 1000 },
      { result: 'victory', elapsedMs: 3000 },
      { result: 'defeat', elapsedMs: 900 },
      { result: 'victory', elapsedMs: 2000 },
      { result: 'stalemate', elapsedMs: 31000 },
      { result: 'timeout', elapsedMs: 99000 },
    ];
    const [lo, hi] = wilsonInterval(0.5, 6);
    expect(summarize(outcomes)).toEqual({
      sims: 6, wins: 3, losses: 1, stalemates: 2, winPct: 50,
      ci: [Math.round(lo * 1000) / 10, Math.round(hi * 1000) / 10],
      medianMs: 2000, p90Ms: 3000, atMs: 0, killEtaMs: null,
    });
    expect(summarize(outcomes.slice(0, 2))).toMatchObject({ medianMs: null, p90Ms: null, winPct: 100 });
    expect(summarize(outcomes, { winRate: 0.75 })).toMatchObject({ winPct: 75, wins: 3 });
    expect(summarize([])).toMatchObject({ sims: 0, winPct: 0, ci: [0, 100], medianMs: null });
  });

  it('takes the median kill ETA from the clone point, extrapolating losses', () => {
    const outcomes: SimOutcome[] = [
      { result: 'victory', elapsedMs: 90000, bossDamageFrac: 1 },
      { result: 'defeat', elapsedMs: 100000, bossDamageFrac: 0.5 },
      { result: 'defeat', elapsedMs: 100000, bossDamageFrac: 0 },
    ];
    expect(summarize(outcomes, { atMs: 60000 })).toMatchObject({ atMs: 60000, killEtaMs: 140000 });
    expect(summarize([outcomes[2], outcomes[2]]).killEtaMs).toBeNull();
    expect(summarize(outcomes, { killEtas: [5000, 7000, 9000] }).killEtaMs).toBe(7000);
  });
});

describe('partyKey', () => {
  const party = (): PartyCombatantInit[] => [
    makePlayer('Anna', 2, { className: 'Knight', level: 10, skills: [SEED_SKILLS.knight_guard, SEED_SKILLS.knight_bash] }),
    makePlayer('Bob', 5, { className: 'Priest', level: 9, skills: [SEED_SKILLS.priest_minor_heal] }),
  ];

  it('ignores usernames and member order', () => {
    const key = partyKey(party());
    expect(key).toMatch(/^pk[0-9a-f]{14}$/);
    const renamed = party().map((p, i) => ({ ...p, username: `x${i}` }));
    expect(partyKey(renamed)).toBe(key);
    expect(partyKey(party().reverse())).toBe(key);
  });

  it('changes with anything that changes the fight', () => {
    const key = partyKey(party());
    const variants: ((p: PartyCombatantInit[]) => void)[] = [
      p => { p[0].level = 11; },
      p => { p[0].maxHp = 999; },
      p => { p[0].baseDamage = 11; },
      p => { p[0].playerDamageType = 'magical'; },
      p => { p[0].gridPosition = 8; },
      p => { p[1].isHenchman = true; },
      p => { p[0].equipBonuses = { bonusAttackMin: 1, bonusAttackMax: 2, damageReductionMin: 0, damageReductionMax: 0, magicReductionMin: 0, magicReductionMax: 0 }; },
      p => { p[0].setBonuses = { damagePercent: 5 }; },
      p => { p[0].className = 'Mage'; },
      p => { p[0].equippedSkills = [SEED_SKILLS.knight_guard]; },
      p => { p[0].equippedSkills = [SEED_SKILLS.knight_guard, { ...SEED_SKILLS.knight_bash, cooldown: 9 }]; },
      p => { p[0].mastery = { goblin: 1 }; },
    ];
    for (const change of variants) {
      const p = party();
      change(p);
      expect(partyKey(p)).not.toBe(key);
    }
  });

  it('includes mastery ranks ≥ 1 only, in any key order', () => {
    const withMastery = (mastery: Record<string, number>) => {
      const p = party();
      p[0].mastery = mastery;
      return partyKey(p);
    };
    expect(withMastery({ goblin: 0, wolf: 0.5 })).toBe(partyKey(party()));
    expect(withMastery({ goblin: 2, wolf: 1 })).toBe(withMastery({ wolf: 1, goblin: 2 }));
    expect(withMastery({ goblin: 2.7 })).toBe(withMastery({ goblin: 2 }));
    expect(withMastery({ goblin: 3 })).not.toBe(withMastery({ goblin: 2 }));
  });

  it('derives stable 32-bit seeds from keys', () => {
    const seed = seedFromKey('2026.09.27.1|3|pk00|room:1,2');
    expect(seed).toBe(seedFromKey('2026.09.27.1|3|pk00|room:1,2'));
    expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
    expect(seedFromKey('a')).not.toBe(seedFromKey('b'));
  });
});

describe('room forecasts', () => {
  it('are deterministic per key, however the job is sliced', () => {
    const input = room([entry('easy'), entry('deadly', 3)]);
    const a = runForecast(input, { key: 'room:a' });
    expect(runForecast(input, { key: 'room:a' })).toEqual(a);

    const sliced = createForecastJob(input, { key: 'room:a' });
    let steps = 0;
    while (!sliced.done) {
      const used = sliced.advance(7);
      expect(used).toBeLessThanOrEqual(7);
      steps += used;
    }
    expect(sliced.result()).toEqual(a);
    expect(steps).toBeGreaterThan(0);

    const other = runForecast(room([entry('easy'), entry('stall')]), { key: 'room:a', seed: 99 });
    expect(other.key).toBe('room:a');
  });

  it('never mutates its inputs', () => {
    const input = room([entry('easy'), entry('deadly')]);
    const before = JSON.stringify(input);
    runForecast(input, { key: 'k' });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('stratifies sims by table entry and reports per-entry rates and the worst common one', () => {
    const r = runForecast(room([entry('easy'), entry('deadly', 3)]), { key: 'k' });
    expect(r.sims).toBe(FORECAST_SIM_BUDGET.trash);
    expect(r.wins).toBe(50);
    expect(r.winPct).toBe(25);
    expect(r.strata).toEqual([
      { label: 'Weaklings', entryId: 'easy', winPct: 100, sharePct: 25 },
      { label: 'Killers', entryId: 'deadly', winPct: 0, sharePct: 75 },
    ]);
    expect(r.worst).toEqual({ label: 'Killers', winPct: 0, sharePct: 75 });
    expect(r.partyKey).toBe(partyKey([hero()]));
    expect(r.medianMs).toBe(1000);
  });

  it('weights the estimate by the table, not by how sims happened to fall', () => {
    const r = runForecast(room([entry('easy', 7), entry('deadly', 3)]), { key: 'k', maxSims: 13 });
    expect(r.sims).toBe(13);
    expect(r.winPct).toBe(70);
  });

  it('never names a rare entry as the worst', () => {
    const r = runForecast(room([entry('easy', 19), entry('deadly', 1)]), { key: 'k' });
    expect(r.worst?.label).not.toBe('Killers');
    expect(r.strata?.find(s => s.entryId === 'deadly')?.sharePct).toBe(5);
  });

  it('merges duplicate entries and falls back like createEncounter', () => {
    expect(runForecast(room([entry('easy'), entry('easy'), entry('deadly', 2)]), { key: 'k' }).strata?.map(s => s.sharePct)).toEqual([50, 50]);
    const fallback = runForecast(room([]), { key: 'k' });
    expect(fallback.strata).toEqual([{ label: 'Weakling', entryId: '', winPct: 100, sharePct: 100 }]);
    expect(runForecast(room([entry('missing')]), { key: 'k' }).strata?.[0]).toMatchObject({ label: 'missing', winPct: 100 });
  });

  it('stops early once every sim agrees', () => {
    const r = runForecast(room([entry('easy')]), { key: 'k' });
    expect(r.sims).toBe(FORECAST_MIN_SIMS);
    expect(r).toMatchObject({ winPct: 100, ci: [88.6, 100], stalemates: 0 });
  });

  it('caps sims by the strongest tier and honours overrides', () => {
    expect(runForecast(room([entry('easy'), entry('boss_deadly')]), { key: 'k' }).sims).toBe(FORECAST_SIM_BUDGET.boss);
    expect(runForecast(room([entry('easy'), entry('raid_deadly')]), { key: 'k' }).sims).toBe(FORECAST_SIM_BUDGET.raid);
    expect(runForecast(room([entry('easy'), entry('deadly')]), { key: 'k', maxSims: 12 }).sims).toBe(12);
    expect(runForecast(room([entry('easy'), entry('deadly', 3)]), { key: 'k', halfWidthPct: 20 }).sims).toBe(FORECAST_MIN_SIMS);
  });

  it('exposes progress while sliced', () => {
    const job = createForecastJob(room([entry('easy'), entry('deadly')]), { key: 'k' });
    expect(job.result()).toMatchObject({ sims: 0, winPct: 0, ci: [0, 100], reasons: [] });
    expect(job.advance(3)).toBe(3);
    expect(job.sims).toBe(0);
    expect(job.runSims(5)).toBe(5);
    expect(job.sims).toBe(5);
    expect(job.done).toBe(false);
    expect(job.maxSims).toBe(FORECAST_SIM_BUDGET.trash);
    expect(job.advance(0)).toBe(0);
  });

  it('counts no-progress fights as stalemates and explains them', () => {
    const r = runForecast(room([entry('stall')]), { key: 'k' });
    expect(r).toMatchObject({ wins: 0, losses: 0, stalemates: r.sims });
    expect(r.reasons.map(x => x.code)).toContain('stalemate');
  });

  it('reports enemy levels and caster warnings', () => {
    const leveled = { ...MONSTERS, caster: { ...MONSTERS.caster, level: 14 } };
    const r = runForecast({ ...room([entry('casters')]), monsters: leveled }, { key: 'k' });
    expect(r.enemyLevels).toEqual([14, 14]);
    expect(r.enemyLevelsDerived).toBe(false);
    expect(r.reasons.map(x => x.code)).toEqual(['level_gap', 'no_interrupt']);
    expect(r.reasons[0].text).toBe('Enemies here are 13 levels above your party.');
  });
});

describe('dungeon forecasts', () => {
  it('regroup at the highest checkpoint reached until the boss falls', () => {
    const r = runForecast(dungeon([floor(1, [entry('easy')]), CHIEF_FLOOR]), { key: 'd' });
    expect(r.sims).toBe(FORECAST_MIN_SIMS);
    expect(r.winPct).toBe(100);
    expect(r.firstTryPct).toBe(0);
    expect(r.floors).toEqual([
      { floor: 1, winPct: 100 },
      { floor: 2, winPct: 100, boss: true, attempts: 3 },
    ]);
    expect(r.medianMs).toBeGreaterThan(25000);
    expect(r.killEtaMs).toBeGreaterThan(20000);
  });

  it('are deterministic when sliced across attempts and floors', () => {
    const input = dungeon([floor(1, [entry('easy'), entry('deadly')]), CHIEF_FLOOR]);
    const whole = runForecast(input, { key: 'd' });
    const job = createForecastJob(input, { key: 'd' });
    while (!job.done) job.advance(13);
    expect(job.result()).toEqual(whole);
  });

  it('fail the run once the regroup budget is spent', () => {
    const r = runForecast(dungeon([floor(1, [entry('easy')]), { ...CHIEF_FLOOR, maxWipes: 1 }]), { key: 'd' });
    expect(r.winPct).toBe(0);
    expect(r.losses).toBe(r.sims);
    expect(r.floors?.[1]).toEqual({ floor: 2, winPct: 0, boss: true, attempts: 2 });
    expect(r.reasons[0].code).toBe('needs_group');
  });

  it('start from the requester\'s resume point', () => {
    const floors = [floor(1, [entry('deadly')]), CHIEF_FLOOR];
    const fromPhase2 = runForecast(dungeon(floors, { start: { floorIndex: 1, phase: 2 } }), { key: 'd' });
    expect(fromPhase2.floors).toEqual([{ floor: 2, winPct: 100, boss: true, attempts: 1 }]);
    expect(fromPhase2.firstTryPct).toBe(100);

    const spent = runForecast(dungeon(floors, { start: { floorIndex: 1, phase: 1, wipes: 2 } }), { key: 'd' });
    expect(spent.floors?.[0].attempts).toBe(2);
    expect(spent.winPct).toBe(100);

    const broke = runForecast(dungeon(floors, { start: { floorIndex: 1, phase: 0, wipes: 3 } }), { key: 'd' });
    expect(broke.winPct).toBe(0);
    expect(broke.floors?.[0].attempts).toBe(1);

    const clamped = runForecast(dungeon(floors, { start: { floorIndex: 9, phase: 99 } }), { key: 'd' });
    expect(clamped.floors).toEqual([{ floor: 2, winPct: 100, boss: true, attempts: 1 }]);
  });

  it('multiply per-floor clear chances', () => {
    const r = runForecast(dungeon([floor(1, [entry('easy'), entry('deadly')]), floor(2, [entry('easy'), entry('deadly', 3)])]), { key: 'd', maxSims: 200 });
    const [f1, f2] = r.floors ?? [];
    expect(r.winPct).toBeCloseTo(f1.winPct * f2.winPct / 100, 0);
    expect(f1.winPct).toBeGreaterThan(30);
    expect(f1.winPct).toBeLessThan(70);
    expect(r.firstTryPct).toBeUndefined();
    expect(r.wins).toBeLessThanOrEqual(r.sims);
  });

  it('flag enrage when the party needs longer than the boss allows', () => {
    const monsters = { ...MONSTERS, chief: { ...MONSTERS.chief, enrage: { afterSeconds: 20 } } };
    const r = runForecast({ ...dungeon([CHIEF_FLOOR]), monsters }, { key: 'd' });
    const enrage = r.reasons.find(x => x.code === 'enrage');
    expect(enrage?.text).toMatch(/^They enrage at 0:20 — your party needs about 0:2\d$/);
  });

  it('use the fallback table for floors without one, and finish at once without floors', () => {
    const r = runForecast(dungeon([floor(1, [])], { fallbackTable: [entry('deadly')] }), { key: 'd' });
    expect(r.winPct).toBe(0);
    const empty = createForecastJob(dungeon([]), { key: 'd' });
    expect(empty.done).toBe(true);
    expect(empty.result()).toMatchObject({ sims: 0, winPct: 0 });
  });
});

describe('live battle forecasts', () => {
  it('forecast from the clone point without touching the live fight', () => {
    const live = createPartyCombatState([hero()], [makeMonster(4, { hp: 1500, tier: 'boss' })]);
    const rng = createRng(4);
    while (live.elapsedMs < 5000) processCombatStep(live, 100, rng);
    const before = JSON.stringify(live);
    const r = runForecast({ kind: 'battle', state: live }, { key: 'battle:1:5000', partyKey: 'pk-live' });
    expect(JSON.stringify(live)).toBe(before);
    expect(r).toMatchObject({ atMs: 5000, winPct: 100, partyKey: 'pk-live', key: 'battle:1:5000' });
    expect(r.medianMs).toBeGreaterThanOrEqual(15000);
    expect(r.killEtaMs).toBe(r.medianMs);

    const fromClone = runForecast({ kind: 'battle', state: cloneCombatState(live) }, { key: 'battle:1:5000', partyKey: 'pk-live' });
    expect(fromClone).toEqual(r);
  });
});

describe('forecast horizon', () => {
  it('runs 10 minutes past the first enrage, or 20 without, and always 10 past the clone point', () => {
    const fight = (m: Partial<MonsterDefinition>) => createPartyCombatState([hero()], [makeMonster(4, m)]);
    expect(defaultHorizonMs(fight({ tier: 'boss' }))).toBe(ENRAGE_TIER_DEFAULTS.boss!.afterSeconds * 1000 + FORECAST_HORIZON_AFTER_ENRAGE_MS);
    expect(defaultHorizonMs(fight({}))).toBe(FORECAST_HORIZON_WITHOUT_ENRAGE_MS);
    expect(defaultHorizonMs(fight({ tier: 'boss', passive: true }))).toBe(FORECAST_HORIZON_WITHOUT_ENRAGE_MS);
    const late = fight({});
    late.elapsedMs = 30 * 60000;
    expect(defaultHorizonMs(late)).toBe(40 * 60000);
  });
});

describe('forecast reasons', () => {
  const base: ForecastReasonInput = {
    winPct: 50, sims: 40, stalemates: 0, medianMs: null, killEtaMs: null, partyLevel: 10, humanPlayers: 1,
  };
  const codes = (extra: Partial<ForecastReasonInput>) => forecastReasons({ ...base, ...extra }).map(r => r.code);

  it('asks small parties to group up for bosses they lose', () => {
    expect(forecastReasons({ ...base, bossFight: true, humanPlayers: 2, winPct: 30 })).toEqual([{
      code: 'needs_group', tone: 'bad', text: 'Bosses are built for groups. Invite friends or hire a henchman.',
    }]);
    expect(codes({ bossFight: true, humanPlayers: 3, winPct: 30 })).toEqual([]);
    expect(codes({ bossFight: true, humanPlayers: 1, winPct: 40 })).toEqual([]);
  });

  it('warns when the kill takes longer than the enrage allows', () => {
    expect(forecastReasons({ ...base, killEtaMs: 570000, enrageAtMs: 480000 })[0]).toEqual({
      code: 'enrage', tone: 'bad', text: 'They enrage at 8:00 — your party needs about 9:30',
    });
    expect(codes({ killEtaMs: 470000, enrageAtMs: 480000 })).toEqual([]);
    expect(codes({ killEtaMs: 570000, enrageAtMs: null })).toEqual([]);
  });

  it('explains stalemates from 20 % of sims', () => {
    expect(forecastReasons({ ...base, stalemates: 8 })[0]).toEqual({
      code: 'stalemate', tone: 'bad', text: 'Your party can barely hurt them. Fights may stall out.',
    });
    expect(codes({ stalemates: 7 })).toEqual([]);
  });

  it('names a much worse common encounter', () => {
    expect(forecastReasons({ ...base, winPct: 70, worst: { label: 'Bandits', winPct: 41, sharePct: 33.3 } })[0]).toEqual({
      code: 'worst_encounter', tone: 'bad', text: '1 in 3 fights here are Bandits: wins 41 %',
    });
    expect(forecastReasons({ ...base, winPct: 70, worst: { label: 'Wolves', winPct: 20, sharePct: 60 } })[0].text)
      .toBe('1 in 2 fights here are Wolves: wins 20 %');
    expect(codes({ winPct: 45, worst: { label: 'Bandits', winPct: 41, sharePct: 33.3 } })).toEqual([]);
    expect(codes({ winPct: 90, worst: { label: 'Bandits', winPct: 75, sharePct: 33.3 } })).toEqual([]);
  });

  it('names the level gap and stays quiet when winning', () => {
    expect(forecastReasons({ ...base, enemyLevel: 14 })[0]).toEqual({
      code: 'level_gap', tone: 'bad', text: 'Enemies here are 4 levels above your party.',
    });
    expect(codes({ enemyLevel: 12 })).toEqual([]);
    expect(codes({ enemyLevel: 14, winPct: 95 })).toEqual([]);
  });

  it('points out missing healers, interrupts and cleanses', () => {
    expect(forecastReasons({ ...base, medianMs: 61000 })[0]).toMatchObject({ code: 'no_healer', tone: 'info' });
    expect(codes({ medianMs: 61000, hasHealer: true })).toEqual([]);
    expect(codes({ medianMs: 60000 })).toEqual([]);
    expect(codes({ casterEnemies: true })).toEqual(['no_interrupt']);
    expect(codes({ casterEnemies: true, hasInterrupt: true })).toEqual([]);
    expect(codes({ afflictingEnemies: true })).toEqual(['no_cleanse']);
    expect(codes({ afflictingEnemies: true, hasCleanse: true })).toEqual([]);
    expect(codes({ casterEnemies: true, afflictingEnemies: true, winPct: 95 })).toEqual([]);
  });

  it('praises a party that outlevels a room it wins', () => {
    expect(forecastReasons({ ...base, winPct: 100, enemyLevel: 3 })).toEqual([{
      code: 'outlevel', tone: 'good', text: 'Your party outlevels the enemies here by 7.',
    }]);
    expect(codes({ winPct: 60, enemyLevel: 3 })).toEqual([]);
  });

  it('keeps the three most important', () => {
    const all = codes({
      bossFight: true, winPct: 10, killEtaMs: 600000, enrageAtMs: 480000, stalemates: 20,
      worst: { label: 'X', winPct: 0, sharePct: 50 }, enemyLevel: 20, medianMs: 90000, casterEnemies: true, afflictingEnemies: true,
    });
    expect(all).toEqual(['needs_group', 'enrage', 'stalemate']);
    expect(all.length).toBe(FORECAST_MAX_REASONS);
  });

  it('formats battle clocks', () => {
    expect(formatForecastClock(0)).toBe('0:00');
    expect(formatForecastClock(570000)).toBe('9:30');
    expect(formatForecastClock(3600000)).toBe('1:00:00');
    expect(formatForecastClock(3725000)).toBe('1:02:05');
    expect(formatForecastClock(-5)).toBe('0:00');
  });
});
