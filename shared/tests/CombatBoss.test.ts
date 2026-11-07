import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildClientCombatSnapshot, createPartyCombatState, processCombatStep } from '../src/systems/CombatEngine';
import { BOSS_STALEMATE_WINDOW_MS, STALEMATE_WINDOW_MS } from '../src/systems/CombatTiming';
import { ENRAGE_MAX_STACKS, ENRAGE_STEP_PERCENT, ENRAGE_STEP_SECONDS, ENRAGE_TIER_DEFAULTS } from '../src/systems/CombatScaling';
import type { MonsterDefinition } from '../src/systems/MonsterTypes';
import { makeMonster, makePlayer, ofKind, pinRandom, runTo } from './combatTestUtils';

afterEach(() => {
  vi.restoreAllMocks();
});

const BOSS_ENRAGE_S = ENRAGE_TIER_DEFAULTS.boss!.afterSeconds;
const HEALER_SKILLS = [{ skillId: 'heal', value: 100000, cooldown: 0, castTime: 0 }];

describe('enrage', () => {
  it('uses the tier defaults for bosses and raids, never for trash, elites or passive monsters', () => {
    const clock = (m: Partial<MonsterDefinition>) => createPartyCombatState([makePlayer('A', 2)], [makeMonster(4, m)]).monsters[0].enrageState;
    expect(clock({ tier: 'boss' })).toEqual({
      atMs: BOSS_ENRAGE_S * 1000, stepMs: ENRAGE_STEP_SECONDS * 1000, stepPercent: ENRAGE_STEP_PERCENT, maxStacks: ENRAGE_MAX_STACKS, stacks: 0,
    });
    expect(clock({ tier: 'raid' })?.atMs).toBe(ENRAGE_TIER_DEFAULTS.raid!.afterSeconds * 1000);
    expect(clock({ tier: 'elite' })).toBeNull();
    expect(clock({})).toBeNull();
    expect(clock({ tier: 'boss', passive: true })).toBeNull();
    expect(clock({ enrage: { afterSeconds: 10 } })?.atMs).toBe(10000);
  });

  it('stacks on schedule up to the cap and multiplies auto-attacks', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 1 })], [
      makeMonster(4, { damage: 10, enrage: { afterSeconds: 2, stepSeconds: 1, stepPercent: 0.5, maxStacks: 2 } }),
    ]);
    const { events, log } = runTo(state, 5000);
    expect(ofKind(events, 'enrage').map(e => [e.t, e.amount])).toEqual([[2000, 1], [3000, 2]]);
    expect(ofKind(events, 'enrage')[0].src).toEqual({ side: 'monster', pos: 4 });
    expect(log).toContain('Dummy is enraged! (×1.5)');
    expect(log).toContain('Dummy is enraged! (×2)');
    const hits = ofKind(events, 'damage').filter(e => e.dst?.side === 'player').map(e => [e.t, e.amount]);
    expect(hits).toEqual([[1400, 10], [2400, 15], [3400, 20], [4400, 20]]);
  });

  it('multiplies skill damage and the DoTs the monster applies', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 1 })], [
      makeMonster(4, {
        damage: 1,
        skills: [{ skillId: 'rot', value: 10, cooldown: 100 }],
        enrage: { afterSeconds: 0, stepPercent: 0.5, maxStacks: 1 },
      }),
    ]);
    const { events } = runTo(state, 3000);
    const rot = ofKind(events, 'damage').find(e => e.overTime && e.dst?.side === 'player');
    expect(rot?.amount).toBe(15);
  });

  it('shows up in every snapshot and as an enrage status once stacked', () => {
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 1 })], [
      makeMonster(4, { damage: 1, enrage: { afterSeconds: 1, stepSeconds: 1, maxStacks: 3 } }),
    ]);
    expect(buildClientCombatSnapshot(state, 1, false).units[1].enrage).toEqual({
      atMs: 1000, stacks: 0, stepMs: 1000, stepPercent: ENRAGE_STEP_PERCENT, maxStacks: 3,
    });
    runTo(state, 2000);
    const unit = buildClientCombatSnapshot(state, 1, false).units[1];
    expect(unit.enrage?.stacks).toBe(2);
    expect(unit.statuses).toContainEqual({ kind: 'enrage', name: 'Enraged', stacks: 2 });
  });
});

