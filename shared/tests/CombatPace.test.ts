import { describe, it, expect } from 'vitest';
import {
  buildClientCombatSnapshot,
  combatRealElapsedMs,
  combatRealStepMs,
  createPartyCombatState,
  processCombatStep,
} from '../src/systems/CombatEngine';
import type { PartyCombatantInit, PartyCombatState } from '../src/systems/CombatEngine';
import type { ClientCombatSkill, ClientCombatSnapshot, ClientCombatUnit, CombatEvent } from '../src/systems/CombatEvents';
import {
  AUTHORED_PACE,
  COMBAT_PACE,
  paceActionSeconds,
  paceDropChance,
  paceHitDamage,
  paceKit,
  paceRealMs,
  paceSkillSeconds,
} from '../src/systems/CombatPace';
import type { CombatPace } from '../src/systems/CombatPace';
import { IGNITE_MAX_STACKS, SUNDER_MAX_STACKS, WAR_SONG_MAX_STACKS } from '../src/systems/CombatScaling';
import { BASE_ACTION_INTERVAL_MS, COMBAT_STEP_MS } from '../src/systems/CombatTiming';
import { CLASS_DEFINITIONS } from '../src/systems/CharacterStats';
import type { ClassName } from '../src/systems/CharacterStats';
import { createRng } from '../src/systems/combat/CombatRng';
import {
  FORECAST_HORIZON_AFTER_ENRAGE_MS,
  FORECAST_HORIZON_WITHOUT_ENRAGE_MS,
  defaultHorizonMs,
  forecastReasons,
  formatForecastClock,
  runForecast,
} from '../src/systems/Forecast';
import type { DungeonForecastInput, ForecastReasonInput, RoomForecastInput } from '../src/systems/Forecast';
import type { MonsterDefinition, MonsterInstance } from '../src/systems/MonsterTypes';
import { LEGACY_SEED_SKILLS } from './legacySeedSkills';
import type { ActiveEffect, SkillDefinition } from '../src/systems/SkillTypes';
import type { PartyGridPosition } from '../src/systems/SocialTypes';
import { activeSkill, makeMonster, makePlayer, monsterAt, monsterDef, ofKind, player } from './combatTestUtils';
import type { PlayerOptions, RunLog } from './combatTestUtils';

type Rng = () => number;

const STEADY: Rng = () => 0.4;
const CLASSES = Object.keys(CLASS_DEFINITIONS) as ClassName[];

function pace(clock: number, classSeconds: CombatPace['classSeconds'] = {}, castsAddTime = false): CombatPace {
  return { clock, classSeconds, castsAddTime, rewardMultiplier: 1 };
}

const KIT1 = pace(2);
const KIT3 = pace(2, { Knight: 6, Archer: 6, Priest: 6, Mage: 6, Bard: 6 });

function fight(p: CombatPace, players: PartyCombatantInit[], monsters: MonsterInstance[] = [makeMonster(0, { hp: 1e9 })]): PartyCombatState {
  return createPartyCombatState(players, monsters, { pace: p });
}

function solo(className: ClassName, skills: SkillDefinition[] = [], opts: PlayerOptions = {}): PartyCombatantInit {
  return makePlayer('P', 2, { className, skills, baseDamage: 100, level: 10, ...opts });
}

function strike(cooldown: number, extra: Partial<SkillDefinition> = {}): SkillDefinition {
  return activeSkill({ id: 'strike', name: 'Strike', cooldown, ...extra });
}

function drum(stunChance: number): SkillDefinition {
  return activeSkill({ id: 'drum', name: 'Drum', trigger: 'enemy_cast', cooldown: 1, warmup: 0, activeEffects: [{ kind: 'stun_aoe', stunChance }] });
}

const HUSH = activeSkill({ id: 'hush', name: 'Hush', trigger: 'enemy_cast', cooldown: 1, warmup: 0, activeEffects: [{ kind: 'enemy_debuff_aoe', debuffPercent: 0.2, debuffDuration: 3 }] });

/** First cast at 1400 ms, countered 300 ms later: 3400 real ms at a clock of 2. */
function spellcaster(): MonsterInstance {
  return makeMonster(0, { hp: 1e6, skills: [{ skillId: 'fireball', value: 5, cooldown: 30 }] });
}

function step(state: PartyCombatState, rng: Rng, into: RunLog): void {
  const r = processCombatStep(state, COMBAT_STEP_MS, rng);
  into.events.push(...r.events);
  into.log.push(...r.logEntries);
}

function playLive(state: PartyCombatState, untilRealMs: number, rng: Rng = STEADY, into: RunLog = { events: [], log: [] }): RunLog {
  while (!state.finished && combatRealElapsedMs(state) < untilRealMs) step(state, rng, into);
  return into;
}

function playOut(state: PartyCombatState, rng: Rng, maxEngineMs = 400000): RunLog {
  const into: RunLog = { events: [], log: [] };
  while (!state.finished && state.elapsedMs < maxEngineMs) step(state, rng, into);
  return into;
}

/** Starts of a player's actions: autos, instant skills and cast_starts, but not a cast's resolving attack. */
function playerActions(events: CombatEvent[], pos = 2): CombatEvent[] {
  return events.filter(e => e.src?.side === 'player' && e.src.pos === pos
    && (e.kind === 'cast_start' || (e.kind === 'attack' && (!e.skill || !!e.skillId))));
}

const actionTimes = (events: CombatEvent[], pos = 2): number[] => playerActions(events, pos).map(e => e.t);
const actionNames = (events: CombatEvent[], pos = 2): string[] => playerActions(events, pos).map(e => e.skill ?? 'auto');

function unit(snapshot: ClientCombatSnapshot, side: 'player' | 'monster', pos: number): ClientCombatUnit {
  const found = snapshot.units.find(u => u.side === side && u.pos === pos);
  if (!found) throw new Error(`no ${side} unit at ${pos}`);
  return found;
}

function skillView(snapshot: ClientCombatSnapshot, pos: number, id: string): ClientCombatSkill {
  const found = unit(snapshot, 'player', pos).skills?.find(s => s.id === id);
  if (!found) throw new Error(`no skill ${id}`);
  return found;
}

function mixedParty(): PartyCombatantInit[] {
  const member = (name: string, pos: PartyGridPosition, className: ClassName, hp: number, baseDamage: number, skills: SkillDefinition[]) =>
    makePlayer(name, pos, { className, hp, baseDamage, level: 10, skills });
  return [
    member('Knight', 2, 'Knight', 3000, 20, [
      LEGACY_SEED_SKILLS.knight_bash, LEGACY_SEED_SKILLS.knight_sunder, LEGACY_SEED_SKILLS.knight_intercept, LEGACY_SEED_SKILLS.knight_shield_slam, LEGACY_SEED_SKILLS.knight_dispel,
    ]),
    member('Archer', 5, 'Archer', 800, 25, [
      LEGACY_SEED_SKILLS.archer_pierce, LEGACY_SEED_SKILLS.archer_snipe, LEGACY_SEED_SKILLS.archer_bleed, LEGACY_SEED_SKILLS.archer_crippling_shot,
    ]),
    member('Priest', 1, 'Priest', 700, 8, [
      LEGACY_SEED_SKILLS.priest_blessed_arms, LEGACY_SEED_SKILLS.priest_minor_heal, LEGACY_SEED_SKILLS.priest_sanctuary, LEGACY_SEED_SKILLS.priest_cure, LEGACY_SEED_SKILLS.priest_mending,
    ]),
    member('Mage', 4, 'Mage', 600, 30, [
      LEGACY_SEED_SKILLS.mage_scorch, LEGACY_SEED_SKILLS.mage_arcane_blast, LEGACY_SEED_SKILLS.mage_blizzard, LEGACY_SEED_SKILLS.mage_zap,
    ]),
    member('Bard', 7, 'Bard', 700, 12, [
      LEGACY_SEED_SKILLS.bard_war_song, LEGACY_SEED_SKILLS.bard_lullaby, LEGACY_SEED_SKILLS.bard_dissonance, LEGACY_SEED_SKILLS.bard_drumroll,
    ]),
  ];
}

function mixedMonsters(): MonsterInstance[] {
  return [
    makeMonster(0, {
      id: 'boss', name: 'Boss', hp: 12000, damage: 40, tier: 'boss', enrage: { afterSeconds: 20, stepSeconds: 5 },
      skills: [{ skillId: 'fireball', value: 30, cooldown: 6 }, { skillId: 'fear', value: 1, cooldown: 9 }, { skillId: 'rot', value: 8, cooldown: 4 }],
    }),
    makeMonster(3, {
      id: 'guard', name: 'Guard', hp: 3000, damage: 25,
      skills: [{ skillId: 'assassinate', value: 60, cooldown: 7 }, { skillId: 'heal', value: 100, cooldown: 8 }],
    }),
  ];
}

