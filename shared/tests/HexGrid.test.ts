import { describe, it, expect } from 'vitest';
import { HexGrid } from '../src/hex/HexGrid';
import { HexTile, TileType } from '../src/hex/HexTile';
import { createCube, cubeToKey } from '../src/hex/HexUtils';

function makeTile(q: number, r: number, type: TileType = TileType.Plains): HexTile {
  return new HexTile(createCube(q, r), type);
}

describe('HexGrid', () => {
  describe('addTile / getTile / hasTile', () => {
    it('stores and retrieves a tile', () => {
      const grid = new HexGrid();
      const tile = makeTile(0, 0);
      grid.addTile(tile);

      expect(grid.getTile(createCube(0, 0))).toBe(tile);
      expect(grid.hasTile(createCube(0, 0))).toBe(true);
    });

    it('returns undefined for missing tile', () => {
      const grid = new HexGrid();
      expect(grid.getTile(createCube(5, 5))).toBeUndefined();
      expect(grid.hasTile(createCube(5, 5))).toBe(false);
    });
  });

  describe('getTileByKey', () => {
    it('retrieves tile by string key', () => {
      const grid = new HexGrid();
      const tile = makeTile(2, -1);
      grid.addTile(tile);

      const key = cubeToKey(createCube(2, -1));
      expect(grid.getTileByKey(key)).toBe(tile);
    });
  });

  describe('getAllTiles', () => {
    it('returns all tiles', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0));
      grid.addTile(makeTile(1, 0));
      grid.addTile(makeTile(0, 1));

      expect(grid.getAllTiles()).toHaveLength(3);
    });
  });

  describe('size', () => {
    it('returns correct count', () => {
      const grid = new HexGrid();
      expect(grid.size).toBe(0);
      grid.addTile(makeTile(0, 0));
      expect(grid.size).toBe(1);
      grid.addTile(makeTile(1, 0));
      expect(grid.size).toBe(2);
    });
  });

  describe('getTraversableNeighbors', () => {
    it('returns only traversable neighbors', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0, TileType.Plains));
      grid.addTile(makeTile(1, 0, TileType.Plains));      // East - traversable
      grid.addTile(makeTile(0, -1, TileType.Mountain));    // Northwest - impassable
      grid.addTile(makeTile(-1, 0, TileType.Water));       // West - impassable

      const neighbors = grid.getTraversableNeighbors(createCube(0, 0));
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0].type).toBe(TileType.Plains);
    });

    it('returns empty array when no traversable neighbors exist', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0, TileType.Plains));
      grid.addTile(makeTile(1, 0, TileType.Mountain));

      // Only one neighbor, and it's impassable
      const neighbors = grid.getTraversableNeighbors(createCube(0, 0));
      expect(neighbors).toHaveLength(0);
    });
  });

  describe('getAllNeighbors', () => {
    it('returns all existing neighbors including impassable', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0, TileType.Plains));
      grid.addTile(makeTile(1, 0, TileType.Plains));
      grid.addTile(makeTile(0, -1, TileType.Mountain));

      const neighbors = grid.getAllNeighbors(createCube(0, 0));
      expect(neighbors).toHaveLength(2);
    });
  });

  describe('canMoveTo', () => {
    it('allows movement to traversable adjacent tile', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0, TileType.Plains));
      grid.addTile(makeTile(1, 0, TileType.Plains));

      expect(grid.canMoveTo(createCube(0, 0), createCube(1, 0))).toBe(true);
    });

    it('denies movement to non-traversable tile', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0, TileType.Plains));
      grid.addTile(makeTile(1, 0, TileType.Mountain));

      expect(grid.canMoveTo(createCube(0, 0), createCube(1, 0))).toBe(false);
    });

    it('denies movement to non-adjacent tile', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0, TileType.Plains));
      grid.addTile(makeTile(2, 0, TileType.Plains));

      expect(grid.canMoveTo(createCube(0, 0), createCube(2, 0))).toBe(false);
    });

    it('denies movement to non-existent tile', () => {
      const grid = new HexGrid();
      grid.addTile(makeTile(0, 0, TileType.Plains));

      expect(grid.canMoveTo(createCube(0, 0), createCube(1, 0))).toBe(false);
    });
  });

  describe('fromSchema', () => {
    it('creates grid from schema', () => {
      const grid = HexGrid.fromSchema({
        name: 'Test',
        startPosition: { col: 0, row: 0 },
        tiles: [
          { col: 0, row: 0, type: TileType.Town },
          { col: 1, row: 0, type: TileType.Plains },
          { col: 0, row: 1, type: TileType.Forest },
        ],
      });

      expect(grid.size).toBe(3);
    });
  });

  describe('createRectangular', () => {
    it('creates grid with correct dimensions', () => {
      const grid = HexGrid.createRectangular(3, 3, () => TileType.Plains);
      expect(grid.size).toBe(9);
    });

    it('uses tile generator function', () => {
      const grid = HexGrid.createRectangular(2, 2, (col, row) =>
        col === 0 && row === 0 ? TileType.Town : TileType.Plains
      );

      const tiles = grid.getAllTiles();
      const towns = tiles.filter(t => t.type === TileType.Town);
      expect(towns).toHaveLength(1);
    });
  });
});
