import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldCache } from '../src/network/WorldCache';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const room = (id: string, mapId: string, type: string, col: number) => ({ id, mapId, col, row: 0, type, zone: 'z', name: id });

async function loadCache(): Promise<WorldCache> {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url !== '/api/world') return json({});
    return json({
      startTile: { col: 0, row: 0 },
      maps: [
        { id: 'isle', name: 'Gull Isle', startTile: { col: 0, row: 0 } },
        { id: 'cave', name: 'Damp Cave', startTile: { col: 0, row: 0 } },
        { id: 'sea', name: 'Open Sea', startTile: { col: 0, row: 0 } },
      ],
      tiles: [
        room('i1', 'isle', 'plains', 0),
        room('i2', 'isle', 'plains', 1),
        room('i3', 'isle', 'gate', 2),
        room('i4', 'isle', 'water', 3),
        room('i5', 'isle', 'void', 4),
        room('i6', 'isle', 'forest', 5),
        room('c1', 'cave', 'plains', 0),
        room('c2', 'cave', 'plains', 1),
        room('s1', 'sea', 'water', 0),
      ],
      tileTypes: {
        plains: { id: 'plains', name: 'Plains', icon: '', color: '#00ff00', traversable: true },
        gate: { id: 'gate', name: 'Gate', icon: '', color: '#888888', traversable: true, entryRequirements: { minLevel: 50 } },
        water: { id: 'water', name: 'Water', icon: '', color: '#0000ff', traversable: false },
      },
    });
  }));
  const cache = new WorldCache();
  await cache.loadWorld();
  return cache;
}

describe('WorldCache.roomsFoundByMap', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('counts walkable rooms per map in world order, a locked room the fog lifted from included', async () => {
    const cache = await loadCache();
    const found = cache.roomsFoundByMap(['i1', 'i3', 'i4', 'i5']);
    expect([...found.entries()]).toEqual([
      ['isle', { name: 'Gull Isle', found: 2, total: 4 }],
      ['cave', { name: 'Damp Cave', found: 0, total: 2 }],
    ]);
  });

  it('ignores ids it does not know and counts a repeated id once', async () => {
    const cache = await loadCache();
    const found = cache.roomsFoundByMap(['c1', 'c1', 'gone', 's1']);
    expect(found.get('cave')).toEqual({ name: 'Damp Cave', found: 1, total: 2 });
    expect(found.get('isle')!.found).toBe(0);
    expect(found.has('sea')).toBe(false);
  });

  it('falls back to the built-in walkability for a type with no definition', async () => {
    const cache = await loadCache();
    expect(cache.roomsFoundByMap(['i6']).get('isle')).toEqual({ name: 'Gull Isle', found: 1, total: 4 });
  });

  it('is empty before the world loads', () => {
    expect(new WorldCache().roomsFoundByMap(['i1']).size).toBe(0);
  });
});