function mapMsFields(value: unknown, atMs: (ms: number) => number, seen: Set<string>, key = ''): unknown {
  if (Array.isArray(value)) return value.map(v => mapMsFields(v, atMs, seen));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapMsFields(v, atMs, seen, k)]));
  }
  if (typeof value === 'number' && key.endsWith('Ms')) {
    seen.add(key);
    return atMs(value);
  }
  return value;
}

describe('pace helpers', () => {
  it('paceActionSeconds reads the class and leaves unnamed classes on the clock', () => {
    const p = pace(2, { Knight: 6 });
    expect(paceActionSeconds(p, 'Knight')).toBe(6);
    expect(paceActionSeconds(p, 'Mage')).toBe(2);
    expect(paceActionSeconds(AUTHORED_PACE, 'Knight')).toBe(1);
  });

  it('paceKit is a class\'s seconds against the clock', () => {
    const p = pace(2, { Knight: 6, Archer: 3 });
    expect(paceKit(p, 'Knight')).toBe(3);
    expect(paceKit(p, 'Archer')).toBe(1.5);
    expect(paceKit(p, 'Mage')).toBe(1);
    expect(paceKit(pace(1, { Bard: 2.5 }), 'Bard')).toBe(2.5);
    expect(paceKit(AUTHORED_PACE, 'Knight')).toBe(1);
  });

  it('paceKit snaps to tenths, and paceActionSeconds reads the snapped kit', () => {
    const p = pace(3, { Archer: 5, Mage: 4 });
    expect(paceKit(p, 'Archer')).toBe(1.7);
    expect(paceKit(p, 'Mage')).toBe(1.3);
    expect(paceKit(pace(2, { Knight: 3.5 }), 'Knight')).toBe(1.8);
    expect(paceActionSeconds(p, 'Archer')).toBe(5.1);
    expect(paceActionSeconds(p, 'Mage')).toBe(3.9);
  });

  it('paceRealMs stretches by the clock, rounds, and leaves clock 1 untouched', () => {
    expect(paceRealMs(pace(2), 1500)).toBe(3000);
    expect(paceRealMs(pace(1.8), 1000)).toBe(1800);
    expect(paceRealMs(pace(1.8), 1111)).toBe(2000);
    expect(paceRealMs(pace(1.8), COMBAT_STEP_MS)).toBe(180);
    expect(paceRealMs(AUTHORED_PACE, 1234.5)).toBe(1234.5);
  });

  it('paceDropChance raises rare drops up to the 0.5 floor and leaves anything at or above it as authored', () => {
    const p = { ...pace(1), rewardMultiplier: 1.8 };
    expect(paceDropChance(p, 0.1)).toBeCloseTo(0.18);
    expect(paceDropChance(p, 0.25)).toBeCloseTo(0.45);
    expect(paceDropChance(p, 0.49)).toBe(0.5);
    expect(paceDropChance(p, 0)).toBe(0);
    expect(paceDropChance(p, 0.5)).toBe(0.5);
    expect(paceDropChance(p, 0.9)).toBe(0.9);
    expect(paceDropChance(p, 1)).toBe(1);
    expect(paceDropChance({ ...pace(1), rewardMultiplier: 3 }, 0.4)).toBe(0.5);
    expect(paceDropChance(AUTHORED_PACE, 0.1)).toBe(0.1);
  });

  it.each([1.8, 3])('paceDropChance at a multiplier of %s never lifts a rarer drop past a commoner one', rewardMultiplier => {
    const p = { ...pace(1), rewardMultiplier };
    const paced = Array.from({ length: 101 }, (_, percent) => paceDropChance(p, percent / 100));
    paced.slice(1).forEach((chance, i) => expect(chance).toBeGreaterThanOrEqual(paced[i]));
  });

  it('paceSkillSeconds keeps actions to the class and reactions to the clock', () => {
    const p = pace(2, { Knight: 6 });
    expect(paceSkillSeconds(p, LEGACY_SEED_SKILLS.knight_bash, 'Knight', 2)).toBe(12);
    expect(paceSkillSeconds(p, LEGACY_SEED_SKILLS.knight_intercept, 'Knight', 2)).toBe(4);
    expect(paceSkillSeconds(p, LEGACY_SEED_SKILLS.knight_dispel, 'Knight', 5)).toBe(10);
    expect(paceSkillSeconds(p, LEGACY_SEED_SKILLS.knight_bash, 'Mage', 2)).toBe(4);
    expect(paceSkillSeconds(AUTHORED_PACE, LEGACY_SEED_SKILLS.knight_bash, 'Knight', 2)).toBe(2);
  });

  it('paceHitDamage rounds an authored hit scaled by the kit', () => {
    const p = pace(2, { Knight: 3 });
    expect(paceHitDamage(p, 'Knight', 10)).toBe(15);
    expect(paceHitDamage(p, 'Knight', 5)).toBe(8);
    expect(paceHitDamage(p, 'Mage', 5)).toBe(5);
    expect(paceHitDamage(AUTHORED_PACE, 'Knight', 7)).toBe(7);
  });
});

describe('COMBAT_PACE', () => {
  it('keeps the Priest on the clock and names every class', () => {
    expect(paceActionSeconds(COMBAT_PACE, 'Priest')).toBe(COMBAT_PACE.clock);
    expect(paceKit(COMBAT_PACE, 'Priest')).toBe(1);
    expect(Object.keys(COMBAT_PACE.classSeconds).sort()).toEqual([...CLASSES].sort());
  });

  it.each(CLASSES)('%s hits for what paceHitDamage shows', className => {
    const state = fight(COMBAT_PACE, [solo(className)]);
    const hit = ofKind(playLive(state, 5000).events, 'damage')[0];
    expect(hit.amount).toBe(paceHitDamage(COMBAT_PACE, className, 100));
  });

  it.each(CLASSES)('%s has a kit in tenths, close to its class seconds, and an interval of whole steps', className => {
    const kit = paceKit(COMBAT_PACE, className);
    expect(Math.round(kit * 10) / 10).toBe(kit);
    expect(Math.abs(kit - COMBAT_PACE.classSeconds[className]! / COMBAT_PACE.clock)).toBeLessThanOrEqual(0.05 + 1e-9);
    const { actionIntervalMs } = fight(COMBAT_PACE, [solo(className)]).players[0];
    expect(actionIntervalMs).toBe(Math.round(kit * BASE_ACTION_INTERVAL_MS));
    expect(actionIntervalMs % COMBAT_STEP_MS).toBe(0);
  });

  it.each(CLASSES.map((c): [ClassName, number] => [c, paceActionSeconds(COMBAT_PACE, c)]))('%s acts every %s real seconds, exactly', (className, seconds) => {
    const expectedGap = Math.round(seconds * 1000);
    const state = fight(COMBAT_PACE, [solo(className)]);
    expect(expectedGap % combatRealStepMs(state)).toBe(0);
    const times = actionTimes(playLive(state, expectedGap * 50).events);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(gaps.length).toBeGreaterThanOrEqual(45);
    expect(gaps).toEqual(gaps.map(() => expectedGap));
  });

  function actionsPerUse(className: ClassName, cooldown: number): number {
    const state = fight(COMBAT_PACE, [solo(className, [strike(cooldown)])]);
    const until = 1000 + 120 * state.players[0].actionIntervalMs;
    const actions = actionNames(playOut(state, STEADY, until).events);
    return Math.round(actions.length / actions.filter(name => name === 'Strike').length);
  }

  const COOLDOWNS = [1, 2, 3, 4, 5, 6];
  const EVERY_NTH_ACTION = Object.fromEntries(CLASSES.map(c => [c, Object.fromEntries(COOLDOWNS.map(n => [n, n]))]));

  it('a cooldown of N means every Nth action, for every class', () => {
    const cadence = Object.fromEntries(CLASSES.map(c => [c, Object.fromEntries(COOLDOWNS.map(n => [n, actionsPerUse(c, n)]))]));
    expect(cadence).toEqual(EVERY_NTH_ACTION);
  });

  it('a reaction with a cooldown of 1 answers a monster that attacks every second', () => {
    const state = fight(COMBAT_PACE, [solo('Knight', [LEGACY_SEED_SKILLS.knight_shield_slam])], [makeMonster(0, { hp: 1e6, damage: 5 })]);
    const { events } = playLive(state, 60000);
    const hits = ofKind(events, 'attack').filter(e => e.src?.side === 'monster');
    expect(hits.length).toBeGreaterThan(30);
    expect(ofKind(events, 'reaction').length).toBeGreaterThanOrEqual(hits.length - 1);
  });

  it.each(CLASSES)('%s can use a cooldown-2 skill on its first action', className => {
    const state = fight(COMBAT_PACE, [solo(className, [strike(2)])]);
    expect(actionNames(playLive(state, 5000).events)[0]).toBe('Strike');
  });

  it('shows skill timings in full snapshots that agree with paceSkillSeconds', () => {
    const mage = solo('Mage', [LEGACY_SEED_SKILLS.mage_arcane_blast]);
    const state = fight(COMBAT_PACE, [mage]);
    const blast = LEGACY_SEED_SKILLS.mage_arcane_blast;
    const view = skillView(buildClientCombatSnapshot(state, 1, true), 2, blast.id);
    const cooldownMs = paceSkillSeconds(COMBAT_PACE, blast, 'Mage', blast.cooldown!) * 1000;
    const castMs = paceSkillSeconds(COMBAT_PACE, blast, 'Mage', blast.castTime!) * 1000;
    expect(Math.abs(view.useCooldownMs! - cooldownMs)).toBeLessThanOrEqual(1);
    expect(Math.abs(view.baseCooldownMs! - cooldownMs)).toBeLessThanOrEqual(1);
    expect(Math.abs(view.castTimeMs! - castMs)).toBeLessThanOrEqual(combatRealStepMs(state));
  });

  it('a cast_start predicts the Mage\'s next action exactly', () => {
    const blast = { ...LEGACY_SEED_SKILLS.mage_arcane_blast, warmup: 0 };
    const state = fight(COMBAT_PACE, [solo('Mage', [blast])]);
    const { events } = playLive(state, 12000);
    const [cast, next] = playerActions(events);
    expect(cast.kind).toBe('cast_start');
    const castMs = Math.ceil(paceKit(COMBAT_PACE, 'Mage') * blast.castTime! * 1000 / COMBAT_STEP_MS) * COMBAT_STEP_MS;
    expect(cast.durationMs).toBe(paceRealMs(COMBAT_PACE, castMs));
    expect(cast.nextActionMs).toBe(paceRealMs(COMBAT_PACE, state.players[0].actionIntervalMs + castMs));
    expect(next.t - cast.t).toBe(cast.nextActionMs);
  });
});

