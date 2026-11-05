import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPartyCombatState } from '../src/systems/CombatEngine';
import { SEED_SKILLS } from '../src/systems/SkillTypes';
import { createMonsterInstance, SEED_MONSTERS } from '../src/systems/MonsterTypes';
import { SCORCH_MS } from '../src/systems/CombatTiming';
import {
  activeSkill,
  makeMonster,
  makePlayer,
  monsterAt,
  ofKind,
  passiveSkill,
  pinRandom,
  player,
  runTo,
} from './combatTestUtils';

afterEach(() => { vi.restoreAllMocks(); });

const bleedDot = (perTick: number, ticks = 3) => ({
  sourceUsername: 'A', name: 'bleed', damagePerTick: perTick, ticksRemaining: ticks, damageType: 'physical' as const,
});

describe('status pulses', () => {
  it('pulses DoTs once per second on the owner\'s pulse, grouped by name', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [makeMonster(0)]);
    state.monsters[0].dots.push(bleedDot(4), bleedDot(4));
    const r = runTo(state, 1400);
    const ticks = ofKind(r.events, 'damage').filter(e => e.overTime);
    expect(ticks).toEqual([expect.objectContaining({ t: 1400, amount: 8, overTime: true, dmgType: 'physical', dst: { side: 'monster', pos: 0 } })]);
    expect(r.log).toContain('Dummy receives 8 physical damage from bleed (x2)!');

    runTo(state, 3400, r);
    expect(ofKind(r.events, 'damage').filter(e => e.overTime).map(e => e.t)).toEqual([1400, 2400, 3400]);
    expect(state.monsters[0].dots).toEqual([]);
  });

  it('applies monster resistance at pulse time, not at application', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [makeMonster(0)]);
    state.monsters[0].dots.push(bleedDot(10));
    const r = runTo(state, 1400);
    state.monsters[0].resistances = [{ damageType: 'physical', flatReduction: 0, percentReduction: 50 }];
    runTo(state, 2400, r);
    expect(ofKind(r.events, 'damage').filter(e => e.overTime).map(e => e.amount)).toEqual([10, 5]);
  });

  it('pulses while stunned, and walls pulse too', () => {
    const wall = createMonsterInstance({ ...SEED_MONSTERS.stone_wall, hp: 1000 }, 0);
    const state = createPartyCombatState([makePlayer('A', 2)], [wall, makeMonster(3)]);
    const w = monsterAt(state, 0);
    const d = monsterAt(state, 3);
    w.dots.push(bleedDot(7));
    d.dots.push(bleedDot(3));
    d.stunRemainingMs = 5000;
    const r = runTo(state, 1500);
    const ticks = ofKind(r.events, 'damage').filter(e => e.overTime).map(e => [e.t, e.dst!.pos, e.amount]);
    expect(ticks).toEqual([[1400, 0, 7], [1500, 3, 3]]);
  });

  it('a stunned player still takes DoT pulses', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [makeMonster(0)]);
    const a = state.players[0];
    a.stunRemainingMs = 5000;
    a.dots.push({ sourceUsername: 'm', name: 'rot', damagePerTick: 4, ticksRemaining: 2, damageType: 'magical' });
    const r = runTo(state, 2000);
    expect(ofKind(r.events, 'damage').filter(e => e.overTime).map(e => [e.t, e.amount])).toEqual([[1000, 4], [2000, 4]]);
    expect(ofKind(r.events, 'attack').filter(e => e.src?.side === 'player')).toHaveLength(0);
  });

  it('Bleed (dot_attack) deals a share of the hit over N pulses', () => {
    pinRandom();
    const bleed = activeSkill({ id: 'bl', name: 'Bleed', cooldown: 10, warmup: 0, activeEffects: [{ kind: 'dot_attack', dotPercent: 0.2, dotTicks: 3 }] });
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 30, skills: [bleed] })], [makeMonster(0)]);
    const r = runTo(state, 3400);
    expect(r.log).toContain('Dummy is bleeding!');
    expect(ofKind(r.events, 'status')).toEqual([expect.objectContaining({ t: 1000, name: 'Bleed' })]);
    expect(ofKind(r.events, 'damage').filter(e => e.overTime).map(e => [e.t, e.amount, e.skill])).toEqual([
      [1400, 2, 'Bleed'], [2400, 2, 'Bleed'], [3400, 2, 'Bleed'],
    ]);
    expect(state.monsters[0].dots).toEqual([]);
  });

  it('Ignite stacks permanently from pre-resistance damage; resistance applies at each pulse', () => {
    pinRandom();
    const mage = makePlayer('M', 2, { className: 'Mage', baseDamage: 20, skills: [SEED_SKILLS.mage_ignite] });
    const state = createPartyCombatState([mage], [makeMonster(0, { resistances: [{ damageType: 'magical', flatReduction: 2, percentReduction: 0 }] })]);
    const r = runTo(state, 3400);
    // Flat 2 is a rating: 2 / (2 + 4 × L1) = 1/3 mitigation. Stacks store 25 % of the unresisted 20.
    expect(ofKind(r.events, 'damage').filter(e => !e.overTime && e.src?.side === 'player').map(e => e.amount)).toEqual([13, 13, 13]);
    expect(ofKind(r.events, 'damage').filter(e => e.overTime).map(e => e.amount)).toEqual([3, 6, 10]);
    expect(state.monsters[0].dots).toHaveLength(3);
    expect(state.monsters[0].dots.every(d => d.permanent)).toBe(true);
    expect(r.log).toContain('Dummy receives 10 magical damage from ignite (x3)!');
  });

  it('player DoTs pulse on the player\'s own pulse and Rot stacks', () => {
    const state = createPartyCombatState(
      [makePlayer('K', 2, { className: 'Knight' })],
      [makeMonster(0, { name: 'Rotter', skills: [{ skillId: 'rot', value: 5, cooldown: 2 }] })],
    );
    const r = runTo(state, 4000);
    expect(ofKind(r.events, 'attack').filter(e => e.skillId === 'rot').map(e => e.t)).toEqual([1400, 3400]);
    expect(r.log).toContain('Rotter casts Rot on K! (5 magical damage per second for 3 seconds)');
    expect(ofKind(r.events, 'damage').filter(e => e.overTime).map(e => [e.t, e.amount])).toEqual([
      [2000, 5], [3000, 5], [4000, 10],
    ]);
    expect(r.log).toContain('K receives 10 magical damage from rot (x2)!');
  });

  it('a player killed by a DoT falls (or is revived by Resurrection)', () => {
    const state = createPartyCombatState([
      makePlayer('A', 2, { hp: 100 }),
      makePlayer('B', 5, { hp: 100 }),
      makePlayer('P', 1, { className: 'Priest', skills: [SEED_SKILLS.priest_resurrection] }),
    ], [makeMonster(0)]);
    player(state, 'A').currentHp = 3;
    player(state, 'A').dots.push({ sourceUsername: 'm', name: 'rot', damagePerTick: 5, ticksRemaining: 3, damageType: 'magical' });
    player(state, 'B').currentHp = 3;
    player(state, 'B').dots.push({ sourceUsername: 'm', name: 'rot', damagePerTick: 5, ticksRemaining: 3, damageType: 'magical' });
    const r = runTo(state, 1100);
    expect(ofKind(r.events, 'revive')).toEqual([expect.objectContaining({ t: 1000, dst: { side: 'player', pos: 2 }, amount: 20 })]);
    expect(r.log).toContain('P\'s Resurrection revives A at 20% HP!');
    expect(ofKind(r.events, 'death')).toEqual([expect.objectContaining({ t: 1100, dst: { side: 'player', pos: 5 } })]);
    expect(r.log).toContain('B has fallen!');
  });

  it('heal-over-time pulses stop when the target is full and expire after their count', () => {
    const state = createPartyCombatState([makePlayer('A', 2, { hp: 100 })], [makeMonster(0)]);
    const a = state.players[0];
    a.currentHp = 85;
    a.hots.push({ sourceUsername: 'P', name: 'mending', healPerTick: 10, ticksRemaining: 3 });
    const r = runTo(state, 3000);
    expect(ofKind(r.events, 'heal').map(e => [e.t, e.amount])).toEqual([[1000, 10], [2000, 5]]);
    expect(a.currentHp).toBe(100);
    expect(a.hots).toEqual([]);
  });
});

