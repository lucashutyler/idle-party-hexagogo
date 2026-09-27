import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  ARMOR_K,
  ENRAGE_MAX_STACKS,
  ENRAGE_STEP_PERCENT,
  ENRAGE_STEP_SECONDS,
  ENRAGE_TIER_DEFAULTS,
  GAP_LEVEL_OFFSET,
  LEVEL_GAP_MAX,
  LEVEL_GAP_MIN,
  LEVEL_GAP_SLOPE,
  MAX_DODGE,
  MAX_ENEMY_DAMAGE_REDUCTION,
  MAX_MITIGATION,
  MAX_PERCENT_RESIST,
  SKILL_RATING_SCALE,
  enrageStacksAt,
  isBossTier,
  levelGapMultiplier,
  masteryFactor,
  pairScaling,
  percentResistFactor,
  ratingMitigation,
  resolveEnrage,
  scaleDamage,
  skillRatingMitigation,
} from '../src/systems/CombatScaling';
import { MASTERY_BONUS_PER_RANK, MASTERY_MAX_RANK } from '../src/systems/Mastery';
import { createPartyCombatState } from '../src/systems/CombatEngine';
import type { PartyCombatantInit, PartyCombatState } from '../src/systems/CombatEngine';
import { enemyDebuffFactor, getBlessRating, getGuardRating, getMonsterDamage } from '../src/systems/combat/CombatPassives';
import { SEED_SKILLS } from '../src/systems/SkillTypes';
import type { EquipmentBonuses } from '../src/systems/ItemTypes';
import type { DamageType } from '../src/systems/CharacterStats';
import { createMonsterInstance } from '../src/systems/MonsterTypes';
import type { MonsterDefinition, MonsterTier } from '../src/systems/MonsterTypes';
import { deriveMonsterLevel } from '../src/systems/MonsterLevels';
import { makeMonster, makePlayer, monsterDef, ofKind, passiveSkill, pinRandom, player, runTo } from './combatTestUtils';

afterEach(() => {
  vi.restoreAllMocks();
});

function gear(overrides: Partial<EquipmentBonuses> = {}): EquipmentBonuses {
  return {
    bonusAttackMin: 0, bonusAttackMax: 0,
    damageReductionMin: 0, damageReductionMax: 0,
    magicReductionMin: 0, magicReductionMax: 0,
    ...overrides,
  };
}

const ARMOR_40 = gear({ damageReductionMin: 40, damageReductionMax: 40 });

/** Damage of the first monster hit (at 1400 ms) on `p`, from a monster at pos 4. */
function firstHitOnPlayer(p: PartyCombatantInit, monster: Partial<MonsterDefinition>, extra: PartyCombatantInit[] = []): number {
  const state = createPartyCombatState([p, ...extra], [makeMonster(4, { hp: 1e9, ...monster })]);
  const { events } = runTo(state, 1400);
  const hit = ofKind(events, 'damage').find(e => e.dst?.side === 'player' && e.dst.pos === p.gridPosition);
  if (!hit) throw new Error('no hit');
  return hit.amount ?? -1;
}

/** Damage of the player's first auto-attack (at 1000 ms) on a monster at pos 4. */
function firstHitOnMonster(p: PartyCombatantInit, monster: Partial<MonsterDefinition>): number {
  const state = createPartyCombatState([p], [makeMonster(4, { hp: 1e9, ...monster })]);
  const { events } = runTo(state, 1000);
  const hit = ofKind(events, 'damage').find(e => e.dst?.side === 'monster');
  if (!hit) throw new Error('no hit');
  return hit.amount ?? -1;
}

const mitigated = (raw: number, rating: number, level: number, extra = 1): number =>
  scaleDamage(raw, (1 - ratingMitigation(rating, level)) * extra);