describe('AUTHORED_PACE', () => {
  it('is what a fight uses without a pace', () => {
    const state = createPartyCombatState(mixedParty(), mixedMonsters());
    expect(state.pace).toBe(AUTHORED_PACE);
  });

  it.each([3, 17, 42])('plays seed %i event for event like passing no pace', seed => {
    const none = createPartyCombatState(mixedParty(), mixedMonsters());
    const authored = createPartyCombatState(mixedParty(), mixedMonsters(), { pace: AUTHORED_PACE });
    const a = playOut(none, createRng(seed));
    const b = playOut(authored, createRng(seed));
    expect(a.events.length).toBeGreaterThan(50);
    expect(b.events).toEqual(a.events);
    expect(b.log).toEqual(a.log);
    expect(authored.result).toBe(none.result);
    expect(authored.elapsedMs).toBe(none.elapsedMs);
  });
});

describe.each([2, COMBAT_PACE.clock])('a clock of %s with no class seconds', clock => {
  const p = pace(clock);
  const real = (ms: number): number => paceRealMs(p, ms);
  const stretched = (e: CombatEvent): CombatEvent => ({
    ...e,
    t: real(e.t),
    ...(e.durationMs === undefined ? {} : { durationMs: real(e.durationMs) }),
  });

  it.each([3, 17, 42])('plays seed %i the same fight as clock 1, step for step, stretched by the clock', seed => {
    const authored = createPartyCombatState(mixedParty(), mixedMonsters());
    const paced = fight(p, mixedParty(), mixedMonsters());
    const a = playOut(authored, createRng(seed));
    const b = playOut(paced, createRng(seed));
    expect(paced.result).toBe(authored.result);
    expect(paced.tickCount).toBe(authored.tickCount);
    expect(b.events).toEqual(a.events.map(stretched));
    expect(a.events.some(e => e.durationMs !== undefined)).toBe(true);
  });

  it('reads every snapshot ms field multiplied by the clock', () => {
    const authored = createPartyCombatState(mixedParty(), mixedMonsters());
    const paced = fight(p, mixedParty(), mixedMonsters());
    const seen = new Set<string>();
    const rngA = createRng(5);
    const rngB = createRng(5);
    const log: RunLog = { events: [], log: [] };
    while (!authored.finished && authored.elapsedMs < 120000) {
      step(authored, rngA, log);
      step(paced, rngB, log);
      const a = buildClientCombatSnapshot(authored, 1, true);
      const b = buildClientCombatSnapshot(paced, 1, true);
      expect(b).toEqual(mapMsFields(a, real, seen));
    }
    expect([...seen]).toEqual(expect.arrayContaining([
      'actionIntervalMs', 'actionMs', 'actionTotalMs', 'atMs', 'baseCooldownMs', 'castTimeMs', 'cooldownMs', 'elapsedMs',
      'remainingMs', 'stepMs', 'stunMs', 'stunTotalMs', 'totalMs', 'useCooldownMs',
    ]));
  });

  it('advances real time by exactly one real step per step, however long the fight', () => {
    const state = fight(p, [solo('Archer')]);
    const realStep = combatRealStepMs(state);
    expect(realStep).toBe(real(COMBAT_STEP_MS));
    let drifted = 0;
    for (let i = 1; i <= 20000; i++) {
      processCombatStep(state, COMBAT_STEP_MS, STEADY);
      if (combatRealElapsedMs(state) !== i * realStep) drifted++;
    }
    expect(drifted).toBe(0);
  });

  it('tells pulse lengths in real time', () => {
    const state = fight(p, [makePlayer('A', 2, { hp: 5000 })], [makeMonster(0, { name: 'Rotter', skills: [{ skillId: 'rot', value: 8, cooldown: 30 }] })]);
    const { log } = playLive(state, real(1500));
    expect(log).toContain(`Rotter casts Rot on A! (8 magical damage every ${clock} seconds for ${real(3000) / 1000} seconds)`);
  });
});

