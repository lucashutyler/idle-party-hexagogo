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
 * Features:
 * - Central starting area
 * - Mountain range running north-south (with a pass)
 * - River running east-west (with bridge crossings)
 * - Multiple towns and dungeons
 */
export const WORLD_MAP: MapSchema = {
  name: 'Overworld',
  startPosition: { col: 4, row: 6 },
  tiles: [
    // ==========================================
    // CENTRAL AREA - Starting Town
    // ==========================================
    t(4, 6, TileType.Town),      // Starting town
    t(3, 6, TileType.Plains),
    t(5, 6, TileType.Plains),
    t(4, 5, TileType.Plains),
    t(4, 7, TileType.Plains),
    t(3, 5, TileType.Plains),
    t(5, 5, TileType.Plains),
    t(3, 7, TileType.Forest),
    t(5, 7, TileType.Forest),

    // ==========================================
    // WESTERN AREA (before mountains)
    // ==========================================
    t(2, 6, TileType.Plains),
    t(2, 5, TileType.Plains),
    t(2, 7, TileType.Plains),
    t(1, 6, TileType.Forest),
    t(1, 5, TileType.Forest),
    t(1, 7, TileType.Plains),
    t(0, 6, TileType.Plains),
    t(0, 5, TileType.Plains),
    t(0, 7, TileType.Town),      // Western town

    // Western area - north section
    t(2, 4, TileType.Plains),
    t(1, 4, TileType.Plains),
    t(0, 4, TileType.Plains),
    t(2, 3, TileType.Plains),
    t(1, 3, TileType.Forest),
    t(0, 3, TileType.Dungeon),   // Western dungeon

    // Western area - south section
    t(2, 8, TileType.Plains),
    t(1, 8, TileType.Plains),
    t(0, 8, TileType.Plains),
    t(2, 9, TileType.Forest),
    t(1, 9, TileType.Forest),
    t(0, 9, TileType.Plains),

    // ==========================================
    // MOUNTAIN RANGE (north-south barrier)
    // ==========================================
    // Northern mountains
    t(6, 1, TileType.Mountain),
    t(6, 2, TileType.Mountain),
    t(6, 3, TileType.Mountain),

    // Mountain pass (traversable gap)
    t(6, 4, TileType.Plains),    // Mountain pass!
    t(6, 5, TileType.Plains),    // Mountain pass continues

    // Southern mountains
    t(6, 6, TileType.Mountain),
    t(6, 7, TileType.Mountain),
    t(6, 8, TileType.Mountain),
    t(6, 9, TileType.Mountain),
    t(6, 10, TileType.Mountain),

    // ==========================================
    // EASTERN AREA (after mountains)
    // ==========================================
    // East of the pass
    t(7, 4, TileType.Plains),
    t(7, 5, TileType.Plains),
    t(7, 3, TileType.Plains),
    t(8, 4, TileType.Plains),
    t(8, 5, TileType.Plains),
    t(8, 3, TileType.Forest),
    t(9, 4, TileType.Plains),
    t(9, 5, TileType.Plains),
    t(9, 3, TileType.Plains),

    // Eastern town area
    t(10, 4, TileType.Plains),
    t(10, 5, TileType.Town),     // Eastern town
    t(10, 3, TileType.Plains),
    t(11, 4, TileType.Plains),
    t(11, 5, TileType.Plains),
    t(11, 3, TileType.Forest),

    // Far east - dungeon area
    t(12, 4, TileType.Plains),
    t(12, 5, TileType.Plains),
    t(12, 3, TileType.Plains),
    t(13, 4, TileType.Dungeon),  // Eastern dungeon
    t(13, 5, TileType.Mountain),
    t(13, 3, TileType.Mountain),

    // ==========================================
    // RIVER (east-west barrier)
    // ==========================================
    // River runs along row 10-11
    t(0, 10, TileType.Water),
    t(1, 10, TileType.Water),
    t(2, 10, TileType.Water),
    t(3, 10, TileType.Plains),   // Bridge crossing!
    t(4, 10, TileType.Water),
    t(5, 10, TileType.Water),
    // River meets mountain at col 6
    t(7, 10, TileType.Water),
    t(8, 10, TileType.Water),
    t(9, 10, TileType.Plains),   // Eastern bridge!
    t(10, 10, TileType.Water),
    t(11, 10, TileType.Water),
    t(12, 10, TileType.Water),

    // ==========================================
    // NORTHERN REGION
    // ==========================================
    // North of starting area
    t(4, 4, TileType.Plains),
    t(3, 4, TileType.Plains),
    t(5, 4, TileType.Plains),
    t(4, 3, TileType.Plains),
    t(3, 3, TileType.Plains),
    t(5, 3, TileType.Forest),
    t(4, 2, TileType.Plains),
    t(3, 2, TileType.Plains),
    t(5, 2, TileType.Plains),
    t(4, 1, TileType.Town),      // Northern town
    t(3, 1, TileType.Plains),
    t(5, 1, TileType.Mountain),

    // Far north
    t(4, 0, TileType.Plains),
    t(3, 0, TileType.Plains),
    t(2, 0, TileType.Plains),
    t(2, 1, TileType.Plains),
    t(2, 2, TileType.Forest),
    t(1, 0, TileType.Dungeon),   // Northern dungeon
    t(1, 1, TileType.Plains),
    t(1, 2, TileType.Plains),
    t(0, 0, TileType.Mountain),
    t(0, 1, TileType.Mountain),
    t(0, 2, TileType.Plains),

    // ==========================================
    // SOUTHERN REGION (below starting area)
    // ==========================================
    t(4, 8, TileType.Plains),
    t(3, 8, TileType.Plains),
    t(5, 8, TileType.Plains),
    t(4, 9, TileType.Plains),
    t(3, 9, TileType.Plains),
    t(5, 9, TileType.Forest),

    // ==========================================
    // SOUTH OF RIVER
    // ==========================================
    // Southwest region
    t(0, 11, TileType.Plains),
    t(1, 11, TileType.Plains),
    t(2, 11, TileType.Plains),
    t(3, 11, TileType.Plains),
    t(0, 12, TileType.Forest),
    t(1, 12, TileType.Plains),
    t(2, 12, TileType.Plains),
    t(3, 12, TileType.Plains),
    t(0, 13, TileType.Plains),
    t(1, 13, TileType.Plains),
    t(2, 13, TileType.Town),     // Southern town
    t(3, 13, TileType.Forest),

    // South central (blocked by mountains from river)
    t(4, 11, TileType.Plains),
    t(5, 11, TileType.Plains),
    t(4, 12, TileType.Plains),
    t(5, 12, TileType.Forest),
    t(4, 13, TileType.Plains),
    t(5, 13, TileType.Dungeon),  // Southern dungeon

    // Mountain extension south of river
    t(6, 11, TileType.Mountain),
    t(6, 12, TileType.Mountain),
    t(6, 13, TileType.Mountain),

    // Southeast region (across eastern bridge)
    t(7, 11, TileType.Plains),
    t(8, 11, TileType.Plains),
    t(9, 11, TileType.Plains),
    t(10, 11, TileType.Plains),
    t(7, 12, TileType.Forest),
    t(8, 12, TileType.Plains),
    t(9, 12, TileType.Plains),
    t(10, 12, TileType.Forest),
    t(7, 13, TileType.Plains),
    t(8, 13, TileType.Plains),
    t(9, 13, TileType.Town),     // Southeast town
    t(10, 13, TileType.Plains),
    t(11, 11, TileType.Plains),
    t(11, 12, TileType.Plains),
    t(11, 13, TileType.Dungeon), // Southeast dungeon

    // ==========================================
    // CONNECTION PATHS
    // ==========================================
    // Path to mountain pass from west
    t(5, 4, TileType.Plains),

    // Path east of mountains to river
    t(7, 6, TileType.Plains),
    t(7, 7, TileType.Plains),
    t(7, 8, TileType.Plains),
    t(7, 9, TileType.Plains),
    t(8, 6, TileType.Forest),
    t(8, 7, TileType.Plains),
    t(8, 8, TileType.Plains),
    t(8, 9, TileType.Plains),
    t(9, 6, TileType.Plains),
    t(9, 7, TileType.Plains),
    t(9, 8, TileType.Plains),
    t(9, 9, TileType.Plains),
  ],
};
