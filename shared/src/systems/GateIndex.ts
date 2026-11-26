import type { TileTypeDefinition } from '../hex/HexTile.js';
import type { WorldTileDefinition } from '../hex/MapSchema.js';
import type { RoomEntryRequirements } from './RoomRequirements.js';
import { isRoomGateEmpty, resolveTileRequirements, toRoomRequirements } from './RoomRequirements.js';

/** One lock in the world: a gated room, or a gated exit (`door`) out of `tileId` towards `linkTileId`. */
export interface GateRef {
  kind: 'room' | 'door';
  /** The gated room, or the room the door leaves from. */
  tileId: string;
  /** The map `tileId` is on. */
  mapId: string;
  /** Door only: where the exit leads. */
  linkTileId?: string;
  linkMapId?: string;
  reqs: RoomEntryRequirements;
}

/** Every room gate (type default merged with the room's own) and every gated transition, in world order. */
export function collectGates(
  tiles: readonly WorldTileDefinition[],
  tileTypes: Readonly<Record<string, TileTypeDefinition>>,
): GateRef[] {
  const gates: GateRef[] = [];
  for (const tile of tiles) {
    const typeDef = Object.prototype.hasOwnProperty.call(tileTypes, tile.type) ? tileTypes[tile.type] : undefined;
    const roomReqs = resolveTileRequirements(tile, typeDef);
    if (roomReqs && !isRoomGateEmpty(roomReqs)) {
      gates.push({ kind: 'room', tileId: tile.id, mapId: tile.mapId, reqs: roomReqs });
    }
    for (const link of tile.transitions ?? []) {
      const doorReqs = toRoomRequirements(link.entryRequirements);
      if (!doorReqs || isRoomGateEmpty(doorReqs)) continue;
      gates.push({ kind: 'door', tileId: tile.id, mapId: tile.mapId, linkTileId: link.tileId, linkMapId: link.mapId, reqs: doorReqs });
    }
  }
  return gates;
}
