import type { TileTypeDefinition } from '../hex/HexTile.js';
import type { WorldTileDefinition } from '../hex/MapSchema.js';
import type { RoomEntryMemberInfo, RoomEntryRequirements } from './RoomRequirements.js';
import { isRoomGateEmpty, resolveTileRequirements, toRoomRequirements, validateRoomEntry } from './RoomRequirements.js';

/** One lock in the world: a gated room, or an exit (`door`) out of `tileId` towards `linkTileId`. */
export interface GateRef {
  kind: 'room' | 'door';
  /** The gated room, or the room the door leaves from. */
  tileId: string;
  /** The map `tileId` is on. */
  mapId: string;
  /** Door only: where the exit leads. */
  linkTileId?: string;
  linkMapId?: string;
  /** The room's gate, or the door's own (empty when only the room behind it is gated). */
  reqs: RoomEntryRequirements;
  /** Door only: the gate of the room behind it, which applies as well. */
  destinationReqs?: RoomEntryRequirements;
}

/**
 * Every room gate (type default merged with the room's own) and every exit that is gated itself or
 * leads into a gated room, in world order.
 */
export function collectGates(
  tiles: readonly WorldTileDefinition[],
  tileTypes: Readonly<Record<string, TileTypeDefinition>>,
): GateRef[] {
  const roomGates = new Map<string, RoomEntryRequirements>();
  for (const tile of tiles) {
    const typeDef = Object.prototype.hasOwnProperty.call(tileTypes, tile.type) ? tileTypes[tile.type] : undefined;
    const reqs = resolveTileRequirements(tile, typeDef);
    if (reqs && !isRoomGateEmpty(reqs)) roomGates.set(tile.id, reqs);
  }
  const gates: GateRef[] = [];
  for (const tile of tiles) {
    const roomReqs = roomGates.get(tile.id);
    if (roomReqs) gates.push({ kind: 'room', tileId: tile.id, mapId: tile.mapId, reqs: roomReqs });
    for (const link of tile.transitions ?? []) {
      const own = toRoomRequirements(link.entryRequirements);
      const destinationReqs = roomGates.get(link.tileId);
      if (isRoomGateEmpty(own) && !destinationReqs) continue;
      gates.push({
        kind: 'door',
        tileId: tile.id,
        mapId: tile.mapId,
        linkTileId: link.tileId,
        linkMapId: link.mapId,
        reqs: own ?? {},
        ...(destinationReqs ? { destinationReqs } : {}),
      });
    }
  }
  return gates;
}

/** Whether `member` alone gets through: a door needs its own gate and the room behind it. */
export function passesGate(gate: GateRef, member: RoomEntryMemberInfo): boolean {
  return !validateRoomEntry(gate.reqs, [member]) && !validateRoomEntry(gate.destinationReqs, [member]);
}

/** The level a gate asks for (a door: the higher of its own and its room's); undefined when none. */
export function gateMinLevel(gate: GateRef): number | undefined {
  const levels = [gate.reqs.minLevel, gate.destinationReqs?.minLevel].filter((l): l is number => Number.isFinite(l));
  return levels.length > 0 ? Math.max(...levels) : undefined;
}

/** Every quest a gate asks for, a door's room included. */
export function gateQuestIds(gate: GateRef): Set<string> {
  return new Set([...(gate.reqs.requiredQuestIds ?? []), ...(gate.destinationReqs?.requiredQuestIds ?? [])]);
}
