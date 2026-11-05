import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPartyCombatState } from '../src/systems/CombatEngine';
import { getMonsterSkillCastTimeMs } from '../src/systems/MonsterSkills';
import type { MonsterSkillEntry } from '../src/systems/MonsterTypes';
import { activeSkill, makeMonster, makePlayer, ofKind, pinRandom, runTo } from './combatTestUtils';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reaction and counter edge cases', () => {
  it('cancels an attack whose attacker an ally_targeted reaction just stunned', () => {
    pinRandom();
    const guardBash = activeSkill({
      id: 'guard_bash', name: 'Guard Bash', trigger: 'ally_targeted', cooldown: 5,
      activeEffects: [{ kind: 'stun_single', stunChance: 1 }],
    });
    const state = createPartyCombatState(
      [makePlayer('Pia', 2), makePlayer('Guard', 5, { className: 'Knight', hp: 5000, skills: [guardBash] })],
      [makeMonster(0, { name: 'Ogre', damage: 20 })],
    );
    const r = runTo(state, 1400);
    const at1400 = r.events.filter(e => e.t === 1400);
    expect(at1400.map(e => e.kind)).toContain('stun');
    expect(at1400.some(e => e.kind === 'attack' && e.src?.side === 'monster')).toBe(false);
    expect(state.players[0].currentHp).toBe(1000);
  });

  it('a reactor stunned before its counter resolves loses the counter and fizzles', () => {
    pinRandom();
    const counterspell = activeSkill({
      id: 'counterspell', name: 'Counterspell', className: 'Mage', trigger: 'enemy_cast', cooldown: 4, warmup: 0,
      activeEffects: [{ kind: 'damage_percent', damagePercent: 1 }],
    });
    const fireball: MonsterSkillEntry = { skillId: 'fireball', value: 5, cooldown: 10 };
    const fear: MonsterSkillEntry = { skillId: 'fear', value: 0, cooldown: 10, castTime: 0 };
    const state = createPartyCombatState(
      [makePlayer('Mira', 2, { className: 'Mage', skills: [counterspell] })],
      [makeMonster(0, { name: 'Shaman', skills: [fireball] }), makeMonster(3, { name: 'Banshee', skills: [fear] })],
    );
    const r = runTo(state, 3000);
    expect(ofKind(r.events, 'reaction').map(e => e.t)).toEqual([1400]);
    expect(ofKind(r.events, 'stun').map(e => e.t)).toEqual([1500]);
    expect(ofKind(r.events, 'fizzle')).toEqual([expect.objectContaining({ t: 1700, src: { side: 'player', pos: 2 }, skill: 'Counterspell' })]);
    expect(ofKind(r.events, 'interrupt')).toHaveLength(0);
    expect(ofKind(r.events, 'cast_end')).toEqual([expect.objectContaining({ t: 2900, skill: 'Fireball' })]);
  });
});

describe('authored content edge cases', () => {
  it('rounds cast times up to whole combat steps', () => {
    const entry = (castTime: number): MonsterSkillEntry => ({ skillId: 'fireball', value: 1, cooldown: 1, castTime });
    expect(getMonsterSkillCastTimeMs(entry(1.25))).toBe(1300);
    expect(getMonsterSkillCastTimeMs(entry(0.05))).toBe(100);
    expect(getMonsterSkillCastTimeMs(entry(1.5))).toBe(1500);

    const aim = activeSkill({ id: 'aim', name: 'Aim', cooldown: 5, warmup: 0, castTime: 1.25 });
    const state = createPartyCombatState([makePlayer('Ada', 2, { skills: [aim] })], [makeMonster(0)]);
    const r = runTo(state, 1000);
    expect(ofKind(r.events, 'cast_start')).toEqual([expect.objectContaining({ durationMs: 1300 })]);
  });

  it('treats a monster skill entry without a value as zero instead of producing NaN', () => {
    pinRandom();
    const entry = { skillId: 'assassinate', cooldown: 0, castTime: 0 } as MonsterSkillEntry;
    const state = createPartyCombatState([makePlayer('Ada', 2)], [makeMonster(0, { skills: [entry] })]);
    const r = runTo(state, 3000);
    const hits = ofKind(r.events, 'damage').filter(e => e.src?.side === 'monster');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(Number.isFinite(hit.amount)).toBe(true);
    expect(Number.isFinite(state.players[0].currentHp)).toBe(true);
  });
});
