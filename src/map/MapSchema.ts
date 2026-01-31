import { TileType } from './HexTile';

/**
 * Schema for defining a map.
 * Instead of filling a rectangular grid, tiles are explicitly defined.
 */
export interface MapSchema {
  name: string;
  startPosition: { col: number; row: number };
  tiles: TileDefinition[];
}

export interface TileDefinition {
  col: number;
  row: number;
  type: TileType;
}

/**
 * Helper to create tile definitions more concisely.
 */
function t(col: number, row: number, type: TileType): TileDefinition {
  return { col, row, type };
}

/**
 * The main world map schema.
 * All navigable tiles are connected via adjacent traversable tiles.
 */
export const WORLD_MAP: MapSchema = {
  name: 'Overworld',
  startPosition: { col: 4, row: 4 },
  tiles: [
    // ==========================================
    // CENTRAL AREA - Starting Town
    // ==========================================
    t(4, 4, TileType.Town),      // Starting town
    t(3, 4, TileType.Plains),
    t(5, 4, TileType.Plains),
    t(4, 3, TileType.Plains),
    t(4, 5, TileType.Plains),
    t(3, 3, TileType.Plains),
    t(5, 3, TileType.Plains),
    t(3, 5, TileType.Forest),
    t(5, 5, TileType.Forest),

    // ==========================================
    // WESTERN FOREST PATH
    // ==========================================
    t(2, 4, TileType.Forest),
    t(2, 3, TileType.Forest),
    t(2, 5, TileType.Forest),
    t(1, 4, TileType.Forest),
    t(1, 3, TileType.Plains),
    t(1, 5, TileType.Plains),
    t(0, 4, TileType.Plains),
    t(0, 3, TileType.Dungeon),   // Western dungeon
    t(0, 5, TileType.Mountain),

    // ==========================================
    // EASTERN PATH - Main road
    // ==========================================
    t(6, 4, TileType.Plains),
    t(7, 4, TileType.Plains),
    t(8, 4, TileType.Plains),
    t(6, 3, TileType.Plains),
    t(7, 3, TileType.Forest),
    t(8, 3, TileType.Plains),
    t(6, 5, TileType.Forest),
    t(7, 5, TileType.Plains),
    t(8, 5, TileType.Plains),

    // ==========================================
    // NORTHERN MOUNTAIN PASS
    // ==========================================
    t(4, 2, TileType.Plains),
    t(5, 2, TileType.Plains),
    t(6, 2, TileType.Mountain),
    t(4, 1, TileType.Plains),
    t(5, 1, TileType.Mountain),
    t(3, 2, TileType.Plains),
    t(3, 1, TileType.Plains),
    t(2, 2, TileType.Plains),
    t(2, 1, TileType.Plains),
    t(1, 2, TileType.Plains),
    t(1, 1, TileType.Dungeon),   // Northern dungeon

    // ==========================================
    // SOUTHERN PLAINS
    // ==========================================
    t(4, 6, TileType.Plains),
    t(5, 6, TileType.Plains),
    t(6, 6, TileType.Plains),
    t(4, 7, TileType.Plains),
    t(5, 7, TileType.Forest),
    t(6, 7, TileType.Plains),
    t(3, 6, TileType.Plains),
    t(3, 7, TileType.Plains),
    t(2, 6, TileType.Forest),
    t(2, 7, TileType.Town),      // Southern town

    // ==========================================
    // EASTERN TOWN AREA
    // ==========================================
    t(9, 4, TileType.Plains),
    t(10, 4, TileType.Plains),
    t(11, 4, TileType.Town),     // Eastern town
    t(9, 3, TileType.Plains),
    t(10, 3, TileType.Plains),
    t(11, 3, TileType.Plains),
    t(9, 5, TileType.Plains),
    t(10, 5, TileType.Forest),
    t(11, 5, TileType.Plains),

    // ==========================================
    // FAR EAST - Final dungeon area
    // ==========================================
    t(12, 4, TileType.Plains),
    t(13, 4, TileType.Plains),
    t(12, 3, TileType.Mountain),
    t(13, 3, TileType.Mountain),
    t(12, 5, TileType.Plains),
    t(13, 5, TileType.Plains),
    t(14, 4, TileType.Plains),
    t(14, 5, TileType.Mountain),
    t(14, 3, TileType.Dungeon),  // Final dungeon

    // ==========================================
    // SOUTHEAST FOREST
    // ==========================================
    t(7, 6, TileType.Plains),
    t(8, 6, TileType.Plains),
    t(9, 6, TileType.Forest),
    t(10, 6, TileType.Forest),
    t(7, 7, TileType.Forest),
    t(8, 7, TileType.Forest),
    t(9, 7, TileType.Plains),
    t(10, 7, TileType.Plains),
    t(11, 6, TileType.Plains),
    t(11, 7, TileType.Dungeon),  // Southeast dungeon

    // ==========================================
    // WATER FEATURES (decorative borders)
    // ==========================================
    t(0, 6, TileType.Water),
    t(1, 6, TileType.Water),
    t(1, 7, TileType.Water),
    t(0, 7, TileType.Water),

    // ==========================================
    // MOUNTAIN BORDER (north)
    // ==========================================
    t(0, 0, TileType.Mountain),
    t(1, 0, TileType.Mountain),
    t(2, 0, TileType.Mountain),
    t(3, 0, TileType.Mountain),
    t(4, 0, TileType.Mountain),
    t(0, 1, TileType.Mountain),
    t(0, 2, TileType.Mountain),
  ],
};