describe('rating mitigation', () => {
  it('is R / (R + ARMOR_K × attacker level), capped', () => {
    expect(ratingMitigation(ARMOR_K * 10, 10)).toBe(0.5);
    expect(ratingMitigation(ARMOR_K * 30, 30)).toBe(0.5);
    expect(ratingMitigation(40, 30)).toBeCloseTo(Math.min(MAX_MITIGATION, 40 / (40 + ARMOR_K * 30)), 12);
    expect(ratingMitigation(1e9, 1)).toBe(MAX_MITIGATION);
    expect(ratingMitigation(40, 20)).toBeGreaterThan(ratingMitigation(40, 40));
  });

  it('treats zero, negative and non-finite ratings as no mitigation and levels below 1 as 1', () => {
    expect(ratingMitigation(0, 10)).toBe(0);
    expect(ratingMitigation(-50, 10)).toBe(0);
    expect(ratingMitigation(NaN, 10)).toBe(0);
    expect(ratingMitigation(Infinity, 10)).toBe(0);
    expect(ratingMitigation(ARMOR_K, 0)).toBe(0.5);
    expect(ratingMitigation(ARMOR_K, NaN)).toBe(0.5);
  });

  it('gives Guard/Bless the same share at every level (rating = SKILL_RATING_SCALE × value × level)', () => {
    const share = (value: number) => Math.min(MAX_MITIGATION, SKILL_RATING_SCALE * value / (SKILL_RATING_SCALE * value + ARMOR_K));
    for (const level of [1, 10, 37, 100]) {
      expect(skillRatingMitigation(2, level)).toBeCloseTo(share(2), 10);
      expect(skillRatingMitigation(1, level)).toBeCloseTo(share(1), 10);
    }
  });
});

describe('level gap multiplier', () => {
  const spec = (a: number, d: number) => Math.min(LEVEL_GAP_MAX, Math.max(LEVEL_GAP_MIN,
    1 + LEVEL_GAP_SLOPE * (Math.min(a, d) + GAP_LEVEL_OFFSET) / (GAP_LEVEL_OFFSET + 10) * (a - d)));

  it('follows the spec formula, with a slope that grows with the lower level', () => {
    for (const [a, d] of [[10, 13], [30, 33], [60, 63], [5, 1], [10, 10], [45, 50]]) {
      expect(levelGapMultiplier(a, d)).toBeCloseTo(spec(a, d), 12);
    }
    expect(levelGapMultiplier(10, 13)).toBeLessThan(1);
    expect(levelGapMultiplier(30, 33)).toBeLessThan(levelGapMultiplier(10, 13));
    expect(levelGapMultiplier(60, 63)).toBeLessThan(levelGapMultiplier(30, 33));
  });

  it('is symmetric around 1 and clamped', () => {
    for (const [a, d] of [[10, 13], [30, 27], [4, 9], [60, 58]]) {
      expect(levelGapMultiplier(a, d) - 1).toBeCloseTo(1 - levelGapMultiplier(d, a), 10);
    }
    expect(levelGapMultiplier(200, 1)).toBe(LEVEL_GAP_MAX);
    expect(levelGapMultiplier(1, 200)).toBe(LEVEL_GAP_MIN);
    expect(levelGapMultiplier(NaN, 1)).toBe(1);
  });

  it('turns off when either side is derived; a derived attacker is judged at the defender level', () => {
    expect(pairScaling({ level: 20, derived: false }, { level: 10, derived: false }))
      .toEqual({ gap: levelGapMultiplier(20, 10), mitigationLevel: 20 });
    expect(pairScaling({ level: 90, derived: true }, { level: 10, derived: false })).toEqual({ gap: 1, mitigationLevel: 10 });
    expect(pairScaling({ level: 10, derived: false }, { level: 90, derived: true })).toEqual({ gap: 1, mitigationLevel: 10 });
  });
});

describe('damage scaling helpers', () => {
  it('floors once and never drops a real hit below 1', () => {
    expect(scaleDamage(10, 0.55)).toBe(5);
    expect(scaleDamage(10, 1.5)).toBe(15);
    expect(scaleDamage(1e6, 1e-9)).toBe(1);
    expect(scaleDamage(1, 0)).toBe(1);
    expect(scaleDamage(10, NaN)).toBe(1);
  });

  it('does not lose a point to float noise', () => {
    expect(scaleDamage(100, 1 - 0.8)).toBe(20);
    expect(scaleDamage(10, 0.9999)).toBe(9);
  });

  it('keeps 0 (and sub-1 or NaN raw damage) at 0', () => {
    expect(scaleDamage(0, 5)).toBe(0);
    expect(scaleDamage(0.5, 1)).toBe(0);
    expect(scaleDamage(NaN, 1)).toBe(0);
  });

  it('clamps percent resistance to the cap and to the given floor', () => {
    expect(percentResistFactor(50)).toBe(0.5);
    expect(percentResistFactor(100)).toBe(1 - MAX_PERCENT_RESIST);
    expect(percentResistFactor(-50)).toBe(1);
    expect(percentResistFactor(-50, -1)).toBe(1.5);
    expect(percentResistFactor(-500, -1)).toBe(2);
    expect(percentResistFactor(undefined)).toBe(1);
    expect(percentResistFactor(NaN)).toBe(1);
  });

  it('turns mastery ranks into a per-rank bonus, capped at the max rank', () => {
    const top = MASTERY_MAX_RANK * MASTERY_BONUS_PER_RANK;
    expect(masteryFactor(MASTERY_MAX_RANK, 'dealt')).toBeCloseTo(1 + top, 10);
    expect(masteryFactor(MASTERY_MAX_RANK, 'taken')).toBeCloseTo(1 - top, 10);
    expect(masteryFactor(MASTERY_MAX_RANK + 4, 'dealt')).toBeCloseTo(1 + top, 10);
    expect(masteryFactor(2.7, 'dealt')).toBeCloseTo(1 + 2 * MASTERY_BONUS_PER_RANK, 10);
    expect(masteryFactor(-1, 'taken')).toBe(1);
    expect(masteryFactor(undefined, 'dealt')).toBe(1);
    expect(masteryFactor(NaN, 'dealt')).toBe(1);
  });
});

