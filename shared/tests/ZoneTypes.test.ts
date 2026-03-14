import { describe, it, expect } from 'vitest';
import { SEED_ZONES, getZone } from '../src/systems/ZoneTypes';
import { SEED_MONSTERS, createEncounter } from '../src/systems/MonsterTypes';

describe('ZoneTypes', () => {
  describe('SEED_ZONES', () => {
    it('has hatchetmill, darkwood, and crystal_caves zones', () => {
      expect(SEED_ZONES.hatchetmill).toBeDefined();
      expect(SEED_ZONES.darkwood).toBeDefined();
      expect(SEED_ZONES.crystal_caves).toBeDefined();
    });

    it('every encounter table entry references a valid monster', () => {
      for (const zone of Object.values(SEED_ZONES)) {
        for (const entry of zone.encounterTable) {
          expect(SEED_MONSTERS[entry.monsterId]).toBeDefined();
        }
      }
    });

    it('encounter table entries have valid counts', () => {
      for (const zone of Object.values(SEED_ZONES)) {
        for (const entry of zone.encounterTable) {
          expect(entry.minCount).toBeGreaterThanOrEqual(1);
          expect(entry.maxCount).toBeGreaterThanOrEqual(entry.minCount);
          expect(entry.weight).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('getZone', () => {
    it('returns zone for valid ID', () => {
      const zone = getZone('hatchetmill', SEED_ZONES);
      expect(zone).toBeDefined();
      expect(zone!.displayName).toBe('Hatchetmill');
    });

    it('returns undefined for unknown ID', () => {
      expect(getZone('nonexistent', SEED_ZONES)).toBeUndefined();
    });
  });

  describe('createEncounter with zones', () => {
    it('returns monsters for hatchetmill', () => {
      const monsters = createEncounter('hatchetmill', SEED_MONSTERS, SEED_ZONES);
      expect(monsters.length).toBeGreaterThanOrEqual(1);
      expect(monsters.length).toBeLessThanOrEqual(2);
      // hatchetmill only has goblins
      for (const m of monsters) {
        expect(m.id).toBe('goblin');
      }
    });

    it('returns monsters for darkwood', () => {
      const monsters = createEncounter('darkwood', SEED_MONSTERS, SEED_ZONES);
      expect(monsters.length).toBeGreaterThanOrEqual(1);
      expect(monsters.length).toBeLessThanOrEqual(3);
      // darkwood has goblins, wolves, or bandits
      for (const m of monsters) {
        expect(['goblin', 'wolf', 'bandit']).toContain(m.id);
      }
    });

    it('falls back to 2 goblins with no zone', () => {
      const monsters = createEncounter(undefined, SEED_MONSTERS, SEED_ZONES);
      expect(monsters).toHaveLength(2);
      expect(monsters[0].id).toBe('goblin');
      expect(monsters[1].id).toBe('goblin');
    });

    it('falls back to 2 goblins for unknown zone', () => {
      const monsters = createEncounter('nonexistent', SEED_MONSTERS, SEED_ZONES);
      expect(monsters).toHaveLength(2);
      expect(monsters[0].id).toBe('goblin');
    });

    it('uses room encounter table override when provided', () => {
      const roomTable = [{ monsterId: 'wolf', weight: 1, minCount: 2, maxCount: 2 }];
      // Even though zone is hatchetmill (goblins only), room override should produce wolves
      const monsters = createEncounter('hatchetmill', SEED_MONSTERS, SEED_ZONES, roomTable);
      expect(monsters).toHaveLength(2);
      for (const m of monsters) {
        expect(m.id).toBe('wolf');
      }
    });

    it('falls back to zone table when room encounter table is empty', () => {
      const monsters = createEncounter('hatchetmill', SEED_MONSTERS, SEED_ZONES, []);
      expect(monsters.length).toBeGreaterThanOrEqual(1);
      for (const m of monsters) {
        expect(m.id).toBe('goblin');
      }
    });
  });
});
