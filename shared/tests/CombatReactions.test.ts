import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPartyCombatState } from '../src/systems/CombatEngine';
import { LEGACY_SEED_SKILLS } from './legacySeedSkills';
import { createMonsterInstance, SEED_MONSTERS } from '../src/systems/MonsterTypes';
import { INTERRUPT_DELAY_MS } from '../src/systems/CombatTiming';
import {
  activeSkill,
  makeMonster,
  makePlayer,
  monsterAt,
  ofKind,
  pinRandom,
  player,
  runTo,
} from './combatTestUtils';

afterEach(() => { vi.restoreAllMocks(); });

const intercept = LEGACY_SEED_SKILLS.knight_intercept;
const shieldSlam = LEGACY_SEED_SKILLS.knight_shield_slam;
const caster = (pos: 0 | 3 | 6, name = 'Shaman', castTime?: number) => makeMonster(pos, {
  name, skills: [{ skillId: 'fireball', value: 5, cooldown: 3, ...(castTime !== undefined ? { castTime } : {}) }],
});

describe('Intercept (ally_targeted)', () => {
  function setup(archerHp = 200) {
    const knight = makePlayer('Arthur', 0, { className: 'Knight', hp: 500, baseDamage: 1, skills: [LEGACY_SEED_SKILLS.knight_guard, intercept] });
    const archer = makePlayer('Robin', 2, { hp: archerHp, baseDamage: 1 });
    return createPartyCombatState([knight, archer], [makeMonster(1, { damage: 5 })]);
  }

  it('redirects a single-target attack aimed at a frailer ally, then waits out its 2 s cooldown', () => {
    const state = setup();
    const r = runTo(state, 1400);
    const at1400 = r.events.filter(e => e.t === 1400).map(e => e.kind);
    expect(at1400).toEqual(['reaction', 'redirect', 'attack', 'damage']);
    expect(ofKind(r.events, 'reaction')[0]).toMatchObject({
      src: { side: 'player', pos: 0 }, dst: { side: 'player', pos: 2 },
      skill: 'Intercept', skillId: 'knight_intercept', cardType: 'instant',
    });
    expect(ofKind(r.events, 'redirect')[0]).toMatchObject({ src: { side: 'player', pos: 0 }, dst: { side: 'player', pos: 2 } });
    expect(ofKind(r.events, 'attack').at(-1)!.dst).toEqual({ side: 'player', pos: 0 });
    expect(r.log).toContain('Arthur intercepts the attack on Robin!');
    expect(player(state, 'Robin').currentHp).toBe(200);
    expect(player(state, 'Arthur').currentHp).toBe(500 - 2);
    expect(player(state, 'Arthur').skillCooldowns.knight_intercept).toBe(2000);

    runTo(state, 2400, r);
    expect(player(state, 'Robin').currentHp).toBe(195);

    runTo(state, 3400, r);
    expect(ofKind(r.events, 'redirect').map(e => e.t)).toEqual([1400, 3400]);
    expect(player(state, 'Robin').currentHp).toBe(195);
  });

  it('never protects an ally with at least the Knight\'s max HP', () => {
    const state = setup(500);
    const r = runTo(state, 1400);
    expect(ofKind(r.events, 'reaction')).toHaveLength(0);
    expect(player(state, 'Robin').currentHp).toBe(495);
    expect(player(state, 'Arthur').skillCooldowns.knight_intercept).toBe(0);
  });

  it('a redirected attack does not raise ally_targeted again', () => {
    const state = createPartyCombatState([
      makePlayer('K1', 1, { className: 'Knight', hp: 500, skills: [intercept] }),
      makePlayer('K2', 0, { className: 'Knight', hp: 800, skills: [intercept] }),
      makePlayer('Robin', 2, { hp: 200 }),
    ], [makeMonster(1, { damage: 5 })]);
    const r = runTo(state, 1400);
    expect(ofKind(r.events, 'reaction')).toHaveLength(1);
    expect(ofKind(r.events, 'redirect')).toHaveLength(1);
    expect(player(state, 'K1').currentHp).toBe(495);
    expect(player(state, 'K2').currentHp).toBe(800);
    expect(player(state, 'K2').skillCooldowns.knight_intercept).toBe(0);
  });

  it('saves itself for a telegraphed spell locked on an ally, then intercepts the spell', () => {
    const knight = makePlayer('K', 0, { className: 'Knight', hp: 500, skills: [intercept] });
    const archer = makePlayer('R', 2, { hp: 200 });
    const state = createPartyCombatState([knight, archer], [
      makeMonster(0, { name: 'Rogue', damage: 0, skills: [{ skillId: 'assassinate', value: 30, cooldown: 6 }] }),
      makeMonster(3, { name: 'Brute', damage: 5 }),
    ]);
    const r = runTo(state, 1500);
    expect(ofKind(r.events, 'cast_start')).toEqual([expect.objectContaining({
      t: 1400, src: { side: 'monster', pos: 0 }, dst: { side: 'player', pos: 2 }, skill: 'Assassinate', durationMs: 1000,
    })]);
    expect(r.log).toContain('Rogue begins casting Assassinate!');
    expect(ofKind(r.events, 'reaction')).toHaveLength(0);
    expect(player(state, 'R').currentHp).toBe(195);

    runTo(state, 2400, r);
    expect(ofKind(r.events, 'redirect')).toEqual([expect.objectContaining({ t: 2400 })]);
    expect(r.log).toContain('K intercepts Rogue\'s Assassinate aimed at R!');
    expect(player(state, 'K').currentHp).toBe(470);

    runTo(state, 2500, r);
    expect(player(state, 'R').currentHp).toBe(190);
  });

  it('cancels the attack when the reaction killed the attacker', () => {
    pinRandom();
    const riposte = activeSkill({
      id: 'riposte', name: 'Riposte', trigger: 'ally_targeted', cooldown: 1,
      activeEffects: [{ kind: 'high_damage_single', damagePercent: 100 }],
    });
    const state = createPartyCombatState([
      makePlayer('K', 0, { className: 'Knight', hp: 500, baseDamage: 1, skills: [riposte] }),
      makePlayer('R', 2, { hp: 200, baseDamage: 1 }),
    ], [makeMonster(1, { hp: 50, damage: 20 })]);
    const r = runTo(state, 1400);
    expect(state.result).toBe('victory');
    expect(ofKind(r.events, 'reaction')).toEqual([expect.objectContaining({ skill: 'Riposte', cardType: 'instant' })]);
    expect(ofKind(r.events, 'attack').filter(e => e.src?.side === 'monster')).toHaveLength(0);
    expect(player(state, 'R').currentHp).toBe(200);
  });

  it('fires while its owner is casting', () => {
    const channel = activeSkill({ id: 'ch', castTime: 1, cooldown: 5, warmup: 0 });
    const state = createPartyCombatState([
      makePlayer('Arthur', 0, { className: 'Knight', hp: 500, skills: [channel, intercept] }),
      makePlayer('Robin', 2, { hp: 200 }),
    ], [makeMonster(1, { damage: 5 })]);
    runTo(state, 1300);
    expect(player(state, 'Arthur').cast).not.toBeNull();
    const r = runTo(state, 1400);
    expect(ofKind(r.events, 'redirect')).toHaveLength(1);
    expect(player(state, 'Arthur').cast!.remainingMs).toBe(700);
  });

  it('an ally-targeted shield lands before the hit, and never on a Knight', () => {
    const guardianLight = activeSkill({
      id: 'gl', name: 'Guardian Light', className: 'Priest', trigger: 'ally_targeted', cooldown: 3,
      activeEffects: [{ kind: 'shield_non_knight', shieldMultiplier: 4 }],
    });
    const state = createPartyCombatState([
      makePlayer('P', 5, { className: 'Priest', level: 5, skills: [guardianLight] }),
      makePlayer('A', 2, { className: 'Archer' }),
    ], [makeMonster(1, { damage: 30 })]);
    const r = runTo(state, 1400);
    expect(r.events.filter(e => e.t === 1400).map(e => e.kind)).toEqual(['reaction', 'shield', 'attack', 'absorb', 'damage']);
    expect(player(state, 'A').currentHp).toBe(990);

    const knightTarget = createPartyCombatState([
      makePlayer('P', 5, { className: 'Priest', level: 5, skills: [guardianLight] }),
      makePlayer('K', 2, { className: 'Knight' }),
    ], [makeMonster(1, { damage: 30 })]);
    const r2 = runTo(knightTarget, 1400);
    expect(ofKind(r2.events, 'reaction')).toHaveLength(0);
    expect(player(knightTarget, 'P').skillCooldowns.gl).toBe(0);
  });

  it('a stunned Knight cannot intercept', () => {
    const state = setup();
    player(state, 'Arthur').stunRemainingMs = 2000;
    const r = runTo(state, 1400);
    expect(ofKind(r.events, 'reaction')).toHaveLength(0);
    expect(player(state, 'Robin').currentHp).toBe(195);
  });
});

