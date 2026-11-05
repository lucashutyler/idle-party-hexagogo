import { afterEach, describe, it, expect, vi } from 'vitest';
import { createPartyCombatState, processCombatStep } from '../src/systems/CombatEngine';
import { FOCUS_MAX_STACKS, IGNITE_MAX_STACKS, SUNDER_MAX_STACKS, WAR_SONG_MAX_STACKS } from '../src/systems/CombatScaling';
import { HEAL_NEEDED_THRESHOLD, STALEMATE_WINDOW_MS } from '../src/systems/CombatTiming';
import { healTarget } from '../src/systems/combat/CombatTargeting';
import { wouldHaveEffect } from '../src/systems/combat/CombatNeeds';
import { createRng } from '../src/systems/combat/CombatRng';
import { calculateBaseDamage, calculateMaxHp } from '../src/systems/CharacterStats';
import { SEED_SKILLS } from '../src/systems/SkillTypes';
import { createMonsterInstance } from '../src/systems/MonsterTypes';
import { makeMonster, makePlayer, ofKind, pinRandom, player, runTo } from './combatTestUtils';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ramp caps', () => {
  it('Focus stops growing at the stack cap', () => {
    pinRandom();
    const archer = makePlayer('A', 2, { baseDamage: 100, skills: [SEED_SKILLS.archer_focus] });
    const state = createPartyCombatState([archer], [makeMonster(4, { hp: 1e9 })]);
    const { events } = runTo(state, 12000);
    const hits = ofKind(events, 'damage').filter(e => e.dst?.side === 'monster').map(e => e.amount);
    expect(state.players[0].consecutiveHits).toBe(FOCUS_MAX_STACKS);
    const capped = 100 + 10 * FOCUS_MAX_STACKS;
    expect(hits.slice(0, FOCUS_MAX_STACKS + 2)).toEqual([...Array.from({ length: FOCUS_MAX_STACKS + 1 }, (_, i) => 100 + 10 * i), capped]);
    expect(Math.max(...hits.map(h => h ?? 0))).toBe(capped);
  });

  it('Sunder stops adding marks and incoming damage at the stack cap', () => {
    pinRandom();
    const knight = makePlayer('K', 2, { className: 'Knight', baseDamage: 10, skills: [SEED_SKILLS.knight_sunder] });
    const state = createPartyCombatState([knight], [makeMonster(4, { hp: 1e9 })]);
    runTo(state, 40000);
    expect(state.monsters[0].sunderMark?.stacks).toBe(SUNDER_MAX_STACKS);
    expect(state.monsters[0].sunderMark?.totalBonus).toBeCloseTo(SUNDER_MAX_STACKS * 0.25, 10);
  });

  it('War Song holds at the stack cap instead of casting into nothing', () => {
    pinRandom();
    const bard = makePlayer('B', 2, { className: 'Bard', baseDamage: 10, skills: [SEED_SKILLS.bard_war_song] });
    const state = createPartyCombatState([bard], [makeMonster(4, { hp: 1e9 })]);
    const { events } = runTo(state, 60000);
    expect(state.partyBuffs).toEqual([{ name: SEED_SKILLS.bard_war_song.name, stacks: WAR_SONG_MAX_STACKS }]);
    expect(state.warSongBonus).toBeCloseTo(WAR_SONG_MAX_STACKS * 0.1, 10);
    expect(ofKind(events, 'buff')).toHaveLength(WAR_SONG_MAX_STACKS);
    expect(ofKind(events, 'fizzle')).toHaveLength(0);
    expect(wouldHaveEffect(state.players[0], SEED_SKILLS.bard_war_song, state)).toBe(false);
  });

  it('Ignite keeps a capped stack count per source and target, replacing the weakest with a stronger one', () => {
    pinRandom();
    const mage = (name: string, pos: 2 | 5) => makePlayer(name, pos, {
      className: 'Mage', baseDamage: 100, skills: [SEED_SKILLS.mage_ignite],
    });
    const state = createPartyCombatState([mage('M1', 2), mage('M2', 5)], [makeMonster(4, { hp: 1e9 })]);
    runTo(state, 15000);
    const bySource = (name: string) => state.monsters[0].dots.filter(d => d.permanent && d.sourceUsername === name);
    expect(bySource('M1')).toHaveLength(IGNITE_MAX_STACKS);
    expect(bySource('M2')).toHaveLength(IGNITE_MAX_STACKS);
    expect(bySource('M1').every(d => d.damagePerTick === 25)).toBe(true);

    player(state, 'M1').baseDamage = 200;
    runTo(state, 18000);
    const upgraded = bySource('M1').map(d => d.damagePerTick).sort((a, b) => a - b);
    expect(upgraded).toHaveLength(IGNITE_MAX_STACKS);
    expect(upgraded.filter(v => v === 50).length).toBeGreaterThanOrEqual(3);
    expect(bySource('M2')).toHaveLength(IGNITE_MAX_STACKS);
  });
});