describe('debuff durations (seconds)', () => {
  it('Crippling Shot lasts exactly its duration in seconds', () => {
    const cripple = activeSkill({ id: 'cr', name: 'Crippling Shot', cooldown: 10, warmup: 0, activeEffects: [{ kind: 'debuff_attack', debuffPercent: 0.3, debuffDuration: 3 }] });
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [cripple] })], [makeMonster(0, { damage: 10 })]);
    const r = runTo(state, 1000);
    expect(state.monsters[0].debuffs).toEqual([{ type: 'crippling_shot', value: 0.3, remainingMs: 3000, name: 'Crippling Shot' }]);
    expect(r.log).toContain('Dummy\'s damage is reduced by 30%!');
    runTo(state, 3900, r);
    expect(state.monsters[0].debuffs).toHaveLength(1);
    runTo(state, 4400, r);
    expect(state.monsters[0].debuffs).toHaveLength(0);
    const hits = ofKind(r.events, 'damage').filter(e => e.src?.side === 'monster').map(e => [e.t, e.amount]);
    expect(hits).toEqual([[1400, 7], [2400, 7], [3400, 7], [4400, 10]]);
  });

  it('Lullaby refreshes rather than stacks and skips walls', () => {
    const lullaby = { ...SEED_SKILLS.bard_lullaby, warmup: 0, cooldown: 1 };
    const state = createPartyCombatState(
      [makePlayer('B', 2, { className: 'Bard', skills: [lullaby] })],
      [createMonsterInstance(SEED_MONSTERS.stone_wall, 0), makeMonster(3, { damage: 10 })],
    );
    const r = runTo(state, 2000);
    expect(monsterAt(state, 0).debuffs).toEqual([]);
    expect(monsterAt(state, 3).debuffs).toEqual([{ type: 'lullaby', value: 0.2, remainingMs: 3000, name: 'Lullaby' }]);
    expect(r.log).toContain('B\'s Lullaby reduces enemy damage by 20% for 3 seconds');
    expect(ofKind(r.events, 'damage').filter(e => e.src?.side === 'monster').map(e => e.amount)).toEqual([8]);
  });

  it('Scorch lasts 2 s and refreshes on each hit', () => {
    const mage = makePlayer('M', 2, { className: 'Mage', skills: [SEED_SKILLS.mage_scorch] });
    const state = createPartyCombatState([mage], [makeMonster(0)]);
    const r = runTo(state, 1000);
    expect(state.monsters[0].debuffs).toEqual([{ type: 'scorch', value: 0.1, remainingMs: SCORCH_MS, name: 'Scorch' }]);
    runTo(state, 2000, r);
    expect(state.monsters[0].debuffs).toHaveLength(1);
    expect(state.monsters[0].debuffs[0].remainingMs).toBe(SCORCH_MS);
    expect(ofKind(r.events, 'status').filter(e => e.name === 'Scorch')).toHaveLength(1);
  });
});