describe('enrage config', () => {
  const defaults = (afterSeconds: number) => ({
    afterMs: afterSeconds * 1000, stepMs: ENRAGE_STEP_SECONDS * 1000, stepPercent: ENRAGE_STEP_PERCENT, maxStacks: ENRAGE_MAX_STACKS,
  });

  it('defaults bosses and raids to their tier clock; trash and elites never enrage', () => {
    expect(resolveEnrage('boss', undefined)).toEqual(defaults(ENRAGE_TIER_DEFAULTS.boss!.afterSeconds));
    expect(resolveEnrage('raid', undefined)).toEqual(defaults(ENRAGE_TIER_DEFAULTS.raid!.afterSeconds));
    expect(ENRAGE_TIER_DEFAULTS.raid!.afterSeconds).toBeGreaterThan(ENRAGE_TIER_DEFAULTS.boss!.afterSeconds);
    expect(resolveEnrage('trash', undefined)).toBeNull();
    expect(resolveEnrage('elite', undefined)).toBeNull();
    expect(resolveEnrage(undefined, undefined)).toBeNull();
    expect(isBossTier('boss')).toBe(true);
    expect(isBossTier('raid')).toBe(true);
    expect(isBossTier('elite')).toBe(false);
    expect(isBossTier(undefined)).toBe(false);
  });

  it('honours an explicit config on any tier and sanitises bad values', () => {
    expect(resolveEnrage('trash', { afterSeconds: 10 })).toEqual(defaults(10));
    expect(resolveEnrage('boss', { afterSeconds: NaN })).toEqual(resolveEnrage('boss', undefined));
    expect(resolveEnrage('trash', { afterSeconds: -1 })).toBeNull();
    expect(resolveEnrage('trash', { afterSeconds: 5, stepSeconds: 0.01 })?.stepMs).toBe(100);
    expect(resolveEnrage('trash', { afterSeconds: 5, stepSeconds: 0 })?.stepMs).toBe(ENRAGE_STEP_SECONDS * 1000);
    expect(resolveEnrage('trash', { afterSeconds: 5, stepPercent: -1 })?.stepPercent).toBe(ENRAGE_STEP_PERCENT);
    expect(resolveEnrage('trash', { afterSeconds: 5, maxStacks: 2.7 })?.maxStacks).toBe(2);
  });

  it('counts a stack at the start and one per step, up to the cap', () => {
    const clock = { atMs: 1000, stepMs: 500, maxStacks: 3 };
    expect(enrageStacksAt(clock, 999)).toBe(0);
    expect(enrageStacksAt(clock, 1000)).toBe(1);
    expect(enrageStacksAt(clock, 1499)).toBe(1);
    expect(enrageStacksAt(clock, 1500)).toBe(2);
    expect(enrageStacksAt(clock, 99999)).toBe(3);
    expect(enrageStacksAt({ ...clock, maxStacks: 0 }, 99999)).toBe(0);
  });
});

