import { describe, it, expect } from 'vitest';
import {
  xpForNextLevel,
  xpForCraftLevel,
  calculateMaxHp,
  calculateBaseDamage,
  createCharacter,
  addXp,
  addCraftXp,
  getCraftSkillName,
  CRAFT_SKILL_NAMES,
  ALL_CLASS_NAMES,
  CLASS_DEFINITIONS,
} from '../src/systems/CharacterStats';
import type { ClassName } from '../src/systems/CharacterStats';
import { SEED_SKILLS, SEED_SKILL_SLOT_SCHEDULES } from '../src/systems/SkillTypes';
import type { SkillContent } from '../src/systems/SkillTypes';

const SKILL_CONTENT: SkillContent = { skills: SEED_SKILLS, slotSchedules: SEED_SKILL_SLOT_SCHEDULES };

describe('CharacterStats', () => {
  describe('xpForNextLevel', () => {
    it('returns floor(18000 * L^1.2 * 1.06^L)', () => {
      expect(xpForNextLevel(1)).toBe(19080);
      expect(xpForNextLevel(2)).toBe(46464);
      expect(xpForNextLevel(5)).toBe(166175);
    });
  });

  describe('calculateMaxHp', () => {
    it('Knight Lv1 = 50 HP', () => {
      expect(calculateMaxHp(1, 'Knight')).toBe(50);
    });

    it('Knight Lv5 = 50 + 4*5 = 70 HP', () => {
      expect(calculateMaxHp(5, 'Knight')).toBe(70);
    });

    it('Archer Lv1 = 8 HP', () => {
      expect(calculateMaxHp(1, 'Archer')).toBe(8);
    });

    it('Priest Lv1 = 20 HP', () => {
      expect(calculateMaxHp(1, 'Priest')).toBe(20);
    });

    it('Mage Lv1 = 8 HP', () => {
      expect(calculateMaxHp(1, 'Mage')).toBe(8);
    });

    it('Bard Lv1 = 10 HP', () => {
      expect(calculateMaxHp(1, 'Bard')).toBe(10);
    });

    it('all classes follow baseHp + (level-1) * hpPerLevel', () => {
      for (const cn of ALL_CLASS_NAMES) {
        const def = CLASS_DEFINITIONS[cn];
        expect(calculateMaxHp(1, cn)).toBe(def.baseHp);
        expect(calculateMaxHp(10, cn)).toBe(def.baseHp + 9 * def.hpPerLevel);
      }
    });
  });

  describe('calculateBaseDamage', () => {
    it('Knight Lv1 = 1 damage', () => {
      expect(calculateBaseDamage(1, 'Knight')).toBe(1);
    });

    it('Archer Lv1 = 15 damage', () => {
      expect(calculateBaseDamage(1, 'Archer')).toBe(15);
    });

    it('Mage Lv1 = 15 damage', () => {
      expect(calculateBaseDamage(1, 'Mage')).toBe(15);
    });

    it('Priest Lv1 = 3 damage', () => {
      expect(calculateBaseDamage(1, 'Priest')).toBe(3);
    });

    it('Bard Lv1 = 1 damage', () => {
      expect(calculateBaseDamage(1, 'Bard')).toBe(1);
    });

    it('all classes follow baseDamage + (level-1) * damagePerLevel', () => {
      for (const cn of ALL_CLASS_NAMES) {
        const def = CLASS_DEFINITIONS[cn];
        expect(calculateBaseDamage(1, cn)).toBe(def.baseDamage);
        expect(calculateBaseDamage(10, cn)).toBe(def.baseDamage + 9 * def.damagePerLevel);
      }
    });
  });

  describe('createCharacter', () => {
    it('creates a Knight with correct class', () => {
      const char = createCharacter('Knight', SKILL_CONTENT);
      expect(char.className).toBe('Knight');
      expect(char.level).toBe(1);
      expect(char.xp).toBe(0);
    });

    it('initializes skill loadout with first passive unlocked and equipped', () => {
      const char = createCharacter('Knight', SKILL_CONTENT);
      expect(char.skillLoadout.unlockedSkills).toEqual(['knight_guard']);
      expect(char.skillLoadout.equippedSkills).toEqual(['knight_guard', null, null, null, null]);
    });

    it('all playable classes get first skill auto-unlocked', () => {
      const expectedFirstSkills: Record<string, string> = {
        Knight: 'knight_guard',
        Archer: 'archer_pierce',
        Priest: 'priest_bless',
        Mage: 'mage_burn',
        Bard: 'bard_rally',
      };
      for (const cn of ALL_CLASS_NAMES) {
        const char = createCharacter(cn, SKILL_CONTENT);
        expect(char.skillLoadout.unlockedSkills).toEqual([expectedFirstSkills[cn]]);
        expect(char.skillLoadout.equippedSkills[0]).toBe(expectedFirstSkills[cn]);
      }
    });
  });

  describe('addXp', () => {
    it('adds XP without leveling up', () => {
      const char = createCharacter('Knight', SKILL_CONTENT);
      const result = addXp(char, 1000);
      expect(char.xp).toBe(1000);
      expect(char.level).toBe(1);
      expect(result.leveledUp).toBe(false);
      expect(result.levelsGained).toBe(0);
    });

    it('levels up at exactly xpForNextLevel(1)', () => {
      const char = createCharacter('Knight', SKILL_CONTENT);
      const needed = xpForNextLevel(1);
      const result = addXp(char, needed);
      expect(char.level).toBe(2);
      expect(char.xp).toBe(0);
      expect(result.leveledUp).toBe(true);
      expect(result.levelsGained).toBe(1);
    });

    it('carries over excess XP', () => {
      const char = createCharacter('Knight', SKILL_CONTENT);
      const needed = xpForNextLevel(1);
      addXp(char, needed + 500);
      expect(char.level).toBe(2);
      expect(char.xp).toBe(500);
    });

    it('multi-level-up from large XP gain', () => {
      const char = createCharacter('Knight', SKILL_CONTENT);
      const needed = xpForNextLevel(1) + xpForNextLevel(2);
      const result = addXp(char, needed);
      expect(char.level).toBe(3);
      expect(char.xp).toBe(0);
      expect(result.levelsGained).toBe(2);
    });

  });

  describe('CLASS_DEFINITIONS', () => {
    it('Knight has physical damage type', () => {
      expect(CLASS_DEFINITIONS.Knight.damageType).toBe('physical');
    });

    it('Priest has holy damage type', () => {
      expect(CLASS_DEFINITIONS.Priest.damageType).toBe('holy');
    });

    it('Mage has magical damage type', () => {
      expect(CLASS_DEFINITIONS.Mage.damageType).toBe('magical');
    });

    it('ALL_CLASS_NAMES has 5 playable classes', () => {
      expect(ALL_CLASS_NAMES).toHaveLength(5);
      expect(ALL_CLASS_NAMES).toContain('Knight');
      expect(ALL_CLASS_NAMES).toContain('Archer');
      expect(ALL_CLASS_NAMES).toContain('Priest');
      expect(ALL_CLASS_NAMES).toContain('Mage');
      expect(ALL_CLASS_NAMES).toContain('Bard');
    });

    it('all classes have positive baseHp and baseDamage', () => {
      for (const cn of ALL_CLASS_NAMES) {
        const def = CLASS_DEFINITIONS[cn];
        expect(def.baseHp).toBeGreaterThan(0);
        expect(def.baseDamage).toBeGreaterThan(0);
      }
    });
  });

  describe('Craft skill', () => {
    it('every class has a craft skill name', () => {
      for (const cn of ALL_CLASS_NAMES) {
        expect(CRAFT_SKILL_NAMES[cn]).toBeTruthy();
        expect(getCraftSkillName(cn)).toBe(CRAFT_SKILL_NAMES[cn]);
      }
    });

    it('xpForCraftLevel grows with level', () => {
      expect(xpForCraftLevel(2)).toBeGreaterThan(xpForCraftLevel(1));
      expect(xpForCraftLevel(5)).toBeGreaterThan(xpForCraftLevel(2));
    });

    it('createCharacter starts craft skill at level 1, 0 xp', () => {
      const c = createCharacter('Mage', SKILL_CONTENT);
      expect(c.craftLevel).toBe(1);
      expect(c.craftXp).toBe(0);
    });

    it('addCraftXp accumulates without leveling when below threshold', () => {
      const c = createCharacter('Mage', SKILL_CONTENT);
      const result = addCraftXp(c, 10);
      expect(result.leveledUp).toBe(false);
      expect(c.craftLevel).toBe(1);
      expect(c.craftXp).toBe(10);
    });

    it('addCraftXp levels up when threshold crossed', () => {
      const c = createCharacter('Mage', SKILL_CONTENT);
      const need = xpForCraftLevel(1);
      const result = addCraftXp(c, need + 5);
      expect(result.leveledUp).toBe(true);
      expect(c.craftLevel).toBe(2);
      expect(c.craftXp).toBe(5);
    });

    it('addCraftXp can level multiple times in one call', () => {
      const c = createCharacter('Mage', SKILL_CONTENT);
      const need = xpForCraftLevel(1) + xpForCraftLevel(2) + xpForCraftLevel(3);
      const result = addCraftXp(c, need);
      expect(result.levelsGained).toBe(3);
      expect(c.craftLevel).toBe(4);
    });

    it('addCraftXp ignores non-positive amounts', () => {
      const c = createCharacter('Mage', SKILL_CONTENT);
      const result = addCraftXp(c, 0);
      expect(result.leveledUp).toBe(false);
      expect(c.craftLevel).toBe(1);
      expect(c.craftXp).toBe(0);
    });
  });
});
