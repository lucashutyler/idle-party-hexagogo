import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createPartyCombatState,
  effectiveCooldownMs,
  wouldHaveEffect,
} from '../src/systems/CombatEngine';
import type { PartyCombatState } from '../src/systems/CombatEngine';
import { SEED_SKILLS } from '../src/systems/SkillTypes';
import { createMonsterInstance, SEED_MONSTERS } from '../src/systems/MonsterTypes';
import { MIN_COOLDOWN_MS } from '../src/systems/CombatTiming';
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
import type { PlayerOptions } from './combatTestUtils';

afterEach(() => { vi.restoreAllMocks(); });

const tempo = SEED_SKILLS.bard_tempo;
const encore = SEED_SKILLS.bard_encore;

function skillUseTimes(events: ReturnType<typeof runTo>['events'], skillId: string): number[] {
  return events.filter(e => (e.kind === 'attack' || e.kind === 'cast_start') && e.skillId === skillId).map(e => e.t);
}

describe('cooldowns in seconds', () => {
  it('Knight Bash (2 s) fires on the first action and then every 2 seconds', () => {
    const knight = makePlayer('Arthur', 2, { className: 'Knight', baseDamage: 1, skills: [SEED_SKILLS.knight_guard, SEED_SKILLS.knight_bash] });
    const state = createPartyCombatState([knight], [makeMonster(0)]);
    const { events, log } = runTo(state, 6000);
    expect(skillUseTimes(events, 'knight_bash')).toEqual([1000, 3000, 5000]);
    const autos = ofKind(events, 'attack').filter(e => e.src?.side === 'player' && !e.skillId).map(e => e.t);
    expect(autos).toEqual([2000, 4000, 6000]);
    expect(log.some(l => l.includes('uses Bash on Dummy'))).toBe(true);
  });

  it('starts the cooldown at use and decrements it from the next step', () => {
    const skill = activeSkill({ id: 'cd3', cooldown: 3, warmup: 0 });
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [skill] })], [makeMonster(0)]);
    runTo(state, 1000);
    expect(state.players[0].skillCooldowns.cd3).toBe(3000);
    expect(state.players[0].skillCooldownTotals.cd3).toBe(3000);
    runTo(state, 1100);
    expect(state.players[0].skillCooldowns.cd3).toBe(2900);
  });

  it('supports fractional cooldowns', () => {
    const skill = activeSkill({ id: 'frac', cooldown: 1.5, warmup: 0 });
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [skill] })], [makeMonster(0)]);
    const { events } = runTo(state, 5000);
    expect(skillUseTimes(events, 'frac')).toEqual([1000, 3000, 5000]);
  });

  it('uses the first ready skill in slot order', () => {
    const a = activeSkill({ id: 'a', cooldown: 3, warmup: 0 });
    const b = activeSkill({ id: 'b', cooldown: 1, warmup: 0 });
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [a, b] })], [makeMonster(0)]);
    const { events } = runTo(state, 4000);
    expect(events.filter(e => e.kind === 'attack' && e.skillId).map(e => `${e.t}:${e.skillId}`))
      .toEqual(['1000:a', '2000:b', '3000:b', '4000:a']);
  });

  it('ignores active skills without active options', () => {
    const empty = activeSkill({ id: 'empty', activeEffects: [] });
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [empty] })], [makeMonster(0)]);
    expect(state.players[0].skillCooldowns).toEqual({});
    const { events } = runTo(state, 1000);
    expect(ofKind(events, 'attack')[0].skillId).toBeUndefined();
  });
});

