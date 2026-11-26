import type { ServerPartyState, ServerStateMessage } from '@idle-party-rpg/shared';
import type { WorldCache } from '../network/WorldCache';

type TileLookup = Pick<WorldCache, 'getTileOn' | 'getTileByGuid'>;

/** A room's name, but only once it has been explored. */
export function discoveredRoomName(state: ServerStateMessage, worldCache: Pick<WorldCache, 'getTileOn'>, col: number, row: number): string | null {
  const tile = worldCache.getTileOn(state.currentMapId, col, row);
  return tile?.name && state.unlocked?.includes(tile.id) ? tile.name : null;
}

/** The party has somewhere to go: a leg to walk, or a door still ahead with the leg already walked. */
export function isTravelling(party: Pick<ServerPartyState, 'path' | 'route'>): boolean {
  return (party.path?.length ?? 0) > 0 || !!party.route;
}

/** Where the party is headed, once explored: a route's destination, else the walk's last room. */
export function destinationName(state: ServerStateMessage, worldCache: TileLookup): string | null {
  const { path, route } = state.party;
  if (route) {
    const tile = worldCache.getTileByGuid(route.destinationId);
    return tile?.name && state.unlocked?.includes(tile.id) ? tile.name : null;
  }
  const last = path[path.length - 1];
  return last ? discoveredRoomName(state, worldCache, last.col, last.row) : null;
}

/** "N rooms", plus " · N doors" while a door is still ahead. */
export function routeCountText(party: Pick<ServerPartyState, 'path' | 'route'>): string {
  const rooms = party.route?.rooms ?? party.path.length;
  const count = `${rooms} ${rooms === 1 ? 'room' : 'rooms'}`;
  const doors = party.route?.doors ?? 0;
  return doors > 0 ? `${count} · ${doors} ${doors === 1 ? 'door' : 'doors'}` : count;
}

/** "{destination} · N rooms · N doors" for the walk in progress. */
export function routeSummary(state: ServerStateMessage, worldCache: TileLookup): string {
  const name = destinationName(state, worldCache);
  const count = routeCountText(state.party);
  return name ? `${name} · ${count}` : count;
}
