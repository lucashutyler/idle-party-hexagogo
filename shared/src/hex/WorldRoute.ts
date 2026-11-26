import { cubeDistance, cubeToKey, getNeighbors, offsetToCube } from './HexUtils.js';
import type { CubeCoord } from './HexUtils.js';
import type { MapTransitionLink } from './MapSchema.js';

/** The most doors one route may pass through. */
export const MAX_ROUTE_DOORS = 16;

export interface RouteRoom {
  id: string;
  mapId: string;
  col: number;
  row: number;
  traversable: boolean;
  transitions?: readonly MapTransitionLink[];
}

/** One usable exit: a walkable room's link to a walkable room on the map the link names. */
export interface RouteDoor {
  fromTileId: string;
  fromMapId: string;
  toTileId: string;
  toMapId: string;
  link: MapTransitionLink;
}

/** Walk-connected areas and the doors between them. See docs/architecture/content.md → Routes through doors. */
export interface RouteIndex {
  /** The walk-connected area a walkable room belongs to; areas are unique across maps. */
  areaOf(tileId: string): number | undefined;
  mapOf(tileId: string): string | undefined;
  /** Any room, walkable or not. */
  room(tileId: string): RouteRoom | undefined;
  /** A room's doors in authored order, one per target room. */
  doorsFrom(tileId: string): readonly RouteDoor[];
  /** The doors leading out of an area; a door into its own area is left out. */
  doorsOfArea(area: number): readonly RouteDoor[];
}

type Cost = readonly [mapChanges: number, doors: number, walk: number];

interface RouteNode {
  tileId: string;
  cost: Cost;
  via: RouteDoor | null;
  prev: RouteNode | null;
  done: boolean;
}

const NO_DOORS: readonly RouteDoor[] = [];

export function buildRouteIndex(rooms: Iterable<RouteRoom>): RouteIndex {
  const byId = new Map<string, RouteRoom>();
  const walkableByMap = new Map<string, Map<string, RouteRoom>>();
  for (const room of rooms) {
    byId.set(room.id, room);
    if (!room.traversable) continue;
    let onMap = walkableByMap.get(room.mapId);
    if (!onMap) {
      onMap = new Map();
      walkableByMap.set(room.mapId, onMap);
    }
    onMap.set(cubeToKey(offsetToCube(room)), room);
  }

  const areas = floodAreas(walkableByMap);
  const doorsByRoom = new Map<string, RouteDoor[]>();
  const doorsByArea = new Map<number, RouteDoor[]>();
  for (const room of byId.values()) {
    if (!room.traversable || !room.transitions?.length) continue;
    const doors: RouteDoor[] = [];
    for (const link of room.transitions) {
      const target = byId.get(link.tileId);
      if (!target?.traversable || target.mapId !== link.mapId) continue;
      if (doors.some(d => d.toTileId === target.id)) continue;
      doors.push({ fromTileId: room.id, fromMapId: room.mapId, toTileId: target.id, toMapId: target.mapId, link });
    }
    if (doors.length === 0) continue;
    doorsByRoom.set(room.id, doors);
    const area = areas.get(room.id)!;
    for (const door of doors) {
      if (areas.get(door.toTileId) === area) continue;
      const list = doorsByArea.get(area);
      if (list) list.push(door);
      else doorsByArea.set(area, [door]);
    }
  }

  return {
    areaOf: id => areas.get(id),
    mapOf: id => byId.get(id)?.mapId,
    room: id => byId.get(id),
    doorsFrom: id => doorsByRoom.get(id) ?? NO_DOORS,
    doorsOfArea: area => doorsByArea.get(area) ?? NO_DOORS,
  };
}

/**
 * The doors to take from one room to another, cheapest first by map changes, then doors, then the estimated walk.
 * [] when one walk reaches it, null when no route of usable doors does. Ties go to the earlier authored door.
 * `canUse` is asked at most once per door.
 */
export function planRouteDoors(
  index: RouteIndex,
  fromTileId: string,
  toTileId: string,
  canUse: (door: RouteDoor) => boolean,
): RouteDoor[] | null {
  const fromArea = index.areaOf(fromTileId);
  const toArea = index.areaOf(toTileId);
  if (fromArea === undefined || toArea === undefined) return null;
  if (fromArea === toArea) return [];

  const cubes = new Map<string, CubeCoord>();
  const cubeOf = (id: string): CubeCoord => {
    let cube = cubes.get(id);
    if (!cube) {
      cube = offsetToCube(index.room(id)!);
      cubes.set(id, cube);
    }
    return cube;
  };
  const usable = new Map<RouteDoor, boolean>();
  const usableDoor = (door: RouteDoor): boolean => {
    let ok = usable.get(door);
    if (ok === undefined) {
      ok = canUse(door);
      usable.set(door, ok);
    }
    return ok;
  };

  const start: RouteNode = { tileId: fromTileId, cost: [0, 0, 0], via: null, prev: null, done: false };
  const nodes = new Map<string, RouteNode>([[fromTileId, start]]);
  const open: RouteNode[] = [start];
  let best: { node: RouteNode; cost: Cost } | null = null;

  while (open.length > 0) {
    let pick = 0;
    for (let i = 1; i < open.length; i++) {
      if (costLess(open[i].cost, open[pick].cost)) pick = i;
    }
    const node = open.splice(pick, 1)[0];
    if (best && !costLess(node.cost, best.cost)) break;
    node.done = true;

    const area = index.areaOf(node.tileId)!;
    if (area === toArea) {
      const total = addCost(node.cost, [0, 0, cubeDistance(cubeOf(node.tileId), cubeOf(toTileId))]);
      if (!best || costLess(total, best.cost)) best = { node, cost: total };
      continue;
    }
    if (node.cost[1] >= MAX_ROUTE_DOORS) continue;

    for (const door of index.doorsOfArea(area)) {
      if (!usableDoor(door)) continue;
      const walk = cubeDistance(cubeOf(node.tileId), cubeOf(door.fromTileId)) + 1;
      const cost = addCost(node.cost, [door.toMapId !== door.fromMapId ? 1 : 0, 1, walk]);
      const known = nodes.get(door.toTileId);
      if (known && (known.done || !costLess(cost, known.cost))) continue;
      if (known) {
        known.cost = cost;
        known.via = door;
        known.prev = node;
        continue;
      }
      const next: RouteNode = { tileId: door.toTileId, cost, via: door, prev: node, done: false };
      nodes.set(next.tileId, next);
      open.push(next);
    }
  }

  if (!best) return null;
  const doors: RouteDoor[] = [];
  for (let node: RouteNode | null = best.node; node?.via; node = node.prev) doors.push(node.via);
  return doors.reverse();
}

/** One area id per walkable room, by the rule HexGrid.getTraversableNeighbors walks. */
function floodAreas(walkableByMap: ReadonlyMap<string, ReadonlyMap<string, RouteRoom>>): Map<string, number> {
  const areas = new Map<string, number>();
  let nextArea = 0;
  for (const onMap of walkableByMap.values()) {
    for (const start of onMap.values()) {
      if (areas.has(start.id)) continue;
      const area = nextArea++;
      areas.set(start.id, area);
      const stack = [offsetToCube(start)];
      while (stack.length > 0) {
        for (const coord of getNeighbors(stack.pop()!)) {
          const next = onMap.get(cubeToKey(coord));
          if (!next || areas.has(next.id)) continue;
          areas.set(next.id, area);
          stack.push(coord);
        }
      }
    }
  }
  return areas;
}

function addCost(a: Cost, b: Cost): Cost {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function costLess(a: Cost, b: Cost): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}
