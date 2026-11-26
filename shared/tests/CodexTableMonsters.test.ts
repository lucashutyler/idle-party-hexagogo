import { describe, it, expect } from 'vitest';
import { encounterMonsterIds, tableMonsterIds, tableShares } from '../src/systems/Forecast';
import { createEncounter } from '../src/systems/EncounterTypes';
import type { EncounterDefinition } from '../src/systems/EncounterTypes';
import type { MonsterDefinition } from '../src/systems/MonsterTypes';
import type { EncounterTableEntry } from '../src/systems/ZoneTypes';
import { createRng } from '../src/systems/combat/CombatRng';

const monster = (id: string): MonsterDefinition => ({ id, name: id, hp: 10, damage: 1, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0 });

const MONSTERS: Record<string, MonsterDefinition> = {
  goblin: monster('goblin'),
  wolf: monster('wolf'),
  shaman: monster('shaman'),
  bear: monster('bear'),
  chief: monster('chief'),
};

const ENCOUNTERS: Record<string, EncounterDefinition> = {
  wolves: { id: 'wolves', name: 'Wolves', type: 'random', monsterPool: [{ monsterId: 'wolf', min: 1, max: 3 }] },
  camp: {
    id: 'camp', name: 'Camp', type: 'random',
    monsterPool: [{ monsterId: 'goblin', min: 1, max: 2 }, { monsterId: 'shaman', min: 0, max: 1 }, { monsterId: 'bear', min: 0, max: 0 }],
  },
  court: {
    id: 'court', name: 'Court', type: 'explicit',
    placements: [{ monsterId: 'chief', gridPosition: 4 }, { monsterId: 'goblin', gridPosition: 1 }, { monsterId: 'goblin', gridPosition: 7 }],
  },
  ghosts: { id: 'ghosts', name: 'Ghosts', type: 'random', monsterPool: [{ monsterId: 'ghost', min: 1, max: 2 }] },
  empty: { id: 'empty', name: 'Empty', type: 'explicit', placements: [] },
};

const sorted = (ids: string[]): string[] => [...ids].sort();

describe('encounterMonsterIds', () => {
  it('lists pool entries that can roll at least one, never max 0', () => {
    expect(sorted(encounterMonsterIds('camp', MONSTERS, ENCOUNTERS))).toEqual(['goblin', 'shaman']);
  });

  it('lists explicit placements once each', () => {
    expect(sorted(encounterMonsterIds('court', MONSTERS, ENCOUNTERS))).toEqual(['chief', 'goblin']);
  });

  it('gives the fallback monster for an unknown encounter, one with no known monster, or one with none at all', () => {
    expect(encounterMonsterIds('missing', MONSTERS, ENCOUNTERS)).toEqual(['goblin']);
    expect(encounterMonsterIds('ghosts', MONSTERS, ENCOUNTERS)).toEqual(['goblin']);
    expect(encounterMonsterIds('empty', MONSTERS, ENCOUNTERS)).toEqual(['goblin']);
  });

  it('gives nothing when no monster exists at all', () => {
    expect(encounterMonsterIds('wolves', {}, ENCOUNTERS)).toEqual([]);
  });
});

describe('tableMonsterIds', () => {
  it('drops weight-0 entries', () => {
    const table: EncounterTableEntry[] = [{ encounterId: 'wolves', weight: 3 }, { encounterId: 'court', weight: 0 }];
    expect(tableMonsterIds(table, MONSTERS, ENCOUNTERS)).toEqual(['wolf']);
  });

  it('keeps the first entry of an all-zero table', () => {
    const table: EncounterTableEntry[] = [{ encounterId: 'court', weight: 0 }, { encounterId: 'wolves', weight: 0 }];
    expect(sorted(tableMonsterIds(table, MONSTERS, ENCOUNTERS))).toEqual(['chief', 'goblin']);
  });

  it('merges duplicate entries and monsters shared between encounters', () => {
    const table: EncounterTableEntry[] = [
      { encounterId: 'camp', weight: 1 },
      { encounterId: 'camp', weight: 2 },
      { encounterId: 'court', weight: 1 },
    ];
    expect(sorted(tableMonsterIds(table, MONSTERS, ENCOUNTERS))).toEqual(['chief', 'goblin', 'shaman']);
  });

  it('gives the fallback monster for an empty table and for an unknown encounter', () => {
    expect(tableMonsterIds([], MONSTERS, ENCOUNTERS)).toEqual(['goblin']);
    expect(tableMonsterIds([{ encounterId: 'missing', weight: 1 }], MONSTERS, ENCOUNTERS)).toEqual(['goblin']);
  });

  it('follows the entries tableShares reports', () => {
    const table: EncounterTableEntry[] = [{ encounterId: 'wolves', weight: 1 }, { encounterId: 'court', weight: -2 }];
    expect(tableShares(table).map(s => s.entryId)).toEqual(['wolves']);
    expect(tableMonsterIds(table, MONSTERS, ENCOUNTERS)).toEqual(['wolf']);
  });

  it('lists every monster createEncounter puts in a fight from the table', () => {
    const table: EncounterTableEntry[] = [
      { encounterId: 'wolves', weight: 2 },
      { encounterId: 'camp', weight: 1 },
      { encounterId: 'court', weight: 1 },
      { encounterId: 'missing', weight: 1 },
      { encounterId: 'bears', weight: 0 },
    ];
    const listed = new Set(tableMonsterIds(table, MONSTERS, ENCOUNTERS));
    const rng = createRng(7);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const m of createEncounter('meadow', MONSTERS, {}, ENCOUNTERS, table, rng)) seen.add(m.id);
    }
    expect([...seen].every(id => listed.has(id))).toBe(true);
    expect(sorted([...seen])).toEqual(sorted([...listed]));
  });
});