describe('Shield Slam (self_hit)', () => {
  it('reflects a share of a physical hit to every living enemy right away', () => {
    const state = createPartyCombatState(
      [makePlayer('K', 2, { className: 'Knight', skills: [shieldSlam] })],
      [makeMonster(0, { damage: 50 }), makeMonster(3, { damage: 50 })],
    );
    const r = runTo(state, 1400);
    const at1400 = r.events.filter(e => e.t === 1400);
    expect(at1400.map(e => e.kind)).toEqual(['attack', 'damage', 'reaction', 'damage', 'damage']);
    const reflects = ofKind(at1400, 'damage').filter(e => e.skill === 'Shield Slam');
    expect(reflects.map(e => [e.dst!.pos, e.amount, e.dmgType])).toEqual([[0, 5, 'physical'], [3, 5, 'physical']]);
    expect(r.log).toContain('K\'s Shield Slam reflects 5 damage to Dummy');
    expect(state.players[0].skillCooldowns.knight_shield_slam).toBe(1000);

    runTo(state, 1500, r);
    expect(ofKind(r.events, 'reaction')).toHaveLength(1);
  });

  it('fires once per cooldown even when two hits land in the same step', () => {
    const state = createPartyCombatState(
      [makePlayer('K', 2, { className: 'Knight', skills: [shieldSlam] })],
      [makeMonster(0, { damage: 50 }), makeMonster(3, { damage: 50, attackInterval: 0.9 })],
    );
    const r = runTo(state, 2400);
    expect(ofKind(r.events, 'attack').filter(e => e.src?.side === 'monster' && e.t === 2400)).toHaveLength(2);
    expect(ofKind(r.events, 'reaction').map(e => e.t)).toEqual([1400, 2400]);
  });

  it('ignores magical hits (no reaction, no cooldown)', () => {
    const state = createPartyCombatState(
      [makePlayer('K', 2, { className: 'Knight', skills: [shieldSlam] })],
      [makeMonster(0, { damage: 30, damageType: 'magical' })],
    );
    const r = runTo(state, 3000);
    expect(state.players[0].currentHp).toBeLessThan(1000);
    expect(ofKind(r.events, 'reaction')).toHaveLength(0);
    expect(state.players[0].skillCooldowns.knight_shield_slam).toBe(0);
  });

  it('does not react to a hit fully absorbed by a shield', () => {
    const state = createPartyCombatState(
      [makePlayer('K', 2, { className: 'Knight', level: 30, skills: [LEGACY_SEED_SKILLS.knight_guard, shieldSlam] })],
      [makeMonster(0, { damage: 50 })],
    );
    state.players[0].damageShield = 1000;
    const r = runTo(state, 1400);
    expect(state.players[0].currentHp).toBe(1000);
    expect(ofKind(r.events, 'reaction')).toHaveLength(0);
  });

  it('a Knight killed by the hit never reacts', () => {
    const state = createPartyCombatState(
      [makePlayer('K', 2, { className: 'Knight', hp: 30, skills: [shieldSlam] }), makePlayer('B', 5)],
      [makeMonster(0, { damage: 50 })],
    );
    const r = runTo(state, 1400);
    expect(player(state, 'K').currentHp).toBe(0);
    expect(ofKind(r.events, 'reaction')).toHaveLength(0);
    expect(r.log).toContain('K has fallen!');
  });
});