describe('monster instances', () => {
  it('carry an authored level (clamped) or a derived one, plus tier and enrage', () => {
    const enrage = { afterSeconds: 60, maxStacks: 3 };
    const authored = createMonsterInstance(monsterDef({ level: 7.6, tier: 'elite', enrage }), 4);
    expect(authored).toMatchObject({ level: 8, levelSource: 'authored', tier: 'elite', enrage });
    expect(authored.enrage).not.toBe(enrage);
    expect(createMonsterInstance(monsterDef({ level: 250 })).level).toBe(200);

    for (const level of [0, NaN, -3, undefined]) {
      const def = monsterDef({ damage: 30, level });
      expect(createMonsterInstance(def)).toMatchObject({ level: deriveMonsterLevel(def), levelSource: 'derived' });
    }
    const bogus = createMonsterInstance(monsterDef({ tier: 'mythic' as MonsterTier }));
    expect(bogus.tier).toBeUndefined();
    expect(bogus.enrage).toBeUndefined();
  });
});

describe('hits on players', () => {
  const L10 = { level: 10, damage: 20 };

  it('uses the average of the gear DR range as a rating — no per-hit roll', () => {
    const results = [0, 0.4, 0.99].map(r => {
      vi.spyOn(Math, 'random').mockReturnValue(r);
      const archer = makePlayer('A', 2, { level: 10, equipBonuses: gear({ damageReductionMin: 30, damageReductionMax: 50 }) });
      const amount = firstHitOnPlayer(archer, L10);
      vi.restoreAllMocks();
      return amount;
    });
    expect(results).toEqual([0, 1, 2].map(() => mitigated(20, 40, 10)));
    expect(results[0]).toBeLessThan(20);
  });

  it('uses gear MR for magical hits and only Bless for holy hits', () => {
    pinRandom();
    const p = () => makePlayer('A', 2, { level: 10, equipBonuses: gear({ damageReductionMin: 40, damageReductionMax: 40, magicReductionMin: 40, magicReductionMax: 40 }) });
    expect(firstHitOnPlayer(p(), { ...L10, damageType: 'magical' })).toBe(mitigated(20, 40, 10));
    expect(firstHitOnPlayer(p(), { ...L10, damageType: 'holy' })).toBe(20);
  });

  it('scales an authored enemy by the level gap and judges mitigation at its level', () => {
    pinRandom();
    expect(firstHitOnPlayer(makePlayer('A', 2, { level: 10 }), { level: 13, damage: 20 })).toBe(scaleDamage(20, levelGapMultiplier(13, 10)));
    expect(firstHitOnPlayer(makePlayer('A', 2, { level: 10, equipBonuses: ARMOR_40 }), { level: 1, damage: 20 }))
      .toBe(mitigated(20, 40, 1, levelGapMultiplier(1, 10)));
  });

  it('never gap-scales a derived enemy and judges its mitigation at the defender level', () => {
    pinRandom();
    const def = monsterDef({ damage: 20 });
    expect(deriveMonsterLevel(def)).not.toBe(10);
    expect(firstHitOnPlayer(makePlayer('A', 2, { level: 10, equipBonuses: ARMOR_40 }), def)).toBe(mitigated(20, 40, 10));
    expect(firstHitOnPlayer(makePlayer('B', 2, { level: 60 }), def)).toBe(20);
  });

  it('treats a hand-built instance without a level source as derived only when it has no level', () => {
    pinRandom();
    const base = makeMonster(4, { hp: 1e9, damage: 20 });
    const hit = (m: typeof base): number => {
      const state = createPartyCombatState([makePlayer('A', 2, { level: 10 })], [m]);
      return ofKind(runTo(state, 1400).events, 'damage').find(e => e.dst?.side === 'player')?.amount ?? -1;
    };
    expect(hit({ ...base, level: undefined, levelSource: undefined })).toBe(20);
    expect(hit({ ...base, level: 13, levelSource: undefined })).toBe(scaleDamage(20, levelGapMultiplier(13, 10)));
  });

  it('never deals 0 to a player, however armored', () => {
    pinRandom();
    const tank = () => makePlayer('A', 2, { level: 1, equipBonuses: gear({ damageReductionMin: 1e9, damageReductionMax: 1e9 }) });
    expect(firstHitOnPlayer(tank(), { level: 1, damage: 1 })).toBe(1);
    expect(firstHitOnPlayer(tank(), { level: 1, damage: 100 })).toBe(Math.round(100 * (1 - MAX_MITIGATION)));
  });

  it('applies the set resist percent after the rating, capped', () => {
    pinRandom();
    const set = (extra: Partial<EquipmentBonuses> = {}) => makePlayer('A', 2, {
      level: 10, setBonuses: { damageResistancePercent: 99 }, equipBonuses: gear(extra),
    });
    expect(firstHitOnPlayer(set(), L10)).toBe(scaleDamage(20, 1 - MAX_PERCENT_RESIST));
    expect(firstHitOnPlayer(set({ damageReductionMin: 40, damageReductionMax: 40 }), L10)).toBe(mitigated(20, 40, 10, 1 - MAX_PERCENT_RESIST));
  });

  it('Guard is a self-only physical rating of SKILL_RATING_SCALE × value × level', () => {
    pinRandom();
    const guard = SKILL_RATING_SCALE * 2 * 10;
    const knight = () => makePlayer('K', 2, { className: 'Knight', level: 10, skills: [SEED_SKILLS.knight_guard] });
    expect(firstHitOnPlayer(knight(), L10)).toBe(mitigated(20, guard, 10));
    expect(firstHitOnPlayer(knight(), { ...L10, damageType: 'magical' })).toBe(20);
    expect(getGuardRating(createPartyCombatState([knight()], []).players[0])).toBe(guard);
  });

  it('Bless takes the strongest living owner instead of stacking', () => {
    pinRandom();
    const priest = (name: string, pos: 0 | 6, level: number) => makePlayer(name, pos, {
      className: 'Priest', level, skills: [SEED_SKILLS.priest_bless],
    });
    const strongest = SKILL_RATING_SCALE * 2 * 10;
    const archer = makePlayer('A', 5, { level: 10 });
    expect(firstHitOnPlayer(archer, { ...L10, damageType: 'magical' }, [priest('P5', 0, 5), priest('P10', 6, 10)]))
      .toBe(mitigated(20, strongest, 10));

    const state = createPartyCombatState([priest('P5', 0, 5), priest('P10', 6, 10)], []);
    expect(getBlessRating(state.players)).toBe(strongest);
    player(state, 'P10').currentHp = 0;
    expect(getBlessRating(state.players)).toBe(SKILL_RATING_SCALE * 2 * 5);
  });
});

