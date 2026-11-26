import { buildRouteIndex, isTileTraversable } from '@idle-party-rpg/shared';
import type { RouteIndex } from '@idle-party-rpg/shared';
import type { ContentStore } from './ContentStore.js';

const indexes = new WeakMap<ContentStore, { epoch: number; index: RouteIndex }>();

/** Areas and doors of the live world, rebuilt once per content change. Built from content: a save bumps the epoch before the grids rebuild. */
export function routeIndexOf(content: ContentStore): RouteIndex {
  const known = indexes.get(content);
  if (known && known.epoch === content.contentEpoch) return known.index;
  const index = buildRouteIndex(content.getWorld().tiles.map(t => ({
    id: t.id,
    mapId: t.mapId,
    col: t.col,
    row: t.row,
    traversable: isTileTraversable(t.type, content.getTileType(t.type)),
    transitions: t.transitions,
  })));
  indexes.set(content, { epoch: content.contentEpoch, index });
  return index;
}