describe('warm-up', () => {
  function warmups(skills: PlayerOptions['skills'], extra: ReturnType<typeof makePlayer>[] = []): Record<string, number> {
    const state = createPartyCombatState([makePlayer('A', 2, { className: 'Knight', skills }), ...extra], [makeMonster(0)]);
    return player(state, 'A').skillCooldowns;
  }

  it('action skills warm up for max(0, cooldown − 1 s)', () => {
    expect(warmups([SEED_SKILLS.knight_bash])).toEqual({ knight_bash: 1000 });
    expect(warmups([SEED_SKILLS.archer_snipe])).toEqual({ archer_snipe: 4000 });
    expect(warmups([SEED_SKILLS.priest_minor_heal])).toEqual({ priest_minor_heal: 0 });
  });

  it('interrupts warm up like action skills; other reactions start ready', () => {
    expect(warmups([SEED_SKILLS.knight_dispel])).toEqual({ knight_dispel: 4000 });
    expect(warmups([SEED_SKILLS.bard_drumroll])).toEqual({ bard_drumroll: 3000 });
    expect(warmups([SEED_SKILLS.knight_intercept, SEED_SKILLS.knight_shield_slam, SEED_SKILLS.priest_cure, SEED_SKILLS.priest_mending]))
      .toEqual({ knight_intercept: 0, knight_shield_slam: 0, priest_cure: 0, priest_mending: 0 });
  });

  it('an explicit warmup wins (Sunder 1 s, War Song 0 s)', () => {
    expect(warmups([SEED_SKILLS.knight_sunder])).toEqual({ knight_sunder: 1000 });
    expect(warmups([SEED_SKILLS.bard_war_song])).toEqual({ bard_war_song: 0 });
    expect(warmups([activeSkill({ id: 'r', trigger: 'ally_low_hp', cooldown: 5, warmup: 2, activeEffects: [{ kind: 'hot_lowest', healMultiplier: 1 }] })]))
      .toEqual({ r: 2000 });
  });

  it('warm-up counts as the snapshot cooldown length', () => {
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [SEED_SKILLS.knight_bash, SEED_SKILLS.knight_intercept] })], [makeMonster(0)]);
    expect(state.players[0].skillCooldownTotals).toEqual({ knight_bash: 1000, knight_intercept: 0 });
  });

  it('warm-up uses the effective (CDR-reduced) cooldown', () => {
    expect(warmups([SEED_SKILLS.archer_snipe, tempo])).toEqual({ archer_snipe: 3000 });
  });

  it('War Song opens the fight on the first action and marks every living ally', () => {
    const bard = makePlayer('Bard', 2, { className: 'Bard', skills: [SEED_SKILLS.bard_war_song] });
    const state = createPartyCombatState([bard, makePlayer('Ally', 5), makePlayer('Fallen', 1)], [makeMonster(0)]);
    player(state, 'Fallen').currentHp = 0;
    const { events, log } = runTo(state, 1000);
    expect(ofKind(events, 'buff')).toEqual([expect.objectContaining({ t: 1000, name: 'War Song', amount: 10 })]);
    expect(ofKind(events, 'status').map(e => [e.name, e.dst!.pos])).toEqual([['War Song', 2], ['War Song', 5]]);
    expect(state.warSongBonus).toBeCloseTo(0.10);
    expect(log).toContain('Bard\'s War Song increases party damage by 10%! (Total: +10%)');
  });
});

describe('cooldown reduction (seconds)', () => {
  function stateWith(ownerSkills: PlayerOptions['skills'], others: ReturnType<typeof makePlayer>[] = [], setCdr?: number): PartyCombatState {
    return createPartyCombatState(
      [makePlayer('Owner', 2, { className: 'Bard', skills: ownerSkills, setBonuses: setCdr ? { cooldownReduction: setCdr } : undefined }), ...others],
      [makeMonster(0)],
    );
  }
  const cd3 = activeSkill({ id: 'cd3', cooldown: 3 });

  it('own Tempo removes one second', () => {
    const state = stateWith([cd3, tempo]);
    expect(effectiveCooldownMs(state.players[0], cd3, state.players)).toBe(2000);
  });

  it('Encore on another living member is party-wide; Tempo on another member is not', () => {
    const withEncore = stateWith([cd3], [makePlayer('Bard2', 5, { className: 'Bard', skills: [encore] })]);
    expect(effectiveCooldownMs(player(withEncore, 'Owner'), cd3, withEncore.players)).toBe(2000);
    const withTempo = stateWith([cd3], [makePlayer('Bard2', 5, { className: 'Bard', skills: [tempo] })]);
    expect(effectiveCooldownMs(player(withTempo, 'Owner'), cd3, withTempo.players)).toBe(3000);
  });

  it('a dead member\'s Encore stops counting', () => {
    const state = stateWith([cd3], [makePlayer('Bard2', 5, { className: 'Bard', skills: [encore] })]);
    player(state, 'Bard2').currentHp = 0;
    expect(effectiveCooldownMs(player(state, 'Owner'), cd3, state.players)).toBe(3000);
  });

  it('own Tempo + own Encore + set CDR stack in seconds', () => {
    const state = stateWith([activeSkill({ id: 'cd5', cooldown: 5 }), tempo, encore], [], 0.5);
    expect(effectiveCooldownMs(state.players[0], activeSkill({ id: 'cd5', cooldown: 5 }), state.players)).toBe(2500);
  });

  it('floors at MIN_COOLDOWN_MS', () => {
    const state = stateWith([cd3, tempo, encore], [], 3);
    expect(effectiveCooldownMs(state.players[0], cd3, state.players)).toBe(MIN_COOLDOWN_MS);
  });

  it('defaults a missing cooldown to 1 s', () => {
    const state = stateWith([]);
    expect(effectiveCooldownMs(state.players[0], activeSkill({ id: 'x', cooldown: undefined }), state.players)).toBe(1000);
  });

  it('never applies to enemy_cast skills', () => {
    const state = stateWith([SEED_SKILLS.bard_drumroll, tempo, encore], [], 1);
    expect(effectiveCooldownMs(state.players[0], SEED_SKILLS.bard_drumroll, state.players)).toBe(4000);
    expect(state.players[0].skillCooldowns.bard_drumroll).toBe(3000);
  });

  it('applies in combat: Tempo turns a 2 s skill into one used every second', () => {
    const skill = activeSkill({ id: 'cd2', cooldown: 2, warmup: 0 });
    const state = stateWith([skill, tempo]);
    const { events } = runTo(state, 3000);
    expect(skillUseTimes(events, 'cd2')).toEqual([1000, 2000, 3000]);
    expect(state.players[0].skillCooldownTotals.cd2).toBe(1000);
  });
});

