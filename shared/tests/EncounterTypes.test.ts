import { describe, it, expect } from 'vitest';
import { resolveEncounter, createEncounter, SEED_ENCOUNTERS } from '../src/systems/EncounterTypes';
import type { EncounterDefinition } from '../src/systems/EncounterTypes';
import { SEED_MONSTERS } from '../src/systems/MonsterTypes';
import type { MonsterDefinition } from '../src/systems/MonsterTypes';
import { SEED_ZONES } from '../src/systems/ZoneTypes';

describe('EncounterTypes', () => {
  describe('resolveEncounter — random', () => {
    it('produces monsters within min/max bounds', () => {
      const encounter: EncounterDefinition = {
        id: 'test',
        name: 'Test',
        type: 'random',
        monsterPool: [{ monsterId: 'goblin', min: 2, max: 3 }],
        roomMax: 9,
      };
      for (let i = 0; i < 20; i++) {
        const result = resolveEncounter(encounter, SEED_MONSTERS);
        expect(result.length).toBeGreaterThanOrEqual(2);
        expect(result.length).toBeLessThanOrEqual(3);
        for (const m of result) {
          expect(m.id).toBe('goblin');
        }
      }
    });

    it('produces mixed monster types', () => {
      const encounter: EncounterDefinition = {
        id: 'test',
        name: 'Test',
        type: 'random',
        monsterPool: [
          { monsterId: 'goblin', min: 1, max: 1 },
          { monsterId: 'wolf', min: 1, max: 1 },
        ],
        roomMax: 9,
      };
      const result = resolveEncounter(encounter, SEED_MONSTERS);
      expect(result).toHaveLength(2);
      const ids = result.map(m => m.id).sort();
      expect(ids).toEqual(['goblin', 'wolf']);
    });

    it('respects roomMax by trimming from largest count', () => {
      const encounter: EncounterDefinition = {
        id: 'test',
        name: 'Test',
        type: 'random',
        monsterPool: [
          { monsterId: 'goblin', min: 5, max: 5 },
          { monsterId: 'wolf', min: 5, max: 5 },
        ],
        roomMax: 4,
      };
      const result = resolveEncounter(encounter, SEED_MONSTERS);
      expect(result).toHaveLength(4);
    });

    it('assigns unique grid positions', () => {
      const encounter: EncounterDefinition = {
        id: 'test',
        name: 'Test',
        type: 'random',
        monsterPool: [{ monsterId: 'goblin', min: 5, max: 5 }],
        roomMax: 9,
      };
      const result = resolveEncounter(encounter, SEED_MONSTERS);
      const positions = result.map(m => m.gridPosition);
      const uniquePositions = new Set(positions);
      expect(uniquePositions.size).toBe(positions.length);
    });

    it('skips unknown monster IDs', () => {
      const encounter: EncounterDefinition = {
        id: 'test',
        name: 'Test',
        type: 'random',
        monsterPool: [
          { monsterId: 'nonexistent', min: 1, max: 1 },
          { monsterId: 'goblin', min: 1, max: 1 },
        ],
        roomMax: 9,
      };
      const result = resolveEncounter(encounter, SEED_MONSTERS);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('goblin');
    });

    it('returns empty for empty pool', () => {
      const encounter: EncounterDefinition = {
        id: 'test',
        name: 'Test',
        type: 'random',
        monsterPool: [],
        roomMax: 9,
      };
      const result = resolveEncounter(encounter, SEED_MONSTERS);
      expect(result).toHaveLength(0);
    });

    it('handles min of 0 (monster may not appear)', () => {
      const encounter: EncounterDefinition = {
        id: 'test',
        name: 'Test',
        type: 'random',
        monsterPool: [{ monsterId: 'goblin', min: 0, max: 0 }],
        roomMax: 9,
      };
      const result = resolveEncounter(encounter, SEED_MONSTERS);
      expect(result).toHaveLength(0);
    });
  });

  describe('resolveEncounter — explicit', () => {
    it('places monsters at specified positions', () => {
      const encounter: EncounterDefinition = {
        id: 'test',
        name: 'Test',
        type: 'explicit',
        placements: [
          { monsterId: 'goblin', gridPosition: 0 },
          { monsterId: 'wolf', gridPosition: 4 },
          { monsterId: 'bandit', gridPosition: 8 },
        ],
      };
      const result = resolveEncounter(encounter, SEED_MONSTERS);
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('goblin');
      expect(result[0].gridPosition).toBe(0);
      expect(result[1].id).toBe('wolf');
      expect(result[1].gridPosition).toBe(4);
      expect(result[2].id).toBe('bandit');
      expect(result[2].gridPosition).toBe(8);
    });

    it('skips unknown monster IDs', () => {
      const encounter: EncounterDefinition = {
        id: 'test',
        name: 'Test',
        type: 'explicit',
        placements: [
          { monsterId: 'nonexistent', gridPosition: 0 },
          { monsterId: 'goblin', gridPosition: 4 },
        ],
      };
      const result = resolveEncounter(encounter, SEED_MONSTERS);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('goblin');
    });

    it('returns empty for empty placements', () => {
      const encounter: EncounterDefinition = {
        id: 'test',
        name: 'Test',
        type: 'explicit',
        placements: [],
      };
      const result = resolveEncounter(encounter, SEED_MONSTERS);
      expect(result).toHaveLength(0);
    });
  });

  describe('createEncounter', () => {
    it('uses zone encounter table', () => {
      const result = createEncounter('hatchetmill', SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS);
      expect(result.length).toBeGreaterThanOrEqual(1);
      for (const m of result) {
        expect(m.id).toBe('goblin');
      }
    });

    it('uses room override over zone', () => {
      const roomTable = [{ encounterId: 'darkwood_wolves', weight: 1 }];
      const result = createEncounter('hatchetmill', SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS, roomTable);
      expect(result.length).toBeGreaterThanOrEqual(1);
      for (const m of result) {
        expect(m.id).toBe('wolf');
      }
    });

    it('falls back to goblin for unknown zone', () => {
      const result = createEncounter('nonexistent', SEED_MONSTERS, SEED_ZONES, SEED_ENCOUNTERS);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('goblin');
    });

    it('falls back to goblin for unknown encounter ID', () => {
      const zones = {
        test: {
          id: 'test',
          displayName: 'Test',
          encounterTable: [{ encounterId: 'nonexistent', weight: 1 }],
          levelRange: [1, 1] as [number, number],
        },
      };
      const result = createEncounter('test', SEED_MONSTERS, zones, SEED_ENCOUNTERS);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('goblin');
    });
  });

  describe('SEED_ENCOUNTERS', () => {
    it('has encounters for all seed zones', () => {
      expect(SEED_ENCOUNTERS.hatchetmill_goblins).toBeDefined();
      expect(SEED_ENCOUNTERS.darkwood_goblins).toBeDefined();
      expect(SEED_ENCOUNTERS.darkwood_wolves).toBeDefined();
      expect(SEED_ENCOUNTERS.darkwood_bandits).toBeDefined();
      expect(SEED_ENCOUNTERS.crystal_caves_goblins).toBeDefined();
      expect(SEED_ENCOUNTERS.crystal_caves_wolves).toBeDefined();
    });

    it('all encounter pool entries reference valid monsters', () => {
      for (const enc of Object.values(SEED_ENCOUNTERS)) {
        if (enc.monsterPool) {
          for (const entry of enc.monsterPool) {
            expect(SEED_MONSTERS[entry.monsterId]).toBeDefined();
          }
        }
      }
    });
  });
});
