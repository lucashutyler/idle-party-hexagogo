import { describe, it, expect } from 'vitest';
import { collectGates } from '../src/systems/GateIndex';
import type { TileTypeDefinition } from '../src/hex/HexTile';
import type { WorldTileDefinition } from '../src/hex/MapSchema';

function room(id: string, extra: Partial<WorldTileDefinition> = {}): WorldTileDefinition {
  return { id, mapId: 'overworld', col: 0, row: 0, type: 'plains', zone: 'meadow', name: id, ...extra };
}

const TYPES: Record<string, TileTypeDefinition> = {
  plains: { id: 'plains', name: 'Plains', icon: '', color: '#000', traversable: true },
  crypt: { id: 'crypt', name: 'Crypt', icon: '', color: '#000', traversable: true, entryRequirements: { minLevel: 10 } },
  lava: { id: 'lava', name: 'Lava', icon: '', color: '#000', traversable: true, requiredItemId: 'boots' },
};

describe('collectGates', () => {
  it('skips ungated rooms and gives a gated tile type to every room of that type', () => {
    const gates = collectGates([room('a'), room('b', { type: 'crypt' }), room('c', { type: 'crypt' })], TYPES);
    expect(gates).toEqual([
      { kind: 'room', tileId: 'b', mapId: 'overworld', reqs: { minLevel: 10 } },
      { kind: 'room', tileId: 'c', mapId: 'overworld', reqs: { minLevel: 10 } },
    ]);
  });

  it('merges a room override with its type field by field', () => {
    const [gate] = collectGates([room('b', { type: 'crypt', entryRequirements: { requiredQuestIds: ['q1'] } })], TYPES);
    expect(gate.reqs).toEqual({ minLevel: 10, requiredQuestIds: ['q1'] });

    const [raised] = collectGates([room('b', { type: 'crypt', entryRequirements: { minLevel: 12 } })], TYPES);
    expect(raised.reqs).toEqual({ minLevel: 12 });
  });

  it('folds the legacy item gate in on rooms and types', () => {
    const gates = collectGates([room('a', { requiredItemId: 'key' }), room('b', { type: 'lava' })], TYPES);
    expect(gates.map(g => g.reqs)).toEqual([{ requiredItemId: 'key' }, { requiredItemId: 'boots' }]);
  });

  it('lists each gated exit as a door from its room, and ignores ungated or empty ones', () => {
    const gates = collectGates([room('cellar', {
      transitions: [
        { mapId: 'sewers', tileId: 's1', entryRequirements: { requiredQuestIds: ['q2'] } },
        { mapId: 'sewers', tileId: 's2' },
        { mapId: 'sewers', tileId: 's3', entryRequirements: { requiredQuestIds: [] } },
      ],
    })], TYPES);
    expect(gates).toEqual([
      { kind: 'door', tileId: 'cellar', mapId: 'overworld', linkTileId: 's1', linkMapId: 'sewers', reqs: { requiredQuestIds: ['q2'] } },
    ]);
  });

  it('gives a door the gate of the room it leads to, and lists an ungated exit into a gated room', () => {
    const gates = collectGates([
      room('cellar', {
        transitions: [
          { mapId: 'sewers', tileId: 's1', entryRequirements: { requiredQuestIds: ['q2'] } },
          { mapId: 'sewers', tileId: 's2' },
          { mapId: 'sewers', tileId: 'missing' },
        ],
      }),
      room('s1', { mapId: 'sewers', type: 'crypt' }),
      room('s2', { mapId: 'sewers', entryRequirements: { requiredQuestIds: ['q3'] } }),
    ], TYPES);
    expect(gates.filter(g => g.kind === 'door')).toEqual([
      {
        kind: 'door', tileId: 'cellar', mapId: 'overworld', linkTileId: 's1', linkMapId: 'sewers',
        reqs: { requiredQuestIds: ['q2'] }, destinationReqs: { minLevel: 10 },
      },
      { kind: 'door', tileId: 'cellar', mapId: 'overworld', linkTileId: 's2', linkMapId: 'sewers', reqs: {}, destinationReqs: { requiredQuestIds: ['q3'] } },
    ]);
  });

  it('keeps a room gate and its door gate apart', () => {
    const gates = collectGates([room('gate', {
      entryRequirements: { minLevel: 3 },
      transitions: [{ mapId: 'tower', tileId: 't1', entryRequirements: { minLevel: 8 } }],
    })], TYPES);
    expect(gates.map(g => [g.kind, g.reqs.minLevel])).toEqual([['room', 3], ['door', 8]]);
  });

  it('does not read a tile type from the object prototype', () => {
    expect(collectGates([room('odd', { type: 'constructor' })], TYPES)).toEqual([]);
  });
});