describe('Cure (ally_afflicted level trigger)', () => {
  function fearFight() {
    const state = createPartyCombatState([
      makePlayer('P', 2, { className: 'Priest', skills: [LEGACY_SEED_SKILLS.priest_cure] }),
      makePlayer('A', 5, { className: 'Archer', hp: 1000 }),
      makePlayer('M', 1, { className: 'Mage', hp: 500 }),
    ], [makeMonster(0, { name: 'Horror', skills: [{ skillId: 'fear', value: 1, cooldown: 3 }] })]);
    player(state, 'M').currentHp = 200;
    return state;
  }

  it('cleanses one Fear victim (lowest %HP first) and the rest wait for the next cooldown', () => {
    const state = fearFight();
    const r = runTo(state, 2400);
    expect(ofKind(r.events, 'cast_start')).toEqual([expect.objectContaining({ t: 1400, skill: 'Fear', durationMs: 1000 })]);
    const at2400 = r.events.filter(e => e.t === 2400);
    expect(ofKind(at2400, 'stun').map(e => e.dst!.pos)).toEqual([5, 1]);
    expect(r.log).toContain('Horror casts Fear! A, M are stunned!');
    expect(ofKind(r.events, 'reaction')).toEqual([expect.objectContaining({
      t: 2400, src: { side: 'player', pos: 2 }, dst: { side: 'player', pos: 1 }, skill: 'Cure', cardType: 'instant',
    })]);
    expect(ofKind(r.events, 'cleanse')).toEqual([expect.objectContaining({ dst: { side: 'player', pos: 1 } })]);
    expect(r.log).toContain('P cures M\'s afflictions!');
    expect(player(state, 'M').stunRemainingMs).toBe(0);
    expect(player(state, 'A').stunRemainingMs).toBe(1000);
    expect(player(state, 'P').skillCooldowns.priest_cure).toBe(3000);

    runTo(state, 3400, r);
    expect(ofKind(r.events, 'reaction')).toHaveLength(1);
    expect(player(state, 'A').stunRemainingMs).toBe(0);
  });

  it('a cured player acts again right away', () => {
    const state = fearFight();
    const r = runTo(state, 3100);
    const mageActs = ofKind(r.events, 'attack').filter(e => e.src?.side === 'player' && e.src.pos === 1).map(e => e.t);
    expect(mageActs).toEqual([1200, 2200, 3200].filter(t => t <= 3100));
    const archerActs = ofKind(r.events, 'attack').filter(e => e.src?.side === 'player' && e.src.pos === 5).map(e => e.t);
    expect(archerActs).toEqual([1100, 2100]);
  });

  it('removes DoTs and debuffs too', () => {
    const state = createPartyCombatState([
      makePlayer('P', 2, { className: 'Priest', skills: [LEGACY_SEED_SKILLS.priest_cure] }),
      makePlayer('K', 5, { className: 'Knight' }),
    ], [makeMonster(0)]);
    player(state, 'K').dots.push({ sourceUsername: 'x', name: 'rot', damagePerTick: 3, ticksRemaining: 3, damageType: 'magical' });
    player(state, 'K').debuffs.push({ type: 'weak', value: 0.1, remainingMs: 5000 });
    const r = runTo(state, 100);
    expect(ofKind(r.events, 'cleanse')).toHaveLength(1);
    expect(player(state, 'K').dots).toEqual([]);
    expect(player(state, 'K').debuffs).toEqual([]);
  });

  it('a stunned priest cannot cure', () => {
    const state = createPartyCombatState([
      makePlayer('P', 2, { className: 'Priest', skills: [LEGACY_SEED_SKILLS.priest_cure] }),
      makePlayer('K', 5, { className: 'Knight' }),
    ], [makeMonster(0)]);
    player(state, 'P').stunRemainingMs = 5000;
    player(state, 'K').debuffs.push({ type: 'weak', value: 0.1, remainingMs: 5000 });
    const r = runTo(state, 1000);
    expect(ofKind(r.events, 'reaction')).toHaveLength(0);
  });

  it('a cure un-pauses a stunned player\'s cast', () => {
    const channel = activeSkill({ id: 'ch', castTime: 1, cooldown: 5, warmup: 0 });
    const state = createPartyCombatState([
      makePlayer('M', 2, { className: 'Mage', skills: [channel] }),
      makePlayer('P', 5, { className: 'Priest', skills: [LEGACY_SEED_SKILLS.priest_cure] }),
    ], [makeMonster(0)]);
    runTo(state, 1300);
    player(state, 'M').stunRemainingMs = 1000;
    const r = runTo(state, 2100);
    expect(ofKind(r.events, 'cleanse')).toEqual([expect.objectContaining({ t: 1400, dst: { side: 'player', pos: 2 } })]);
    expect(ofKind(r.events, 'cast_end').map(e => e.t)).toEqual([2100]);
  });
});

