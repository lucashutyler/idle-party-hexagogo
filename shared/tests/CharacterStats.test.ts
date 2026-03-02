import { describe, it, expect } from 'vitest';
import {
  xpForNextLevel,
  calculateMaxHp,
  createDefaultCharacter,
  addXp,
  allocateStatPoints,
  ALL_STATS,
  XP_PER_VICTORY,
  BASE_HP,
  HP_PER_LEVEL,
  STAT_POINTS_PER_LEVEL,
} from '../src/systems/CharacterStats';
import type { CharacterState } from '../src/systems/CharacterStats';

describe('CharacterStats', () => {
  describe('xpForNextLevel', () => {
    it('returns 100 * level', () => {
      expect(xpForNextLevel(1)).toBe(100);
      expect(xpForNextLevel(2)).toBe(200);
      expect(xpForNextLevel(5)).toBe(500);
    });
  });

  describe('calculateMaxHp', () => {
    it('Lv1 CON10 = 40 HP', () => {
      expect(calculateMaxHp(1, 10)).toBe(BASE_HP + 10); // 30 + 10 = 40
    });

    it('Lv2 CON10 = 45 HP', () => {
      expect(calculateMaxHp(2, 10)).toBe(BASE_HP + HP_PER_LEVEL + 10); // 30 + 5 + 10 = 45
    });

    it('Lv5 CON15 = 65 HP', () => {
      expect(calculateMaxHp(5, 15)).toBe(BASE_HP + 4 * HP_PER_LEVEL + 15); // 30 + 20 + 15 = 65
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

  describe('addXp', () => {
    it('adds XP without leveling up', () => {
      const char = createDefaultCharacter();
      const result = addXp(char, 50);
      expect(char.xp).toBe(50);
      expect(char.level).toBe(1);
      expect(result.leveledUp).toBe(false);
      expect(result.levelsGained).toBe(0);
    });

    it('levels up at exactly 100 XP', () => {
      const char = createDefaultCharacter();
      const result = addXp(char, 100);
      expect(char.level).toBe(2);
      expect(char.xp).toBe(0);
      expect(result.leveledUp).toBe(true);
      expect(result.levelsGained).toBe(1);
    });

    it('carries over excess XP', () => {
      const char = createDefaultCharacter();
      addXp(char, 130);
      expect(char.level).toBe(2);
      expect(char.xp).toBe(30);
    });

    it('multi-level-up from large XP gain', () => {
      const char = createDefaultCharacter();
      // Lv1→2 needs 100, Lv2→3 needs 200 = 300 total
      const result = addXp(char, 300);
      expect(char.level).toBe(3);
      expect(char.xp).toBe(0);
      expect(result.levelsGained).toBe(2);
    });

    it('allocates stat points on level up', () => {
      const char = createDefaultCharacter();
      const totalStatsBefore = ALL_STATS.reduce((sum, s) => sum + char.stats[s], 0);
      addXp(char, 100); // 1 level up = 2 stat points
      const totalStatsAfter = ALL_STATS.reduce((sum, s) => sum + char.stats[s], 0);
      expect(totalStatsAfter).toBe(totalStatsBefore + STAT_POINTS_PER_LEVEL);
    });

    it('10 victories at XP_PER_VICTORY levels from 1 to 2', () => {
      const char = createDefaultCharacter();
      for (let i = 0; i < 10; i++) {
        addXp(char, XP_PER_VICTORY);
      }
      expect(char.level).toBe(2);
      expect(char.xp).toBe(0);
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
});
