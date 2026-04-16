import type { WorldTileDefinition, TileTypeDefinition } from '@idle-party-rpg/shared';

/**
 * Client-side cache for world data.
 * Loaded once from GET /api/world on login.
 * Fog of war is determined by state.unlocked (sent every tick).
 */
export class WorldCache {
  private tiles = new Map<string, WorldTileDefinition>();
  private tileTypeDefs = new Map<string, TileTypeDefinition>();
  private startTile: { col: number; row: number } = { col: 0, row: 0 };

  /** Tile GUID → offset key ("col,row") for fast unlock lookups. */
  private idToOffsetKey = new Map<string, string>();

  /** Offset-format keys ("col,row") for unlocked tiles. */
  private unlockedOffsetKeys = new Set<string>();

  /** Zone IDs that have at least one unlocked tile. */
  private unlockedZones = new Set<string>();

  /** Previous unlock count — used to detect changes. */
  private lastUnlockedCount = 0;

  /** Load initial world data from the server. */
  async loadWorld(): Promise<void> {
    const res = await fetch('/api/world', { credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to load world: ${res.status}`);

    const data = await res.json() as {
      startTile: { col: number; row: number };
      tiles: WorldTileDefinition[];
      tileTypes?: Record<string, TileTypeDefinition>;
    };

    this.startTile = data.startTile;
    this.tiles.clear();
    this.idToOffsetKey.clear();
    for (const tile of data.tiles) {
      const offsetKey = `${tile.col},${tile.row}`;
      this.tiles.set(offsetKey, tile);
      this.idToOffsetKey.set(tile.id, offsetKey);
    }

    this.tileTypeDefs.clear();
    if (data.tileTypes) {
      for (const def of Object.values(data.tileTypes)) {
        this.tileTypeDefs.set(def.id, def);
      }
    }
  }

  /**
   * Update the unlocked tile set from state.unlocked (tile GUIDs).
   * Returns true if the set changed (caller should re-render).
   */
  updateUnlocked(tileIds: string[]): boolean {
    if (tileIds.length === this.lastUnlockedCount) return false;
    this.lastUnlockedCount = tileIds.length;

    this.unlockedOffsetKeys.clear();
    this.unlockedZones.clear();

    for (const id of tileIds) {
      const offsetKey = this.idToOffsetKey.get(id);
      if (!offsetKey) continue; // Unknown tile ID (stale save or deleted tile)

      this.unlockedOffsetKeys.add(offsetKey);

      const tile = this.tiles.get(offsetKey);
      if (tile) {
        this.unlockedZones.add(tile.zone);
      }
    }

    return true;
  }

  /** Check if a tile is unlocked (player can move to it). */
  isUnlocked(col: number, row: number): boolean {
    return this.unlockedOffsetKeys.has(`${col},${row}`);
  }

  /** Check if a zone has been unlocked (at least one tile in it is unlocked). */
  isZoneUnlocked(zone: string): boolean {
    return this.unlockedZones.has(zone);
  }

  /** Get all tiles in the cache. */
  getTiles(): WorldTileDefinition[] {
    return Array.from(this.tiles.values());
  }

  /** Get a specific tile by offset coordinates. */
  getTile(col: number, row: number): WorldTileDefinition | undefined {
    return this.tiles.get(`${col},${row}`);
  }

  /** Get the start tile position. */
  getStartTile(): { col: number; row: number } {
    return this.startTile;
  }

  /** Get a tile type definition by ID. */
  getTileTypeDef(typeId: string): TileTypeDefinition | undefined {
    return this.tileTypeDefs.get(typeId);
  }

  /** Get all tile type definitions. */
  getAllTileTypeDefs(): Map<string, TileTypeDefinition> {
    return this.tileTypeDefs;
  }

  /** Check if world data has been loaded. */
  get isLoaded(): boolean {
    return this.tiles.size > 0;
  }
}