describe('wouldHaveEffect (the "needed" check)', () => {
  const heal = (mult: number) => activeSkill({ id: 'heal', activeEffects: [{ kind: 'heal_lowest', healMultiplier: mult }] });
  const hot = activeSkill({ id: 'hot', activeEffects: [{ kind: 'hot_lowest', healMultiplier: 2, dotTicks: 3 }] });

  function party(): PartyCombatState {
    return createPartyCombatState([
      makePlayer('Healer', 2, { className: 'Priest', level: 5, hp: 100 }),
      makePlayer('Tank', 5, { className: 'Knight', hp: 100 }),
      makePlayer('Frail', 1, { className: 'Mage', hp: 50 }),
    ], [makeMonster(0)]);
  }

  it('heal_lowest: needed when an ally misses at least half the heal amount', () => {
    const state = party();
    const healer = player(state, 'Healer');
    expect(wouldHaveEffect(healer, heal(4), state)).toBe(false);
    player(state, 'Tank').currentHp = 91;
    expect(wouldHaveEffect(healer, heal(4), state)).toBe(false);
    player(state, 'Tank').currentHp = 90;
    expect(wouldHaveEffect(healer, heal(4), state)).toBe(true);
  });

  it('heal_lowest: always needed for an ally below half health, even if the heal is huge', () => {
    const state = party();
    const healer = player(state, 'Healer');
    player(state, 'Tank').currentHp = 60;
    expect(wouldHaveEffect(healer, heal(100), state)).toBe(false);
    player(state, 'Tank').currentHp = 49;
    expect(wouldHaveEffect(healer, heal(100), state)).toBe(true);
  });

  it('heal_lowest counts heal power (Devotion) in the heal amount', () => {
    const state = createPartyCombatState([
      makePlayer('Healer', 2, { className: 'Priest', level: 5, hp: 100, skills: [SEED_SKILLS.priest_devotion] }),
      makePlayer('Tank', 5, { hp: 100 }),
    ], [makeMonster(0)]);
    player(state, 'Tank').currentHp = 89;
    expect(wouldHaveEffect(player(state, 'Healer'), heal(4), state)).toBe(false);
    player(state, 'Healer').equippedSkills = [];
    expect(wouldHaveEffect(player(state, 'Healer'), heal(4), state)).toBe(true);
  });

  it('heals the lowest-%HP ally that needs it', () => {
    pinRandom();
    const state = party();
    player(state, 'Tank').currentHp = 40;
    player(state, 'Frail').currentHp = 30;
    player(state, 'Healer').equippedSkills = [heal(4)];
    player(state, 'Healer').skillCooldowns = { heal: 0 };
    const { events, log } = runTo(state, 1000);
    expect(ofKind(events, 'heal')).toEqual([expect.objectContaining({ dst: { side: 'player', pos: 5 }, amount: 20 })]);
    expect(log).toContain('Healer uses heal on Tank for 20 HP');
  });

  it('hot_lowest uses one pulse as the heal amount', () => {
    const state = party();
    const healer = player(state, 'Healer');
    player(state, 'Tank').currentHp = 96;
    expect(wouldHaveEffect(healer, hot, state)).toBe(false);
    player(state, 'Tank').currentHp = 95;
    expect(wouldHaveEffect(healer, hot, state)).toBe(true);
  });

  it('cure_debuffs: needed when an ally is stunned, dotted or debuffed', () => {
    const cure = activeSkill({ id: 'cure', activeEffects: [{ kind: 'cure_debuffs' }] });
    const state = party();
    const healer = player(state, 'Healer');
    expect(wouldHaveEffect(healer, cure, state)).toBe(false);
    player(state, 'Tank').debuffs.push({ type: 'weak', value: 0.1, remainingMs: 1000 });
    expect(wouldHaveEffect(healer, cure, state)).toBe(true);
    player(state, 'Tank').debuffs = [];
    player(state, 'Tank').dots.push({ sourceUsername: 'm', name: 'rot', damagePerTick: 1, ticksRemaining: 2, damageType: 'magical' });
    expect(wouldHaveEffect(healer, cure, state)).toBe(true);
    player(state, 'Tank').dots = [];
    player(state, 'Tank').stunRemainingMs = 500;
    expect(wouldHaveEffect(healer, cure, state)).toBe(true);
  });

  it('cure_debuffs targets a stunned ally before a lower-HP dotted one', () => {
    const cure = activeSkill({ id: 'cure', cooldown: 1, activeEffects: [{ kind: 'cure_debuffs' }] });
    const state = party();
    player(state, 'Frail').currentHp = 10;
    player(state, 'Frail').dots.push({ sourceUsername: 'm', name: 'rot', damagePerTick: 1, ticksRemaining: 20, damageType: 'magical' });
    player(state, 'Tank').stunRemainingMs = 5000;
    player(state, 'Healer').equippedSkills = [cure];
    player(state, 'Healer').skillCooldowns = { cure: 0 };
    const { events, log } = runTo(state, 1000);
    expect(ofKind(events, 'cleanse')[0]).toMatchObject({ dst: { side: 'player', pos: 5 }, skill: 'cure' });
    expect(log).toContain('Healer cures Tank\'s afflictions!');
    expect(player(state, 'Tank').stunRemainingMs).toBe(0);
    expect(player(state, 'Frail').dots).toHaveLength(1);
  });

  it('shield_non_knight: needed only for an unshielded non-Knight; targets lowest %HP', () => {
    pinRandom();
    const shield = SEED_SKILLS.priest_sanctuary;
    const state = party();
    const healer = player(state, 'Healer');
    expect(wouldHaveEffect(healer, shield, state)).toBe(true);
    healer.damageShield = 5;
    player(state, 'Frail').damageShield = 5;
    expect(wouldHaveEffect(healer, shield, state)).toBe(false);
    player(state, 'Frail').damageShield = 0;
    player(state, 'Frail').currentHp = 40;
    player(state, 'Tank').currentHp = 10;
    healer.equippedSkills = [shield];
    healer.skillCooldowns = { priest_sanctuary: 0 };
    const { events } = runTo(state, 1000);
    expect(ofKind(events, 'shield')).toEqual([expect.objectContaining({ dst: { side: 'player', pos: 1 }, amount: 20 })]);
    expect(player(state, 'Frail').damageShield).toBe(20);
  });

  it('redirect_hit and brace_reflect never have an effect outside their trigger', () => {
    const state = party();
    const healer = player(state, 'Healer');
    expect(wouldHaveEffect(healer, SEED_SKILLS.knight_intercept, state)).toBe(false);
    expect(wouldHaveEffect(healer, SEED_SKILLS.knight_shield_slam, state)).toBe(false);
  });

  it('enemy-targeting kinds are needed while any monster (even a wall) lives; stun_aoe ignores walls', () => {
    const state = createPartyCombatState([makePlayer('A', 2)], [
      createMonsterInstance(SEED_MONSTERS.stone_wall, 0),
      makeMonster(3),
    ]);
    const a = state.players[0];
    const zap = SEED_SKILLS.mage_zap;
    const stunAoe = activeSkill({ id: 'sa', activeEffects: [{ kind: 'stun_aoe', stunChance: 1 }] });
    expect(wouldHaveEffect(a, zap, state)).toBe(true);
    expect(wouldHaveEffect(a, stunAoe, state)).toBe(true);
    monsterAt(state, 3).currentHp = 0;
    expect(wouldHaveEffect(a, zap, state)).toBe(true);
    expect(wouldHaveEffect(a, stunAoe, state)).toBe(false);
  });
});

