import { describe, it, expect } from 'vitest';
import { MAX_ROUTE_DOORS, buildRouteIndex, planRouteDoors } from '../src/hex/WorldRoute';
import type { RouteDoor, RouteRoom } from '../src/hex/WorldRoute';
import { HexTile, TileType, isTileTraversable } from '../src/hex/HexTile';
import type { TileTypeDefinition } from '../src/hex/HexTile';
import { createCube } from '../src/hex/HexUtils';
import type { MapTransitionLink } from '../src/hex/MapSchema';

type Link = [mapId: string, tileId: string];

function r(id: string, mapId: string, col: number, opts: { row?: number; wall?: boolean; links?: Link[] } = {}): RouteRoom {
  const transitions: MapTransitionLink[] | undefined = opts.links?.map(([m, t]) => ({ mapId: m, tileId: t }));
  return { id, mapId, col, row: opts.row ?? 0, traversable: !opts.wall, ...(transitions ? { transitions } : {}) };
}

const ALL = () => true;
const path = (doors: RouteDoor[] | null) => doors?.map(d => `${d.fromTileId}>${d.toTileId}`) ?? null;

describe('buildRouteIndex', () => {
  it('splits areas at walls and at gaps, one area id per walk, unique across maps', () => {
    const index = buildRouteIndex([
      r('a0', 'a', 0), r('a1', 'a', 1), r('a2', 'a', 2, { wall: true }), r('a3', 'a', 3), r('a4', 'a', 4), r('a7', 'a', 7),
      r('b0', 'b', 0),
    ]);
    expect(index.areaOf('a0')).toBe(index.areaOf('a1'));
    expect(index.areaOf('a3')).toBe(index.areaOf('a4'));
    expect(index.areaOf('a1')).not.toBe(index.areaOf('a3'));
    expect(index.areaOf('a4')).not.toBe(index.areaOf('a7'));
    expect(index.areaOf('b0')).not.toBe(index.areaOf('a0'));
    expect(index.areaOf('a2')).toBeUndefined();
    expect(index.room('a2')?.traversable).toBe(false);
    expect(index.mapOf('b0')).toBe('b');
    expect(index.areaOf('nowhere')).toBeUndefined();
  });

  it('keeps a room\'s doors in authored order, leaving out links to missing or unwalkable rooms', () => {
    const index = buildRouteIndex([
      r('a0', 'a', 0, { links: [['b', 'b1'], ['b', 'gone'], ['b', 'bWall'], ['a', 'b0'], ['b', 'b0'], ['b', 'b1']] }),
      r('b0', 'b', 0), r('b1', 'b', 1), r('bWall', 'b', 3, { wall: true }),
    ]);
    expect(index.doorsFrom('a0').map(d => d.toTileId)).toEqual(['b1', 'b0']);
    expect(index.doorsFrom('b0')).toEqual([]);
  });

  it('lists a link inside one area among the room\'s doors, but never as a way out of it', () => {
    const index = buildRouteIndex([r('a0', 'a', 0, { links: [['a', 'a1']] }), r('a1', 'a', 1)]);
    expect(index.doorsFrom('a0').map(d => d.toTileId)).toEqual(['a1']);
    expect(index.doorsOfArea(index.areaOf('a0')!)).toEqual([]);
  });

  it('gives an unwalkable room no doors', () => {
    const index = buildRouteIndex([r('a0', 'a', 0, { wall: true, links: [['b', 'b0']] }), r('b0', 'b', 0)]);
    expect(index.doorsFrom('a0')).toEqual([]);
  });
});

