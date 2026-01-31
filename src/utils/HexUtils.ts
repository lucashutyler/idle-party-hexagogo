/**
 * Hex coordinate utilities using cube coordinate system.
 * Cube coordinates: (q, r, s) where q + r + s = 0
 * This implementation uses flat-top hexagons.
 */

export interface CubeCoord {
  q: number;
  r: number;
  s: number;
}

export interface OffsetCoord {
  col: number;
  row: number;
}

export interface PixelCoord {
  x: number;
  y: number;
}

// Hex size (radius from center to corner)
export const HEX_SIZE = 40;

// Flat-top hex dimensions
export const HEX_WIDTH = HEX_SIZE * 2;
export const HEX_HEIGHT = Math.sqrt(3) * HEX_SIZE;

// Direction vectors for the 6 neighbors (flat-top orientation)
const CUBE_DIRECTIONS: CubeCoord[] = [
  { q: 1, r: 0, s: -1 },  // East
  { q: 1, r: -1, s: 0 },  // Northeast
  { q: 0, r: -1, s: 1 },  // Northwest
  { q: -1, r: 0, s: 1 },  // West
  { q: -1, r: 1, s: 0 },  // Southwest
  { q: 0, r: 1, s: -1 },  // Southeast
];

/**
 * Create a cube coordinate, ensuring q + r + s = 0
 */
export function createCube(q: number, r: number): CubeCoord {
  return { q, r, s: -q - r };
}

/**
 * Convert offset coordinates (col, row) to cube coordinates.
 * Uses "odd-q" offset layout (odd columns are shifted down).
 */
export function offsetToCube(offset: OffsetCoord): CubeCoord {
  const q = offset.col;
  const r = offset.row - Math.floor((offset.col - (offset.col & 1)) / 2);
  return createCube(q, r);
}

/**
 * Convert cube coordinates to offset coordinates.
 * Uses "odd-q" offset layout.
 */
export function cubeToOffset(cube: CubeCoord): OffsetCoord {
  const col = cube.q;
  const row = cube.r + Math.floor((cube.q - (cube.q & 1)) / 2);
  return { col, row };
}

/**
 * Convert cube coordinates to pixel coordinates (center of hex).
 * Flat-top orientation.
 */
export function cubeToPixel(cube: CubeCoord): PixelCoord {
  const x = HEX_SIZE * (3 / 2 * cube.q);
  const y = HEX_SIZE * (Math.sqrt(3) / 2 * cube.q + Math.sqrt(3) * cube.r);
  return { x, y };
}

/**
 * Convert pixel coordinates to cube coordinates (with rounding).
 */
export function pixelToCube(pixel: PixelCoord): CubeCoord {
  const q = (2 / 3 * pixel.x) / HEX_SIZE;
  const r = (-1 / 3 * pixel.x + Math.sqrt(3) / 3 * pixel.y) / HEX_SIZE;
  return cubeRound({ q, r, s: -q - r });
}

/**
 * Round fractional cube coordinates to the nearest hex.
 */
export function cubeRound(cube: CubeCoord): CubeCoord {
  let rQ = Math.round(cube.q);
  let rR = Math.round(cube.r);
  let rS = Math.round(cube.s);

  const qDiff = Math.abs(rQ - cube.q);
  const rDiff = Math.abs(rR - cube.r);
  const sDiff = Math.abs(rS - cube.s);

  // Reset the component with the largest diff to maintain q + r + s = 0
  if (qDiff > rDiff && qDiff > sDiff) {
    rQ = -rR - rS;
  } else if (rDiff > sDiff) {
    rR = -rQ - rS;
  } else {
    rS = -rQ - rR;
  }

  return { q: rQ, r: rR, s: rS };
}

/**
 * Get the 6 neighboring cube coordinates.
 */
export function getNeighbors(cube: CubeCoord): CubeCoord[] {
  return CUBE_DIRECTIONS.map(dir => ({
    q: cube.q + dir.q,
    r: cube.r + dir.r,
    s: cube.s + dir.s,
  }));
}

/**
 * Get a specific neighbor by direction index (0-5).
 */
export function getNeighbor(cube: CubeCoord, direction: number): CubeCoord {
  const dir = CUBE_DIRECTIONS[direction];
  return {
    q: cube.q + dir.q,
    r: cube.r + dir.r,
    s: cube.s + dir.s,
  };
}

/**
 * Calculate the distance between two hexes (in hex steps).
 */
export function cubeDistance(a: CubeCoord, b: CubeCoord): number {
  return Math.max(
    Math.abs(a.q - b.q),
    Math.abs(a.r - b.r),
    Math.abs(a.s - b.s)
  );
}

/**
 * Check if two cube coordinates are equal.
 */
export function cubeEquals(a: CubeCoord, b: CubeCoord): boolean {
  return a.q === b.q && a.r === b.r && a.s === b.s;
}

/**
 * Create a unique string key from cube coordinates (for Maps/Sets).
 */
export function cubeToKey(cube: CubeCoord): string {
  return `${cube.q},${cube.r},${cube.s}`;
}

/**
 * Parse a key back to cube coordinates.
 */
export function keyToCube(key: string): CubeCoord {
  const [q, r, s] = key.split(',').map(Number);
  return { q, r, s };
}

/**
 * Get the corner points of a hex for rendering (flat-top).
 * Returns 6 points relative to the center.
 */
export function getHexCorners(size: number = HEX_SIZE): PixelCoord[] {
  const corners: PixelCoord[] = [];
  for (let i = 0; i < 6; i++) {
    const angleDeg = 60 * i;
    const angleRad = (Math.PI / 180) * angleDeg;
    corners.push({
      x: size * Math.cos(angleRad),
      y: size * Math.sin(angleRad),
    });
  }
  return corners;
}