describe('Mending (ally_low_hp level trigger)', () => {
  it('lays a heal-over-time on an ally below half health, then waits 4 s', () => {
    const state = createPartyCombatState([
      makePlayer('P', 2, { className: 'Priest', level: 5, skills: [LEGACY_SEED_SKILLS.priest_mending] }),
      makePlayer('T', 5, { className: 'Knight', hp: 1000 }),
    ], [makeMonster(0)]);
    player(state, 'T').currentHp = 400;
    const r = runTo(state, 100);
    expect(ofKind(r.events, 'reaction')).toEqual([expect.objectContaining({
      t: 100, dst: { side: 'player', pos: 5 }, skill: 'Mending', cardType: 'instant',
    })]);
    expect(ofKind(r.events, 'status')).toEqual([expect.objectContaining({ dst: { side: 'player', pos: 5 }, name: 'Mending' })]);
    expect(r.log).toContain('P applies Mending to T (10 HP per second for 3 seconds)');

    runTo(state, 3100, r);
    expect(player(state, 'T').hots).toEqual([]);
    runTo(state, 4100, r);
    const heals = ofKind(r.events, 'heal');
    expect(heals.map(e => [e.t, e.amount, e.overTime])).toEqual([[1100, 10, true], [2100, 10, true], [3100, 10, true]]);
    expect(r.log).toContain('T heals for 10 HP from mending');
    expect(ofKind(r.events, 'reaction').map(e => e.t)).toEqual([100, 4100]);
  });

  it('does nothing while everyone is above half health', () => {
    const state = createPartyCombatState([
      makePlayer('P', 2, { className: 'Priest', level: 5, skills: [LEGACY_SEED_SKILLS.priest_mending] }),
      makePlayer('T', 5, { hp: 1000 }),
    ], [makeMonster(0)]);
    player(state, 'T').currentHp = 600;
    const r = runTo(state, 3000);
    expect(ofKind(r.events, 'reaction')).toHaveLength(0);
    expect(player(state, 'P').skillCooldowns.priest_mending).toBe(0);
  });
});

