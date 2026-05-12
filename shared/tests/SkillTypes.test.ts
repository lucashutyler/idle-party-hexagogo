import { describe, it, expect } from 'vitest';
import {
  SKILL_SLOTS,
  SKILL_TREES,
  canEquipSkill,
  equipSkillInSlot,
  unequipSkillFromSlot,
  createDefaultSkillLoadout,
  getSkillById,
  getSkillLearnLevel,
  getUnlockedSkillsForLevel,
} from '../src/systems/SkillTypes';

describe('SkillTypes', () => {
  describe('SKILL_SLOTS', () => {
    it('has 5 slots', () => {
      expect(SKILL_SLOTS).toHaveLength(5);
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

    it('slot 3 is passive unlocked at level 30', () => {
      expect(SKILL_SLOTS[3]).toEqual({ type: 'passive', unlocksAtLevel: 30 });
    });

    it('slot 4 is passive unlocked at level 50', () => {
      expect(SKILL_SLOTS[4]).toEqual({ type: 'passive', unlocksAtLevel: 50 });
    });
  });

  describe('getSkillLearnLevel', () => {
    it('treeOrder 0 unlocks at level 1', () => {
      expect(getSkillLearnLevel(0)).toBe(1);
    });

    it('treeOrder 1 unlocks at level 5', () => {
      expect(getSkillLearnLevel(1)).toBe(5);
    });

    it('treeOrder 10 unlocks at level 50', () => {
      expect(getSkillLearnLevel(10)).toBe(50);
    });
  });

  describe('getUnlockedSkillsForLevel', () => {
    it('Knight at level 1 has only the first skill unlocked', () => {
      const unlocked = getUnlockedSkillsForLevel('Knight', 1);
      expect(unlocked).toEqual(['knight_guard']);
    });

    it('Knight at level 5 has first two skills unlocked', () => {
      const unlocked = getUnlockedSkillsForLevel('Knight', 5);
      expect(unlocked).toEqual(['knight_guard', 'knight_bash']);
    });

    it('Knight at level 50 has all 11 skills unlocked', () => {
      const unlocked = getUnlockedSkillsForLevel('Knight', 50);
      expect(unlocked).toHaveLength(11);
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
      const loadout = { unlockedSkills: ['knight_guard'], equippedSkills: [null, null, null, null, null] };
      const result = equipSkillInSlot('knight_guard', 0, 'Knight', 1, loadout);
      expect(result).toEqual(['knight_guard', null, null, null, null]);
    });

    it('moves skill from one slot to another', () => {
      const loadout = {
        unlockedSkills: ['knight_guard'],
        equippedSkills: ['knight_guard' as string | null, null, null, null, null],
      };
      // Equip into slot 2 (passive at level 10) — should unequip from slot 0
      const result = equipSkillInSlot('knight_guard', 2, 'Knight', 10, loadout);
      expect(result).toEqual([null, null, 'knight_guard', null, null]);
    });

    it('returns null for invalid equip', () => {
      const loadout = { unlockedSkills: ['knight_guard'], equippedSkills: [null, null, null, null, null] };
      const result = equipSkillInSlot('knight_guard', 1, 'Knight', 5, loadout);
      expect(result).toBeNull(); // passive in active slot
    });
  });

  describe('unequipSkillFromSlot', () => {
    it('clears the slot', () => {
      const result = unequipSkillFromSlot(0, ['knight_guard', null, null, null, null]);
      expect(result).toEqual([null, null, null, null, null]);
    });

    it('ignores out-of-range slot', () => {
      const equipped = ['knight_guard' as string | null, null, null, null, null];
      const result = unequipSkillFromSlot(7, equipped);
      expect(result).toEqual(equipped);
    });
  });

  describe('createDefaultSkillLoadout', () => {
    it('unlocks and equips first passive for Knight', () => {
      const loadout = createDefaultSkillLoadout('Knight');
      expect(loadout.unlockedSkills).toEqual(['knight_guard']);
      expect(loadout.equippedSkills).toEqual(['knight_guard', null, null, null, null]);
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
    it('every class has 11 skills', () => {
      for (const cn of ['Knight', 'Archer', 'Priest', 'Mage', 'Bard']) {
        expect(SKILL_TREES[cn]).toHaveLength(11);
      }
    });

    it('every class has 6 passives and 5 actives', () => {
      for (const cn of ['Knight', 'Archer', 'Priest', 'Mage', 'Bard']) {
        const passives = SKILL_TREES[cn].filter(s => s.type === 'passive');
        const actives = SKILL_TREES[cn].filter(s => s.type === 'active');
        expect(passives).toHaveLength(6);
        expect(actives).toHaveLength(5);
      }
    });

    it('tree orders are sequential 0-10', () => {
      for (const cn of ['Knight', 'Archer', 'Priest', 'Mage', 'Bard']) {
        const orders = SKILL_TREES[cn].map(s => s.treeOrder).sort((a, b) => a - b);
        expect(orders).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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
