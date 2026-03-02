import { HexGrid } from './HexGrid.js';
import { HexTile, TileType } from './HexTile.js';
import { WORLD_MAP, MapSchema } from './MapSchema.js';
import { offsetToCube, cubeToKey, getNeighbors } from './HexUtils.js';

// --- Seeded PRNG (mulberry32) ---

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Constants ---

const MAP_SEED = 42;
const MIN_COL = -15;
const MAX_COL = 28;
const MIN_ROW = -15;
const MAX_ROW = 28;

// Exit positions (offset coords): 4 gaps in the border ring
const EXIT_POSITIONS = [
  { col: -1, row: 6 },   // West
  { col: 7, row: -1 },   // North
  { col: 14, row: 4 },   // East
  { col: 4, row: 14 },   // South
];

// --- Darkwood tile distribution ---

function pickDarkwoodTileType(rand: () => number): TileType {
  const roll = rand();
  if (roll < 0.40) return TileType.Forest;
  if (roll < 0.70) return TileType.Plains;
  if (roll < 0.85) return TileType.Mountain;
  if (roll < 0.93) return TileType.Water;
  return TileType.Forest; // remaining 7%
}

/**
 * Generate the world map with procedural wilderness surrounding the schema tiles.
 *
 * Phase 1: Place all schema tiles tagged 'friendly_forest'
 * Phase 2: Compute border ring (neighbors of schema tiles not in the schema)
 * Phase 3: Place border tiles — mountains/water with exit gaps
 * Phase 4: Fill remaining area with procedural 'darkwood' tiles
 */
export function generateWorldMap(schema: MapSchema = WORLD_MAP): HexGrid {
  const grid = new HexGrid();
  const rand = mulberry32(MAP_SEED);

  // Collect schema tile keys for fast lookup
  const schemaKeys = new Set<string>();
  for (const tileDef of schema.tiles) {
    const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
    schemaKeys.add(cubeToKey(coord));
  }

  // --- Phase 1: Place schema tiles as friendly_forest ---
  for (const tileDef of schema.tiles) {
    const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
    const tile = new HexTile(coord, tileDef.type, 'friendly_forest');
    grid.addTile(tile);
  }

  // --- Phase 2: Compute border ring ---
  // Border = all positions neighboring a schema tile that are not themselves schema tiles
  const borderKeys = new Set<string>();
  for (const tileDef of schema.tiles) {
    const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
    for (const neighbor of getNeighbors(coord)) {
      const key = cubeToKey(neighbor);
      if (!schemaKeys.has(key)) {
        borderKeys.add(key);
      }
    }
  }

  // --- Phase 3: Place border tiles with exit gaps ---
  // Compute exit gap keys (exit position + its border neighbors become plains)
  const exitGapKeys = new Set<string>();
  for (const exitPos of EXIT_POSITIONS) {
    const exitCoord = offsetToCube(exitPos);
    const exitKey = cubeToKey(exitCoord);
    exitGapKeys.add(exitKey);
    for (const neighbor of getNeighbors(exitCoord)) {
      const nk = cubeToKey(neighbor);
      if (borderKeys.has(nk)) {
        exitGapKeys.add(nk);
      }
    }
  }

  for (const borderKey of borderKeys) {
    if (grid.getTileByKey(borderKey)) continue; // already placed by schema

    // Find the coord from the key
    const parts = borderKey.split(',').map(Number);
    const coord = { q: parts[0], r: parts[1], s: parts[2] };

    if (exitGapKeys.has(borderKey)) {
      // Exit gap: traversable plains leading to darkwood
      grid.addTile(new HexTile(coord, TileType.Plains, 'darkwood'));
    } else {
      // Border barrier: alternate mountain/water using seeded random
      const type = rand() < 0.6 ? TileType.Mountain : TileType.Water;
      grid.addTile(new HexTile(coord, type, 'friendly_forest'));
    }
  }

  // --- Phase 4: Fill remaining area with procedural darkwood ---
  for (let row = MIN_ROW; row <= MAX_ROW; row++) {
    for (let col = MIN_COL; col <= MAX_COL; col++) {
      const coord = offsetToCube({ col, row });
      const key = cubeToKey(coord);

      if (grid.getTileByKey(key)) continue; // already placed

      const type = pickDarkwoodTileType(rand);
      grid.addTile(new HexTile(coord, type, 'darkwood'));
    }
  }

  return grid;
}

/**
 * Get the starting position for the party.
 */
export function getStartingPosition(schema: MapSchema = WORLD_MAP): { col: number; row: number } {
  return schema.startPosition;
}