describe('reaction chains', () => {
  it('resolve depth-first: an intercepted hit triggers the interceptor\'s Shield Slam', () => {
    const state = createPartyCombatState([
      makePlayer('K', 0, { className: 'Knight', hp: 500, skills: [intercept, shieldSlam] }),
      makePlayer('R', 2, { hp: 200 }),
    ], [makeMonster(1, { damage: 50 })]);
    const r = runTo(state, 1400);
    const seq = r.events.filter(e => e.t === 1400).map(e => `${e.kind}${e.skill ? `:${e.skill}` : ''}`);
    expect(seq).toEqual([
      'reaction:Intercept', 'redirect:Intercept', 'attack', 'damage', 'reaction:Shield Slam', 'damage:Shield Slam',
    ]);
    expect(player(state, 'K').skillCooldowns).toEqual({ knight_intercept: 2000, knight_shield_slam: 1000 });
  });
});

describe('interrupts (enemy_cast)', () => {
  const dispel = activeSkill({
    id: 'dispel', name: 'Dispel', trigger: 'enemy_cast', cooldown: 4, warmup: 0,
    activeEffects: [{ kind: 'remove_buffs' }],
  });
  const drum = activeSkill({
    id: 'drum', name: 'Drumroll', className: 'Bard', trigger: 'enemy_cast', cooldown: 4, warmup: 0,
    activeEffects: [{ kind: 'stun_aoe', stunChance: 0.25 }],
  });

  it('commits at cast start and counters INTERRUPT_DELAY_MS later', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('K', 2, { className: 'Knight', skills: [dispel] })], [caster(0)]);
    state.monsters[0].buffs.push({ type: 'ward', value: 1, remainingMs: -1, name: 'Ward' });
    const r = runTo(state, 1400);
    expect(ofKind(r.events, 'attack').find(e => e.t === 1000)!.skillId).toBeUndefined();
    const at1400 = r.events.filter(e => e.t === 1400);
    expect(at1400.map(e => e.kind)).toEqual(['cast_start', 'reaction']);
    expect(at1400[1]).toMatchObject({
      src: { side: 'player', pos: 2 }, dst: { side: 'monster', pos: 0 }, skill: 'Dispel', skillId: 'dispel', cardType: 'instant',
    });
    expect(state.players[0].skillCooldowns.dispel).toBe(4000);
    expect(state.monsters[0].cast!.counter).toEqual({ reactorUsername: 'K', skillId: 'dispel', atMs: 1400 + INTERRUPT_DELAY_MS });

    runTo(state, 1600, r);
    expect(ofKind(r.events, 'interrupt')).toHaveLength(0);
    runTo(state, 1700, r);
    const at1700 = r.events.filter(e => e.t === 1700);
    expect(at1700.map(e => e.kind)).toEqual(['damage', 'cleanse', 'interrupt']);
    expect(at1700[2]).toMatchObject({
      src: { side: 'player', pos: 2 }, dst: { side: 'monster', pos: 0 }, skill: 'Fireball', skillId: 'fireball', countered: true,
    });
    expect(r.log).toContain('K\'s Dispel counters Shaman\'s Fireball!');
    expect(state.monsters[0].cast).toBeNull();
    expect(state.monsters[0].buffs).toEqual([]);
    expect(state.monsters[0].skillCooldowns.fireball).toBeGreaterThan(0);

    runTo(state, 4000, r);
    expect(ofKind(r.events, 'interrupt')).toHaveLength(1);
    expect(ofKind(r.events, 'cast_end')).toHaveLength(0);
    expect(ofKind(r.events, 'attack').filter(e => e.src?.side === 'monster').map(e => e.t)).toEqual([2900, 3900]);
    expect(state.players[0].currentHp).toBe(1000);
  });

  it('counters at once when the cast would resolve before the delay', () => {
    const state = createPartyCombatState([makePlayer('K', 2, { className: 'Knight', skills: [dispel] })], [caster(0, 'Shaman', 0.2)]);
    const r = runTo(state, 1400);
    expect(r.events.filter(e => e.t === 1400).map(e => e.kind)).toEqual(['cast_start', 'reaction', 'damage', 'interrupt']);
    expect(state.monsters[0].cast).toBeNull();
    expect(state.pendingCounters).toEqual([]);
  });

  it('interrupt stuns roll their normal chance and never emit a second interrupt', () => {
    pinRandom(0.1);
    const state = createPartyCombatState([makePlayer('B', 2, { className: 'Bard', skills: [drum] })], [caster(0)]);
    const r = runTo(state, 1700);
    expect(ofKind(r.events, 'stun')).toEqual([expect.objectContaining({ t: 1700, dst: { side: 'monster', pos: 0 } })]);
    expect(ofKind(r.events, 'interrupt')).toEqual([expect.objectContaining({ src: { side: 'player', pos: 2 }, skill: 'Fireball' })]);
    expect(r.log).toContain('B\'s Drumroll counters Shaman\'s Fireball!');
    expect(r.log).not.toContain('Shaman\'s Fireball is interrupted!');
    expect(state.monsters[0].stunRemainingMs).toBe(900);
  });

  it('the counter is guaranteed even when the stun roll fails', () => {
    pinRandom(0.9);
    const state = createPartyCombatState([makePlayer('B', 2, { className: 'Bard', skills: [drum] })], [caster(0)]);
    const r = runTo(state, 1700);
    expect(ofKind(r.events, 'stun')).toHaveLength(0);
    expect(ofKind(r.events, 'interrupt')).toHaveLength(1);
    expect(ofKind(r.events, 'fizzle')).toHaveLength(0);
  });

  it('a counter\'s stun on another casting enemy interrupts that cast normally', () => {
    pinRandom(0.1);
    const state = createPartyCombatState([makePlayer('B', 2, { className: 'Bard', skills: [drum] })], [caster(0, 'First'), caster(3, 'Second')]);
    const r = runTo(state, 1700);
    expect(ofKind(r.events, 'reaction')).toEqual([expect.objectContaining({ t: 1400, dst: { side: 'monster', pos: 0 } })]);
    const interrupts = ofKind(r.events, 'interrupt');
    expect(interrupts.map(e => e.dst!.pos).sort()).toEqual([0, 3]);
    expect(interrupts.find(e => e.dst!.pos === 0)!.countered).toBe(true);
    expect(interrupts.find(e => e.dst!.pos === 3)!.countered).toBeUndefined();
    expect(r.log).toContain('Second\'s Fireball is interrupted!');
    expect(r.log).toContain('B\'s Drumroll counters First\'s Fireball!');
  });

  it('casts started in the same step are handled in monster order, each by the next free reactor', () => {
    const state = createPartyCombatState([
      makePlayer('K', 2, { className: 'Knight', skills: [dispel] }),
      makePlayer('K2', 5, { className: 'Knight', skills: [dispel] }),
    ], [caster(0, 'First'), caster(3, 'Second')]);
    state.monsters[1].actionRemainingMs = 1400;
    const r = runTo(state, 1700);
    expect(ofKind(r.events, 'reaction').map(e => [e.t, e.src!.pos, e.dst!.pos])).toEqual([[1400, 2, 0], [1400, 5, 3]]);
    expect(ofKind(r.events, 'interrupt').map(e => [e.t, e.src!.pos, e.dst!.pos])).toEqual([[1700, 2, 0], [1700, 5, 3]]);
  });

  it('a pending counter still applies its effects when another stun already cancelled the cast', () => {
    pinRandom();
    const jolt = activeSkill({ id: 'jolt', name: 'Jolt', cooldown: 5, warmup: 0, activeEffects: [{ kind: 'stun_single', stunChance: 1 }] });
    const state = createPartyCombatState([
      makePlayer('J', 2, { skills: [jolt] }),
      makePlayer('K', 5, { className: 'Knight', skills: [dispel] }),
    ], [caster(0)]);
    state.monsters[0].actionRemainingMs = 900;
    const r = runTo(state, 1200);
    expect(ofKind(r.events, 'reaction')).toEqual([expect.objectContaining({ t: 900, src: { side: 'player', pos: 5 } })]);
    const interrupts = ofKind(r.events, 'interrupt');
    expect(interrupts).toEqual([expect.objectContaining({ t: 1000, src: { side: 'player', pos: 2 } })]);
    expect(ofKind(r.events, 'damage').filter(e => e.skill === 'Dispel').map(e => e.t)).toEqual([1200]);
  });

  it('no interrupt when the caster died before the counter resolved', () => {
    const state = createPartyCombatState([
      makePlayer('K', 2, { className: 'Knight', skills: [dispel] }),
      makePlayer('Killer', 5, { baseDamage: 100000 }),
    ], [caster(0), makeMonster(3)]);
    player(state, 'Killer').actionRemainingMs = 1500;
    player(state, 'Killer').gridPosition = 2;
    const r = runTo(state, 1700);
    expect(monsterAt(state, 0).currentHp).toBe(0);
    expect(ofKind(r.events, 'interrupt')).toHaveLength(0);
    expect(ofKind(r.events, 'cast_end')).toHaveLength(0);
  });

  it('a stunned reactor cannot commit — the next eligible one does', () => {
    const state = createPartyCombatState([
      makePlayer('K', 2, { className: 'Knight', skills: [dispel] }),
      makePlayer('K2', 5, { className: 'Knight', skills: [dispel] }),
    ], [caster(0)]);
    player(state, 'K').stunRemainingMs = 5000;
    const r = runTo(state, 1400);
    expect(ofKind(r.events, 'reaction').map(e => e.src!.pos)).toEqual([5]);
  });

  it('interrupts are never CDR-reduced', () => {
    const state = createPartyCombatState([
      makePlayer('B', 2, { className: 'Bard', skills: [drum, LEGACY_SEED_SKILLS.bard_tempo, LEGACY_SEED_SKILLS.bard_encore] }),
    ], [caster(0)]);
    runTo(state, 1400);
    expect(state.players[0].skillCooldowns.drum).toBe(4000);
  });
});

