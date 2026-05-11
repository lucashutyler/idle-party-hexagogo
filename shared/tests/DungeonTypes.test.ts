import { describe, it, expect } from 'vitest';
import { SEED_DUNGEONS, getDungeon } from '../src/systems/DungeonTypes';
import { SEED_ENCOUNTERS } from '../src/systems/EncounterTypes';

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
});
