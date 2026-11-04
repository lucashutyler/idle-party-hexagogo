import { describe, expect, it } from 'vitest';
import {
  FOG_ALPHA,
  bakeScale,
  computeFogLevels,
  coverFit,
  fogAlpha,
  hexVariant,
  isLandmarkType,
  lodForZoom,
  outsideFollowFrame,
  pickZoneLabels,
  terrainMaterial,
  zoneLabelAnchors,
} from '../src/ui/mapTerrain';
import type { FogRoom } from '../src/ui/mapTerrain';

describe('terrainMaterial', () => {
  it.each([
    [0x4a90d9, false, 'water'],
    [0x2f5d73, false, 'water'],
    [0x3d8c40, true, 'foliage'],
    [0x7ec850, true, 'foliage'],
    [0x2d5a27, false, 'foliage'],
    [0x8b7355, false, 'rock'],
    [0x4a5568, false, 'rock'],
    [0xf5deb3, true, 'sand'],
    [0xc2b280, true, 'sand'],
    [0xd44000, true, 'ember'],
    [0x8a5a3c, true, 'plain'],
    [0x6b4c6b, true, 'plain'],
  ] as const)('reads %s (walkable %s) as %s', (color, traversable, material) => {
    expect(terrainMaterial(color, traversable)).toBe(material);
  });

  it('never treats a walkable blue room as water', () => {
    expect(terrainMaterial(0x4a90d9, true)).not.toBe('water');
  });
});