describe('a class swing', () => {
  const swing = pace(2, { Knight: 6 });

  it('is no swing at all when class seconds equal the clock', () => {
    const named = pace(2, { Knight: 2, Archer: 2, Priest: 2, Mage: 2, Bard: 2 });
    const a = playOut(fight(KIT1, mixedParty(), mixedMonsters()), createRng(9));
    const b = playOut(fight(named, mixedParty(), mixedMonsters()), createRng(9));
    expect(b.events).toEqual(a.events);
  });

  it('spaces a class\'s actions by its real seconds, opening at the authored first action', () => {
    const { events } = playLive(fight(swing, [solo('Knight')]), 27000);
    expect(actionTimes(events)).toEqual([2000, 8000, 14000, 20000, 26000]);
  });

  it('leaves a class the pace does not name on the clock', () => {
    const { events } = playLive(fight(swing, [solo('Mage')]), 9000);
    expect(actionTimes(events)).toEqual([2000, 4000, 6000, 8000]);
  });

  it('works with a clock of 1', () => {
    const { events } = playLive(fight(pace(1, { Knight: 2.5 }), [solo('Knight')]), 7000);
    expect(actionTimes(events)).toEqual([1000, 3500, 6000]);
    expect(ofKind(events, 'damage')[0].amount).toBe(250);
  });

  it('fires a cooldown of 2 on every 2nd action, auto-attacking in between', () => {
    const { events } = playLive(fight(KIT3, [solo('Knight', [strike(2)])]), 39000);
    expect(actionNames(events)).toEqual(['Strike', 'auto', 'Strike', 'auto', 'Strike', 'auto', 'Strike']);
    expect(actionTimes(events)).toEqual([2000, 8000, 14000, 20000, 26000, 32000, 38000]);
  });

  it('fires a cooldown of 1 on every action and a cooldown of 3 on every 3rd', () => {
    expect(actionNames(playLive(fight(KIT3, [solo('Knight', [strike(1)])]), 21000).events)).toEqual(['Strike', 'Strike', 'Strike', 'Strike']);
    expect(actionNames(playLive(fight(KIT3, [solo('Knight', [strike(3)])]), 45000).events))
      .toEqual(['auto', 'Strike', 'auto', 'auto', 'Strike', 'auto', 'auto', 'Strike']);
  });

  it('keeps that cadence at a fractional kit', () => {
    const p = pace(2, { Knight: 5 });
    const { events } = playLive(fight(p, [solo('Knight', [strike(2)])]), 33000);
    expect(actionNames(events)).toEqual(['Strike', 'auto', 'Strike', 'auto', 'Strike', 'auto', 'Strike']);
    expect(actionTimes(events)).toEqual([2000, 7000, 12000, 17000, 22000, 27000, 32000]);
  });

  describe('sizes', () => {
    const firstDamage = (p: CombatPace, skills: SkillDefinition[] = []): number => {
      const state = fight(p, [solo('Knight', skills)]);
      return ofKind(playLive(state, 2000).events, 'damage')[0].amount!;
    };

    it('an auto-attack hits for the kit times its authored amount', () => {
      expect(firstDamage(KIT1)).toBe(100);
      expect(firstDamage(KIT3)).toBe(300);
    });

    const effects: [string, ActiveEffect][] = [
      ['stun_single', { kind: 'stun_single', stunChance: 0 }],
      ['damage_percent', { kind: 'damage_percent', damagePercent: 0.5 }],
      ['high_damage_single', { kind: 'high_damage_single', damagePercent: 2.5 }],
      ['multi_hit', { kind: 'multi_hit', hitCount: 2, damagePercent: 0.3 }],
      ['multi_hit_random', { kind: 'multi_hit_random', hitCount: 3, damagePercent: 0.5 }],
      ['ignore_dr_single', { kind: 'ignore_dr_single', damagePercent: 2 }],
      ['target_lowest_hp', { kind: 'target_lowest_hp' }],
      ['smite', { kind: 'smite', holyMultiplier: 3 }],
      ['stacking_mark', { kind: 'stacking_mark', markMultiplier: 0.25 }],
      ['remove_buffs', { kind: 'remove_buffs' }],
      ['dot_attack', { kind: 'dot_attack', dotPercent: 0.2, dotTicks: 3 }],
      ['debuff_attack', { kind: 'debuff_attack', debuffPercent: 0.3, debuffDuration: 3 }],
      ['damage_aoe_all by percent', { kind: 'damage_aoe_all', damagePercent: 1 }],
      ['damage_aoe_all by level', { kind: 'damage_aoe_all', damagePerLevel: 2 }],
    ];

    it.each(effects)('%s hits for the kit times its authored amount', (_name, effect) => {
      const skill = strike(1, { activeEffects: [effect] });
      const authored = firstDamage(KIT1, [skill]);
      expect(authored).toBeGreaterThan(1);
      expect(firstDamage(KIT3, [skill])).toBe(authored * 3);
    });

    it('a DoT rider carries the scaled hit, over the same pulses', () => {
      const skill = strike(1, { activeEffects: [{ kind: 'dot_attack', dotPercent: 0.2, dotTicks: 2 }] });
      const dotOf = (p: CombatPace) => {
        const state = fight(p, [solo('Knight', [skill])]);
        playLive(state, 2000);
        return monsterAt(state, 0).dots[0];
      };
      expect(dotOf(KIT1)).toMatchObject({ damagePerTick: 10, ticksRemaining: 2 });
      expect(dotOf(KIT3)).toMatchObject({ damagePerTick: 30, ticksRemaining: 2 });
    });

    it('an Ignite stack is a share of the scaled hit', () => {
      const tick = (p: CombatPace) => {
        const state = fight(p, [solo('Mage', [LEGACY_SEED_SKILLS.mage_ignite])]);
        playLive(state, 2000);
        return monsterAt(state, 0).dots[0].damagePerTick;
      };
      expect(tick(KIT1)).toBe(25);
      expect(tick(KIT3)).toBe(75);
    });

    function healer(p: CombatPace, skill: SkillDefinition): PartyCombatState {
      const state = fight(p, [
        makePlayer('Healer', 2, { className: 'Priest', level: 10, skills: [skill] }),
        makePlayer('Hurt', 5, { hp: 1000 }),
      ]);
      player(state, 'Hurt').currentHp = 100;
      return state;
    }

    it('a heal restores the kit times its authored amount', () => {
      const heal = strike(1, { id: 'mend', name: 'Mend', activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }] });
      const healed = (p: CombatPace) => ofKind(playLive(healer(p, heal), 2000).events, 'heal')[0].amount;
      expect(healed(KIT1)).toBe(40);
      expect(healed(KIT3)).toBe(120);
    });

    it('a shield absorbs the kit times its authored amount', () => {
      const shielded = (p: CombatPace) => ofKind(playLive(healer(p, LEGACY_SEED_SKILLS.priest_sanctuary), 2000).events, 'shield')[0].amount;
      expect(shielded(KIT1)).toBe(40);
      expect(shielded(KIT3)).toBe(120);
    });

    it('a heal over time pulses for the kit times its authored amount, on the clock', () => {
      const renew = strike(1, { id: 'renew', name: 'Renew', activeEffects: [{ kind: 'hot_lowest', healMultiplier: 2, dotTicks: 3 }] });
      const applied = (p: CombatPace) => {
        const state = healer(p, renew);
        const { log } = playLive(state, 2000);
        return { hot: player(state, 'Hurt').hots[0], log };
      };
      expect(applied(KIT1).hot).toMatchObject({ healPerTick: 20, ticksRemaining: 3 });
      const kit3 = applied(KIT3);
      expect(kit3.hot).toMatchObject({ healPerTick: 60, ticksRemaining: 3 });
      expect(kit3.log).toContain('Healer applies Renew to Hurt (60 HP every 2 seconds for 6 seconds)');
    });

    it('the holy rider scales by the striker\'s kit', () => {
      const state = fight(pace(2, { Knight: 6 }), [
        makePlayer('K', 2, { className: 'Knight', baseDamage: 100 }),
        makePlayer('A', 5, { className: 'Archer', baseDamage: 100 }),
        makePlayer('Pr', 8, { className: 'Priest', level: 10, skills: [LEGACY_SEED_SKILLS.priest_blessed_arms] }),
      ]);
      const holy = ofKind(playLive(state, 3000).events, 'damage').filter(e => e.dmgType === 'holy');
      expect(holy.find(e => e.src?.pos === 2)?.amount).toBe(30);
      expect(holy.find(e => e.src?.pos === 5)?.amount).toBe(10);
    });
  });

  it('stretches a cast by the kit', () => {
    const blast = strike(10, { id: 'blast', name: 'Blast', warmup: 0, castTime: 1.5 });
    const { events } = playLive(fight(KIT3, [solo('Knight', [blast])]), 12000);
    expect(ofKind(events, 'cast_start')[0]).toMatchObject({ t: 2000, durationMs: 9000, skill: 'Blast' });
    expect(ofKind(events, 'cast_end')[0].t).toBe(11000);
    expect(ofKind(events, 'damage').find(e => e.dst?.side === 'monster')).toMatchObject({ t: 11000, amount: 300, skill: 'Blast' });
  });

  it('reports skill timings in real time, and only in full snapshots', () => {
    const blast = strike(5, { id: 'blast', name: 'Blast', castTime: 1 });
    const intercept = LEGACY_SEED_SKILLS.knight_intercept;
    const dispel = LEGACY_SEED_SKILLS.knight_dispel;
    const state = fight(pace(2, { Knight: 6 }), [solo('Knight', [blast, intercept, dispel], { setBonuses: { cooldownReduction: 1 } })]);
    const full = buildClientCombatSnapshot(state, 1, true);

    expect(skillView(full, 2, 'blast')).toMatchObject({ castTimeMs: 6000, baseCooldownMs: 30000, useCooldownMs: 24000, remainingMs: 14000, cooldownMs: 14000 });
    expect(skillView(full, 2, intercept.id)).toMatchObject({ castTimeMs: 0, baseCooldownMs: 4000, useCooldownMs: 2000, remainingMs: 0 });
    expect(skillView(full, 2, dispel.id)).toMatchObject({ castTimeMs: 0, baseCooldownMs: 10000, useCooldownMs: 10000, remainingMs: 8000 });

    expect(skillView(full, 2, 'blast').baseCooldownMs).toBe(paceSkillSeconds(state.pace, blast, 'Knight', blast.cooldown!) * 1000);
    expect(skillView(full, 2, 'blast').castTimeMs).toBe(paceSkillSeconds(state.pace, blast, 'Knight', blast.castTime!) * 1000);
    expect(skillView(full, 2, intercept.id).baseCooldownMs).toBe(paceSkillSeconds(state.pace, intercept, 'Knight', intercept.cooldown!) * 1000);

    const dynamic = skillView(buildClientCombatSnapshot(state, 1, false), 2, 'blast');
    expect(dynamic).not.toHaveProperty('castTimeMs');
    expect(dynamic).not.toHaveProperty('baseCooldownMs');
    expect(dynamic).not.toHaveProperty('useCooldownMs');
  });

  it('reports action timers in real time', () => {
    const state = fight(pace(2, { Knight: 6 }), [solo('Knight')]);
    playLive(state, 2000);
    const knight = unit(buildClientCombatSnapshot(state, 1, true), 'player', 2);
    expect(knight).toMatchObject({ actionMs: 6000, actionTotalMs: 6000, actionIntervalMs: 6000 });
  });
});

