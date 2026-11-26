import type { WorldTileDefinition } from '@idle-party-rpg/shared';
import type { ContentStore } from './ContentStore.js';

type NpcRoomContent = Pick<ContentStore, 'contentEpoch' | 'getWorld'>;

const indexes = new WeakMap<NpcRoomContent, { epoch: number; rooms: ReadonlyMap<string, readonly WorldTileDefinition[]> }>();

/** Every room each NPC stands in, on every map, in world order. Rebuilt once per content epoch. */
export function npcRoomsOf(content: NpcRoomContent): ReadonlyMap<string, readonly WorldTileDefinition[]> {
  const known = indexes.get(content);
  if (known && known.epoch === content.contentEpoch) return known.rooms;
  const rooms = new Map<string, WorldTileDefinition[]>();
  for (const tile of content.getWorld().tiles) {
    if (!tile.npcId) continue;
    const list = rooms.get(tile.npcId);
    if (list) list.push(tile);
    else rooms.set(tile.npcId, [tile]);
  }
  indexes.set(content, { epoch: content.contentEpoch, rooms });
  return rooms;
}
