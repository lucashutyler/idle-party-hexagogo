import type { WorldTileDefinition } from '@idle-party-rpg/shared';

/**
 * Client-side cache for world data.
 * Loaded once from GET /api/world on login.
 * Fog of war is determined by state.unlocked (sent every tick).
 */
export class WorldCache {
  private tiles = new Map<string, WorldTileDefinition>();
  private startTile: { col: number; row: number } = { col: 0, row: 0 };

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
    };

    this.startTile = data.startTile;
    this.tiles.clear();
    for (const tile of data.tiles) {
      this.tiles.set(`${tile.col},${tile.row}`, tile);
    }
  }

  /**
   * Update the unlocked tile set from state.unlocked (cube keys).
   * Returns true if the set changed (caller should re-render).
   */
  updateUnlocked(cubeKeys: string[]): boolean {
    if (cubeKeys.length === this.lastUnlockedCount) return false;
    this.lastUnlockedCount = cubeKeys.length;

    this.unlockedOffsetKeys.clear();
    this.unlockedZones.clear();

    for (const cubeKey of cubeKeys) {
      const [q, r] = cubeKey.split(',').map(Number);
      // cubeToOffset: col = q, row = r + floor((q - (q & 1)) / 2)
      const col = q;
      const row = r + Math.floor((q - (q & 1)) / 2);
      const offsetKey = `${col},${row}`;
      this.unlockedOffsetKeys.add(offsetKey);

      // Track which zones have unlocked tiles
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

  /** Check if world data has been loaded. */
  get isLoaded(): boolean {
    return this.tiles.size > 0;
  }
}
