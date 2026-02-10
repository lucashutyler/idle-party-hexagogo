import { describe, it, expect } from 'vitest';
import { HexPathfinder } from '../src/hex/HexPathfinder';
import { HexGrid } from '../src/hex/HexGrid';
import { HexTile, TileType } from '../src/hex/HexTile';
import { createCube } from '../src/hex/HexUtils';

function makeTile(q: number, r: number, type: TileType = TileType.Plains): HexTile {
  return new HexTile(createCube(q, r), type);
}

function makeLineGrid(): HexGrid {
  // Simple line: (0,0) → (1,0) → (2,0)
  const grid = new HexGrid();
  grid.addTile(makeTile(0, 0));
  grid.addTile(makeTile(1, 0));
  grid.addTile(makeTile(2, 0));
  return grid;
}

function makeGridWithObstacle(): HexGrid {
  // (0,0) → (1,0)[blocked] → (2,0)
  // Detour: (0,0) → (1,-1) → (2,-1) → (2,0)
  const grid = new HexGrid();
  grid.addTile(makeTile(0, 0));
  grid.addTile(makeTile(1, 0, TileType.Mountain)); // blocked
  grid.addTile(makeTile(2, 0));
  grid.addTile(makeTile(1, -1));  // detour step 1: neighbor of (0,0)
  grid.addTile(makeTile(2, -1));  // detour step 2: neighbor of both (1,-1) and (2,0)
  return grid;
}

describe('HexPathfinder', () => {
  describe('findPath', () => {
    it('finds path between adjacent tiles', () => {
      const grid = makeLineGrid();
      const pf = new HexPathfinder(grid);

      const path = pf.findPath(createCube(0, 0), createCube(1, 0));
      expect(path).not.toBeNull();
      expect(path!).toHaveLength(2);
      expect(path![0].coord).toEqual(createCube(0, 0));
      expect(path![1].coord).toEqual(createCube(1, 0));
    });

    it('finds longer path', () => {
      const grid = makeLineGrid();
      const pf = new HexPathfinder(grid);

      const path = pf.findPath(createCube(0, 0), createCube(2, 0));
      expect(path).not.toBeNull();
      expect(path!).toHaveLength(3);
    });

    it('avoids obstacles', () => {
      const grid = makeGridWithObstacle();
      const pf = new HexPathfinder(grid);

      const path = pf.findPath(createCube(0, 0), createCube(2, 0));
      expect(path).not.toBeNull();
      // Path should go around the mountain
      const keys = path!.map(t => t.key);
      // Should NOT include the mountain tile
      const mountainKey = makeTile(1, 0, TileType.Mountain).key;
      expect(keys).not.toContain(mountainKey);
    });

    it('returns null when no path exists', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0));
      grid.addTile(makeTile(5, 5)); // disconnected
      const pf = new HexPathfinder(grid);

      expect(pf.findPath(createCube(0, 0), createCube(5, 5))).toBeNull();
    });

    it('returns single-tile path for start equals goal', () => {
      const grid = makeLineGrid();
      const pf = new HexPathfinder(grid);

      const path = pf.findPath(createCube(0, 0), createCube(0, 0));
      expect(path).not.toBeNull();
      expect(path!).toHaveLength(1);
    });

    it('returns null for non-existent start', () => {
      const grid = makeLineGrid();
      const pf = new HexPathfinder(grid);

      expect(pf.findPath(createCube(99, 99), createCube(0, 0))).toBeNull();
    });

    it('returns null for non-traversable goal', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0));
      grid.addTile(makeTile(1, 0, TileType.Mountain));
      const pf = new HexPathfinder(grid);

      expect(pf.findPath(createCube(0, 0), createCube(1, 0))).toBeNull();
    });
  });

  describe('hasPath', () => {
    it('returns true when path exists', () => {
      const grid = makeLineGrid();
      const pf = new HexPathfinder(grid);

      expect(pf.hasPath(createCube(0, 0), createCube(2, 0))).toBe(true);
    });

    it('returns false when no path exists', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0));
      grid.addTile(makeTile(5, 5));
      const pf = new HexPathfinder(grid);

      expect(pf.hasPath(createCube(0, 0), createCube(5, 5))).toBe(false);
    });
  });

  describe('getPathLength', () => {
    it('returns correct length for known path', () => {
      const grid = makeLineGrid();
      const pf = new HexPathfinder(grid);

      expect(pf.getPathLength(createCube(0, 0), createCube(2, 0))).toBe(2);
    });

    it('returns 0 for same tile', () => {
      const grid = makeLineGrid();
      const pf = new HexPathfinder(grid);

      expect(pf.getPathLength(createCube(0, 0), createCube(0, 0))).toBe(0);
    });

    it('returns -1 when no path exists', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0));
      const pf = new HexPathfinder(grid);

      expect(pf.getPathLength(createCube(0, 0), createCube(5, 5))).toBe(-1);
    });
  });
});
