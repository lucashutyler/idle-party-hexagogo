import { describe, it, expect } from 'vitest';
import type { EncounterDefinition, ZoneDefinition } from '@idle-party-rpg/shared';
import { SEED_ZONES, SEED_ENCOUNTERS, SEED_MONSTERS } from '@idle-party-rpg/shared';

describe('Encounter Migration', () => {
  describe('Seed data format', () => {
    it('seed zones use new-format encounter tables (encounterId, not monsterId)', () => {
      for (const zone of Object.values(SEED_ZONES) as ZoneDefinition[]) {
        for (const entry of zone.encounterTable) {
          expect(entry).toHaveProperty('encounterId');
          expect(entry).toHaveProperty('weight');
          expect(entry).not.toHaveProperty('monsterId');
          expect(entry).not.toHaveProperty('minCount');
          expect(entry).not.toHaveProperty('maxCount');
        }
      }
    });

    it('seed zone encounter tables reference valid encounter definitions', () => {
      for (const zone of Object.values(SEED_ZONES) as ZoneDefinition[]) {
        for (const entry of zone.encounterTable) {
          expect(SEED_ENCOUNTERS[entry.encounterId]).toBeDefined();
        }
      }
    });

    it('seed encounters reference valid monsters', () => {
      for (const enc of Object.values(SEED_ENCOUNTERS) as EncounterDefinition[]) {
        if (enc.monsterPool) {
          for (const entry of enc.monsterPool) {
            expect(SEED_MONSTERS[entry.monsterId]).toBeDefined();
          }
        }
        if (enc.placements) {
          for (const placement of enc.placements) {
            expect(SEED_MONSTERS[placement.monsterId]).toBeDefined();
          }
        }
      }
    });

    it('all seed encounters have valid structure', () => {
      for (const enc of Object.values(SEED_ENCOUNTERS) as EncounterDefinition[]) {
        expect(enc.id).toBeTruthy();
        expect(enc.name).toBeTruthy();
        expect(['random', 'explicit']).toContain(enc.type);

        if (enc.type === 'random') {
          expect(enc.monsterPool).toBeDefined();
          expect(enc.monsterPool!.length).toBeGreaterThan(0);
          for (const entry of enc.monsterPool!) {
            expect(entry.min).toBeGreaterThanOrEqual(0);
            expect(entry.max).toBeGreaterThanOrEqual(entry.min);
          }
        }
      }
    });
  });

  describe('Old format detection', () => {
    it('detects old-format entries (has monsterId, no encounterId)', () => {
      const isOldFormat = (entry: Record<string, unknown>): boolean => {
        return 'monsterId' in entry && !('encounterId' in entry);
      };

      expect(isOldFormat({ monsterId: 'goblin', weight: 1, minCount: 1, maxCount: 2 })).toBe(true);
      expect(isOldFormat({ encounterId: 'auto_goblin', weight: 1 })).toBe(false);
      expect(isOldFormat({ monsterId: 'goblin', encounterId: 'auto_goblin', weight: 1 })).toBe(false);
    });
  });

  describe('MonsterDefinition without level', () => {
    it('seed monsters do not have a level field', () => {
      for (const monster of Object.values(SEED_MONSTERS)) {
        expect(monster).not.toHaveProperty('level');
      }
    });

    it('seed monsters have resistances and skills as optional', () => {
      for (const monster of Object.values(SEED_MONSTERS)) {
        // These should not be defined on seed monsters (they're optional)
        // but the fields should be accepted by the type
        expect(monster.resistances).toBeUndefined();
        expect(monster.skills).toBeUndefined();
      }
    });
  });
});