describe('a counter with nothing to counter', () => {
  it('stays idle in a fight with no caster, and the player auto-attacks', () => {
    pinRandom(0.1);
    const bard = makePlayer('Bard', 2, { className: 'Bard', skills: [LEGACY_SEED_SKILLS.bard_drumroll] });
    const state = createPartyCombatState([bard], [createMonsterInstance({ ...SEED_MONSTERS.goblin, hp: 1000 }, 0)]);
    const r = runTo(state, 5000);
    expect(r.events.some(e => e.skillId === 'bard_drumroll')).toBe(false);
    expect(ofKind(r.events, 'attack').filter(e => e.src?.side === 'player').length).toBeGreaterThan(0);
  });

  it('stays idle once the last caster dies', () => {
    pinRandom(0.9);
    const bard = makePlayer('Bard', 2, { className: 'Bard', skills: [LEGACY_SEED_SKILLS.bard_drumroll] });
    const state = createPartyCombatState([bard], [caster(0), createMonsterInstance({ ...SEED_MONSTERS.goblin, hp: 100000 }, 3)]);
    state.monsters[0].currentHp = 0;
    const r = runTo(state, 5000);
    expect(r.events.some(e => e.skillId === 'bard_drumroll')).toBe(false);
  });

  it('never fires as an action, only on a cast', () => {
    pinRandom(0.9);
    const bard = makePlayer('Bard', 2, { className: 'Bard', skills: [LEGACY_SEED_SKILLS.bard_drumroll] });
    const state = createPartyCombatState([bard], [caster(0)]);
    const r = runTo(state, 5000);
    expect(ofKind(r.events, 'attack').filter(e => e.skillId === 'bard_drumroll')).toHaveLength(0);
    expect(ofKind(r.events, 'cast_start').map(e => e.t)).toEqual([1400, 4900]);
    expect(ofKind(r.events, 'reaction').map(e => e.t)).toEqual([4900]);
  });
});