describe('planRouteDoors', () => {
  const world = buildRouteIndex([
    r('a0', 'a', 0), r('a1', 'a', 1, { links: [['a', 'a3']] }), r('a2', 'a', 2, { wall: true }),
    r('a3', 'a', 3), r('a4', 'a', 4, { links: [['b', 'b0']] }),
    r('b0', 'b', 0), r('b1', 'b', 1),
    r('c0', 'c', 0),
  ]);

  it('is empty within one area and null with no way at all', () => {
    expect(planRouteDoors(world, 'a0', 'a1', ALL)).toEqual([]);
    expect(planRouteDoors(world, 'a0', 'c0', ALL)).toBeNull();
    expect(planRouteDoors(world, 'a0', 'a2', ALL)).toBeNull();
    expect(planRouteDoors(world, 'gone', 'a1', ALL)).toBeNull();
  });

  it('takes a door on the same map, then one to another map', () => {
    expect(path(planRouteDoors(world, 'a0', 'a4', ALL))).toEqual(['a1>a3']);
    expect(path(planRouteDoors(world, 'a0', 'b1', ALL))).toEqual(['a1>a3', 'a4>b0']);
    const doors = planRouteDoors(world, 'a0', 'b1', ALL)!;
    expect(doors.map(d => [d.fromMapId, d.toMapId])).toEqual([['a', 'a'], ['a', 'b']]);
  });

  it('steps through two doors from a room that holds the next exit as well as the way in', () => {
    const index = buildRouteIndex([
      r('a0', 'a', 0, { links: [['b', 'b0']] }),
      r('b0', 'b', 0, { links: [['c', 'c0']] }),
      r('c0', 'c', 0), r('c1', 'c', 1),
    ]);
    expect(path(planRouteDoors(index, 'a0', 'c1', ALL))).toEqual(['a0>b0', 'b0>c0']);
  });

  it('never follows a one-way link backwards', () => {
    expect(planRouteDoors(world, 'b1', 'a0', ALL)).toBeNull();
    expect(planRouteDoors(world, 'a4', 'a0', ALL)).toBeNull();
  });

  it('skips the doors canUse refuses', () => {
    expect(planRouteDoors(world, 'a0', 'a4', d => d.fromTileId !== 'a1')).toBeNull();
    const two = buildRouteIndex([
      r('a0', 'a', 0, { links: [['b', 'b0'], ['b', 'b1']] }),
      r('b0', 'b', 0), r('b1', 'b', 1),
    ]);
    expect(path(planRouteDoors(two, 'a0', 'b1', d => d.toTileId !== 'b0'))).toEqual(['a0>b1']);
  });

  it('puts fewer map changes ahead of fewer doors', () => {
    const index = buildRouteIndex([
      r('x0', 'x', 0, { links: [['y', 'y0'], ['x', 'x10']] }),
      r('y0', 'y', 0, { links: [['x', 'x30']] }),
      r('x10', 'x', 10, { links: [['x', 'x20']] }),
      r('x20', 'x', 20, { links: [['x', 'x30']] }),
      r('x30', 'x', 30),
    ]);
    expect(path(planRouteDoors(index, 'x0', 'x30', ALL))).toEqual(['x0>x10', 'x10>x20', 'x20>x30']);
  });

  it('puts fewer doors ahead of a shorter walk', () => {
    const near = Array.from({ length: 8 }, (_, col) => r(`a${col}`, 'a', col, col === 0 ? { links: [['a', 'a20']] } : {}));
    const index = buildRouteIndex([
      ...near,
      r('a8', 'a', 8, { links: [['b', 'b0']] }),
      r('a20', 'a', 20, { links: [['b', 'b0']] }),
      r('b0', 'b', 0),
    ]);
    expect(path(planRouteDoors(index, 'a0', 'b0', ALL))).toEqual(['a8>b0']);
  });

  it('takes the shorter walk when doors and map changes tie', () => {
    const index = buildRouteIndex([
      r('a0', 'a', 0), r('a1', 'a', 1), r('a2', 'a', 2), r('a3', 'a', 3, { links: [['b', 'b0']] }),
      r('a4', 'a', 4, { links: [['b', 'b0']] }),
      r('b0', 'b', 0),
    ].reverse());
    expect(path(planRouteDoors(index, 'a0', 'b0', ALL))).toEqual(['a3>b0']);
  });

  it('breaks an exact tie by authored order', () => {
    const rooms = (first: string, second: string) => [
      r('a0', 'a', 0, { links: [['b', first], ['b', second]] }),
      r('b0', 'b', 0), r('b1', 'b', 1), r('b2', 'b', 2),
    ];
    expect(path(planRouteDoors(buildRouteIndex(rooms('b2', 'b0')), 'a0', 'b1', ALL))).toEqual(['a0>b2']);
    expect(path(planRouteDoors(buildRouteIndex(rooms('b0', 'b2')), 'a0', 'b1', ALL))).toEqual(['a0>b0']);
  });

  it('gives up past the door cap', () => {
    const rooms: RouteRoom[] = [];
    for (let i = 0; i <= MAX_ROUTE_DOORS + 2; i++) rooms.push(r(`m${i}`, `m${i}`, 0, { links: [[`m${i + 1}`, `m${i + 1}`]] }));
    const index = buildRouteIndex(rooms);
    expect(planRouteDoors(index, 'm0', `m${MAX_ROUTE_DOORS}`, ALL)).toHaveLength(MAX_ROUTE_DOORS);
    expect(planRouteDoors(index, 'm0', `m${MAX_ROUTE_DOORS + 1}`, ALL)).toBeNull();
  });

  it('ends on a loop of doors that never reaches the room', () => {
    const index = buildRouteIndex([
      r('a0', 'a', 0, { links: [['b', 'b0']] }),
      r('b0', 'b', 0, { links: [['a', 'a0'], ['c', 'c0']] }),
      r('c0', 'c', 0, { links: [['b', 'b0'], ['a', 'a0']] }),
      r('z0', 'z', 0),
    ]);
    expect(planRouteDoors(index, 'a0', 'z0', ALL)).toBeNull();
  });

  it('asks canUse about each door once, however many arrival rooms share its area', () => {
    const spokes = 30;
    const rooms: RouteRoom[] = [];
    for (let k = 0; k < spokes; k++) {
      rooms.push(r(`h${k}`, 'hub', k, { links: [[`s${k}`, `s${k}`]] }));
      rooms.push(r(`s${k}`, `s${k}`, 0, { links: [['hub', `h${k}`]] }));
    }
    rooms.push(r('z0', 'z', 0));
    const index = buildRouteIndex(rooms);
    let asked = 0;
    expect(planRouteDoors(index, 'h0', 'z0', () => { asked++; return true; })).toBeNull();
    expect(asked).toBeLessThanOrEqual(spokes * 2);
  });

  it('gives the same answer every time', () => {
    const runs = Array.from({ length: 5 }, () => path(planRouteDoors(world, 'a0', 'b1', ALL)));
    expect(new Set(runs.map(run => JSON.stringify(run))).size).toBe(1);
  });
});

describe('isTileTraversable', () => {
  const def = (traversable: boolean): TileTypeDefinition => ({ id: 'x', name: 'X', icon: '', color: '#000000', traversable });

  it('matches HexTile.isTraversable with and without a type definition', () => {
    for (const type of [TileType.Plains, TileType.Water, TileType.Void, 'made_up']) {
      for (const typeDef of [undefined, def(true), def(false)]) {
        const tile = new HexTile(createCube(0, 0), type, 'z', 'id', undefined, typeDef);
        expect(isTileTraversable(type, typeDef)).toBe(tile.isTraversable);
      }
    }
    expect(isTileTraversable(TileType.Water)).toBe(false);
    expect(isTileTraversable('made_up')).toBe(true);
  });
});