describe('held skills and fizzles', () => {
  it('a support card with nobody to help is held: no cooldown, auto-attack instead', () => {
    const priest = makePlayer('P', 2, { className: 'Priest', level: 5, hp: 100, skills: [SEED_SKILLS.priest_minor_heal] });
    const state = createPartyCombatState([priest], [makeMonster(0)]);
    const r = runTo(state, 1000);
    expect(ofKind(r.events, 'attack')[0].t).toBe(1000);
    expect(ofKind(r.events, 'attack')[0].skillId).toBeUndefined();
    expect(state.players[0].skillCooldowns.priest_minor_heal).toBe(0);
    state.players[0].currentHp = 60;
    runTo(state, 2000, r);
    expect(ofKind(r.events, 'heal')).toEqual([expect.objectContaining({ t: 2000, amount: 20, skill: 'Minor Heal' })]);
    expect(state.players[0].skillCooldowns.priest_minor_heal).toBe(1000);
  });

  it('a held skill lets the next ready skill in slot order act', () => {
    const zap = activeSkill({ id: 'zap', cooldown: 1 });
    const priest = makePlayer('P', 2, { className: 'Priest', level: 5, skills: [SEED_SKILLS.priest_minor_heal, zap] });
    const state = createPartyCombatState([priest], [makeMonster(0)]);
    const { events } = runTo(state, 1000);
    expect(ofKind(events, 'attack')[0].skillId).toBe('zap');
  });

  it('an instant skill whose roll fails fizzles: cooldown spent, then a fallback auto-attack in the same action', () => {
    pinRandom(0.9);
    const shout = activeSkill({ id: 'shout', name: 'Shout', cooldown: 3, warmup: 0, activeEffects: [{ kind: 'stun_aoe', stunChance: 0.25 }] });
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [shout] })], [makeMonster(0)]);
    const { events, log } = runTo(state, 1000);
    const kinds = events.filter(e => e.t === 1000).map(e => e.kind);
    expect(kinds).toEqual(['attack', 'fizzle', 'attack', 'damage']);
    expect(ofKind(events, 'fizzle')[0]).toMatchObject({ src: { side: 'player', pos: 2 }, skill: 'Shout', skillId: 'shout' });
    expect(log).toContain('A\'s Shout fizzles!');
    expect(state.players[0].skillCooldowns.shout).toBe(3000);
    expect(state.monsters[0].currentHp).toBeLessThan(10000);
  });

  it('a fizzle rewinds Arcane Surge so the next effective active still gets the doubled count', () => {
    pinRandom(0.9);
    const fizzler = activeSkill({ id: 'fz', cooldown: 1, warmup: 0, activeEffects: [{ kind: 'stun_aoe', stunChance: 0 }] });
    const mage = makePlayer('M', 2, { className: 'Mage', skills: [SEED_SKILLS.mage_arcane_surge, fizzler] });
    const state = createPartyCombatState([mage], [makeMonster(0)]);
    runTo(state, 3000);
    expect(state.players[0].activeSkillCount).toBe(0);
  });

  it('Arcane Surge doubles every second effective active', () => {
    pinRandom();
    const zap = activeSkill({ id: 'zap', cooldown: 1, activeEffects: [{ kind: 'damage_percent', damagePercent: 1 }] });
    const mage = makePlayer('M', 2, { className: 'Mage', baseDamage: 10, skills: [SEED_SKILLS.mage_arcane_surge, zap] });
    const state = createPartyCombatState([mage], [makeMonster(0)]);
    const { events } = runTo(state, 3000);
    expect(ofKind(events, 'damage').filter(e => e.src?.side === 'player').map(e => e.amount)).toEqual([10, 20, 10]);
  });

  it('Intensify raises skill damage and lowers auto-attack damage', () => {
    pinRandom();
    const zap = activeSkill({ id: 'zap', cooldown: 2, warmup: 0, activeEffects: [{ kind: 'damage_percent', damagePercent: 1 }] });
    const mage = makePlayer('M', 2, { className: 'Mage', baseDamage: 10, skills: [SEED_SKILLS.mage_intensify, zap] });
    const state = createPartyCombatState([mage], [makeMonster(0)]);
    const { events } = runTo(state, 2000);
    expect(ofKind(events, 'damage').filter(e => e.src?.side === 'player').map(e => e.amount)).toEqual([15, 5]);
  });
});

