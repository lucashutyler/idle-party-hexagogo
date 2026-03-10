import { CubeCoord, cubeToKey, getNeighbors, cubeEquals, offsetToCube } from './HexUtils.js';
import { HexTile, TileType } from './HexTile.js';
import { MapSchema } from './MapSchema.js';

export class HexGrid {
  private tiles: Map<string, HexTile> = new Map();

  /**
   * Add a tile to the grid.
   */
  addTile(tile: HexTile): void {
    this.tiles.set(tile.key, tile);
  }

  /**
   * Remove all tiles from the grid.
   */
  clear(): void {
    this.tiles.clear();
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
   * BFS from a starting tile to find all reachable traversable tiles.
   * Returns a Set of tile keys that are reachable.
   */
  getReachableTiles(start: CubeCoord): Set<string> {
    const startTile = this.getTile(start);
    if (!startTile || !startTile.isTraversable) return new Set();

    const visited = new Set<string>();
    const queue: CubeCoord[] = [start];
    visited.add(cubeToKey(start));

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of getNeighbors(current)) {
        const key = cubeToKey(neighbor);
        if (visited.has(key)) continue;
        const tile = this.getTile(neighbor);
        if (tile && tile.isTraversable) {
          visited.add(key);
          queue.push(neighbor);
        }
      }
    }

    return visited;
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