describe('Iron Will', () => {
  it('resists a stun when it is applied and never shows as stunned', () => {
    const ironWill = passiveSkill({ id: 'iw', name: 'Iron Will', className: 'Archer', passiveEffects: [{ kind: 'stun_immune' }] });
    const state = createPartyCombatState(
      [makePlayer('A', 2, { className: 'Archer', skills: [ironWill] })],
      [makeMonster(0, { name: 'Horror', skills: [{ skillId: 'fear', value: 1, cooldown: 3 }] })],
    );
    const r = runTo(state, 2400);
    expect(ofKind(r.events, 'resist')).toEqual([expect.objectContaining({ t: 2400, dst: { side: 'player', pos: 2 }, skill: 'Iron Will' })]);
    expect(r.log).toContain('A\'s Iron Will resists the stun!');
    expect(r.log).toContain('Horror casts Fear but no targets are affected!');
    expect(ofKind(r.events, 'stun')).toHaveLength(0);
    expect(state.players[0].stunRemainingMs).toBe(0);
  });
});

describe('direct monster hit pipeline', () => {
  const bashAndSlam = [SEED_SKILLS.knight_shield_bash, SEED_SKILLS.knight_shield_slam];

  it('order: damage → Shield Bash stun → self_hit reaction', () => {
    pinRandom(0.05);
    const state = createPartyCombatState([makePlayer('K', 2, { className: 'Knight', skills: bashAndSlam })], [makeMonster(0, { damage: 50 })]);
    const r = runTo(state, 1400);
    const seq = r.events.filter(e => e.t === 1400).map(e => `${e.kind}${e.skill ? `:${e.skill}` : ''}`);
    expect(seq).toEqual(['attack', 'damage', 'stun', 'reaction:Shield Slam', 'damage:Shield Slam']);
    expect(r.log).toContain('K\'s Shield Bash stuns Dummy!');
    expect(r.log).toContain('Dummy is stunned!');
    expect(state.monsters[0].stunRemainingMs).toBe(1000);
  });

  it('Shield Bash stuns even when a shield absorbs the whole hit; no Martyr and no self_hit then', () => {
    pinRandom(0.05);
    const state = createPartyCombatState([
      makePlayer('K', 2, { className: 'Knight', level: 30, skills: [SEED_SKILLS.knight_guard, ...bashAndSlam] }),
      makePlayer('P', 5, { className: 'Priest', skills: [SEED_SKILLS.priest_martyr] }),
    ], [makeMonster(0, { damage: 50 })]);
    player(state, 'K').damageShield = 1000;
    const r = runTo(state, 1400);
    expect(ofKind(r.events, 'stun')).toHaveLength(1);
    expect(ofKind(r.events, 'reaction')).toHaveLength(0);
    expect(player(state, 'P').martyrBonus).toBe(0);
  });

  it('Shield Bash is physical-only', () => {
    pinRandom(0.05);
    const state = createPartyCombatState([makePlayer('K', 2, { className: 'Knight', skills: bashAndSlam })], [makeMonster(0, { damage: 50, damageType: 'magical' })]);
    const r = runTo(state, 1400);
    expect(ofKind(r.events, 'stun')).toHaveLength(0);
  });

  it('a lethal hit: Shield Bash → Resurrection revive → self_hit on the revived Knight', () => {
    pinRandom(0.05);
    const state = createPartyCombatState([
      makePlayer('K', 2, { className: 'Knight', hp: 30, skills: bashAndSlam }),
      makePlayer('P', 5, { className: 'Priest', skills: [SEED_SKILLS.priest_resurrection] }),
    ], [makeMonster(0, { damage: 50 })]);
    const r = runTo(state, 1400);
    const seq = r.events.filter(e => e.t === 1400).map(e => e.kind);
    expect(seq).toEqual(['attack', 'damage', 'stun', 'revive', 'reaction', 'damage']);
    expect(player(state, 'K').currentHp).toBe(6);
    expect(player(state, 'P').hasResurrected).toBe(true);
  });

  it('Resurrection fires once per battle', () => {
    const state = createPartyCombatState([
      makePlayer('K', 2, { className: 'Knight', hp: 30 }),
      makePlayer('P', 5, { className: 'Priest', skills: [SEED_SKILLS.priest_resurrection] }),
    ], [makeMonster(0, { damage: 50 })]);
    const r = runTo(state, 2400);
    expect(ofKind(r.events, 'revive')).toHaveLength(1);
    expect(ofKind(r.events, 'death')).toEqual([expect.objectContaining({ t: 2400, dst: { side: 'player', pos: 2 } })]);
  });

  it('Martyr: damage to a Knight arms the priest\'s next heal once (capped at one stack)', () => {
    pinRandom();
    const state = createPartyCombatState([
      makePlayer('K', 2, { className: 'Knight', hp: 200 }),
      makePlayer('P', 5, { className: 'Priest', level: 5, skills: [SEED_SKILLS.priest_martyr, SEED_SKILLS.priest_minor_heal] }),
    ], [makeMonster(0, { damage: 70 }), makeMonster(3, { damage: 30 })]);
    runTo(state, 1500);
    expect(player(state, 'P').martyrBonus).toBe(0.25);
    const r = runTo(state, 2100);
    expect(ofKind(r.events, 'heal')).toEqual([expect.objectContaining({ t: 2100, amount: 25 })]);
    expect(player(state, 'P').martyrBonus).toBe(0);
  });

  it('a shield absorbs before HP loss', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [makeMonster(0, { damage: 50 })]);
    state.players[0].damageShield = 20;
    const r = runTo(state, 1400);
    const seq = r.events.filter(e => e.t === 1400).map(e => [e.kind, e.amount]);
    expect(seq).toEqual([['attack', undefined], ['absorb', 20], ['damage', 30]]);
    expect(r.log).toContain('A\'s shield absorbs 20 damage');
    expect(state.players[0].currentHp).toBe(970);
  });

  it('Nimble dodge avoids the hit entirely', () => {
    pinRandom(0.01);
    const state = createPartyCombatState([
      makePlayer('B', 2, { className: 'Bard', skills: [SEED_SKILLS.bard_nimble] }),
    ], [makeMonster(0, { damage: 50 })]);
    const r = runTo(state, 1400);
    expect(ofKind(r.events, 'dodge')).toEqual([expect.objectContaining({ dst: { side: 'player', pos: 2 } })]);
    expect(r.log).toContain('B dodges Dummy\'s attack!');
    expect(state.players[0].currentHp).toBe(1000);
  });

  it('Unnerve and Lullaby reduce auto-attacks, never monster skills', () => {
    const lullaby = { ...SEED_SKILLS.bard_lullaby, warmup: 0 };
    const state = createPartyCombatState([
      makePlayer('B', 2, { className: 'Bard', skills: [SEED_SKILLS.bard_unnerve, lullaby] }),
    ], [makeMonster(0, { damage: 100, skills: [{ skillId: 'fireball', value: 50, cooldown: 30, castTime: 0 }] })]);
    const r = runTo(state, 2400);
    expect(ofKind(r.events, 'damage').filter(e => e.src?.side === 'monster').map(e => [e.skill, e.amount])).toEqual([
      ['Fireball', 50], [undefined, 76],
    ]);
  });
});

