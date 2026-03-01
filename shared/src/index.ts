// Hex utilities
export {
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
} from './hex/HexUtils.js';
export type { CubeCoord, OffsetCoord, PixelCoord } from './hex/HexUtils.js';

// Hex tile
export { TileType, TILE_CONFIGS, HexTile } from './hex/HexTile.js';
export type { TileConfig } from './hex/HexTile.js';

// Hex grid & pathfinding
export { HexGrid } from './hex/HexGrid.js';
export { HexPathfinder } from './hex/HexPathfinder.js';

// Map
export { WORLD_MAP } from './hex/MapSchema.js';
export type { MapSchema, TileDefinition } from './hex/MapSchema.js';
export { generateWorldMap, getStartingPosition } from './hex/MapData.js';

// Systems
export { UnlockSystem } from './systems/UnlockSystem.js';

// Battle types & constants
export type {
  BattleTimerState,
  BattleResult,
  PartyState,
  BattleVisual,
  ServerPartyState,
  ServerBattleState,
  OtherPlayerState,
  CombatLogType,
  CombatLogEntry,
  ServerStateMessage,
  ClientMoveMessage,
  ServerMessage,
  ClientMessage,
} from './systems/BattleTypes.js';
export {
  BATTLE_DURATION,
  MIN_BATTLE_DURATION,
  MAX_BATTLE_DURATION,
  RESULT_PAUSE,
  MOVE_DURATION,
  DEFEAT_CHANCE,
} from './systems/BattleTypes.js';
