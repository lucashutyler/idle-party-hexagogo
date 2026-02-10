import { HexTile } from '../hex/HexTile';
import { HexGrid } from '../hex/HexGrid';

/**
 * Tracks which tiles have been unlocked by the player.
 * Players can only move to unlocked tiles.
 * Winning a battle on a tile unlocks adjacent tiles.
 */
export class UnlockSystem {
  private unlockedKeys: Set<string> = new Set();
  private grid: HexGrid;

  // Event when tiles are unlocked
  onTilesUnlocked?: (tiles: HexTile[]) => void;

  constructor(grid: HexGrid, startTile: HexTile) {
    this.grid = grid;

    // Unlock the starting tile and its neighbors
    this.unlockTile(startTile);
    this.unlockAdjacentTiles(startTile);
  }

  /**
   * Check if a tile is unlocked.
   */
  isUnlocked(tile: HexTile): boolean {
    return this.unlockedKeys.has(tile.key);
  }

  /**
   * Check if a tile is unlocked by key.
   */
  isUnlockedByKey(key: string): boolean {
    return this.unlockedKeys.has(key);
  }

  /**
   * Unlock a specific tile.
   */
  unlockTile(tile: HexTile): boolean {
    if (this.unlockedKeys.has(tile.key)) {
      return false; // Already unlocked
    }
    this.unlockedKeys.add(tile.key);
    return true;
  }

  /**
   * Unlock all traversable adjacent tiles to the given tile.
   * Returns the list of newly unlocked tiles.
   */
  unlockAdjacentTiles(tile: HexTile): HexTile[] {
    const neighbors = this.grid.getAllNeighbors(tile.coord);
    const newlyUnlocked: HexTile[] = [];

    for (const neighbor of neighbors) {
      if (neighbor.isTraversable && !this.unlockedKeys.has(neighbor.key)) {
        this.unlockedKeys.add(neighbor.key);
        newlyUnlocked.push(neighbor);
      }
    }

    if (newlyUnlocked.length > 0) {
      this.onTilesUnlocked?.(newlyUnlocked);
    }

    return newlyUnlocked;
  }

  /**
   * Get all unlocked tiles.
   */
  getUnlockedTiles(): HexTile[] {
    const tiles: HexTile[] = [];
    for (const key of this.unlockedKeys) {
      const tile = this.grid.getTileByKey(key);
      if (tile) {
        tiles.push(tile);
      }
    }
    return tiles;
  }

  /**
   * Get all unlocked tile keys.
   */
  getUnlockedKeys(): string[] {
    return Array.from(this.unlockedKeys);
  }

  /**
   * Get count of unlocked tiles.
   */
  get unlockedCount(): number {
    return this.unlockedKeys.size;
  }
}