describe('monster actions', () => {
  it('Chaos makes each non-wall enemy\'s next action hit a random monster, then wears off', () => {
    pinRandom(0);
    const chaos = { ...SEED_SKILLS.bard_chaos, warmup: 0 };
    const state = createPartyCombatState(
      [makePlayer('B', 2, { className: 'Bard', skills: [chaos] })],
      [createMonsterInstance(SEED_MONSTERS.stone_wall, 0), makeMonster(3, { damage: 10 })],
    );
    const r = runTo(state, 1000);
    expect(monsterAt(state, 0).chaosActive).toBe(false);
    expect(monsterAt(state, 3).chaosActive).toBe(true);
    expect(r.log).toContain('B\'s Chaos causes chaos! Enemies turn on each other!');
    runTo(state, 2500, r);
    expect(r.log).toContain('Dummy attacks Stone Wall in confusion for 10 damage!');
    expect(monsterAt(state, 3).chaosActive).toBe(false);
    expect(ofKind(r.events, 'damage').filter(e => e.src?.side === 'monster' && e.dst?.side === 'player').map(e => e.t)).toEqual([2500]);
  });

  it('walls never act', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [createMonsterInstance(SEED_MONSTERS.stone_wall, 0), makeMonster(3)]);
    const r = runTo(state, 5000);
    expect(r.events.filter(e => e.src?.side === 'monster' && e.src.pos === 0)).toHaveLength(0);
  });
});
