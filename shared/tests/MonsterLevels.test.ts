import { describe, it, expect } from 'vitest';
import {
  deriveMonsterLevel,
  effectiveMonsterLevel,
  effectiveMonsterTier,
  suggestTierFromHp,
  monsterDamagePerSecond,
  levelCon,
  monsterLevelCon,
  xpConFactor,
  formatMonsterLevel,
  LEVEL_CON_INFO,
  LEVEL_CONS,
} from '../src/systems/MonsterLevels';
import { suggestMonsterStats, trashTemplateHp } from '../src/systems/MonsterTemplates';
import { SEED_MONSTERS } from '../src/systems/MonsterTypes';
import type { MonsterDefinition, MonsterTier } from '../src/systems/MonsterTypes';

function monster(overrides: Partial<MonsterDefinition> = {}): MonsterDefinition {
  return {
    id: 'm',
    name: 'M',
    hp: 15,
    damage: 4,
    damageType: 'physical',
    xp: 1,
    goldMin: 0,
    goldMax: 0,
    ...overrides,
  };
}

function fromTemplate(level: number, tier: MonsterTier, tagged: boolean): MonsterDefinition {
  const s = suggestMonsterStats(level, tier);
  return monster({ hp: s.hp, damage: s.damage, attackInterval: s.attackInterval, ...(tagged ? { tier } : {}) });
}