describe('reactions keep kit 1', () => {
  const swing = pace(2, { Knight: 6 });

  it('Shield Slam keeps its cooldown and reflect size, and fires through a long wait', () => {
    const play = (p: CombatPace) => {
      const state = fight(p, [makePlayer('K', 2, { className: 'Knight', baseDamage: 1, skills: [LEGACY_SEED_SKILLS.knight_shield_slam] })], [makeMonster(0, { hp: 1e6, damage: 50 })]);
      return { state, events: playLive(state, 9000).events };
    };
    const reflects = (events: CombatEvent[]) => ofKind(events, 'damage').filter(e => e.skill === 'Shield Slam').map(e => [e.t, e.amount]);

    const slow = play(swing);
    expect(reflects(slow.events)).toEqual([[2800, 5], [4800, 5], [6800, 5], [8800, 5]]);
    expect(reflects(slow.events)).toEqual(reflects(play(KIT1).events));
    expect(actionTimes(slow.events)).toEqual([2000, 8000]);
    expect(player(slow.state, 'K').skillCooldownTotals.knight_shield_slam).toBe(1000);
  });

  it('Intercept keeps its cooldown and fires twice inside one wait', () => {
    const state = fight(swing, [
      makePlayer('K', 0, { className: 'Knight', hp: 500, baseDamage: 1, skills: [LEGACY_SEED_SKILLS.knight_intercept] }),
      makePlayer('R', 2, { hp: 200, baseDamage: 1 }),
    ], [makeMonster(1, { hp: 1e6, damage: 5 })]);
    const { events } = playLive(state, 2800);
    expect(player(state, 'K').skillCooldowns.knight_intercept).toBe(2000);
    playLive(state, 7000, STEADY, { events, log: [] });
    expect(ofKind(events, 'redirect').map(e => e.t)).toEqual([2800, 6800]);
    expect(actionTimes(events, 0)).toEqual([2200]);
  });

  it('a reaction that strikes hits at its authored size', () => {
    const riposte = activeSkill({
      id: 'riposte', name: 'Riposte', trigger: 'ally_targeted', cooldown: 1,
      activeEffects: [{ kind: 'high_damage_single', damagePercent: 2 }],
    });
    const state = fight(swing, [
      makePlayer('K', 0, { className: 'Knight', baseDamage: 100, skills: [riposte] }),
      makePlayer('R', 2, { baseDamage: 1 }),
    ], [makeMonster(1, { hp: 1e6, damage: 5 })]);
    const { events } = playLive(state, 7000);
    const hits = ofKind(events, 'damage').filter(e => e.skill === 'Riposte');
    expect(hits.map(e => [e.t, e.amount])).toEqual([[2800, 200], [4800, 200], [6800, 200]]);
    expect(ofKind(events, 'damage').filter(e => e.src?.side === 'player' && e.src.pos === 0 && !e.skill).map(e => e.amount)).toEqual([300]);
  });

  it('an interrupt counters during a long wait, at its authored size and cooldown', () => {
    const dispel = { ...LEGACY_SEED_SKILLS.knight_dispel, warmup: 0 };
    const state = fight(swing, [solo('Knight', [dispel])], [spellcaster()]);
    const { events } = playLive(state, 4000);
    expect(ofKind(events, 'interrupt').map(e => e.t)).toEqual([3400]);
    expect(ofKind(events, 'damage').filter(e => e.skill === dispel.name).map(e => e.amount)).toEqual([100]);
    expect(player(state, 'P').skillCooldownTotals[dispel.id]).toBe(5000);
    expect(actionTimes(events)).toEqual([2000]);
  });

  it('a triggered heal over time keeps its authored size and cooldown', () => {
    const state = fight(KIT3, [
      makePlayer('Healer', 2, { className: 'Priest', level: 10, skills: [LEGACY_SEED_SKILLS.priest_mending] }),
      makePlayer('Hurt', 5, { hp: 1000 }),
    ]);
    player(state, 'Hurt').currentHp = 100;
    playLive(state, 100);
    expect(player(state, 'Hurt').hots[0]).toMatchObject({ healPerTick: 20, ticksRemaining: 3 });
    expect(player(state, 'Healer').skillCooldownTotals.priest_mending).toBe(4000);
  });

  it('a triggered stun rolls its authored chance for an authored length', () => {
    const counter = (rng: Rng) => playLive(fight(KIT3, [solo('Knight', [drum(0.5)])], [spellcaster()]), 3400, rng).events;
    const missed = counter(() => 0.6);
    expect(ofKind(missed, 'reaction')).toHaveLength(1);
    expect(ofKind(missed, 'stun')).toEqual([]);
    expect(ofKind(counter(() => 0.4), 'stun').map(e => e.durationMs)).toEqual([2000]);
  });

  it('a triggered debuff keeps its authored length', () => {
    const state = fight(KIT3, [solo('Knight', [HUSH])], [spellcaster()]);
    const { events } = playLive(state, 3400);
    expect(ofKind(events, 'reaction')).toHaveLength(1);
    expect(monsterAt(state, 0).debuffs[0]).toMatchObject({ type: 'lullaby', remainingMs: 3000 });
  });
});

describe('warm-up', () => {
  const warmup = (p: CombatPace, skill: SkillDefinition, className: ClassName = 'Knight'): number =>
    fight(p, [solo(className, [skill])]).players[0].skillCooldowns[skill.id];

  it('stays authored up to the opener, then follows 1000 + (cooldown - 2000) x kit', () => {
    expect(warmup(KIT3, strike(1))).toBe(0);
    expect(warmup(KIT3, strike(1.5))).toBe(500);
    expect(warmup(KIT3, strike(2))).toBe(1000);
    expect(warmup(KIT3, strike(3))).toBe(4000);
    expect(warmup(KIT3, strike(5))).toBe(10000);
  });

  it.each(CLASSES)('makes a cooldown of N ready on action N - 1 for a %s on COMBAT_PACE', className => {
    for (const cooldown of [2, 3, 4, 5, 6]) {
      const state = fight(COMBAT_PACE, [solo(className, [strike(cooldown)])]);
      const names = actionNames(playOut(state, STEADY, 1000 + cooldown * state.players[0].actionIntervalMs).events);
      expect(names.indexOf('Strike')).toBe(cooldown - 2);
    }
  });

  it.each([1, 2, 3, 5, 8])('matches authored time at kit 1 for a cooldown of %i', cooldown => {
    const authored = createPartyCombatState([solo('Knight', [strike(cooldown)])], [makeMonster(0)]).players[0].skillCooldowns.strike;
    expect(authored).toBe(cooldown * 1000 - 1000);
    expect(warmup(KIT1, strike(cooldown))).toBe(authored);
  });

  it('uses the reduced cooldown', () => {
    const state = fight(KIT3, [solo('Knight', [strike(3)], { setBonuses: { cooldownReduction: 1 } })]);
    expect(state.players[0].skillCooldowns.strike).toBe(1000);
  });

  it('keeps an explicit warm-up up to the opener and scales only the time past it', () => {
    expect(warmup(KIT3, strike(5, { warmup: 0 }))).toBe(0);
    expect(warmup(KIT3, strike(5, { warmup: 0.5 }))).toBe(500);
    expect(warmup(KIT3, strike(5, { warmup: 1 }))).toBe(1000);
    expect(warmup(KIT3, strike(5, { warmup: 2 }))).toBe(1000 + 1000 * 3);
    expect(warmup(KIT1, strike(5, { warmup: 2 }))).toBe(2000);
    expect(warmup(KIT3, LEGACY_SEED_SKILLS.knight_sunder)).toBe(1000);
  });

  it.each(CLASSES)('an explicit warm-up of 1 is usable on a %s\'s first action on COMBAT_PACE', className => {
    const state = fight(COMBAT_PACE, [solo(className, [strike(5, { warmup: 1 })])]);
    expect(actionNames(playOut(state, STEADY, BASE_ACTION_INTERVAL_MS).events)).toEqual(['Strike']);
  });

  it('leaves reactions alone', () => {
    expect(warmup(KIT3, LEGACY_SEED_SKILLS.knight_intercept)).toBe(0);
    expect(warmup(KIT3, LEGACY_SEED_SKILLS.knight_dispel)).toBe(warmup(KIT1, LEGACY_SEED_SKILLS.knight_dispel));
    expect(warmup(KIT3, LEGACY_SEED_SKILLS.knight_dispel)).toBe(4000);
  });

  it('a cooldown-2 skill is usable on the first action at kit above 1', () => {
    for (const seconds of [3, 4, 5, 6, 8]) {
      const { events } = playLive(fight(pace(2, { Knight: seconds }), [solo('Knight', [strike(2)])]), 2000);
      expect(actionNames(events)).toEqual(['Strike']);
    }
  });

  it('the opener of a staggered second player is no later than the skill', () => {
    const state = fight(KIT3, [
      makePlayer('A', 2, { className: 'Knight', skills: [strike(2)] }),
      makePlayer('B', 5, { className: 'Knight', skills: [strike(2)] }),
    ]);
    const { events } = playLive(state, 2200);
    expect(actionNames(events, 2)).toEqual(['Strike']);
    expect(actionNames(events, 5)).toEqual(['Strike']);
    expect(actionTimes(events, 5)).toEqual([2200]);
  });
});

