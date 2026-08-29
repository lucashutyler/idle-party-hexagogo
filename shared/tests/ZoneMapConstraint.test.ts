import { describe, it, expect } from 'vitest';
import { zoneMapConflict, findZonesSpanningMaps } from '../src/hex/MapSchema.js';
import type { WorldTileDefinition } from '../src/hex/MapSchema.js';

function tile(mapId: string, col: number, row: number, zone: string): WorldTileDefinition {
  return { id: `${mapId}-${col}-${row}`, mapId, col, row, type: 'plains', zone, name: `${col},${row}` };
}

describe('zoneMapConflict', () => {
  it('allows a brand-new zone', () => {
    const tiles = [tile('overworld', 0, 0, 'town')];
    expect(zoneMapConflict(tiles, { mapId: 'sewers', zone: 'sewer' })).toBeNull();
  });

  it('allows a room joining a zone that already lives on its own map', () => {
    const tiles = [tile('overworld', 0, 0, 'town')];
    expect(zoneMapConflict(tiles, { mapId: 'overworld', zone: 'town' })).toBeNull();
  });

  it('refuses a room that would put a zone onto a second map', () => {
    const tiles = [tile('overworld', 0, 0, 'town')];
    const err = zoneMapConflict(tiles, { mapId: 'sewers', zone: 'town' });

    expect(err).toBeTruthy();
    expect(err).toContain('town');
    expect(err).toContain('cannot span maps');
  });

  it('names the map the zone already belongs to, so the author can act on it', () => {
    const tiles = [tile('overworld', 0, 0, 'town')];
    expect(zoneMapConflict(tiles, { mapId: 'sewers', zone: 'town' })).toContain('overworld');
  });

  it('keeps a pre-existing cross-map zone editable', () => {
    const tiles = [tile('overworld', 0, 0, 'town'), tile('sewers', 0, 0, 'town')];

    expect(zoneMapConflict(tiles, { mapId: 'overworld', zone: 'town' })).toBeNull();
    expect(zoneMapConflict(tiles, { mapId: 'sewers', zone: 'town' })).toBeNull();
  });

  it('still refuses adding a THIRD map to an already-spanning zone', () => {
    const tiles = [tile('overworld', 0, 0, 'town'), tile('sewers', 0, 0, 'town')];
    expect(zoneMapConflict(tiles, { mapId: 'crypt', zone: 'town' })).toBeTruthy();
  });

  it('allows an empty world', () => {
    expect(zoneMapConflict([], { mapId: 'overworld', zone: 'town' })).toBeNull();
  });
});

describe('findZonesSpanningMaps', () => {
  it('finds nothing when every zone sits on one map', () => {
    const tiles = [
      tile('overworld', 0, 0, 'town'),
      tile('overworld', 1, 0, 'town'),
      tile('sewers', 0, 0, 'sewer'),
    ];
    expect(findZonesSpanningMaps(tiles)).toEqual([]);
  });

  it('reports a zone that spans two maps, with both map ids', () => {
    const tiles = [tile('overworld', 0, 0, 'town'), tile('sewers', 0, 0, 'town')];
    expect(findZonesSpanningMaps(tiles)).toEqual([{ zone: 'town', mapIds: ['overworld', 'sewers'] }]);
  });

  it('orders the worst offender first', () => {
    const tiles = [
      tile('a', 0, 0, 'two'), tile('b', 0, 0, 'two'),
      tile('a', 1, 0, 'three'), tile('b', 1, 0, 'three'), tile('c', 1, 0, 'three'),
    ];
    const spanning = findZonesSpanningMaps(tiles);

    expect(spanning[0].zone).toBe('three');
    expect(spanning[0].mapIds).toHaveLength(3);
    expect(spanning[1].zone).toBe('two');
  });

  it('handles an empty world', () => {
    expect(findZonesSpanningMaps([])).toEqual([]);
  });
});
