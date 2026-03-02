import { describe, it, expect } from 'vitest';
import { ZONES, getZone } from '../src/systems/ZoneTypes';
import { MONSTERS, createEncounter } from '../src/systems/MonsterTypes';

describe('ZoneTypes', () => {
  describe('ZONES', () => {
    it('has friendly_forest and darkwood zones', () => {
      expect(ZONES.friendly_forest).toBeDefined();
      expect(ZONES.darkwood).toBeDefined();
    });

    it('every encounter table entry references a valid monster', () => {
      for (const zone of Object.values(ZONES)) {
        for (const entry of zone.encounterTable) {
          expect(MONSTERS[entry.monsterId]).toBeDefined();
        }
      }
    });

    it('encounter table entries have valid counts', () => {
      for (const zone of Object.values(ZONES)) {
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
      const zone = getZone('friendly_forest');
      expect(zone).toBeDefined();
      expect(zone!.displayName).toBe('Friendly Forest');
    });

    it('returns undefined for unknown ID', () => {
      expect(getZone('nonexistent')).toBeUndefined();
    });
  });

  describe('createEncounter with zones', () => {
    it('returns monsters for friendly_forest', () => {
      const monsters = createEncounter('friendly_forest');
      expect(monsters.length).toBeGreaterThanOrEqual(1);
      expect(monsters.length).toBeLessThanOrEqual(2);
      // friendly_forest only has goblins
      for (const m of monsters) {
        expect(m.id).toBe('goblin');
      }
    });

    it('returns monsters for darkwood', () => {
      const monsters = createEncounter('darkwood');
      expect(monsters.length).toBeGreaterThanOrEqual(1);
      expect(monsters.length).toBeLessThanOrEqual(3);
      // darkwood has goblins, wolves, or bandits
      for (const m of monsters) {
        expect(['goblin', 'wolf', 'bandit']).toContain(m.id);
      }
    });

    it('falls back to 2 goblins with no zone', () => {
      const monsters = createEncounter();
      expect(monsters).toHaveLength(2);
      expect(monsters[0].id).toBe('goblin');
      expect(monsters[1].id).toBe('goblin');
    });

    it('falls back to 2 goblins for unknown zone', () => {
      const monsters = createEncounter('nonexistent');
      expect(monsters).toHaveLength(2);
      expect(monsters[0].id).toBe('goblin');
    });
  });
});