describe('castsAddTime', () => {
  const bolt = (castTime: number) => activeSkill({ id: 'bolt', name: 'Bolt', className: 'Mage', cooldown: 30, warmup: 0, castTime });
  const on = pace(2, { Mage: 6 }, true);
  const off = pace(2, { Mage: 6 });

  it('makes a player wait interval + cast, and cast_start says so', () => {
    const state = fight(on, [solo('Mage', [bolt(1)])]);
    const { events } = playLive(state, 2000);
    const cast = ofKind(events, 'cast_start')[0];
    expect(cast).toMatchObject({ t: 2000, durationMs: 6000, nextActionMs: 12000 });

    const snapshot = unit(buildClientCombatSnapshot(state, 1, false), 'player', 2);
    expect(snapshot).toMatchObject({ actionMs: 12000, actionTotalMs: 12000 });
    expect(snapshot.cast).toMatchObject({ totalMs: 6000, remainingMs: 6000 });

    playLive(state, 15000, STEADY, { events, log: [] });
    expect(ofKind(events, 'cast_end')[0].t).toBe(8000);
    expect(actionTimes(events)).toEqual([2000, 2000 + cast.nextActionMs!]);
  });

  it('holds for casts shorter and longer than the interval', () => {
    const next = (castTime: number) => {
      const { events } = playLive(fight(on, [solo('Mage', [bolt(castTime)])]), 40000);
      const [cast, after] = playerActions(events);
      return [cast.nextActionMs, after.t - cast.t];
    };
    expect(next(0.5)).toEqual([9000, 9000]);
    expect(next(2)).toEqual([18000, 18000]);
  });

  it('leaves instant actions at the interval', () => {
    const { events } = playLive(fight(on, [solo('Mage', [strike(1, { className: 'Mage' })])]), 15000);
    expect(actionTimes(events)).toEqual([2000, 8000, 14000]);
    expect(ofKind(events, 'cast_start')).toEqual([]);
  });

  it('off, a cast is absorbed by the wait and cast_start carries no nextActionMs', () => {
    const absorbed = playLive(fight(off, [solo('Mage', [bolt(1)])]), 9000).events;
    expect(ofKind(absorbed, 'cast_start')[0]).not.toHaveProperty('nextActionMs');
    expect(actionTimes(absorbed)).toEqual([2000, 8000]);

    const longer = playLive(fight(off, [solo('Mage', [bolt(2)])]), 15000).events;
    expect(ofKind(longer, 'cast_start')[0]).not.toHaveProperty('nextActionMs');
    expect(actionTimes(longer)).toEqual([2000, 14000]);

    const short = playLive(fight(off, [solo('Mage', [bolt(0.5)])]), 9000).events;
    expect(actionTimes(short)).toEqual([2000, 8000]);
  });

  it.each([[3, 8800], [1, 6800]])('a monster keeps max(interval, cast) with a %i s cast', (castTime, nextT) => {
    const caster = makeMonster(0, { hp: 1e6, attackInterval: 2, skills: [{ skillId: 'fireball', value: 1, cooldown: 60, castTime }] });
    const { events } = playLive(fight(on, [makePlayer('A', 2)], [caster]), 9000);
    const cast = ofKind(events, 'cast_start').find(e => e.src?.side === 'monster')!;
    expect(cast).toMatchObject({ t: 2800, durationMs: castTime * 2000 });
    expect(cast).not.toHaveProperty('nextActionMs');
    expect(ofKind(events, 'attack').find(e => e.src?.side === 'monster' && !e.skill)?.t).toBe(nextT);
  });
});

describe('stuns', () => {
  const bash = (stunChance: number) => strike(1, { id: 'bash', name: 'Bash', activeEffects: [{ kind: 'stun_single', stunChance }] });
  const stuns = (p: CombatPace, stunChance: number, rng: Rng) => ofKind(playLive(fight(p, [solo('Knight', [bash(stunChance)])]), 2000, rng).events, 'stun');

  it('scales the chance by the kit', () => {
    expect(stuns(KIT1, 0.2, () => 0.19)).toHaveLength(1);
    expect(stuns(KIT1, 0.2, () => 0.21)).toHaveLength(0);
    expect(stuns(KIT3, 0.2, () => 0.59)).toHaveLength(1);
    expect(stuns(KIT3, 0.2, () => 0.61)).toHaveLength(0);
  });

  it('a stun under 100 % keeps its authored length', () => {
    expect(stuns(KIT3, 0.2, () => 0.59).map(e => e.durationMs)).toEqual([2000]);
  });

  it('caps the chance at 100 %, and exactly reaching it adds no length', () => {
    expect(stuns(pace(2, { Knight: 4 }), 0.5, () => 0.999).map(e => e.durationMs)).toEqual([2000]);
  });

  it('turns chance past 100 % into a longer stun', () => {
    const state = fight(KIT3, [solo('Knight', [bash(0.5)])]);
    const { events } = playLive(state, 2000, () => 0.999);
    expect(ofKind(events, 'stun').map(e => e.durationMs)).toEqual([3000]);
    expect(monsterAt(state, 0).stunTotalMs).toBe(1500);
    expect(unit(buildClientCombatSnapshot(state, 1, false), 'monster', 0).stunTotalMs).toBe(3000);
  });

  it('applies to area stuns, rolled per monster', () => {
    const roar = strike(1, { id: 'roar', name: 'Roar', activeEffects: [{ kind: 'stun_aoe', stunChance: 0.5 }] });
    const { events } = playLive(fight(KIT3, [solo('Knight', [roar])], [makeMonster(0, { hp: 1e6 }), makeMonster(3, { hp: 1e6 })]), 2000, () => 0.999);
    expect(ofKind(events, 'stun').map(e => [e.dst?.pos, e.durationMs])).toEqual([[0, 3000], [3, 3000]]);
  });

  it.each([[0.25, 1], [0.25, 2], [0.25, 3], [0.25, 5], [0.5, 1], [0.5, 2], [0.5, 3]])(
    'with a %f chance at kit %i, stun-seconds per second stay about the chance',
    (stunChance, kit) => {
      const state = fight(pace(2, { Knight: 2 * kit }), [solo('Knight', [bash(stunChance)], { baseDamage: 1 })]);
      const { events } = playLive(state, 1200000, createRng(77));
      const stunned = ofKind(events, 'stun').reduce((sum, e) => sum + e.durationMs!, 0);
      expect(stunned / combatRealElapsedMs(state)).toBeCloseTo(stunChance, 1);
    },
  );
});

