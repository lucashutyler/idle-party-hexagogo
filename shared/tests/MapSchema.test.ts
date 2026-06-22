import { describe, it, expect } from 'vitest';
import { migrateWorldData, DEFAULT_MAP_ID, type WorldData } from '../src/hex/MapSchema';

/** A legacy world as loaded from an old data/world.json: no mapId/maps/defaultMapId. */
function legacyWorld(): WorldData {
  return {
    startTile: { col: 2, row: 2 },
    tiles: [
      { id: 't1', col: 2, row: 2, type: 'plains', zone: 'town', name: 'Square' },
      { id: 't2', col: 3, row: 2, type: 'plains', zone: 'town', name: 'Road' },
    ],
  } as unknown as WorldData;
}

describe('migrateWorldData', () => {
  it('normalizes a legacy single-map world', () => {
    const world = legacyWorld();
    const changed = migrateWorldData(world);

    expect(changed).toBe(true);
    expect(world.defaultMapId).toBe(DEFAULT_MAP_ID);
    expect(world.tiles.every(t => t.mapId === DEFAULT_MAP_ID)).toBe(true);
    expect(world.maps).toEqual([
      { id: DEFAULT_MAP_ID, name: 'Overworld', startTile: { col: 2, row: 2 } },
    ]);
  });

  it('is a no-op on an already-migrated world', () => {
    const world = legacyWorld();
    migrateWorldData(world);
    const snapshot = JSON.parse(JSON.stringify(world));

    const changed = migrateWorldData(world);

    expect(changed).toBe(false);
    expect(world).toEqual(snapshot);
  });

  it('appends a maps entry for a mapId present on tiles but missing from the registry', () => {
    const world = {
      startTile: { col: 0, row: 0 },
      defaultMapId: DEFAULT_MAP_ID,
      maps: [{ id: DEFAULT_MAP_ID, name: 'Overworld', startTile: { col: 0, row: 0 } }],
      tiles: [
        { id: 'a', mapId: DEFAULT_MAP_ID, col: 0, row: 0, type: 'plains', zone: 'z', name: 'A' },
        { id: 'b', mapId: 'crystal_caves', col: 5, row: 7, type: 'plains', zone: 'z2', name: 'B' },
      ],
    } as WorldData;

    const changed = migrateWorldData(world);

    expect(changed).toBe(true);
    const caves = world.maps.find(m => m.id === 'crystal_caves');
    // startTile seeded from the map's first tile; name title-cased from the id.
    expect(caves).toEqual({ id: 'crystal_caves', name: 'Crystal Caves', startTile: { col: 5, row: 7 } });
  });

  it('is idempotent across repeated runs', () => {
    const world = legacyWorld();
    expect(migrateWorldData(world)).toBe(true);
    expect(migrateWorldData(world)).toBe(false);
    expect(migrateWorldData(world)).toBe(false);
  });
});
