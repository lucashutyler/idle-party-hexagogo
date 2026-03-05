import { CubeCoord, cubeToKey, cubeToOffset, getNeighbors, cubeEquals, offsetToCube } from './HexUtils.js';
import { HexTile, TileType } from './HexTile.js';
import { MapSchema } from './MapSchema.js';
import type { MapDefinition, SerializedTile } from '../systems/BattleTypes.js';

export class HexGrid {
  private tiles: Map<string, HexTile> = new Map();

  /**
   * Add a tile to the grid.
   */
  addTile(tile: HexTile): void {
    this.tiles.set(tile.key, tile);
  }

  /**
   * Get a tile by its cube coordinates.
   */
  getTile(coord: CubeCoord): HexTile | undefined {
    return this.tiles.get(cubeToKey(coord));
  }

  /**
   * Get a tile by its key string.
   */
  getTileByKey(key: string): HexTile | undefined {
    return this.tiles.get(key);
  }

  /**
   * Check if a tile exists at the given coordinates.
   */
  hasTile(coord: CubeCoord): boolean {
    return this.tiles.has(cubeToKey(coord));
  }

  /**
   * Get all tiles in the grid.
   */
  getAllTiles(): HexTile[] {
    return Array.from(this.tiles.values());
  }

  /**
   * Get traversable neighbors of a tile.
   */
  getTraversableNeighbors(coord: CubeCoord): HexTile[] {
    const neighbors: HexTile[] = [];
    for (const neighborCoord of getNeighbors(coord)) {
      const tile = this.getTile(neighborCoord);
      if (tile && tile.isTraversable) {
        neighbors.push(tile);
      }
    }
    return neighbors;
  }

  /**
   * Get all neighbors of a tile (including impassable).
   */
  getAllNeighbors(coord: CubeCoord): HexTile[] {
    const neighbors: HexTile[] = [];
    for (const neighborCoord of getNeighbors(coord)) {
      const tile = this.getTile(neighborCoord);
      if (tile) {
        neighbors.push(tile);
      }
    }
    return neighbors;
  }

  /**
   * Check if movement from one tile to another is valid.
   */
  canMoveTo(from: CubeCoord, to: CubeCoord): boolean {
    const targetTile = this.getTile(to);
    if (!targetTile || !targetTile.isTraversable) {
      return false;
    }

    // Check if target is a neighbor
    const neighbors = getNeighbors(from);
    return neighbors.some(n => cubeEquals(n, to));
  }

  /**
   * Get the number of tiles in the grid.
   */
  get size(): number {
    return this.tiles.size;
  }

  /**
   * Create a hex grid from a map schema.
   * Only tiles explicitly defined in the schema will exist.
   */
  static fromSchema(schema: MapSchema, zone?: string): HexGrid {
    const grid = new HexGrid();

    for (const tileDef of schema.tiles) {
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      const tile = new HexTile(coord, tileDef.type, zone);
      grid.addTile(tile);
    }

    return grid;
  }

  /**
   * Create a hex grid from a MapDefinition (loaded from content store or admin API).
   */
  static fromMapDefinition(def: MapDefinition): HexGrid {
    const grid = new HexGrid();
    for (const t of def.tiles) {
      const coord = offsetToCube({ col: t.col, row: t.row });
      const tile = new HexTile(coord, t.type, t.zone);
      grid.addTile(tile);
    }
    return grid;
  }

  /**
   * Serialize the grid to a MapDefinition for persistence or transmission.
   */
  toMapDefinition(id: string, name: string, type: 'overworld' | 'dungeon', startPosition: { col: number; row: number }): MapDefinition {
    const tiles: SerializedTile[] = [];
    for (const tile of this.tiles.values()) {
      const offset = cubeToOffset(tile.coord);
      tiles.push({
        col: offset.col,
        row: offset.row,
        type: tile.type,
        zone: tile.zone,
      });
    }
    return { id, name, type, startPosition, tiles };
  }

  /**
   * Create a rectangular hex grid.
   * Uses offset coordinates for easy rectangular layout.
   */
  static createRectangular(
    width: number,
    height: number,
    tileGenerator: (col: number, row: number) => TileType,
    zone?: string,
  ): HexGrid {
    const grid = new HexGrid();

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        // Convert offset to cube coordinates (odd-q layout)
        const q = col;
        const r = row - Math.floor((col - (col & 1)) / 2);
        const s = -q - r;

        const type = tileGenerator(col, row);
        const tile = new HexTile({ q, r, s }, type, zone);
        grid.addTile(tile);
      }
    }

    return grid;
  }
}