describe('ramps', () => {
  describe('Sunder', () => {
    const sunder = LEGACY_SEED_SKILLS.knight_sunder;
    const kitOf = (seconds: number): number => paceKit(pace(2, { Knight: seconds }), 'Knight');
    const sunderFight = (seconds: number, untilRealMs: number) => {
      const state = fight(pace(2, { Knight: seconds }), [solo('Knight', [sunder])]);
      const events: CombatEvent[] = [];
      const shown: (number | undefined)[] = [];
      while (combatRealElapsedMs(state) < untilRealMs) {
        step(state, STEADY, { events, log: [] });
        const mark = monsterAt(state, 0).sunderMark;
        expect(mark?.stacks ?? 0).toBeLessThanOrEqual(SUNDER_MAX_STACKS);
        const status = unit(buildClientCombatSnapshot(state, 1, false), 'monster', 0).statuses?.find(s => s.kind === 'mark');
        if (status?.stacks !== undefined && shown.at(-1) !== status.stacks) shown.push(status.stacks);
      }
      return { state, events, shown };
    };

    it('adds up to the kit in stacks at once, without passing the cap', () => {
      const first = sunderFight(3.5, 5500);
      expect(actionNames(first.events)).toEqual(['Sunder', 'auto']);
      expect(monsterAt(first.state, 0).sunderMark).toMatchObject({ stacks: kitOf(3.5) });
      expect(monsterAt(first.state, 0).sunderMark!.totalBonus).toBeCloseTo(0.25 * kitOf(3.5));

      const capped = sunderFight(3.5, 30000);
      expect(actionNames(capped.events).filter(name => name === 'Sunder').length).toBeGreaterThanOrEqual(3);
      expect(monsterAt(capped.state, 0).sunderMark).toMatchObject({ stacks: SUNDER_MAX_STACKS });
    });

    it('totals the same bonus at the cap as authored time', () => {
      const authored = sunderFight(2, 30000);
      expect(monsterAt(authored.state, 0).sunderMark!.stacks).toBe(SUNDER_MAX_STACKS);
      const capped = monsterAt(sunderFight(3.5, 30000).state, 0).sunderMark!.totalBonus!;
      expect(capped).toBeCloseTo(monsterAt(authored.state, 0).sunderMark!.totalBonus!);
      expect(capped).toBeCloseTo(0.75);
      expect(monsterAt(sunderFight(8, 30000).state, 0).sunderMark).toMatchObject({ stacks: SUNDER_MAX_STACKS, totalBonus: 0.75 });
    });

    it('hits the same share harder at the cap', () => {
      const autos = (seconds: number) => ofKind(sunderFight(seconds, 30000).events, 'damage').filter(e => e.src?.side === 'player' && !e.skill).map(e => e.amount);
      expect(autos(2).at(-1)).toBe(175);
      expect(autos(3.5).at(-1)).toBe(Math.round(175 * kitOf(3.5)));
    });

    it('shows whole stacks in snapshots', () => {
      expect(sunderFight(3.5, 30000).shown).toEqual([2, 3]);
      const small = sunderFight(2.4, 30000).shown;
      expect(small.length).toBeGreaterThan(0);
      for (const stacks of small) expect(Number.isInteger(stacks)).toBe(true);
      expect(small.at(-1)).toBe(SUNDER_MAX_STACKS);
    });
  });

  describe('War Song', () => {
    const song = LEGACY_SEED_SKILLS.bard_war_song;
    const songFight = (seconds: number, untilRealMs: number) => {
      const state = fight(pace(2, { Bard: seconds }), [solo('Bard', [song])]);
      const events: CombatEvent[] = [];
      const shown: number[] = [];
      while (combatRealElapsedMs(state) < untilRealMs) {
        step(state, STEADY, { events, log: [] });
        expect(state.partyBuffs[0]?.stacks ?? 0).toBeLessThanOrEqual(WAR_SONG_MAX_STACKS);
        const status = unit(buildClientCombatSnapshot(state, 1, false), 'player', 2).statuses?.find(s => s.kind === 'buff');
        if (status?.stacks !== undefined && shown.at(-1) !== status.stacks) shown.push(status.stacks);
      }
      return { state, events, shown };
    };

    it('reaches the cap in fewer, bigger steps and stops there', () => {
      const { state, events } = songFight(3.5, 60000);
      expect(ofKind(events, 'buff')).toHaveLength(3);
      expect(state.partyBuffs[0].stacks).toBe(WAR_SONG_MAX_STACKS);
      expect(actionNames(events).at(-1)).toBe('auto');
    });

    it('totals the same bonus at the cap as authored time', () => {
      const authored = songFight(2, 60000);
      expect(ofKind(authored.events, 'buff')).toHaveLength(WAR_SONG_MAX_STACKS);
      expect(authored.state.warSongBonus).toBeCloseTo(0.5);
      expect(songFight(3.5, 60000).state.warSongBonus).toBeCloseTo(0.5);

      const oneShot = songFight(12, 3000);
      expect(ofKind(oneShot.events, 'buff').map(e => e.amount)).toEqual([50]);
      expect(oneShot.state.partyBuffs[0].stacks).toBe(WAR_SONG_MAX_STACKS);
    });

    it('shows whole stacks in snapshots', () => {
      const { shown } = songFight(3.5, 60000);
      expect(shown.length).toBeGreaterThan(1);
      for (const stacks of shown) expect(Number.isInteger(stacks)).toBe(true);
      expect(shown.at(-1)).toBe(WAR_SONG_MAX_STACKS);
    });
  });

  describe('Ignite', () => {
    const burns = (p: CombatPace, className: ClassName = 'Mage') => {
      const state = fight(p, [solo(className, [LEGACY_SEED_SKILLS.mage_ignite])]);
      playOut(state, STEADY, 60000);
      return monsterAt(state, 0).dots;
    };
    const total = (dots: { damagePerTick: number }[]): number => dots.reduce((sum, d) => sum + d.damagePerTick, 0);

    it('reaches the full cap in authored time', () => {
      expect(burns(KIT1)).toHaveLength(IGNITE_MAX_STACKS);
    });

    const paces: [string, CombatPace, ClassName][] = [
      ...CLASSES.map((c): [string, CombatPace, ClassName] => [`a ${c} on COMBAT_PACE`, COMBAT_PACE, c]),
      ['kit 3', KIT3, 'Mage'],
      ['a fractional kit', pace(2, { Mage: 3.4 }), 'Mage'],
    ];

    it.each(paces)('caps %s at round(max / kit) stacks, within half a stack of the authored total', (_name, p, className) => {
      const dots = burns(p, className);
      expect(dots).toHaveLength(Math.round(IGNITE_MAX_STACKS / paceKit(p, className)));
      expect(Math.abs(total(dots) - total(burns(KIT1)))).toBeLessThanOrEqual(dots[0].damagePerTick / 2);
    });

    it('keeps one stack however slow the class', () => {
      expect(burns(pace(1, { Mage: 20 }))).toHaveLength(1);
    });
  });
});

describe('durations', () => {
  it('Scorch lasts the striker\'s kit times its authored length, so it stays up between hits', () => {
    const scorched = (p: CombatPace) => {
      const state = fight(p, [solo('Mage', [LEGACY_SEED_SKILLS.mage_scorch])]);
      playLive(state, 2000);
      return state;
    };
    expect(monsterAt(scorched(KIT1), 0).debuffs[0]).toMatchObject({ type: 'scorch', remainingMs: 2000 });
    const state = scorched(KIT3);
    expect(monsterAt(state, 0).debuffs[0]).toMatchObject({ type: 'scorch', remainingMs: 6000 });
    expect(unit(buildClientCombatSnapshot(state, 1, false), 'monster', 0).statuses?.find(s => s.kind === 'scorch')?.remainingMs).toBe(12000);
    playLive(state, 7950);
    expect(monsterAt(state, 0).debuffs).toHaveLength(1);
  });

  it('a damage debuff lasts the kit times its authored length', () => {
    const shot = { ...LEGACY_SEED_SKILLS.archer_crippling_shot, warmup: 0 };
    const debuffOf = (p: CombatPace) => {
      const state = fight(p, [solo('Archer', [shot])]);
      playLive(state, 2000);
      return monsterAt(state, 0).debuffs[0];
    };
    expect(debuffOf(KIT1)).toMatchObject({ type: 'crippling_shot', remainingMs: 3000 });
    expect(debuffOf(KIT3)).toMatchObject({ type: 'crippling_shot', remainingMs: 9000 });
  });

  it('Lullaby lasts the kit times its authored length, and says so in real seconds', () => {
    const lullaby = { ...LEGACY_SEED_SKILLS.bard_lullaby, warmup: 0 };
    const state = fight(KIT3, [solo('Bard', [lullaby])]);
    const { log } = playLive(state, 2000);
    expect(monsterAt(state, 0).debuffs[0]).toMatchObject({ type: 'lullaby', remainingMs: 9000 });
    expect(log).toContain('P\'s Lullaby reduces enemy damage by 20% for 18 seconds');

    const authored = fight(KIT1, [solo('Bard', [lullaby])]);
    expect(playLive(authored, 2000).log).toContain('P\'s Lullaby reduces enemy damage by 20% for 6 seconds');

    const seconds = Math.round(3 * paceActionSeconds(COMBAT_PACE, 'Bard') * 10) / 10;
    expect(playLive(fight(COMBAT_PACE, [solo('Bard', [lullaby])]), 2000).log).toContain(`P's Lullaby reduces enemy damage by 20% for ${seconds} seconds`);
  });
});

