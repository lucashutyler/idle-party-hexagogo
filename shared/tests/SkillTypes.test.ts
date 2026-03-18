import { describe, it, expect } from 'vitest';
import {
  SKILL_SLOTS,
  SKILL_TREES,
  LEVELS_PER_SKILL_POINT,
  getSkillPointsForLevel,
  getAvailableSkillPoints,
  canUnlockSkill,
  unlockSkill,
  canEquipSkill,
  equipSkillInSlot,
  unequipSkillFromSlot,
  createDefaultSkillLoadout,
  getSkillById,
} from '../src/systems/SkillTypes';

describe('SkillTypes', () => {
  describe('SKILL_SLOTS', () => {
    it('has 3 slots', () => {
      expect(SKILL_SLOTS).toHaveLength(3);
    });

    it('slot 0 is passive unlocked at level 1', () => {
      expect(SKILL_SLOTS[0]).toEqual({ type: 'passive', unlocksAtLevel: 1 });
    });

    it('slot 1 is active unlocked at level 5', () => {
      expect(SKILL_SLOTS[1]).toEqual({ type: 'active', unlocksAtLevel: 5 });
    });

    it('slot 2 is passive unlocked at level 10', () => {
      expect(SKILL_SLOTS[2]).toEqual({ type: 'passive', unlocksAtLevel: 10 });
    });
  });

  describe('getSkillPointsForLevel', () => {
    it('returns 0 for levels 1-4', () => {
      for (let l = 1; l <= 4; l++) {
        expect(getSkillPointsForLevel(l)).toBe(0);
      }
    });

    it('returns 1 for levels 5-9', () => {
      expect(getSkillPointsForLevel(5)).toBe(1);
      expect(getSkillPointsForLevel(9)).toBe(1);
    });

    it('returns 2 for levels 10-14', () => {
      expect(getSkillPointsForLevel(10)).toBe(2);
    });
  });

  describe('getAvailableSkillPoints', () => {
    it('first skill is free, so 0 points at level 1 with 1 unlocked', () => {
      expect(getAvailableSkillPoints(1, ['knight_guard'])).toBe(0);
    });

    it('level 5 with 1 skill = 1 available point', () => {
      expect(getAvailableSkillPoints(5, ['knight_guard'])).toBe(1);
    });

    it('level 5 with 2 skills = 0 available points', () => {
      expect(getAvailableSkillPoints(5, ['knight_guard', 'knight_bash'])).toBe(0);
    });
  });

  describe('canUnlockSkill', () => {
    it('allows unlocking first skill at level 1 (free)', () => {
      expect(canUnlockSkill('knight_guard', 'Knight', 1, [])).toBe(true);
    });

    it('rejects unlocking already-unlocked skill', () => {
      expect(canUnlockSkill('knight_guard', 'Knight', 1, ['knight_guard'])).toBe(false);
    });

    it('rejects unlocking second skill without points', () => {
      expect(canUnlockSkill('knight_bash', 'Knight', 1, ['knight_guard'])).toBe(false);
    });

    it('allows unlocking second skill at level 5 with points', () => {
      expect(canUnlockSkill('knight_bash', 'Knight', 5, ['knight_guard'])).toBe(true);
    });

    it('rejects skipping tree order', () => {
      expect(canUnlockSkill('knight_bash', 'Knight', 5, [])).toBe(false);
    });

    it('rejects wrong class skill', () => {
      expect(canUnlockSkill('mage_burn', 'Knight', 1, [])).toBe(false);
    });
  });

  describe('unlockSkill', () => {
    it('returns updated array on success', () => {
      const result = unlockSkill('knight_guard', 'Knight', 1, []);
      expect(result).toEqual(['knight_guard']);
    });

    it('returns null on failure', () => {
      const result = unlockSkill('knight_bash', 'Knight', 1, []);
      expect(result).toBeNull();
    });
  });

  describe('canEquipSkill', () => {
    it('allows equipping passive in passive slot', () => {
      expect(canEquipSkill('knight_guard', 0, 'Knight', 1, ['knight_guard'])).toBe(true);
    });

    it('rejects equipping passive in active slot', () => {
      expect(canEquipSkill('knight_guard', 1, 'Knight', 5, ['knight_guard'])).toBe(false);
    });

    it('rejects equipping active in passive slot', () => {
      expect(canEquipSkill('knight_bash', 0, 'Knight', 5, ['knight_guard', 'knight_bash'])).toBe(false);
    });

    it('allows equipping active in active slot at level 5+', () => {
      expect(canEquipSkill('knight_bash', 1, 'Knight', 5, ['knight_guard', 'knight_bash'])).toBe(true);
    });

    it('rejects equipping in slot not yet unlocked by level', () => {
      expect(canEquipSkill('knight_bash', 1, 'Knight', 4, ['knight_guard', 'knight_bash'])).toBe(false);
    });

    it('rejects equipping unobtained skill', () => {
      expect(canEquipSkill('knight_bash', 1, 'Knight', 5, ['knight_guard'])).toBe(false);
    });
  });

  describe('equipSkillInSlot', () => {
    it('equips skill in slot', () => {
      const loadout = { unlockedSkills: ['knight_guard'], equippedSkills: [null, null, null] };
      const result = equipSkillInSlot('knight_guard', 0, 'Knight', 1, loadout);
      expect(result).toEqual(['knight_guard', null, null]);
    });

    it('moves skill from one slot to another', () => {
      const loadout = {
        unlockedSkills: ['knight_guard'],
        equippedSkills: ['knight_guard' as string | null, null, null],
      };
      // Equip into slot 2 (passive at level 10) — should unequip from slot 0
      const result = equipSkillInSlot('knight_guard', 2, 'Knight', 10, loadout);
      expect(result).toEqual([null, null, 'knight_guard']);
    });

    it('returns null for invalid equip', () => {
      const loadout = { unlockedSkills: ['knight_guard'], equippedSkills: [null, null, null] };
      const result = equipSkillInSlot('knight_guard', 1, 'Knight', 5, loadout);
      expect(result).toBeNull(); // passive in active slot
    });
  });

  describe('unequipSkillFromSlot', () => {
    it('clears the slot', () => {
      const result = unequipSkillFromSlot(0, ['knight_guard', null, null]);
      expect(result).toEqual([null, null, null]);
    });

    it('ignores out-of-range slot', () => {
      const equipped = ['knight_guard' as string | null, null, null];
      const result = unequipSkillFromSlot(5, equipped);
      expect(result).toEqual(equipped);
    });
  });

  describe('createDefaultSkillLoadout', () => {
    it('unlocks and equips first passive for Knight', () => {
      const loadout = createDefaultSkillLoadout('Knight');
      expect(loadout.unlockedSkills).toEqual(['knight_guard']);
      expect(loadout.equippedSkills).toEqual(['knight_guard', null, null]);
    });

    it('returns empty for Adventurer (no skill tree)', () => {
      const loadout = createDefaultSkillLoadout('Adventurer');
      expect(loadout.unlockedSkills).toHaveLength(0);
      expect(loadout.equippedSkills).toEqual([null, null, null]);
    });
  });

  describe('getSkillById', () => {
    it('finds knight_guard', () => {
      const skill = getSkillById('knight_guard');
      expect(skill).toBeDefined();
      expect(skill!.name).toBe('Guard');
      expect(skill!.className).toBe('Knight');
    });

    it('returns undefined for unknown id', () => {
      expect(getSkillById('nonexistent')).toBeUndefined();
    });
  });

  describe('SKILL_TREES', () => {
    it('every class has at least 2 skills', () => {
      for (const cn of ['Knight', 'Archer', 'Priest', 'Mage', 'Bard']) {
        expect(SKILL_TREES[cn].length).toBeGreaterThanOrEqual(2);
      }
    });

    it('first skill in each tree is passive with treeOrder 0', () => {
      for (const cn of ['Knight', 'Archer', 'Priest', 'Mage', 'Bard']) {
        const first = SKILL_TREES[cn].find(s => s.treeOrder === 0);
        expect(first).toBeDefined();
        expect(first!.type).toBe('passive');
      }
    });

    it('second skill in each tree is active with treeOrder 1', () => {
      for (const cn of ['Knight', 'Archer', 'Priest', 'Mage', 'Bard']) {
        const second = SKILL_TREES[cn].find(s => s.treeOrder === 1);
        expect(second).toBeDefined();
        expect(second!.type).toBe('active');
      }
    });
  });
});
