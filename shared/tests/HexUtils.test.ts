import { describe, it, expect } from 'vitest';
import {
  createCube,
  cubeDistance,
  cubeEquals,
  cubeToKey,
  keyToCube,
  cubeToPixel,
  pixelToCube,
  cubeRound,
  cubeToOffset,
  offsetToCube,
  getNeighbors,
  getNeighbor,
  getHexCorners,
  HEX_SIZE,
  HEX_WIDTH,
  HEX_HEIGHT,
} from '../src/hex/HexUtils';

describe('HexUtils', () => {
  describe('createCube', () => {
    it('creates valid cube coordinates where q + r + s = 0', () => {
      const cube = createCube(1, 2);
      expect(cube.q).toBe(1);
      expect(cube.r).toBe(2);
      expect(cube.s).toBe(-3);
      expect(cube.q + cube.r + cube.s).toBe(0);
    });

    it('handles origin', () => {
      const cube = createCube(0, 0);
      expect(cube.q).toBe(0);
      expect(cube.r).toBe(0);
      expect(cube.q + cube.r + cube.s).toBe(0);
    });

    it('handles negative coordinates', () => {
      const cube = createCube(-2, 1);
      expect(cube.s).toBe(1);
      expect(cube.q + cube.r + cube.s).toBe(0);
    });
  });

  describe('offsetToCube / cubeToOffset', () => {
    it('round-trips correctly for even column', () => {
      const offset = { col: 4, row: 6 };
      const cube = offsetToCube(offset);
      const result = cubeToOffset(cube);
      expect(result).toEqual(offset);
    });

    it('round-trips correctly for odd column', () => {
      const offset = { col: 3, row: 5 };
      const cube = offsetToCube(offset);
      const result = cubeToOffset(cube);
      expect(result).toEqual(offset);
    });

    it('round-trips for origin', () => {
      const offset = { col: 0, row: 0 };
      const cube = offsetToCube(offset);
      const result = cubeToOffset(cube);
      expect(result).toEqual(offset);
    });
  });

  describe('cubeToPixel / pixelToCube', () => {
    it('round-trips correctly', () => {
      const cube = createCube(3, -1);
      const pixel = cubeToPixel(cube);
      const result = pixelToCube(pixel);
      expect(cubeEquals(result, cube)).toBe(true);
    });

    it('places origin at pixel origin', () => {
      const pixel = cubeToPixel({ q: 0, r: 0, s: 0 });
      expect(pixel.x).toBe(0);
      expect(pixel.y).toBe(0);
    });
  });

  describe('cubeRound', () => {
    it('rounds fractional coordinates', () => {
      const rounded = cubeRound({ q: 0.4, r: 0.3, s: -0.7 });
      expect(rounded.q + rounded.r + rounded.s).toBe(0);
    });

    it('handles exact coordinates', () => {
      const rounded = cubeRound({ q: 1, r: -1, s: 0 });
      expect(rounded).toEqual({ q: 1, r: -1, s: 0 });
    });
  });

  describe('cubeDistance', () => {
    it('returns 0 for same hex', () => {
      const a = createCube(1, 2);
      expect(cubeDistance(a, a)).toBe(0);
    });

    it('returns 1 for adjacent hexes', () => {
      const a = createCube(0, 0);
      const b = createCube(1, 0);
      expect(cubeDistance(a, b)).toBe(1);
    });

    it('calculates correct distance for distant hexes', () => {
      const a = createCube(0, 0);
      const b = createCube(3, -2);
      expect(cubeDistance(a, b)).toBe(3);
    });
  });

  describe('cubeEquals', () => {
    it('returns true for equal coordinates', () => {
      expect(cubeEquals(createCube(1, 2), createCube(1, 2))).toBe(true);
    });

    it('returns false for different coordinates', () => {
      expect(cubeEquals(createCube(1, 2), createCube(1, 3))).toBe(false);
    });
  });

  describe('cubeToKey / keyToCube', () => {
    it('round-trips correctly', () => {
      const cube = createCube(5, -3);
      const key = cubeToKey(cube);
      const result = keyToCube(key);
      expect(cubeEquals(result, cube)).toBe(true);
    });

    it('produces deterministic keys', () => {
      expect(cubeToKey(createCube(1, 2))).toBe('1,2,-3');
    });
  });

  describe('getNeighbors', () => {
    it('returns 6 neighbors', () => {
      const neighbors = getNeighbors(createCube(0, 0));
      expect(neighbors).toHaveLength(6);
    });

    it('each neighbor is at distance 1', () => {
      const origin = createCube(0, 0);
      const neighbors = getNeighbors(origin);
      for (const n of neighbors) {
        expect(cubeDistance(origin, n)).toBe(1);
        expect(n.q + n.r + n.s).toBe(0);
      }
    });

    it('all neighbors are unique', () => {
      const neighbors = getNeighbors(createCube(2, -1));
      const keys = neighbors.map(cubeToKey);
      expect(new Set(keys).size).toBe(6);
    });
  });

  describe('getNeighbor', () => {
    it('returns neighbor at specific direction', () => {
      const origin = createCube(0, 0);
      const east = getNeighbor(origin, 0); // East direction
      expect(east).toEqual({ q: 1, r: 0, s: -1 });
    });

    it('returns valid cube coordinates', () => {
      const n = getNeighbor(createCube(3, -1), 3);
      expect(n.q + n.r + n.s).toBe(0);
    });
  });

  describe('getHexCorners', () => {
    it('returns 6 corners', () => {
      expect(getHexCorners()).toHaveLength(6);
    });

    it('corners are equidistant from center', () => {
      const corners = getHexCorners(10);
      for (const c of corners) {
        const dist = Math.sqrt(c.x * c.x + c.y * c.y);
        expect(dist).toBeCloseTo(10, 5);
      }
    });
  });

  describe('constants', () => {
    it('HEX_SIZE is 40', () => {
      expect(HEX_SIZE).toBe(40);
    });

    it('HEX_WIDTH is 2 * HEX_SIZE', () => {
      expect(HEX_WIDTH).toBe(HEX_SIZE * 2);
    });

    it('HEX_HEIGHT is sqrt(3) * HEX_SIZE', () => {
      expect(HEX_HEIGHT).toBeCloseTo(Math.sqrt(3) * HEX_SIZE, 5);
    });
  });
});