describe('player casts', () => {
  const aimed = (castTime: number, extra: Parameters<typeof activeSkill>[0] = { id: 'aimed' }) => activeSkill({
    name: 'Aimed Shot', cooldown: 3, warmup: 0, castTime, activeEffects: [{ kind: 'high_damage_single', damagePercent: 2 }], ...extra,
  });

  it('telegraphs with cast_start, starts the cooldown at cast start and resolves after castTime', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 10, skills: [aimed(1)] })], [makeMonster(0)]);
    const r = runTo(state, 1000);
    expect(ofKind(r.events, 'cast_start')).toEqual([expect.objectContaining({
      t: 1000, src: { side: 'player', pos: 2 }, dst: { side: 'monster', pos: 0 }, skill: 'Aimed Shot', skillId: 'aimed', durationMs: 1000,
    })]);
    expect(r.log).toContain('A begins casting Aimed Shot!');
    expect(state.players[0].cast).toMatchObject({ skillId: 'aimed', totalMs: 1000, remainingMs: 1000, target: { side: 'monster', pos: 0 } });
    expect(state.players[0].skillCooldowns.aimed).toBe(3000);
    expect(state.monsters[0].currentHp).toBe(10000);

    runTo(state, 1900, r);
    expect(state.players[0].cast!.remainingMs).toBe(100);
    expect(state.monsters[0].currentHp).toBe(10000);

    runTo(state, 2000, r);
    const at2000 = r.events.filter(e => e.t === 2000).map(e => `${e.kind}${e.skill ? `:${e.skill}` : ''}`);
    expect(at2000).toEqual(['cast_end:Aimed Shot', 'attack:Aimed Shot', 'damage:Aimed Shot', 'attack', 'damage']);
    expect(state.players[0].cast).toBeNull();
    expect(state.monsters[0].currentHp).toBe(10000 - 20 - 10);
  });

  it('the resolving attack event carries no skillId (cast_start already restarted the cooldown sweep)', () => {
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [aimed(1)] })], [makeMonster(0)]);
    const { events } = runTo(state, 2000);
    const resolved = ofKind(events, 'attack').find(e => e.skill === 'Aimed Shot');
    expect(resolved).toBeDefined();
    expect(resolved!.skillId).toBeUndefined();
    expect(ofKind(events, 'cast_end')[0].skillId).toBe('aimed');
  });

  it('a cast longer than the action interval pushes the next action back', () => {
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [aimed(1.5)] })], [makeMonster(0)]);
    const r = runTo(state, 1000);
    expect(state.players[0].actionTotalMs).toBe(1500);
    runTo(state, 3500, r);
    expect(ofKind(r.events, 'cast_end').map(e => e.t)).toEqual([2500]);
    const autos = ofKind(r.events, 'attack').filter(e => e.src?.side === 'player' && !e.skill).map(e => e.t);
    expect(autos).toEqual([2500, 3500]);
  });

  it('AoE casts do not lock a target', () => {
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [SEED_SKILLS.mage_blizzard] })], [makeMonster(0)]);
    state.players[0].skillCooldowns.mage_blizzard = 0;
    const { events } = runTo(state, 1000);
    const start = ofKind(events, 'cast_start')[0];
    expect(start.durationMs).toBe(1500);
    expect(start.dst).toBeUndefined();
    expect(state.players[0].cast!.target).toBeUndefined();
  });

  it('keeps a locked single-enemy target while it lives', () => {
    const cutDown = activeSkill({ id: 'cd', castTime: 0.5, cooldown: 5, warmup: 0, activeEffects: [{ kind: 'target_lowest_hp' }] });
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [cutDown] })], [makeMonster(0, { hp: 100 }), makeMonster(3, { hp: 200 })]);
    runTo(state, 1000);
    expect(state.players[0].cast!.target).toEqual({ side: 'monster', pos: 0 });
    monsterAt(state, 3).currentHp = 5;
    const { events } = runTo(state, 1500);
    const hit = ofKind(events, 'damage').find(e => e.skill === 'cd');
    expect(hit!.dst).toEqual({ side: 'monster', pos: 0 });
  });

  it('re-picks a single-enemy target when the locked one died', () => {
    const cutDown = activeSkill({ id: 'cd', castTime: 0.5, cooldown: 5, warmup: 0, activeEffects: [{ kind: 'target_lowest_hp' }] });
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [cutDown] })], [
      makeMonster(0, { hp: 100 }), makeMonster(3, { hp: 200 }), makeMonster(6, { hp: 300 }),
    ]);
    runTo(state, 1000);
    monsterAt(state, 0).currentHp = 0;
    const { events } = runTo(state, 1500);
    expect(ofKind(events, 'damage').find(e => e.skill === 'cd')!.dst).toEqual({ side: 'monster', pos: 3 });
  });

  it('ally-targeting casts always re-pick at resolution', () => {
    const slowHeal = activeSkill({ id: 'sh', name: 'Slow Heal', castTime: 0.5, cooldown: 5, warmup: 0, activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }] });
    const state = createPartyCombatState([
      makePlayer('Healer', 2, { className: 'Priest', level: 5, hp: 100, skills: [slowHeal] }),
      makePlayer('X', 5, { hp: 100 }),
      makePlayer('Y', 1, { hp: 100 }),
    ], [makeMonster(0)]);
    player(state, 'X').currentHp = 50;
    runTo(state, 1000);
    expect(state.players[0].cast!.target).toEqual({ side: 'player', pos: 5 });
    player(state, 'X').currentHp = 100;
    player(state, 'Y').currentHp = 40;
    const { events } = runTo(state, 1500);
    expect(ofKind(events, 'heal')).toEqual([expect.objectContaining({ dst: { side: 'player', pos: 1 }, amount: 20 })]);
  });

  it('fizzles without a fallback auto-attack when nothing is valid at resolution', () => {
    const slowHeal = activeSkill({ id: 'sh', name: 'Slow Heal', castTime: 0.5, cooldown: 5, warmup: 0, activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }] });
    const state = createPartyCombatState([
      makePlayer('Healer', 2, { className: 'Priest', level: 5, hp: 100, skills: [slowHeal] }),
      makePlayer('X', 5, { hp: 100 }),
    ], [makeMonster(0)]);
    player(state, 'X').currentHp = 50;
    runTo(state, 1000);
    player(state, 'X').currentHp = 100;
    const { events, log } = runTo(state, 1500);
    const at1500 = events.filter(e => e.t === 1500);
    expect(at1500.map(e => e.kind)).toEqual(['cast_end', 'attack', 'fizzle']);
    expect(log).toContain('Healer\'s Slow Heal fizzles!');
    expect(state.players[0].skillCooldowns.sh).toBe(4500);
  });

  it('a stun pauses a player\'s cast; it resumes when the stun ends', () => {
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [aimed(1)] })], [makeMonster(0)]);
    runTo(state, 1300);
    expect(state.players[0].cast!.remainingMs).toBe(700);
    state.players[0].stunRemainingMs = 1000;
    state.players[0].stunTotalMs = 1000;
    const r = runTo(state, 2900);
    expect(state.players[0].cast).not.toBeNull();
    expect(state.players[0].cast!.remainingMs).toBe(100);
    runTo(state, 3000, r);
    expect(ofKind(r.events, 'cast_end').map(e => e.t)).toEqual([3000]);
    expect(ofKind(r.events, 'interrupt')).toHaveLength(0);
  });

  it('death clears a cast silently', () => {
    const state = createPartyCombatState([
      makePlayer('A', 2, { hp: 5, skills: [aimed(1)] }),
      makePlayer('B', 5),
    ], [makeMonster(1, { damage: 50 })]);
    const r = runTo(state, 1400);
    expect(player(state, 'A').currentHp).toBe(0);
    expect(player(state, 'A').cast).toBeNull();
    runTo(state, 3000, r);
    expect(ofKind(r.events, 'cast_end')).toHaveLength(0);
    expect(ofKind(r.events, 'death')).toEqual([expect.objectContaining({ dst: { side: 'player', pos: 2 } })]);
  });
});

