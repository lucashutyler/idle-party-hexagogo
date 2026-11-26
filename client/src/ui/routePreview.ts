import { isRoomGateEmpty, planRouteDoors } from '@idle-party-rpg/shared';
import type { RoomEntryFailure, RouteDoor, ServerStateMessage } from '@idle-party-rpg/shared';
import type { WorldCache } from '../network/WorldCache';
import { previewTravelLock, roomLockLines, roomRequirements } from './RoomEntryCheck';

export const NO_KNOWN_WAY_TEXT = "You haven't found a way there yet.";
export const LOCKED_DOOR_WAY_TEXT = 'The way there passes a locked door';

/** How the party would get to a room, as far as the viewer can tell. */
export type RoutePreview =
  | { kind: 'walk' }
  /** `gated`: some door on the way, or the room behind it, has a gate, which other members may fail. */
  | { kind: 'doors'; doors: number; otherMap: boolean; gated: boolean }
  | { kind: 'locked'; lines: RoomEntryFailure[] }
  | { kind: 'none' };

type RouteLookups = Pick<WorldCache, 'routeIndex' | 'getTileOn' | 'getTileByGuid' | 'getTileTypeDef'>;

const WALK: RoutePreview = { kind: 'walk' };
const foundByHistory = new WeakMap<readonly string[], ReadonlySet<string>>();

/**
 * Only the viewer's own found doors and gates count: other members may know a door, so the server judges.
 * A room whose area the client can't place is a walk, so nothing is withheld on a guess.
 */
export function previewRoute(state: ServerStateMessage, worldCache: RouteLookups, tileId: string): RoutePreview {
  const index = worldCache.routeIndex();
  const here = worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row);
  const hereArea = here ? index.areaOf(here.id) : undefined;
  const thereArea = index.areaOf(tileId);
  if (!here || hereArea === undefined || thereArea === undefined || hereArea === thereArea) return WALK;

  const found = foundRooms(state);
  const locks = (door: RouteDoor) => previewTravelLock(door.link, worldCache.getTileByGuid(door.toTileId), worldCache, state);
  const doors = planRouteDoors(index, here.id, tileId, door => found.has(door.fromTileId) && locks(door) === null);
  if (doors) {
    const gated = doors.some(door => {
      const arrival = worldCache.getTileByGuid(door.toTileId);
      return !isRoomGateEmpty(door.link.entryRequirements) || (!!arrival && !isRoomGateEmpty(roomRequirements(arrival, worldCache)));
    });
    return { kind: 'doors', doors: doors.length, otherMap: doors.some(d => d.toMapId !== d.fromMapId), gated };
  }

  const anyDoors = planRouteDoors(index, here.id, tileId, door => found.has(door.fromTileId));
  for (const door of anyDoors ?? []) {
    const lines = locks(door);
    if (lines) return { kind: 'locked', lines };
  }
  return { kind: 'none' };
}

/** What the sheet says about the way there. */
export function routePreviewLines(route: RoutePreview | null, state: ServerStateMessage | null): string[] {
  switch (route?.kind) {
    case 'doors': return [route.doors === 1 ? 'Through 1 door' : `Through ${route.doors} doors`];
    case 'locked': return [LOCKED_DOOR_WAY_TEXT, ...roomLockLines(route.lines, state)];
    case 'none': return [NO_KNOWN_WAY_TEXT];
    default: return [];
  }
}

/** Whether the viewer knows no open way there. */
export function routeUnknown(route: RoutePreview | null): boolean {
  return route?.kind === 'none' || route?.kind === 'locked';
}

function foundRooms(state: ServerStateMessage): ReadonlySet<string> {
  const unlocked = state.unlocked ?? [];
  let found = foundByHistory.get(unlocked);
  if (!found) {
    found = new Set(unlocked);
    foundByHistory.set(unlocked, found);
  }
  return found;
}
