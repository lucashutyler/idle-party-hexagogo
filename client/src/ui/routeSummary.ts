import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { WorldCache } from '../network/WorldCache';

type TileLookup = Pick<WorldCache, 'getTileOn'>;

/** A room's name, but only once it has been explored. */
export function discoveredRoomName(state: ServerStateMessage, worldCache: TileLookup, col: number, row: number): string | null {
  const tile = worldCache.getTileOn(state.currentMapId, col, row);
  return tile?.name && state.unlocked?.includes(tile.id) ? tile.name : null;
}

/** "{destination} · N rooms" for the walk in progress. */
export function routeSummary(state: ServerStateMessage, worldCache: TileLookup): string {
  const { path } = state.party;
  const last = path[path.length - 1];
  const name = last ? discoveredRoomName(state, worldCache, last.col, last.row) : null;
  const count = `${path.length} ${path.length === 1 ? 'room' : 'rooms'}`;
  return name ? `${name} · ${count}` : count;
}