describe('stun_single targeting', () => {
  it('prefers the first monster with a cast in progress and interrupts it', () => {
    pinRandom();
    const jolt = activeSkill({ id: 'jolt', name: 'Jolt', cooldown: 5, warmup: 1.5, activeEffects: [{ kind: 'stun_single', stunChance: 1 }] });
    const state = createPartyCombatState([makePlayer('A', 2, { skills: [jolt] })], [
      makeMonster(0, { name: 'Brute' }),
      makeMonster(3, { name: 'Shaman', skills: [{ skillId: 'fireball', value: 5, cooldown: 5 }] }),
    ]);
    const r = runTo(state, 1500);
    expect(ofKind(r.events, 'cast_start')).toEqual([expect.objectContaining({ t: 1500, src: { side: 'monster', pos: 3 } })]);
    runTo(state, 2000, r);
    const joltHit = ofKind(r.events, 'damage').find(e => e.skill === 'Jolt');
    expect(joltHit!.dst).toEqual({ side: 'monster', pos: 3 });
    expect(ofKind(r.events, 'interrupt')).toEqual([expect.objectContaining({
      t: 2000, src: { side: 'player', pos: 2 }, dst: { side: 'monster', pos: 3 }, skill: 'Fireball', skillId: 'fireball',
    })]);
    expect(r.log).toContain('Shaman is stunned!');
    expect(r.log).toContain('Shaman\'s Fireball is interrupted!');
    const shaman = monsterAt(state, 3);
    expect(shaman.cast).toBeNull();
    expect(shaman.skillCooldowns.fireball).toBeGreaterThan(0);
    expect(state.players[0].currentHp).toBe(1000);
  });

  it('falls back to grid targeting when nobody is casting', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('K', 2, { className: 'Knight', skills: [SEED_SKILLS.knight_bash] })], [
      makeMonster(0, { name: 'Front' }), makeMonster(3, { name: 'Other' }),
    ]);
    const { events, log } = runTo(state, 1000);
    expect(ofKind(events, 'stun')[0].dst).toEqual({ side: 'monster', pos: 0 });
    expect(log).toContain('Front is stunned!');
  });
});