describe('hits on monsters', () => {
  it('scales player damage by the gap against authored monsters only', () => {
    pinRandom();
    const p = (level: number) => makePlayer('A', 2, { level, baseDamage: 100 });
    expect(firstHitOnMonster(p(10), { level: 13 })).toBe(scaleDamage(100, levelGapMultiplier(10, 13)));
    expect(firstHitOnMonster(p(10), {})).toBe(100);
    expect(firstHitOnMonster(p(30), { level: 10 })).toBe(scaleDamage(100, levelGapMultiplier(30, 10)));
  });

  it('reads flat resistance as a rating against the attacker level', () => {
    pinRandom();
    const resist = (flat: number, percent = 0): Partial<MonsterDefinition> => ({
      resistances: [{ damageType: 'physical' as DamageType, flatReduction: flat, percentReduction: percent }],
    });
    const knight = (level: number) => makePlayer('K', 2, { className: 'Knight', level, baseDamage: 100 });
    expect(firstHitOnMonster(knight(10), resist(40))).toBe(mitigated(100, 40, 10));
    expect(firstHitOnMonster(knight(30), resist(40))).toBe(mitigated(100, 40, 30));
    expect(firstHitOnMonster(knight(30), resist(40))).toBeGreaterThan(firstHitOnMonster(knight(10), resist(40)));
    expect(firstHitOnMonster(knight(10), resist(1e9))).toBe(Math.round(100 * (1 - MAX_MITIGATION)));
    expect(firstHitOnMonster(knight(10), resist(0, 100))).toBe(scaleDamage(100, 1 - MAX_PERCENT_RESIST));
    expect(firstHitOnMonster(knight(10), resist(-40, -50))).toBe(150);
  });

  it('never deals 0 to a monster that can be hit', () => {
    pinRandom();
    const weak = makePlayer('A', 2, { className: 'Knight', level: 1, baseDamage: 1 });
    expect(firstHitOnMonster(weak, { resistances: [{ damageType: 'physical', flatReduction: 1e9, percentReduction: 100 }] })).toBe(1);
  });
});

describe('henchmen levels', () => {
  it('count as derived: no gap in either direction', () => {
    pinRandom();
    const hench = () => makePlayer('H', 2, { level: 30, baseDamage: 100, isHenchman: true });
    const human = () => makePlayer('P', 2, { level: 30, baseDamage: 100 });
    expect(firstHitOnMonster(hench(), { level: 10 })).toBe(100);
    expect(firstHitOnMonster(human(), { level: 10 })).toBe(scaleDamage(100, levelGapMultiplier(30, 10)));
    expect(firstHitOnPlayer(hench(), { level: 10, damage: 20 })).toBe(20);
    expect(firstHitOnPlayer(human(), { level: 10, damage: 20 })).toBe(scaleDamage(20, levelGapMultiplier(10, 30)));
  });
});