describe('heal "needed" rule', () => {
  it('heals an ally only below 70 % HP', () => {
    const state = createPartyCombatState([makePlayer('A', 2, { hp: 100 }), makePlayer('B', 5, { hp: 100 })], []);
    const [a, b] = state.players;
    a.currentHp = 71;
    b.currentHp = 100;
    expect(healTarget(state.players)).toBeNull();
    a.currentHp = Math.ceil(100 * HEAL_NEEDED_THRESHOLD) - 1;
    expect(healTarget(state.players)).toBe(a);
    b.currentHp = 30;
    expect(healTarget(state.players)).toBe(b);
    b.currentHp = 0;
    expect(healTarget(state.players)).toBe(a);
  });

  it('a solo Priest keeps attacking between heals and wins against chip damage', () => {
    pinRandom();
    const priest = makePlayer('P', 2, {
      className: 'Priest', level: 10, hp: 100, baseDamage: 10, skills: [SEED_SKILLS.priest_minor_heal],
    });
    const state = createPartyCombatState([priest], [makeMonster(4, { hp: 200, damage: 8 })]);
    const hpBeforeHeal: number[] = [];
    while (!state.finished && state.elapsedMs < 120000) {
      const before = state.players[0].currentHp;
      const r = processCombatStep(state);
      if (r.events.some(e => e.kind === 'heal' && e.src?.side === 'player')) hpBeforeHeal.push(before);
    }
    expect(state.result).toBe('victory');
    expect(state.elapsedMs).toBeLessThan(STALEMATE_WINDOW_MS);
    expect(hpBeforeHeal.length).toBeGreaterThan(0);
    for (const hp of hpBeforeHeal) expect(hp).toBeLessThan(100 * HEAL_NEEDED_THRESHOLD);
  });

  it('a solo seed-geared L5 Priest beats two on-level class-average monsters without stalling', () => {
    const level = 5;
    const priest = makePlayer('P', 4, {
      className: 'Priest',
      level,
      hp: calculateMaxHp(level, 'Priest'),
      baseDamage: calculateBaseDamage(level, 'Priest'),
      equipBonuses: { bonusAttackMin: 3, bonusAttackMax: 10, damageReductionMin: 1, damageReductionMax: 8, magicReductionMin: 0, magicReductionMax: 0 },
      skills: [SEED_SKILLS.priest_bless, SEED_SKILLS.priest_minor_heal],
    });
    const hpAvg = 19.2 + 2 * (level - 1);
    const dmgAvg = 7 + 1.4 * (level - 1);
    const def = {
      id: 'tm', name: 'Template', hp: Math.round(15 / 7 * dmgAvg), damage: Math.round(4 / 19.2 * hpAvg),
      damageType: 'physical' as const, xp: 1, goldMin: 0, goldMax: 0, level,
    };
    for (let seed = 1; seed <= 5; seed++) {
      const rng = createRng(seed);
      const state = createPartyCombatState([priest], [createMonsterInstance(def, 4), createMonsterInstance(def, 1)]);
      while (!state.finished) processCombatStep(state, 100, rng);
      expect(state.result).toBe('victory');
      expect(state.elapsedMs).toBeLessThan(STALEMATE_WINDOW_MS);
    }
  });
});