describe('forecasts', () => {
  const hero = (): PartyCombatantInit => makePlayer('Hero', 2, { hp: 1000, baseDamage: 100 });

  function roomOf(monster: MonsterDefinition, p?: CombatPace, players: PartyCombatantInit[] = [hero()]): RoomForecastInput {
    return {
      kind: 'room',
      players,
      table: [{ encounterId: 'foes', weight: 1 }],
      monsters: { [monster.id]: monster },
      encounters: { foes: { id: 'foes', name: 'Foes', type: 'explicit', placements: [{ monsterId: monster.id, gridPosition: 4 }] } },
      ...(p ? { pace: p } : {}),
    };
  }

  const coin = monsterDef({ id: 'coin', name: 'Coin', hp: 1000, damage: 100 });
  const chief = monsterDef({ id: 'chief', name: 'Chief', hp: 2400, damage: 100, tier: 'boss', enrage: { afterSeconds: 20 } });

  describe.each([2, COMBAT_PACE.clock])('at a clock of %s', clock => {
    const p = pace(clock);
    const real = (ms: number): number => paceRealMs(p, ms);

    it('report win times in real time and the same win rates as the same key at clock 1', () => {
      const plain = runForecast(roomOf(coin), { key: 'k' });
      const paced = runForecast(roomOf(coin, p), { key: 'k' });
      expect(plain.winPct).toBeGreaterThan(10);
      expect(plain.winPct).toBeLessThan(90);
      expect(plain.medianMs).not.toBeNull();
      expect(paced).toEqual({
        ...plain,
        medianMs: real(plain.medianMs!),
        p90Ms: real(plain.p90Ms!),
      });
    });

    it('report the kill ETA and the enrage reason in real time', () => {
      const plain = runForecast(roomOf(chief), { key: 'k' });
      const paced = runForecast(roomOf(chief, p), { key: 'k' });
      expect(paced.winPct).toBe(plain.winPct);
      expect(paced.reasons.map(r => r.code)).toEqual(plain.reasons.map(r => r.code));
      expect(paced.killEtaMs).toBe(real(plain.killEtaMs!));

      const reason = paced.reasons.find(r => r.code === 'enrage');
      expect(reason?.text).toBe(`They enrage at ${formatForecastClock(real(20000))} — your party needs about ${formatForecastClock(real(plain.killEtaMs!))}`);
      expect(plain.reasons.find(r => r.code === 'enrage')?.text).not.toBe(reason?.text);
    });

    it('judge no_healer in engine time', () => {
      const codes = (hp: number) => {
        const r = runForecast(roomOf(monsterDef({ id: 'm', name: 'M', hp }), p), { key: 'k' });
        return { medianMs: r.medianMs!, codes: r.reasons.map(x => x.code) };
      };
      const midFight = codes(4500);
      expect(midFight.medianMs).toBeGreaterThan(60000);
      expect(midFight.codes).not.toContain('no_healer');
      expect(codes(7000).codes).toContain('no_healer');
    });
  });

  it('forecastReasons compares in engine time and writes in real time', () => {
    const base: ForecastReasonInput = { winPct: 50, sims: 40, stalemates: 0, medianMs: null, killEtaMs: null, partyLevel: 10, humanPlayers: 1, clock: 2 };
    expect(forecastReasons({ ...base, killEtaMs: 570000, enrageAtMs: 480000 })[0].text)
      .toBe('They enrage at 16:00 — your party needs about 19:00');
    expect(forecastReasons({ ...base, killEtaMs: 470000, enrageAtMs: 480000 })).toEqual([]);
    expect(forecastReasons({ ...base, medianMs: 40000 })).toEqual([]);
    expect(forecastReasons({ ...base, medianMs: 61000 }).map(r => r.code)).toEqual(['no_healer']);
  });

  it('leave missing times missing', () => {
    const doomed = monsterDef({ id: 'killer', name: 'Killer', hp: 1e9, damage: 100000 });
    expect(runForecast(roomOf(doomed, pace(2)), { key: 'k' })).toMatchObject({ winPct: 0, medianMs: null, p90Ms: null, killEtaMs: null, atMs: 0 });
  });

  it('play a room at the class pace', () => {
    const p = pace(2, { Archer: 6 });
    const r = runForecast(roomOf(monsterDef({ id: 'm', name: 'M', hp: 1000 }), p), { key: 'k' });
    expect(r).toMatchObject({ winPct: 100, medianMs: 20000, p90Ms: 20000 });
  });

  it('play both kinds of dungeon floor at the class pace', () => {
    const p = pace(2, { Archer: 6 });
    const input: DungeonForecastInput = {
      kind: 'dungeon',
      players: [hero()],
      pace: p,
      dungeon: {
        id: 'd',
        name: 'Den',
        floors: [
          { floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'small', weight: 1 }] },
          { floorNumber: 2, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'big', weight: 1 }], isBoss: true, checkpoints: [0.5], maxWipes: 3 },
        ],
      },
      monsters: {
        small: monsterDef({ id: 'small', name: 'Small', hp: 1000, damage: 1 }),
        big: monsterDef({ id: 'big', name: 'Big', hp: 2300, damage: 1, tier: 'boss' }),
      },
      encounters: {
        small: { id: 'small', name: 'Small', type: 'explicit', placements: [{ monsterId: 'small', gridPosition: 4 }] },
        big: { id: 'big', name: 'Big', type: 'explicit', placements: [{ monsterId: 'big', gridPosition: 4 }] },
      },
    };
    const r = runForecast(input, { key: 'd' });
    expect(r).toMatchObject({ winPct: 100, medianMs: 64000, killEtaMs: 44000 });
  });

  describe('of a live battle', () => {
    it('work from a paced state, in real time, without touching it', () => {
      const p = pace(2, { Archer: 6 });
      const live = fight(p, [hero()], [makeMonster(4, { hp: 1400, tier: 'boss' })]);
      const rng = createRng(4);
      while (combatRealElapsedMs(live) < 10000) processCombatStep(live, COMBAT_STEP_MS, rng);
      const before = JSON.stringify(live);
      const r = runForecast({ kind: 'battle', state: live }, { key: 'battle:1', partyKey: 'pk' });
      expect(JSON.stringify(live)).toBe(before);
      expect(r).toMatchObject({ atMs: 10000, winPct: 100, medianMs: 26000, killEtaMs: 26000 });

      while (!live.finished) processCombatStep(live, COMBAT_STEP_MS, rng);
      expect(combatRealElapsedMs(live)).toBe(r.medianMs);
    });

    it('land on the live fight\'s own last step on COMBAT_PACE, since both run the same steps', () => {
      const live = fight(COMBAT_PACE, [solo('Knight')], [makeMonster(0, { hp: 3000, tier: 'boss' })]);
      const rng = createRng(4);
      while (combatRealElapsedMs(live) < 5000) processCombatStep(live, COMBAT_STEP_MS, rng);
      const r = runForecast({ kind: 'battle', state: live }, { key: 'battle:1', partyKey: 'pk' });
      expect(r.winPct).toBe(100);
      expect(r.atMs).toBe(combatRealElapsedMs(live));

      while (!live.finished) processCombatStep(live, COMBAT_STEP_MS, rng);
      expect(r.medianMs).toBe(combatRealElapsedMs(live));
    });

    it('reason in real time from a paced state', () => {
      const live = fight(pace(2), [hero()], [makeMonster(4, { hp: 2400, damage: 100, tier: 'boss', enrage: { afterSeconds: 20 } })]);
      const rng = createRng(4);
      while (combatRealElapsedMs(live) < 4000) processCombatStep(live, COMBAT_STEP_MS, rng);
      const r = runForecast({ kind: 'battle', state: live }, { key: 'b', partyKey: 'pk' });
      const reason = r.reasons.find(x => x.code === 'enrage');
      expect(reason?.text.startsWith(`They enrage at ${formatForecastClock(40000)} — your party needs about `)).toBe(true);
      expect(reason?.text.endsWith(formatForecastClock(r.killEtaMs!))).toBe(true);
    });
  });

  describe('horizons', () => {
    it('stay in engine time', () => {
      const plain = createPartyCombatState([hero()], [makeMonster(4, { tier: 'boss' })]);
      const paced = fight(KIT3, [hero()], [makeMonster(4, { tier: 'boss' })]);
      expect(defaultHorizonMs(paced)).toBe(defaultHorizonMs(plain));
      expect(defaultHorizonMs(fight(KIT3, [hero()]))).toBe(FORECAST_HORIZON_WITHOUT_ENRAGE_MS);
    });

    const paces: [string, CombatPace][] = [['a clock', pace(2)], ['a class pace', KIT3]];

    it.each(paces)('do not turn a win into a timeout at %s, though it runs past the horizon in real time', (_name, p) => {
      const giant = monsterDef({ id: 'giant', name: 'Giant', hp: 90000 });
      const r = runForecast(roomOf(giant, p), { key: 'k', maxSims: 3, minSims: 3 });
      expect(r).toMatchObject({ winPct: 100, wins: 3, stalemates: 0 });
      expect(r.medianMs!).toBeGreaterThan(FORECAST_HORIZON_WITHOUT_ENRAGE_MS);
    });

    it('do not cut a boss fight short at its enrage horizon in real time', () => {
      const giant = monsterDef({ id: 'giant', name: 'Giant', hp: 54000, tier: 'boss', enrage: { afterSeconds: 60 } });
      const r = runForecast(roomOf(giant, pace(2)), { key: 'k', maxSims: 3, minSims: 3 });
      expect(r).toMatchObject({ winPct: 100, wins: 3, stalemates: 0 });
      expect(r.medianMs!).toBeGreaterThan(60000 + FORECAST_HORIZON_AFTER_ENRAGE_MS);
    });
  });
});