describe('monster casts', () => {
  const rogue = (pos: 0 | 3) => makeMonster(pos, { name: 'Rogue', hp: 25, skills: [{ skillId: 'assassinate', value: 30, cooldown: 6 }] });

  it('a monster killed mid-cast drops the cast silently', () => {
    pinRandom();
    const state = createPartyCombatState([makePlayer('A', 2, { baseDamage: 15 })], [rogue(0), makeMonster(3)]);
    const r = runTo(state, 2400);
    expect(ofKind(r.events, 'cast_start').map(e => e.t)).toEqual([1400]);
    expect(monsterAt(state, 0).currentHp).toBe(0);
    expect(monsterAt(state, 0).cast).toBeNull();
    expect(ofKind(r.events, 'cast_end')).toHaveLength(0);
    expect(ofKind(r.events, 'interrupt')).toHaveLength(0);
    expect(state.players[0].currentHp).toBe(1000);
  });

  it('re-picks the lowest-HP player when the locked target died', () => {
    const state = createPartyCombatState([makePlayer('Low', 2, { hp: 100 }), makePlayer('High', 5, { hp: 500 }), makePlayer('Mid', 1, { hp: 300 })], [
      makeMonster(0, { name: 'Rogue', skills: [{ skillId: 'assassinate', value: 30, cooldown: 6 }] }),
    ]);
    const r = runTo(state, 1400);
    expect(ofKind(r.events, 'cast_start')[0].dst).toEqual({ side: 'player', pos: 2 });
    player(state, 'Low').currentHp = 0;
    runTo(state, 2400, r);
    expect(ofKind(r.events, 'damage').find(e => e.skill === 'Assassinate')!.dst).toEqual({ side: 'player', pos: 1 });
  });

  it('keeps the locked target even if someone else becomes weaker', () => {
    const state = createPartyCombatState([makePlayer('Low', 2, { hp: 100 }), makePlayer('High', 5, { hp: 500 })], [
      makeMonster(0, { name: 'Rogue', skills: [{ skillId: 'assassinate', value: 30, cooldown: 6 }] }),
    ]);
    runTo(state, 1400);
    player(state, 'High').currentHp = 10;
    const r = runTo(state, 2400);
    expect(ofKind(r.events, 'damage').find(e => e.skill === 'Assassinate')!.dst).toEqual({ side: 'player', pos: 2 });
  });

  it('a stun landing as the cast resolves (Shield Bash) is an ordinary stun, not an interrupt', () => {
    pinRandom(0.05);
    const state = createPartyCombatState(
      [makePlayer('K', 2, { className: 'Knight', skills: [SEED_SKILLS.knight_shield_bash] })],
      [makeMonster(0, { name: 'Rogue', skills: [{ skillId: 'assassinate', value: 30, cooldown: 6 }] })],
    );
    const r = runTo(state, 2400);
    const at2400 = r.events.filter(e => e.t === 2400).map(e => e.kind);
    expect(at2400).toEqual(['cast_end', 'attack', 'damage', 'stun']);
    expect(ofKind(r.events, 'interrupt')).toHaveLength(0);
  });

  it('a monster whose cast and action land in the same step acts after the cast resolves', () => {
    const state = createPartyCombatState([makePlayer('K', 2)], [
      makeMonster(0, { name: 'Rogue', damage: 1, skills: [{ skillId: 'assassinate', value: 30, cooldown: 6 }] }),
    ]);
    const r = runTo(state, 2400);
    const seq = r.events.filter(e => e.t === 2400 && e.src?.side === 'monster').map(e => `${e.kind}:${e.skillId ?? ''}`);
    expect(seq).toEqual(['cast_end:assassinate', 'attack:assassinate', 'damage:', 'attack:', 'damage:']);
  });
});