describe('kill mastery', () => {
  const rank = MASTERY_MAX_RANK;

  it('adds damage dealt to that monster and removes damage taken from it', () => {
    pinRandom();
    const mastered = () => makePlayer('A', 2, { level: 10, baseDamage: 100, mastery: { dummy: rank } });
    expect(firstHitOnMonster(mastered(), {})).toBe(scaleDamage(100, masteryFactor(rank, 'dealt')));
    expect(firstHitOnMonster(mastered(), {})).toBeGreaterThan(100);
    expect(firstHitOnPlayer(mastered(), { damage: 20 })).toBe(scaleDamage(20, masteryFactor(rank, 'taken')));
    expect(firstHitOnMonster(mastered(), { id: 'other' })).toBe(100);
  });

  it('applies after the gap clamp', () => {
    pinRandom();
    const p = makePlayer('A', 2, { level: 1, baseDamage: 100, mastery: { dummy: rank } });
    expect(firstHitOnMonster(p, { level: 200 })).toBe(scaleDamage(100, LEVEL_GAP_MIN * masteryFactor(rank, 'dealt')));
  });

  it('applies to DoT pulses by their source', () => {
    pinRandom();
    const ignite = (mastery?: Record<string, number>) => {
      const mage = makePlayer('M', 2, { className: 'Mage', level: 10, baseDamage: 100, skills: [SEED_SKILLS.mage_ignite], mastery });
      const state = createPartyCombatState([mage], [makeMonster(4, { hp: 1e9 })]);
      return ofKind(runTo(state, 1400).events, 'damage').find(e => e.overTime)?.amount;
    };
    const perTick = Math.floor(100 * (SEED_SKILLS.mage_ignite.passiveEffects?.[0].dotPercent ?? 0));
    expect(ignite()).toBe(perTick);
    expect(ignite({ dummy: rank })).toBe(scaleDamage(perTick, masteryFactor(rank, 'dealt')));
  });
});

describe('enemy damage debuffs and dodge', () => {
  function debuffState(): PartyCombatState {
    return createPartyCombatState([makePlayer('A', 2)], [makeMonster(4, { damage: 7 })]);
  }

  it('multiply as floats with a single floor', () => {
    const state = debuffState();
    const monster = state.monsters[0];
    state.unnerveReduction = 0.2;
    monster.debuffs.push({ type: 'lullaby', value: 0.2, remainingMs: 3000 });
    monster.debuffs.push({ type: 'crippling_shot', value: 0.3, remainingMs: 3000 });
    const factor = Math.max(1 - MAX_ENEMY_DAMAGE_REDUCTION, 0.8 * 0.8 * 0.7);
    expect(enemyDebuffFactor(monster, state)).toBeCloseTo(factor, 10);
    expect(getMonsterDamage(monster, state)).toBe(scaleDamage(7, factor));
    expect(getMonsterDamage(monster, state)).not.toBe(Math.floor(Math.floor(Math.floor(7 * 0.8) * 0.8) * 0.7));
  });

  it('cap the combined reduction', () => {
    const state = debuffState();
    const monster = state.monsters[0];
    monster.damage = 100;
    state.unnerveReduction = 0.9;
    monster.debuffs.push({ type: 'lullaby', value: 0.9, remainingMs: 3000 });
    expect(enemyDebuffFactor(monster, state)).toBeCloseTo(1 - MAX_ENEMY_DAMAGE_REDUCTION, 10);
    expect(getMonsterDamage(monster, state)).toBe(Math.round(100 * (1 - MAX_ENEMY_DAMAGE_REDUCTION)));
  });

  it('cap party dodge', () => {
    const nimble = passiveSkill({ id: 'nimble', passiveEffects: [{ kind: 'dodge_party', flatValue: 0.2, perPartyMember: true }] });
    const players = ([0, 1, 2, 3, 4] as const).map(pos => makePlayer(`B${pos}`, pos, { className: 'Bard', skills: [nimble] }));
    expect(createPartyCombatState(players, []).nimbleDodge).toBe(MAX_DODGE);
  });
});