describe('deriveMonsterLevel', () => {
  it('derives from damage output even when a level is authored', () => {
    expect(deriveMonsterLevel(SEED_MONSTERS.goblin)).toBe(deriveMonsterLevel({ ...SEED_MONSTERS.goblin, level: undefined }));
    expect(deriveMonsterLevel(SEED_MONSTERS.wolf)).toBeGreaterThan(deriveMonsterLevel(SEED_MONSTERS.goblin));
  });

  it('ignores HP entirely', () => {
    const base = monster({ damage: 12 });
    expect(deriveMonsterLevel(monster({ damage: 12, hp: 15 * 200 }))).toBe(deriveMonsterLevel(base));
  });

  it('rates passive and harmless monsters as level 1', () => {
    expect(deriveMonsterLevel(SEED_MONSTERS.stone_wall)).toBe(1);
    expect(deriveMonsterLevel(monster({ damage: 0 }))).toBe(1);
  });

  it('round-trips every tier template at its own level when the tier is authored', () => {
    for (const tier of ['elite', 'boss', 'raid'] as const) {
      for (const level of [1, 6, 25, 60]) {
        expect(Math.abs(deriveMonsterLevel(fromTemplate(level, tier, true)) - level)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('round-trips trash templates to within the few levels one point of damage spans', () => {
    for (const level of [1, 6, 25, 60, 120]) {
      expect(Math.abs(deriveMonsterLevel(fromTemplate(level, 'trash', false)) - level)).toBeLessThanOrEqual(5);
    }
  });

  it('grows with damage and faster attacks', () => {
    const slow = deriveMonsterLevel(monster({ damage: 20, attackInterval: 2 }));
    const fast = deriveMonsterLevel(monster({ damage: 20, attackInterval: 1 }));
    expect(fast).toBeGreaterThan(slow);
  });

  it('counts damage skills and DoTs but not heals or stuns', () => {
    const plain = monsterDamagePerSecond(monster());
    expect(monsterDamagePerSecond(monster({ skills: [{ skillId: 'heal', value: 50, cooldown: 2 }] }))).toBe(plain);
    expect(monsterDamagePerSecond(monster({ skills: [{ skillId: 'fear', value: 0, cooldown: 3 }] }))).toBe(plain);
    expect(monsterDamagePerSecond(monster({ skills: [{ skillId: 'rot', value: 2, cooldown: 2 }] }))).toBeGreaterThan(plain);
    expect(monsterDamagePerSecond(monster({ skills: [{ skillId: 'unknown_skill', value: 99, cooldown: 1 }] }))).toBe(plain);
  });

  it('clamps extreme damage to level 200 and honours the minimum interval', () => {
    expect(deriveMonsterLevel(monster({ damage: 1e9 }))).toBe(200);
    expect(monsterDamagePerSecond(monster({ damage: 3, attackInterval: 0.01 }))).toBeCloseTo(10);
  });

  it('recomputes when a definition is edited in place', () => {
    const def = monster({ damage: 4 });
    const before = deriveMonsterLevel(def);
    def.damage = 40;
    expect(deriveMonsterLevel(def)).toBeGreaterThan(before);
  });
});

describe('effectiveMonsterLevel', () => {
  it('honours an authored level and marks the source', () => {
    expect(effectiveMonsterLevel(monster({ level: 7 }))).toEqual({ level: 7, source: 'authored' });
    expect(effectiveMonsterLevel(monster({ level: 450 }))).toEqual({ level: 200, source: 'authored' });
  });

  it('falls back to the derived level when the authored value is unusable', () => {
    for (const level of [0, -3, NaN, Infinity]) {
      expect(effectiveMonsterLevel(monster({ level })).source).toBe('derived');
    }
    expect(effectiveMonsterLevel(monster())).toEqual({ level: deriveMonsterLevel(monster()), source: 'derived' });
  });

  it('treats unknown or absent tiers as trash', () => {
    expect(effectiveMonsterTier({})).toBe('trash');
    expect(effectiveMonsterTier({ tier: 'mythic' as MonsterTier })).toBe('trash');
    expect(effectiveMonsterTier({ tier: 'boss' })).toBe('boss');
  });
});

describe('suggestTierFromHp', () => {
  it('recognises every tier template, tagged or not', () => {
    for (const tier of ['trash', 'elite', 'boss', 'raid'] as const) {
      for (const level of [1, 10, 40]) {
        expect(suggestTierFromHp(fromTemplate(level, tier, false))).toBe(tier);
        expect(suggestTierFromHp(fromTemplate(level, tier, true))).toBe(tier);
      }
    }
  });

  it('uses an authored level as is', () => {
    expect(suggestTierFromHp(monster({ level: 1, hp: trashTemplateHp(1) * 7 }))).toBe('elite');
    expect(suggestTierFromHp(monster({ level: 1, hp: trashTemplateHp(1) * 200 }))).toBe('boss');
  });

  it('never suggests a tier for passive monsters', () => {
    expect(suggestTierFromHp(monster({ passive: true, hp: 1e9 }))).toBe('trash');
  });
});

describe('levelCon', () => {
  it('uses the tighter bands below level 10', () => {
    expect(levelCon(8, 5)).toBe('deadly');
    expect(levelCon(7, 5)).toBe('hard');
    expect(levelCon(6, 5)).toBe('even');
    expect(levelCon(3, 5)).toBe('even');
    expect(levelCon(2, 5)).toBe('easy');
    expect(levelCon(1, 7)).toBe('trivial');
  });

  it('widens the easy band by one per 10 viewer levels', () => {
    expect(levelCon(35, 30)).toBe('deadly');
    expect(levelCon(33, 30)).toBe('hard');
    expect(levelCon(32, 30)).toBe('even');
    expect(levelCon(28, 30)).toBe('even');
    expect(levelCon(27, 30)).toBe('easy');
    expect(levelCon(22, 30)).toBe('easy');
    expect(levelCon(21, 30)).toBe('trivial');
  });

  it('shows derived levels as even and never scales their XP', () => {
    expect(monsterLevelCon(90, 'derived', 5)).toBe('even');
    expect(monsterLevelCon(90, 'authored', 5)).toBe('deadly');
    expect(xpConFactor(1, 'derived', 60)).toBe(1);
    expect(xpConFactor(1, 'authored', 60)).toBe(0.25);
    expect(xpConFactor(25, 'authored', 30)).toBe(0.75);
    expect(xpConFactor(40, 'authored', 30)).toBe(1);
  });

  it('has a label and a distinct glyph for every con', () => {
    const glyphs = new Set(LEVEL_CONS.map(c => LEVEL_CON_INFO[c].glyph));
    expect(glyphs.size).toBe(LEVEL_CONS.length);
    for (const c of LEVEL_CONS) expect(LEVEL_CON_INFO[c].label.length).toBeGreaterThan(0);
  });

  it('formats derived levels with a tilde', () => {
    expect(formatMonsterLevel(9, 'derived')).toBe('~L9');
    expect(formatMonsterLevel(9, 'authored')).toBe('L9');
  });
});
