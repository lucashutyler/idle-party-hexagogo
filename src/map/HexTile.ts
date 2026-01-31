import { CubeCoord, cubeToPixel, cubeToKey } from '../utils/HexUtils';

export enum TileType {
  Plains = 'plains',
  Forest = 'forest',
  Mountain = 'mountain',
  Water = 'water',
  Town = 'town',
  Dungeon = 'dungeon',
  Void = 'void',
}

export interface TileConfig {
  type: TileType;
  color: number;
  traversable: boolean;
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
};

export class HexTile {
  readonly coord: CubeCoord;
  readonly type: TileType;
  readonly config: TileConfig;
  readonly key: string;

  // Phaser graphics reference (set when rendered)
  graphics?: Phaser.GameObjects.Graphics;

  constructor(coord: CubeCoord, type: TileType) {
    this.coord = coord;
    this.type = type;
    this.config = TILE_CONFIGS[type];
    this.key = cubeToKey(coord);
  }

  get isTraversable(): boolean {
    return this.config.traversable;
  }

  get color(): number {
    return this.config.color;
  }

  get pixelPosition(): { x: number; y: number } {
    return cubeToPixel(this.coord);
  }
}
