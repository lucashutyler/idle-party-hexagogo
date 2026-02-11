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
} from './hex/HexUtils';
export type { CubeCoord, OffsetCoord, PixelCoord } from './hex/HexUtils';

// Hex tile
export { TileType, TILE_CONFIGS, HexTile } from './hex/HexTile';
export type { TileConfig } from './hex/HexTile';

// Hex grid & pathfinding
export { HexGrid } from './hex/HexGrid';
export { HexPathfinder } from './hex/HexPathfinder';

// Map
export { WORLD_MAP } from './hex/MapSchema';
export type { MapSchema, TileDefinition } from './hex/MapSchema';
export { generateWorldMap, getStartingPosition } from './hex/MapData';

// Systems
export { UnlockSystem } from './systems/UnlockSystem';

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
  ClientLoginMessage,
  ServerLoginSuccessMessage,
  ServerLoginErrorMessage,
  ServerMessage,
  ClientMessage,
} from './systems/BattleTypes';
export {
  BATTLE_DURATION,
  MIN_BATTLE_DURATION,
  MAX_BATTLE_DURATION,
  RESULT_PAUSE,
  MOVE_DURATION,
  DEFEAT_CHANCE,
} from './systems/BattleTypes';
