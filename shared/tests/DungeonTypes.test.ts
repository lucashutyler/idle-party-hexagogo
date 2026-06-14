import { describe, it, expect } from 'vitest';
import {
  SEED_DUNGEONS,
  getDungeon,
  validateDungeonEntry,
  rollDungeonRewards,
  rewardAppliesToClass,
} from '../src/systems/DungeonTypes';
import type { DungeonDefinition, DungeonEntryMemberInfo } from '../src/systems/DungeonTypes';
import { SEED_ENCOUNTERS } from '../src/systems/EncounterTypes';
import type { ClassName } from '../src/systems/CharacterStats';

describe('DungeonTypes', () => {
  describe('SEED_DUNGEONS', () => {
    it('has the crystal_caves_trial seed dungeon', () => {
      expect(SEED_DUNGEONS.crystal_caves_trial).toBeDefined();
    });

    it('every floor references a valid encounter', () => {
      for (const dungeon of Object.values(SEED_DUNGEONS)) {
        for (const floor of dungeon.floors) {
          for (const entry of floor.encounterTable) {
            expect(SEED_ENCOUNTERS[entry.encounterId]).toBeDefined();
          }
        }
      }
    });

    it('every floor has a valid grid shape', () => {
      for (const dungeon of Object.values(SEED_DUNGEONS)) {
        for (const floor of dungeon.floors) {
          expect(floor.gridShape.cols).toBeGreaterThan(0);
          expect(floor.gridShape.rows).toBeGreaterThan(0);
        }
      }
    });

    it('floor numbers are sequential starting at 1', () => {
      for (const dungeon of Object.values(SEED_DUNGEONS)) {
        const sorted = [...dungeon.floors].sort((a, b) => a.floorNumber - b.floorNumber);
        sorted.forEach((floor, i) => {
          expect(floor.floorNumber).toBe(i + 1);
        });
      }
    });

    it('encounter table weights are positive', () => {
      for (const dungeon of Object.values(SEED_DUNGEONS)) {
        for (const floor of dungeon.floors) {
          for (const entry of floor.encounterTable) {
            expect(entry.weight).toBeGreaterThan(0);
          }
        }
      }
    });

    it('reward chances stay within [0, 1]', () => {
      for (const dungeon of Object.values(SEED_DUNGEONS)) {
        for (const floor of dungeon.floors) {
          for (const reward of floor.rewards ?? []) {
            expect(reward.chance).toBeGreaterThanOrEqual(0);
            expect(reward.chance).toBeLessThanOrEqual(1);
          }
        }
        for (const reward of dungeon.firstClearRewards ?? []) {
          expect(reward.chance).toBeGreaterThanOrEqual(0);
          expect(reward.chance).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('getDungeon', () => {
    it('returns dungeon for valid ID', () => {
      const dungeon = getDungeon('crystal_caves_trial', SEED_DUNGEONS);
      expect(dungeon).toBeDefined();
      expect(dungeon!.name).toBe('Crystal Caves Trial');
    });

    it('returns undefined for unknown ID', () => {
      expect(getDungeon('nonexistent', SEED_DUNGEONS)).toBeUndefined();
    });
  });

  describe('validateDungeonEntry', () => {
    const member = (over: Partial<DungeonEntryMemberInfo> = {}): DungeonEntryMemberInfo => ({
      username: 'Alice',
      level: 10,
      className: 'knight' as ClassName,
      hasRequiredItem: true,
      ...over,
    });

    const dungeon = (over: Partial<DungeonDefinition> = {}): DungeonDefinition => ({
      id: 'd',
      name: 'Test Dungeon',
      floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'e', weight: 1 }] }],
      ...over,
    });

    it('allows entry when no requirements are set', () => {
      expect(validateDungeonEntry(dungeon(), [member()])).toBeNull();
    });

    it('rejects a dungeon with no floors', () => {
      expect(validateDungeonEntry(dungeon({ floors: [] }), [member()])).toMatch(/not ready/i);
    });

    it('rejects an empty party', () => {
      expect(validateDungeonEntry(dungeon(), [])).toMatch(/party/i);
    });

    it('enforces minimum party size', () => {
      const d = dungeon({ entryRequirements: { minPartySize: 2 } });
      expect(validateDungeonEntry(d, [member()])).toMatch(/at least 2/i);
      expect(validateDungeonEntry(d, [member(), member({ username: 'Bob' })])).toBeNull();
    });

    it('enforces maximum party size', () => {
      const d = dungeon({ entryRequirements: { maxPartySize: 1 } });
      expect(validateDungeonEntry(d, [member(), member({ username: 'Bob' })])).toMatch(/at most 1/i);
    });

    it('enforces min and max level, naming the offending member', () => {
      const lo = dungeon({ entryRequirements: { minLevel: 5 } });
      expect(validateDungeonEntry(lo, [member({ username: 'Lowbie', level: 3 })])).toMatch(/Lowbie.*level 5/i);
      const hi = dungeon({ entryRequirements: { maxLevel: 8 } });
      expect(validateDungeonEntry(hi, [member({ username: 'Maxed', level: 12 })])).toMatch(/Maxed.*cap/i);
    });

    it('enforces class restrictions', () => {
      const d = dungeon({ entryRequirements: { requiredClasses: ['mage' as ClassName] } });
      expect(validateDungeonEntry(d, [member({ className: 'knight' as ClassName })])).toMatch(/class cannot enter/i);
      expect(validateDungeonEntry(d, [member({ className: 'mage' as ClassName })])).toBeNull();
    });

    it('enforces a required item and uses its display name', () => {
      const d = dungeon({ entryRequirements: { requiredItemId: 'sigil' } });
      const msg = validateDungeonEntry(d, [member({ username: 'Carol', hasRequiredItem: false })], 'Cave Sigil');
      expect(msg).toMatch(/Carol needs Cave Sigil/i);
      expect(validateDungeonEntry(d, [member({ hasRequiredItem: true })], 'Cave Sigil')).toBeNull();
    });
  });

  describe('rollDungeonRewards', () => {
    it('returns nothing for an empty or missing table', () => {
      expect(rollDungeonRewards(undefined)).toEqual([]);
      expect(rollDungeonRewards([])).toEqual([]);
    });

    it('drops a reward when the roll is under the chance', () => {
      const out = rollDungeonRewards([{ itemId: 'gem', chance: 0.5 }], () => 0);
      expect(out).toEqual([{ itemId: 'gem', quantity: 1 }]);
    });

    it('skips a reward when the roll is at/above the chance', () => {
      const out = rollDungeonRewards([{ itemId: 'gem', chance: 0.5 }], () => 0.9);
      expect(out).toEqual([]);
    });

    it('rolls quantity within [minQty, maxQty]', () => {
      // rng() returns 0 → chance passes, qty = min + floor(0 * range) = min
      const min = rollDungeonRewards([{ itemId: 'gem', chance: 1, minQty: 2, maxQty: 5 }], () => 0);
      expect(min).toEqual([{ itemId: 'gem', quantity: 2 }]);
      // rng() returns 0.999 → qty = min + floor(0.999 * 4) = 2 + 3 = 5
      const max = rollDungeonRewards([{ itemId: 'gem', chance: 1, minQty: 2, maxQty: 5 }], () => 0.999);
      expect(max).toEqual([{ itemId: 'gem', quantity: 5 }]);
    });
  });

  describe('rewardAppliesToClass', () => {
    const knightOnly = { itemId: 'blade', chance: 1, classRestriction: ['Knight'] as ClassName[] };
    const anyClass = { itemId: 'gem', chance: 1 };

    it('unrestricted rewards apply to any class (and to characterless)', () => {
      expect(rewardAppliesToClass(anyClass, 'Mage' as ClassName)).toBe(true);
      expect(rewardAppliesToClass({ itemId: 'x', chance: 1, classRestriction: [] }, 'Mage' as ClassName)).toBe(true);
      expect(rewardAppliesToClass(anyClass, null)).toBe(true);
    });

    it('restricted rewards apply only to listed classes', () => {
      expect(rewardAppliesToClass(knightOnly, 'Knight' as ClassName)).toBe(true);
      expect(rewardAppliesToClass(knightOnly, 'Bard' as ClassName)).toBe(false);
      expect(rewardAppliesToClass(knightOnly, null)).toBe(false);
    });

    it('filters a reward table down to a class before rolling', () => {
      const table = [knightOnly, { itemId: 'lute', chance: 1, classRestriction: ['Bard'] as ClassName[] }, anyClass];
      const forKnight = table.filter(r => rewardAppliesToClass(r, 'Knight' as ClassName));
      expect(rollDungeonRewards(forKnight, () => 0).map(d => d.itemId)).toEqual(['blade', 'gem']);
    });
  });
});
