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
}

/** Data-driven tile type definition — stored in ContentStore, editable via admin. */
export interface TileTypeDefinition {
  id: string;
  name: string;
  icon: string;
  color: string;
  traversable: boolean;
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
  },
  [TileType.LavaField]: {
    type: TileType.LavaField,
    color: 0xd44000,
    traversable: true,
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

/** Seed data for tile type definitions. Used to populate data/tile-types.json on first run. */
export const SEED_TILE_TYPES: TileTypeDefinition[] = [
  { id: 'plains', name: 'Plains', icon: '', color: '#7ec850', traversable: true },
  { id: 'forest', name: 'Forest', icon: '\uD83C\uDF32', color: '#3d8c40', traversable: true },
  { id: 'mountain', name: 'Mountain', icon: '\u26F0\uFE0F', color: '#8b7355', traversable: false },
  { id: 'water', name: 'Water', icon: '\uD83C\uDF0A', color: '#4a90d9', traversable: false },
  { id: 'town', name: 'Town', icon: '\uD83C\uDFE0', color: '#d4a574', traversable: true },
  { id: 'dungeon', name: 'Dungeon', icon: '\uD83D\uDD73\uFE0F', color: '#6b4c6b', traversable: true },
  { id: 'void', name: 'Void', icon: '', color: '#000000', traversable: false },
  { id: 'desert', name: 'Desert', icon: '\uD83C\uDFDC\uFE0F', color: '#c2b280', traversable: true },
  { id: 'lava_field', name: 'Lava Field', icon: '\uD83D\uDD25', color: '#d44000', traversable: true },
  { id: 'beach', name: 'Beach', icon: '\uD83C\uDFD6\uFE0F', color: '#f5deb3', traversable: true },
  { id: 'hedge', name: 'Hedge', icon: '\uD83C\uDF3F', color: '#2d5a27', traversable: false },
  { id: 'volcano', name: 'Volcano', icon: '\uD83C\uDF0B', color: '#4a1a1a', traversable: false },
];

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

  /** Optional data-driven tile type definition from ContentStore. */
  private readonly _tileTypeDef?: TileTypeDefinition;

  constructor(coord: CubeCoord, type: TileType, zone: string = 'friendly_forest', id?: string, requiredItemId?: string, tileTypeDef?: TileTypeDefinition) {
    this.coord = coord;
    this.type = type;
    this.config = TILE_CONFIGS[type] ?? TILE_CONFIGS[TileType.Plains];
    this.key = cubeToKey(coord);
    this.zone = zone;
    this.id = id ?? this.key; // Fallback to cube key for legacy/test usage
    this._requiredItemId = requiredItemId;
    this._tileTypeDef = tileTypeDef;
  }

  get isTraversable(): boolean {
    if (this._tileTypeDef) return this._tileTypeDef.traversable;
    return this.config.traversable;
  }

  get requiredItemId(): string | undefined {
    // Per-tile override takes precedence, then tile type default
    return this._requiredItemId ?? this._tileTypeDef?.requiredItemId;
  }

  get color(): number {
    if (this._tileTypeDef) return parseInt(this._tileTypeDef.color.replace('#', ''), 16);
    return this.config.color;
  }

  get pixelPosition(): { x: number; y: number } {
    return cubeToPixel(this.coord);
  }
}
