import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import type { WorldTileDefinition } from '@idle-party-rpg/shared';
import type { ContentStore } from './ContentStore.js';

/**
 * Registry of per-map {@link HexGrid}s — one grid per `mapId` in the world.
 *
 * Both the registry object AND each per-map grid keep a stable object identity
 * across rebuilds (grids are cleared + repopulated in place), which preserves
 * the by-reference invariant relied on by PartyBattleManager / PlayerSession /
 * ServerParty: hand out a reference once, and it stays valid after a content
 * deploy or tile edit.
 */
export class WorldGrids {
  private grids = new Map<string, HexGrid>();

  constructor(private content: ContentStore) {
    this.rebuild();
  }

  /** The grid for `mapId`, or undefined if no such map exists. */
  get(mapId: string): HexGrid | undefined {
    return this.grids.get(mapId);
  }

  /** The grid for `mapId`, throwing if it does not exist. */
  getOrThrow(mapId: string): HexGrid {
    const grid = this.grids.get(mapId);
    if (!grid) throw new Error(`[WorldGrids] No grid for map "${mapId}"`);
    return grid;
  }

  has(mapId: string): boolean {
    return this.grids.has(mapId);
  }

  mapIds(): string[] {
    return [...this.grids.keys()];
  }

  /** Total tiles across all maps. */
  totalSize(): number {
    let total = 0;
    for (const grid of this.grids.values()) total += grid.size;
    return total;
  }

  /**
   * Rebuild every map's grid in place from the content store. Existing grid
   * objects are reused (cleared + repopulated); new maps get a fresh grid; maps
   * that no longer exist are dropped.
   */
  rebuild(): void {
    const world = this.content.getWorld();

    // Partition tiles by mapId.
    const byMap = new Map<string, WorldTileDefinition[]>();
    for (const tileDef of world.tiles) {
      const arr = byMap.get(tileDef.mapId);
      if (arr) arr.push(tileDef);
      else byMap.set(tileDef.mapId, [tileDef]);
    }
    // Every declared map gets a grid, even if it has no tiles yet.
    for (const meta of world.maps) {
      if (!byMap.has(meta.id)) byMap.set(meta.id, []);
    }

    const seen = new Set<string>();
    for (const [mapId, tiles] of byMap) {
      seen.add(mapId);
      let grid = this.grids.get(mapId);
      if (!grid) {
        grid = new HexGrid();
        this.grids.set(mapId, grid);
      }
      grid.clear();
      for (const tileDef of tiles) {
        const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
        const tileTypeDef = this.content.getTileType(tileDef.type);
        grid.addTile(new HexTile(coord, tileDef.type, tileDef.zone, tileDef.id, tileDef.requiredItemId, tileTypeDef));
      }
    }

    // Drop grids whose map was deleted.
    for (const mapId of [...this.grids.keys()]) {
      if (!seen.has(mapId)) this.grids.delete(mapId);
    }
  }
}
