import { describe, it, expect } from 'vitest';
import {
  isRoomGateEmpty,
  toRoomRequirements,
  mergeRoomRequirements,
  validateRoomEntry,
} from '../src/systems/RoomRequirements';
import type { RoomEntryMemberInfo, RoomEntryLabels } from '../src/systems/RoomRequirements';

describe('RoomRequirements', () => {
  const member = (over: Partial<RoomEntryMemberInfo> = {}): RoomEntryMemberInfo => ({
    username: 'Alice',
    level: 10,
    equippedItemIds: new Set<string>(),
    completedQuestIds: new Set<string>(),
    ...over,
  });

  describe('validateRoomEntry', () => {
    it('allows entry when there is no gate at all', () => {
      expect(validateRoomEntry(undefined, [member()])).toBeNull();
    });

    it('allows entry for an empty gate object', () => {
      expect(validateRoomEntry({}, [member()])).toBeNull();
    });

    describe('item gate', () => {
      const reqs = { requiredItemId: 'lantern' };

      it('passes when every member has the item equipped', () => {
        const members = [
          member({ equippedItemIds: new Set(['lantern']) }),
          member({ username: 'Bob', equippedItemIds: new Set(['lantern', 'boots']) }),
        ];
        expect(validateRoomEntry(reqs, members)).toBeNull();
      });

      it('fails naming the item and listing every member missing it', () => {
        const members = [
          member({ username: 'Alice', equippedItemIds: new Set(['lantern']) }),
          member({ username: 'Bob' }),
          member({ username: 'Carol', equippedItemIds: new Set(['boots']) }),
        ];
        const failure = validateRoomEntry(reqs, members, { itemName: () => 'Glowing Lantern' });
        expect(failure).not.toBeNull();
        expect(failure!.kind).toBe('item');
        expect(failure!.itemId).toBe('lantern');
        expect(failure!.itemName).toBe('Glowing Lantern');
        expect(failure!.missingPlayers).toEqual(['Bob', 'Carol']);
        expect(failure!.reason).toBe('Glowing Lantern is required to enter this room.');
      });
    });

    describe('level gate', () => {
      const reqs = { minLevel: 10 };

      it('fails naming the level and every under-level member', () => {
        const members = [
          member({ username: 'Alice', level: 12 }),
          member({ username: 'Bob', level: 9 }),
          member({ username: 'Carol', level: 1 }),
        ];
        const failure = validateRoomEntry(reqs, members);
        expect(failure).not.toBeNull();
        expect(failure!.kind).toBe('level');
        expect(failure!.minLevel).toBe(10);
        expect(failure!.missingPlayers).toEqual(['Bob', 'Carol']);
        expect(failure!.reason).toBe('Level 10 is required to enter this room.');
      });

      it('passes at exactly the minimum level', () => {
        expect(validateRoomEntry(reqs, [member({ level: 10 })])).toBeNull();
        expect(validateRoomEntry(reqs, [member({ level: 9 })])).not.toBeNull();
      });
    });

    describe('quest gate', () => {
      const reqs = { requiredQuestIds: ['q_intro', 'q_bridge'] };

      it('passes when every member has completed all of them', () => {
        const members = [
          member({ completedQuestIds: new Set(['q_intro', 'q_bridge']) }),
          member({ username: 'Bob', completedQuestIds: new Set(['q_bridge', 'q_intro', 'q_extra']) }),
        ];
        expect(validateRoomEntry(reqs, members)).toBeNull();
      });

      it('fails on the first unsatisfied quest in list order', () => {
        const members = [
          member({ username: 'Alice', completedQuestIds: new Set<string>() }),
          member({ username: 'Bob', completedQuestIds: new Set(['q_intro']) }),
        ];
        const failure = validateRoomEntry(reqs, members, { questName: id => `Quest ${id}` });
        expect(failure).not.toBeNull();
        expect(failure!.kind).toBe('quest');
        expect(failure!.questId).toBe('q_intro');
        expect(failure!.questName).toBe('Quest q_intro');
        expect(failure!.missingPlayers).toEqual(['Alice']);
        expect(failure!.reason).toBe('"Quest q_intro" must be completed to enter this room.');
      });

      it('reports the later quest once the earlier one is satisfied', () => {
        const members = [member({ completedQuestIds: new Set(['q_intro']) })];
        const failure = validateRoomEntry(reqs, members);
        expect(failure!.questId).toBe('q_bridge');
      });

      it('treats an empty requiredQuestIds array as a no-op', () => {
        expect(validateRoomEntry({ requiredQuestIds: [] }, [member()])).toBeNull();
      });
    });

    it('checks item, then level, then quest when several gates are unmet', () => {
      const reqs = { minLevel: 20, requiredItemId: 'lantern', requiredQuestIds: ['q_intro'] };
      const members = [member({ username: 'Alice', level: 1 })];

      expect(validateRoomEntry(reqs, members)!.kind).toBe('item');

      const withItem = [member({ username: 'Alice', level: 1, equippedItemIds: new Set(['lantern']) })];
      expect(validateRoomEntry(reqs, withItem)!.kind).toBe('level');

      const withItemAndLevel = [
        member({ username: 'Alice', level: 20, equippedItemIds: new Set(['lantern']) }),
      ];
      expect(validateRoomEntry(reqs, withItemAndLevel)!.kind).toBe('quest');

      const allSatisfied = [
        member({
          username: 'Alice',
          level: 20,
          equippedItemIds: new Set(['lantern']),
          completedQuestIds: new Set(['q_intro']),
        }),
      ];
      expect(validateRoomEntry(reqs, allSatisfied)).toBeNull();
    });

    describe('labels', () => {
      it('falls back to the raw id when no resolvers are supplied', () => {
        const item = validateRoomEntry({ requiredItemId: 'lantern' }, [member()]);
        expect(item!.itemName).toBe('lantern');
        expect(item!.reason).toBe('lantern is required to enter this room.');

        const quest = validateRoomEntry({ requiredQuestIds: ['q_intro'] }, [member()]);
        expect(quest!.questName).toBe('q_intro');
        expect(quest!.reason).toBe('"q_intro" must be completed to enter this room.');
      });

      it('falls back to the raw id when a resolver returns undefined', () => {
        const labels: RoomEntryLabels = { itemName: () => undefined, questName: () => undefined };
        expect(validateRoomEntry({ requiredItemId: 'lantern' }, [member()], labels)!.itemName).toBe('lantern');
        expect(validateRoomEntry({ requiredQuestIds: ['q_intro'] }, [member()], labels)!.questName).toBe('q_intro');
      });

      it('resolves each id through its own resolver', () => {
        const labels: RoomEntryLabels = {
          itemName: id => (id === 'lantern' ? 'Glowing Lantern' : undefined),
          questName: id => (id === 'q_intro' ? 'A Humble Start' : undefined),
        };
        expect(validateRoomEntry({ requiredItemId: 'lantern' }, [member()], labels)!.itemName).toBe('Glowing Lantern');
        expect(validateRoomEntry({ requiredQuestIds: ['q_intro'] }, [member()], labels)!.questName).toBe('A Humble Start');
      });
    });

    it('passes every gate vacuously for an empty member list', () => {
      const reqs = { minLevel: 99, requiredItemId: 'lantern', requiredQuestIds: ['q_intro'] };
      expect(validateRoomEntry(reqs, [])).toBeNull();
    });
  });

  describe('toRoomRequirements', () => {
    it('folds a legacy requiredItemId into a gate', () => {
      expect(toRoomRequirements(undefined, 'lantern')).toEqual({ requiredItemId: 'lantern' });
    });

    it("prefers the object's own requiredItemId over the legacy one", () => {
      expect(toRoomRequirements({ requiredItemId: 'key' }, 'lantern')).toEqual({ requiredItemId: 'key' });
    });

    it('returns undefined when nothing is gated', () => {
      expect(toRoomRequirements(undefined)).toBeUndefined();
      expect(toRoomRequirements({})).toBeUndefined();
      expect(toRoomRequirements(undefined, '')).toBeUndefined();
    });

    it('treats an empty requiredQuestIds array as unset', () => {
      expect(toRoomRequirements({ requiredQuestIds: [] })).toBeUndefined();
      expect(toRoomRequirements({ requiredQuestIds: [], minLevel: 5 })).toEqual({ minLevel: 5 });
    });

    it('produces a gate from minLevel alone', () => {
      expect(toRoomRequirements({ minLevel: 5 })).toEqual({ minLevel: 5 });
    });

    it('carries every set field through', () => {
      const out = toRoomRequirements({ minLevel: 5, requiredQuestIds: ['q_intro'] }, 'lantern');
      expect(out).toEqual({ minLevel: 5, requiredItemId: 'lantern', requiredQuestIds: ['q_intro'] });
    });
  });

  describe('mergeRoomRequirements', () => {
    it('returns undefined when both sides are undefined', () => {
      expect(mergeRoomRequirements(undefined, undefined)).toBeUndefined();
    });

    it('returns the base when there is no override', () => {
      expect(mergeRoomRequirements({ minLevel: 5 }, undefined)).toEqual({ minLevel: 5 });
    });

    it('returns the override when there is no base', () => {
      expect(mergeRoomRequirements(undefined, { minLevel: 5 })).toEqual({ minLevel: 5 });
    });

    it('overrides field by field', () => {
      const merged = mergeRoomRequirements(
        { minLevel: 5, requiredItemId: 'lantern', requiredQuestIds: ['q_intro'] },
        { minLevel: 12, requiredItemId: 'key', requiredQuestIds: ['q_bridge'] },
      );
      expect(merged).toEqual({ minLevel: 12, requiredItemId: 'key', requiredQuestIds: ['q_bridge'] });
    });

    it('keeps the base requiredItemId when the override only sets minLevel', () => {
      const merged = mergeRoomRequirements({ requiredItemId: 'lantern' }, { minLevel: 12 });
      expect(merged).toEqual({ minLevel: 12, requiredItemId: 'lantern' });
    });

    it('keeps base quests when the override only sets an item', () => {
      const merged = mergeRoomRequirements({ requiredQuestIds: ['q_intro'] }, { requiredItemId: 'key' });
      expect(merged).toEqual({ requiredItemId: 'key', requiredQuestIds: ['q_intro'] });
    });

    it('omits fields neither side sets', () => {
      expect(mergeRoomRequirements({ minLevel: 5 }, {})).toEqual({ minLevel: 5 });
      expect(Object.keys(mergeRoomRequirements({ minLevel: 5 }, {})!)).toEqual(['minLevel']);
    });
  });

  describe('isRoomGateEmpty', () => {
    it('is true for undefined, an empty object, and an empty quest list', () => {
      expect(isRoomGateEmpty(undefined)).toBe(true);
      expect(isRoomGateEmpty({})).toBe(true);
      expect(isRoomGateEmpty({ requiredQuestIds: [] })).toBe(true);
    });

    it('is false when any single field is set', () => {
      expect(isRoomGateEmpty({ minLevel: 1 })).toBe(false);
      expect(isRoomGateEmpty({ requiredItemId: 'lantern' })).toBe(false);
      expect(isRoomGateEmpty({ requiredQuestIds: ['q_intro'] })).toBe(false);
    });
  });
});
