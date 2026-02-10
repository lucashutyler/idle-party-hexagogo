import { describe, it, expect, vi } from 'vitest';
import { UnlockSystem } from '../src/systems/UnlockSystem';
import { HexGrid } from '../src/hex/HexGrid';
import { HexTile, TileType } from '../src/hex/HexTile';
import { createCube } from '../src/hex/HexUtils';

function makeTile(q: number, r: number, type: TileType = TileType.Plains): HexTile {
  return new HexTile(createCube(q, r), type);
}

function makeTestGrid(): { grid: HexGrid; center: HexTile } {
  const grid = new HexGrid();

  const center = makeTile(0, 0, TileType.Town);
  grid.addTile(center);

  // 6 neighbors: mix of traversable and non-traversable
  grid.addTile(makeTile(1, 0, TileType.Plains));    // East
  grid.addTile(makeTile(1, -1, TileType.Plains));   // NE
  grid.addTile(makeTile(0, -1, TileType.Mountain)); // NW - impassable
  grid.addTile(makeTile(-1, 0, TileType.Plains));   // West
  grid.addTile(makeTile(-1, 1, TileType.Water));    // SW - impassable
  grid.addTile(makeTile(0, 1, TileType.Forest));    // SE

  // Distant tiles (beyond neighbors)
  grid.addTile(makeTile(2, 0, TileType.Plains));
  grid.addTile(makeTile(2, -1, TileType.Plains));

  return { grid, center };
}

describe('UnlockSystem', () => {
  describe('constructor', () => {
    it('unlocks start tile and traversable neighbors', () => {
      const { grid, center } = makeTestGrid();
      const system = new UnlockSystem(grid, center);

      // Center is unlocked
      expect(system.isUnlocked(center)).toBe(true);

      // Traversable neighbors are unlocked
      expect(system.isUnlockedByKey(makeTile(1, 0).key)).toBe(true);   // Plains
      expect(system.isUnlockedByKey(makeTile(1, -1).key)).toBe(true);  // Plains
      expect(system.isUnlockedByKey(makeTile(-1, 0).key)).toBe(true);  // Plains
      expect(system.isUnlockedByKey(makeTile(0, 1).key)).toBe(true);   // Forest

      // Impassable neighbors are NOT unlocked
      expect(system.isUnlockedByKey(makeTile(0, -1).key)).toBe(false); // Mountain
      expect(system.isUnlockedByKey(makeTile(-1, 1).key)).toBe(false); // Water
    });

    it('does not unlock distant tiles', () => {
      const { grid, center } = makeTestGrid();
      const system = new UnlockSystem(grid, center);

      expect(system.isUnlockedByKey(makeTile(2, 0).key)).toBe(false);
    });
  });

  describe('unlockAdjacentTiles', () => {
    it('unlocks new traversable neighbors', () => {
      const { grid, center } = makeTestGrid();
      const system = new UnlockSystem(grid, center);

      const eastTile = grid.getTile(createCube(1, 0))!;
      const newlyUnlocked = system.unlockAdjacentTiles(eastTile);

      // Should unlock tiles adjacent to (1,0) that weren't already unlocked
      expect(newlyUnlocked.length).toBeGreaterThan(0);
      expect(system.isUnlockedByKey(makeTile(2, 0).key)).toBe(true);
    });

    it('returns empty for already-unlocked area', () => {
      const { grid, center } = makeTestGrid();
      const system = new UnlockSystem(grid, center);

      // Unlocking center again should return empty (all neighbors already unlocked or impassable)
      const newlyUnlocked = system.unlockAdjacentTiles(center);
      expect(newlyUnlocked).toHaveLength(0);
    });

    it('fires onTilesUnlocked callback', () => {
      const { grid, center } = makeTestGrid();
      const system = new UnlockSystem(grid, center);

      const callback = vi.fn();
      system.onTilesUnlocked = callback;

      const eastTile = grid.getTile(createCube(1, 0))!;
      system.unlockAdjacentTiles(eastTile);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].length).toBeGreaterThan(0);
    });

    it('does not fire callback when nothing new is unlocked', () => {
      const { grid, center } = makeTestGrid();
      const system = new UnlockSystem(grid, center);

      const callback = vi.fn();
      system.onTilesUnlocked = callback;

      // Try unlocking center again — nothing new
      system.unlockAdjacentTiles(center);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('unlockTile', () => {
    it('returns true for newly unlocked tile', () => {
      const { grid, center } = makeTestGrid();
      const system = new UnlockSystem(grid, center);

      const distantTile = grid.getTile(createCube(2, 0))!;
      expect(system.unlockTile(distantTile)).toBe(true);
    });

    it('returns false for already unlocked tile', () => {
      const { grid, center } = makeTestGrid();
      const system = new UnlockSystem(grid, center);

      expect(system.unlockTile(center)).toBe(false);
    });
  });

  describe('getUnlockedTiles', () => {
    it('returns all unlocked tiles', () => {
      const { grid, center } = makeTestGrid();
      const system = new UnlockSystem(grid, center);

      const unlocked = system.getUnlockedTiles();
      expect(unlocked.length).toBe(system.unlockedCount);
      expect(unlocked.length).toBeGreaterThan(0);
    });
  });

  describe('unlockedCount', () => {
    it('returns correct count', () => {
      const { grid, center } = makeTestGrid();
      const system = new UnlockSystem(grid, center);

      // center + 4 traversable neighbors
      expect(system.unlockedCount).toBe(5);
    });
  });
});