describe('stalemate window', () => {
  it('is 180 s while a boss is alive and 30 s otherwise', () => {
    pinRandom();
    const run = (tier: MonsterDefinition['tier']) => {
      const state = createPartyCombatState([makePlayer('A', 2, { hp: 1e6 })], [makeMonster(4, { tier, skills: HEALER_SKILLS })]);
      runTo(state, 400000);
      return state;
    };
    const boss = run('boss');
    expect(boss.result).toBe('defeat');
    expect(boss.elapsedMs).toBe(boss.lastProgressMs + BOSS_STALEMATE_WINDOW_MS);
    const trash = run(undefined);
    expect(trash.elapsedMs).toBe(trash.lastProgressMs + STALEMATE_WINDOW_MS);
  });

  it('ignores a passive boss-tier wall', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 7, { hp: 1e6 })], [
      makeMonster(1, { id: 'gate', name: 'Gate', hp: 1e9, passive: true, tier: 'boss' }),
      makeMonster(7, { skills: HEALER_SKILLS }),
    ]);
    runTo(state, 400000);
    expect(state.result).toBe('defeat');
    expect(state.elapsedMs).toBe(state.lastProgressMs + STALEMATE_WINDOW_MS);
  });
});

describe('boss fights', () => {
  it('run from full HP to the kill with no phase events or checkpoint lines', () => {
    pinRandom();
    const state = createPartyCombatState(
      [makePlayer('A', 2, { baseDamage: 100, hp: 1e6 })],
      [makeMonster(4, { hp: 1000, tier: 'boss' })],
    );
    expect(state.monsters[0].currentHp).toBe(1000);
    const { events, log } = runTo(state, 20000);
    expect(state.result).toBe('victory');
    expect(events.map(e => e.kind as string)).not.toContain('phase');
    expect(log.filter(line => /checkpoint/i.test(line))).toEqual([]);
    expect(state).not.toHaveProperty('bossPhases');
  });

  it('give clients the tier and walls in full snapshots, and HP and the enrage clock in every one', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [
      makeMonster(0, { tier: 'boss', name: 'Twin', hp: 1000 }),
      makeMonster(1, { tier: 'boss', name: 'Idol', hp: 1000, passive: true }),
      makeMonster(4, { tier: 'raid', name: 'Twin', hp: 1000 }),
      makeMonster(7, { tier: 'elite', name: 'Guard', hp: 1000 }),
    ]);
    const monsters = (full: boolean) => buildClientCombatSnapshot(state, 1, full).units.filter(u => u.side === 'monster');
    expect(monsters(true).map(u => [u.pos, u.tier, !!u.passive])).toEqual([
      [0, 'boss', false], [1, 'boss', true], [4, 'raid', false], [7, 'elite', false],
    ]);
    expect(monsters(false).find(u => u.pos === 4)).toMatchObject({ hp: 1000, maxHp: 1000, enrage: { stacks: 0 } });
    expect(buildClientCombatSnapshot(state, 1, true)).not.toHaveProperty('bossPhases');
  });
});

describe('snapshot and state additions', () => {
  it('full snapshots carry levels, level sources and tiers', () => {
    const state = createPartyCombatState([makePlayer('A', 2, { level: 12 })], [
      makeMonster(0, { level: 7, tier: 'elite' }),
      makeMonster(4, { damage: 4 }),
    ]);
    const [p, authored, derived] = buildClientCombatSnapshot(state, 1, true).units;
    expect(p.level).toBe(12);
    expect(authored).toMatchObject({ level: 7, levelSource: 'authored', tier: 'elite' });
    expect(derived).toMatchObject({ levelSource: 'derived', tier: 'trash' });
    expect(buildClientCombatSnapshot(state, 1, false).units[1].tier).toBeUndefined();
  });

  it('tracks the lowest party HP share seen', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2, { hp: 100 }), makePlayer('B', 5, { hp: 100 })], [
      makeMonster(4, { hp: 1e6, damage: 30 }),
    ]);
    expect(state.minPartyHpFrac).toBe(1);
    let lowest = 1;
    while (!state.finished) {
      processCombatStep(state);
      const frac = state.players.reduce((s, p) => s + p.currentHp, 0) / 200;
      lowest = Math.min(lowest, frac);
      expect(state.minPartyHpFrac).toBeCloseTo(lowest, 10);
    }
    expect(state.minPartyHpFrac).toBe(0);
  });
});