describe('hexVariant', () => {
  it('stays stable per room and uses all three variants', () => {
    const seen = new Set<number>();
    for (let col = -10; col < 10; col++) {
      for (let row = -10; row < 10; row++) {
        const variant = hexVariant(col, row);
        expect(variant).toBe(hexVariant(col, row));
        seen.add(variant);
      }
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });
});

describe('isLandmarkType', () => {
  it('keeps icons for rare types and drops them when they would repeat', () => {
    expect(isLandmarkType(4, 100)).toBe(true);
    expect(isLandmarkType(5, 100)).toBe(false);
    expect(isLandmarkType(10, 800)).toBe(true);
    expect(isLandmarkType(40, 800)).toBe(false);
  });
});

describe('computeFogLevels', () => {
  const room = (overrides: Partial<FogRoom>, neighbors: number[]): FogRoom => ({
    traversable: true,
    explored: false,
    zone: 'a',
    neighbors,
    ...overrides,
  });
  const known = (zone: string) => zone === 'a' || zone === 'b';

  it('grades walkable rooms by exploration and zone', () => {
    const levels = computeFogLevels([
      room({ explored: true, zone: 'a' }, []),
      room({ explored: true, zone: 'b' }, []),
      room({ explored: false, zone: 'a' }, []),
      room({ explored: false, zone: 'z' }, []),
    ], 'a', known);
    expect([...levels]).toEqual([0, 1, 2, 3]);
  });

  it('gives a blocked room its most revealed walkable neighbour', () => {
    const levels = computeFogLevels([
      room({ traversable: false }, [1, 2]),
      room({ explored: true, zone: 'a' }, [0]),
      room({ explored: false, zone: 'z' }, [0]),
    ], 'a', known);
    expect(levels[0]).toBe(0);
  });

  it('fades blocked rooms out one level per ring past the shore', () => {
    const levels = computeFogLevels([
      room({ explored: true, zone: 'a' }, [1]),
      room({ traversable: false }, [0, 2]),
      room({ traversable: false }, [1, 3]),
      room({ traversable: false }, [2, 4]),
      room({ traversable: false }, [3, 5]),
      room({ traversable: false }, [4]),
    ], 'a', known);
    expect([...levels]).toEqual([0, 0, 1, 2, 3, 3]);
  });

  it('leaves blocked rooms with nothing explored nearby in full fog', () => {
    const levels = computeFogLevels([room({ traversable: false }, [])], 'a', known);
    expect(levels[0]).toBe(3);
  });

  it('maps levels to ink opacity', () => {
    expect(FOG_ALPHA).toEqual([0, 0.28, 0.62, 0.86]);
    expect(fogAlpha(0)).toBe(0);
    expect(fogAlpha(9)).toBe(0.86);
  });
});

describe('bakeScale', () => {
  it('sharpens small maps on dense screens, within the comfortable area', () => {
    expect(bakeScale(1000, 1000, 4096, 2)).toBe(2);
    expect(bakeScale(1000, 1000, 4096, 1)).toBe(1);
    expect(bakeScale(2496, 2417, 8192, 2)).toBe(1);
  });

  it('caps by the device texture size and the area budget', () => {
    expect(bakeScale(8192, 2000, 4096, 1)).toBeCloseTo(0.5);
    expect(bakeScale(16000, 16000, 16384, 1)).toBeCloseTo(0.25);
    expect(bakeScale(6000, 6000, 8192, 1)).toBeCloseTo(4000 / 6000);
  });

  it('assumes the usual cap when the device reports nothing', () => {
    expect(bakeScale(16384, 100, 0, 1)).toBeCloseTo(0.5);
  });
});

describe('coverFit', () => {
  it('crops a wide image to the middle without stretching', () => {
    expect(coverFit(400, 200, 100, 100)).toEqual({ sx: 100, sy: 0, sw: 200, sh: 200 });
  });

  it('crops a tall image to the middle without stretching', () => {
    expect(coverFit(200, 400, 100, 100)).toEqual({ sx: 0, sy: 100, sw: 200, sh: 200 });
  });
});

describe('lodForZoom', () => {
  it('switches at the thresholds', () => {
    expect(lodForZoom(0.4)).toBe('far');
    expect(lodForZoom(0.55)).toBe('mid');
    expect(lodForZoom(1.2)).toBe('mid');
    expect(lodForZoom(1.5)).toBe('near');
  });
});

describe('outsideFollowFrame', () => {
  it('tolerates the inner 60% of the view', () => {
    expect(outsideFollowFrame(500, 400, 1000, 800)).toBe(false);
    expect(outsideFollowFrame(201, 161, 1000, 800)).toBe(false);
    expect(outsideFollowFrame(199, 400, 1000, 800)).toBe(true);
    expect(outsideFollowFrame(500, 641, 1000, 800)).toBe(true);
  });
});

describe('zone labels', () => {
  const rooms = [
    { zone: 'a', zoneName: 'Alpha', x: 0, y: 0 },
    { zone: 'a', zoneName: 'Alpha', x: 60, y: 0 },
    { zone: 'a', zoneName: 'Alpha', x: 120, y: 0 },
    { zone: 'b', zoneName: 'Beta', x: 1000, y: 1000 },
  ];

  it('anchors each zone at the explored room nearest its centroid', () => {
    const anchors = zoneLabelAnchors(rooms);
    expect(anchors).toEqual([
      { zone: 'a', name: 'Alpha', x: 60, y: 0, rooms: 3 },
      { zone: 'b', name: 'Beta', x: 1000, y: 1000, rooms: 1 },
    ]);
  });

  it('steps off a room something else is drawn on, unless there is no other', () => {
    const busyMiddle = rooms.map(r => (r.x === 60 ? { ...r, busy: true } : r));
    expect(zoneLabelAnchors(busyMiddle)[0].x).toBe(0);
    expect(zoneLabelAnchors([{ ...rooms[3], busy: true }])[0].x).toBe(1000);
  });

  it('hides whichever overlapping label matters least, as the zoom allows', () => {
    const anchors = [
      { zone: 'big', name: 'Big Zone', x: 0, y: 0, rooms: 30 },
      { zone: 'small', name: 'Small Zone', x: 120, y: 0, rooms: 5 },
      { zone: 'here', name: 'Here Zone', x: 240, y: 0, rooms: 1 },
    ];
    expect(pickZoneLabels(anchors, 2, 'here').map(a => a.zone)).toEqual(['here', 'big', 'small']);
    expect(pickZoneLabels(anchors, 0.4, 'here').map(a => a.zone)).toEqual(['here', 'big']);
  });
});
