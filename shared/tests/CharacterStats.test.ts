import { describe, it, expect } from 'vitest';
import {
  xpForNextLevel,
  calculateMaxHp,
  createDefaultCharacter,
  createCharacter,
  addXp,
  allocateStatPoints,
  ALL_STATS,
  ALL_CLASS_NAMES,
  CLASS_DEFINITIONS,
  BASE_HP,
  HP_PER_LEVEL,
  STAT_POINTS_PER_LEVEL,
} from '../src/systems/CharacterStats';
import type { ClassName } from '../src/systems/CharacterStats';

describe('CharacterStats', () => {
  describe('xpForNextLevel', () => {
    it('returns floor(18000 * L^1.2 * 1.06^L)', () => {
      expect(xpForNextLevel(1)).toBe(19080);
      expect(xpForNextLevel(2)).toBe(46464);
      expect(xpForNextLevel(5)).toBe(166175);
    });
  });

  describe('calculateMaxHp', () => {
    it('Lv1 CON10 Adventurer = 40 HP', () => {
      expect(calculateMaxHp(1, 10)).toBe(BASE_HP + 10); // 30 + 10 = 40
    });

    it('Lv2 CON10 Adventurer = 45 HP', () => {
      expect(calculateMaxHp(2, 10)).toBe(BASE_HP + HP_PER_LEVEL + 10); // 30 + 5 + 10 = 45
    });

    it('Lv5 CON15 Adventurer = 65 HP', () => {
      expect(calculateMaxHp(5, 15)).toBe(BASE_HP + 4 * HP_PER_LEVEL + 15); // 30 + 20 + 15 = 65
    });

    it('Knight Lv1 applies 0.6x HP multiplier', () => {
      // Knight CON=20: base = 30 + 0 + 20 = 50, * 0.6 = 30
      expect(calculateMaxHp(1, 20, 'Knight')).toBe(30);
    });

    it('Archer Lv1 applies 0.2x HP multiplier', () => {
      // Archer CON=4: base = 30 + 0 + 4 = 34, * 0.2 = 6 (floor)
      expect(calculateMaxHp(1, 4, 'Archer')).toBe(6);
    });

    it('Mage Lv1 applies 0.2x HP multiplier', () => {
      // Mage CON=4: base = 30 + 0 + 4 = 34, * 0.2 = 6
      expect(calculateMaxHp(1, 4, 'Mage')).toBe(6);
    });

    it('Priest Lv1 applies 0.5x HP multiplier', () => {
      // Priest CON=10: base = 30 + 0 + 10 = 40, * 0.5 = 20
      expect(calculateMaxHp(1, 10, 'Priest')).toBe(20);
    });

    it('Bard Lv1 applies 0.3x HP multiplier', () => {
      // Bard CON=6: base = 30 + 0 + 6 = 36, * 0.3 = 10 (floor)
      expect(calculateMaxHp(1, 6, 'Bard')).toBe(10);
    });

    it('HP multiplier scales with level', () => {
      // Knight Lv5 CON=20: base = 30 + 20 + 20 = 70, * 0.6 = 42
      expect(calculateMaxHp(5, 20, 'Knight')).toBe(42);
    });
  });

  describe('createDefaultCharacter', () => {
    it('creates a Level 1 Adventurer', () => {
      const char = createDefaultCharacter();
      expect(char.className).toBe('Adventurer');
      expect(char.level).toBe(1);
      expect(char.xp).toBe(0);
      expect(char.priorityStat).toBeNull();
    });

    it('has all stats at 10', () => {
      const char = createDefaultCharacter();
      for (const stat of ALL_STATS) {
        expect(char.stats[stat]).toBe(10);
      }
    });
  });

  describe('createCharacter', () => {
    it('creates a Knight with Knight base stats', () => {
      const char = createCharacter('Knight');
      expect(char.className).toBe('Knight');
      expect(char.level).toBe(1);
      expect(char.xp).toBe(0);
      expect(char.stats.STR).toBe(16);
      expect(char.stats.CON).toBe(20);
      expect(char.stats.INT).toBe(8);
    });

    it('creates an Archer with DEX base stats', () => {
      const char = createCharacter('Archer');
      expect(char.className).toBe('Archer');
      expect(char.stats.DEX).toBe(16);
      expect(char.stats.CON).toBe(4);
    });

    it('creates a Mage with INT base stats', () => {
      const char = createCharacter('Mage');
      expect(char.className).toBe('Mage');
      expect(char.stats.INT).toBe(20);
      expect(char.stats.CON).toBe(4);
    });

    it('creates a Priest with WIS base stats', () => {
      const char = createCharacter('Priest');
      expect(char.className).toBe('Priest');
      expect(char.stats.WIS).toBe(16);
      expect(char.stats.CON).toBe(10);
    });

    it('creates a Bard with CHA base stats', () => {
      const char = createCharacter('Bard');
      expect(char.className).toBe('Bard');
      expect(char.stats.CHA).toBe(16);
      expect(char.stats.CON).toBe(6);
    });

    it('all playable classes have correct base stats from definitions', () => {
      for (const cn of ALL_CLASS_NAMES) {
        const char = createCharacter(cn);
        const def = CLASS_DEFINITIONS[cn];
        for (const stat of ALL_STATS) {
          expect(char.stats[stat]).toBe(def.baseStats[stat]);
        }
      }
    });
  });

  describe('addXp', () => {
    it('adds XP without leveling up', () => {
      const char = createDefaultCharacter();
      const result = addXp(char, 1000);
      expect(char.xp).toBe(1000);
      expect(char.level).toBe(1);
      expect(result.leveledUp).toBe(false);
      expect(result.levelsGained).toBe(0);
    });

    it('levels up at exactly xpForNextLevel(1)', () => {
      const char = createDefaultCharacter();
      const needed = xpForNextLevel(1);
      const result = addXp(char, needed);
      expect(char.level).toBe(2);
      expect(char.xp).toBe(0);
      expect(result.leveledUp).toBe(true);
      expect(result.levelsGained).toBe(1);
    });

    it('carries over excess XP', () => {
      const char = createDefaultCharacter();
      const needed = xpForNextLevel(1);
      addXp(char, needed + 500);
      expect(char.level).toBe(2);
      expect(char.xp).toBe(500);
    });

    it('multi-level-up from large XP gain', () => {
      const char = createDefaultCharacter();
      const needed = xpForNextLevel(1) + xpForNextLevel(2);
      const result = addXp(char, needed);
      expect(char.level).toBe(3);
      expect(char.xp).toBe(0);
      expect(result.levelsGained).toBe(2);
    });

    it('does NOT allocate stat points on level up', () => {
      const char = createCharacter('Knight');
      const statsBefore = { ...char.stats };
      addXp(char, xpForNextLevel(1));
      for (const stat of ALL_STATS) {
        expect(char.stats[stat]).toBe(statsBefore[stat]);
      }
    });
  });

  describe('allocateStatPoints', () => {
    it('with priorityStat, all points go to that stat', () => {
      const char = createDefaultCharacter();
      char.priorityStat = 'STR';
      allocateStatPoints(char, 5);
      expect(char.stats.STR).toBe(15);
      // Other stats unchanged
      expect(char.stats.INT).toBe(10);
      expect(char.stats.CON).toBe(10);
    });

    it('without priorityStat, total stat points increase by amount', () => {
      const char = createDefaultCharacter();
      const totalBefore = ALL_STATS.reduce((sum, s) => sum + char.stats[s], 0);
      allocateStatPoints(char, 4);
      const totalAfter = ALL_STATS.reduce((sum, s) => sum + char.stats[s], 0);
      expect(totalAfter).toBe(totalBefore + 4);
    });
  });

  describe('CLASS_DEFINITIONS', () => {
    it('Knight has null attackStat and physical reduction', () => {
      const def = CLASS_DEFINITIONS.Knight;
      expect(def.attackStat).toBeNull();
      expect(def.physicalReductionBase).toBe(2);
      expect(def.physicalReductionPerLevel).toBe(1);
    });

    it('Archer has DEX attackStat', () => {
      expect(CLASS_DEFINITIONS.Archer.attackStat).toBe('DEX');
    });

    it('Mage has INT attackStat', () => {
      expect(CLASS_DEFINITIONS.Mage.attackStat).toBe('INT');
    });

    it('Priest has null attackStat and party magical reduction', () => {
      const def = CLASS_DEFINITIONS.Priest;
      expect(def.attackStat).toBeNull();
      expect(def.partyMagicalReductionBase).toBe(2);
      expect(def.partyMagicalReductionPerLevel).toBe(1);
    });

    it('Bard has null attackStat and stat multiplier', () => {
      const def = CLASS_DEFINITIONS.Bard;
      expect(def.attackStat).toBeNull();
      expect(def.bardStatMultiplierPerMember).toBe(0.20);
    });

    it('ALL_CLASS_NAMES excludes Adventurer', () => {
      expect(ALL_CLASS_NAMES).not.toContain('Adventurer');
      expect(ALL_CLASS_NAMES).toHaveLength(5);
    });
  });
});
