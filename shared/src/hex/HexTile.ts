import { CubeCoord, cubeToPixel, cubeToKey } from './HexUtils.js';

export enum TileType {
  Plains = 'plains',
  Forest = 'forest',
  Mountain = 'mountain',
  Water = 'water',
  Town = 'town',
  Dungeon = 'dungeon',
  Void = 'void',
  Desert = 'desert',
  LavaField = 'lava_field',
  Beach = 'beach',
  Hedge = 'hedge',
  Volcano = 'volcano',
}

export interface TileConfig {
  type: TileType;
  color: number;
  traversable: boolean;
  /** Item ID that ALL party members must have equipped to traverse this tile. */
  requiredItemId?: string;
}

export const TILE_CONFIGS: Record<TileType, TileConfig> = {
  [TileType.Plains]: {
    type: TileType.Plains,
    color: 0x7ec850,
    traversable: true,
  },
  [TileType.Forest]: {
    type: TileType.Forest,
    color: 0x3d8c40,
    traversable: true,
  },
  [TileType.Mountain]: {
    type: TileType.Mountain,
    color: 0x8b7355,
    traversable: false,
  },
  [TileType.Water]: {
    type: TileType.Water,
    color: 0x4a90d9,
    traversable: false,
  },
  [TileType.Town]: {
    type: TileType.Town,
    color: 0xd4a574,
    traversable: true,
  },
  [TileType.Dungeon]: {
    type: TileType.Dungeon,
    color: 0x6b4c6b,
    traversable: true,
  },
  [TileType.Void]: {
    type: TileType.Void,
    color: 0x000000,
    traversable: false,
  },
  [TileType.Desert]: {
    type: TileType.Desert,
    color: 0xc2b280,
    traversable: true,
    requiredItemId: 'waterskin',
  },
  [TileType.LavaField]: {
    type: TileType.LavaField,
    color: 0xd44000,
    traversable: true,
    requiredItemId: 'magma_boots',
  },
  [TileType.Beach]: {
    type: TileType.Beach,
    color: 0xf5deb3,
    traversable: true,
  },
  [TileType.Hedge]: {
    type: TileType.Hedge,
    color: 0x2d5a27,
    traversable: false,
  },
  [TileType.Volcano]: {
    type: TileType.Volcano,
    color: 0x4a1a1a,
    traversable: false,
  },
};

export class HexTile {
  readonly coord: CubeCoord;
  readonly type: TileType;
  readonly config: TileConfig;
  readonly key: string;
  readonly zone: string;
  /** Stable GUID from WorldTileDefinition — used as unlock key. */
  readonly id: string;
  /** Per-tile override for required item. Takes precedence over TileConfig default. */
  private readonly _requiredItemId?: string;

  constructor(coord: CubeCoord, type: TileType, zone: string = 'friendly_forest', id?: string, requiredItemId?: string) {
    this.coord = coord;
    this.type = type;
    this.config = TILE_CONFIGS[type];
    this.key = cubeToKey(coord);
    this.zone = zone;
    this.id = id ?? this.key; // Fallback to cube key for legacy/test usage
    this._requiredItemId = requiredItemId;
  }

  get isTraversable(): boolean {
    return this.config.traversable;
  }

  get requiredItemId(): string | undefined {
    return this._requiredItemId ?? this.config.requiredItemId;
  }

  get color(): number {
    return this.config.color;
  }

  get pixelPosition(): { x: number; y: number } {
    return cubeToPixel(this.coord);
  }
}
