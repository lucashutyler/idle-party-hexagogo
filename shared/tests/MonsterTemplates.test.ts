import { describe, it, expect } from 'vitest';
import {
  XP_INCOME_MODEL,
  suggestMonsterStats,
  referencePartyDps,
  levelForTemplateDps,
  templateDps,
  trashTemplateDps,
  REFERENCE_PARTY,
  REFERENCE_PARTY_SIZE,
  BOSS_TARGET_SECONDS,
  RAID_TARGET_SECONDS,
  ELITE_HP_MULTIPLIER,
} from '../src/systems/MonsterTemplates';

describe('XP_INCOME_MODEL', () => {
  it('matches the admin XP table anchors', () => {
    expect(XP_INCOME_MODEL(1)).toBe(57_600);
    expect(XP_INCOME_MODEL(10)).toBe(557_000);
    expect(XP_INCOME_MODEL(20)).toBeCloseTo(1_114_000);
    expect(XP_INCOME_MODEL(5)).toBeCloseTo(57_600 + (4 / 9) * (557_000 - 57_600));
  });

  it('never drops below the level-1 income', () => {
    expect(XP_INCOME_MODEL(0)).toBe(57_600);
  });
});

describe('suggestMonsterStats', () => {
  it('gives the calibrated level-1 trash template', () => {
    expect(suggestMonsterStats(1)).toEqual({ hp: 41, damage: 1, attackInterval: 1.5, xp: 4, goldMin: 1, goldMax: 2 });
  });

  it('grows HP, damage and XP with level for every tier', () => {
    for (const tier of ['trash', 'elite', 'boss', 'raid'] as const) {
      const lo = suggestMonsterStats(10, tier);
      const hi = suggestMonsterStats(40, tier);
      expect(hi.hp).toBeGreaterThan(lo.hp);
      expect(hi.damage).toBeGreaterThan(lo.damage);
      expect(hi.xp).toBeGreaterThan(lo.xp);
    }
  });

  it('orders tiers by HP and XP', () => {
    for (const level of [1, 25, 80]) {
      const [t, e, b, r] = (['trash', 'elite', 'boss', 'raid'] as const).map(tier => suggestMonsterStats(level, tier));
      expect(e.hp).toBeGreaterThanOrEqual((t.hp - 1) * ELITE_HP_MULTIPLIER);
      expect(b.hp).toBeGreaterThan(e.hp);
      expect(r.hp).toBeGreaterThan(b.hp);
      expect(b.xp).toBeGreaterThan(e.xp);
      expect(r.xp).toBeGreaterThan(b.xp);
    }
  });

  it('sizes boss and raid HP from the reference party', () => {
    expect(REFERENCE_PARTY.classes).toHaveLength(REFERENCE_PARTY_SIZE);
    expect(suggestMonsterStats(25, 'boss').hp).toBe(Math.round(referencePartyDps(25) * BOSS_TARGET_SECONDS));
    expect(suggestMonsterStats(25, 'raid').hp).toBe(Math.round(referencePartyDps(25) * RAID_TARGET_SECONDS));
  });

  it('keeps XP per hour exponential so outlevelled content pays less per kill', () => {
    const ratio = suggestMonsterStats(20).xp / suggestMonsterStats(30).xp;
    expect(ratio).toBeLessThan(0.6);
  });

  it('applies role modifiers', () => {
    const base = suggestMonsterStats(20);
    const bruiser = suggestMonsterStats(20, 'trash', 'bruiser');
    const skirmisher = suggestMonsterStats(20, 'trash', 'skirmisher');
    expect(bruiser.hp).toBeGreaterThan(base.hp);
    expect(bruiser.attackInterval).toBeGreaterThan(base.attackInterval);
    expect(skirmisher.attackInterval).toBeLessThan(base.attackInterval);
    expect(bruiser.xp).toBe(base.xp);
  });

  it('clamps nonsense levels', () => {
    expect(suggestMonsterStats(NaN)).toEqual(suggestMonsterStats(1));
    expect(suggestMonsterStats(-5)).toEqual(suggestMonsterStats(1));
    expect(suggestMonsterStats(999)).toEqual(suggestMonsterStats(200));
  });
});

describe('referencePartyDps', () => {
  it('interpolates between measured points and extrapolates past the table', () => {
    expect(referencePartyDps(1)).toBe(148);
    expect(referencePartyDps(7.5)).toBeCloseTo((220 + 310) / 2);
    expect(referencePartyDps(120)).toBeGreaterThan(referencePartyDps(100));
  });
});

describe('levelForTemplateDps', () => {
  it('inverts each tier curve', () => {
    for (const tier of ['trash', 'elite', 'boss', 'raid'] as const) {
      for (const level of [1, 17, 55, 140]) {
        expect(levelForTemplateDps(templateDps(level, tier), tier)).toBeCloseTo(level, 3);
      }
    }
  });

  it('clamps to [1, 200]', () => {
    expect(levelForTemplateDps(0)).toBe(1);
    expect(levelForTemplateDps(trashTemplateDps(1) / 2)).toBe(1);
    expect(levelForTemplateDps(1e9)).toBe(200);
  });
});
