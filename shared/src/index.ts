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
export type { MapSchema, TileDefinition, WorldTileDefinition, WorldData } from './hex/MapSchema.js';
export { generateWorldMap, getStartingPosition } from './hex/MapData.js';

// Systems
export { UnlockSystem } from './systems/UnlockSystem.js';

// Character stats
export {
  ALL_STATS,
  BASE_STATS,
  CLASS_DEFINITIONS,
  ALL_CLASS_NAMES,
  XP_PER_VICTORY,
  STAT_POINTS_PER_LEVEL,
  BASE_HP,
  HP_PER_LEVEL,
  MAX_GOLD,
  xpForNextLevel,
  calculateMaxHp,
  createDefaultCharacter,
  createCharacter,
  addXp,
  addGold,
  allocateStatPoints,
} from './systems/CharacterStats.js';
export type {
  ClassName,
  DamageType,
  StatName,
  StatBlock,
  CharacterState,
  ClassDefinition,
} from './systems/CharacterStats.js';

// Item types
export {
  MAX_STACK,
  RARITY_DROP_RATES,
  EQUIP_SLOTS,
  SEED_ITEMS,
  addItemToInventory,
  removeItemFromInventory,
  equipItem,
  unequipItem,
  computeEquipmentBonuses,
  getItemEffectText,
  rollDrops,
} from './systems/ItemTypes.js';
export type {
  ItemRarity,
  EquipSlot,
  ItemDefinition,
  ItemDrop,
  EquipmentBonuses,
} from './systems/ItemTypes.js';

// Monster types
export {
  SEED_MONSTERS,
  createMonsterInstance,
  createEncounter,
} from './systems/MonsterTypes.js';
export type {
  MonsterDefinition,
  MonsterInstance,
} from './systems/MonsterTypes.js';

// Zone types
export {
  SEED_ZONES,
  getZone,
} from './systems/ZoneTypes.js';
export type {
  EncounterTableEntry,
  ZoneDefinition,
} from './systems/ZoneTypes.js';

// Combat engine
export {
  createCombatState,
  processTick,
  createPartyCombatState,
  processPartyTick,
  findTarget,
} from './systems/CombatEngine.js';
export type {
  CombatantState,
  CombatState,
  TickResult,
  PartyCombatant,
  PartyCombatState,
  CombatAction,
} from './systems/CombatEngine.js';

// Battle types & constants
export type {
  BattleTimerState,
  BattleResult,
  PartyState,
  BattleVisual,
  ServerPartyState,
  ClientPlayerCombatant,
  ClientMonsterState,
  ClientCombatAction,
  ClientCombatState,
  ServerBattleState,
  ClientCharacterState,
  OtherPlayerState,
  CombatLogType,
  CombatLogEntry,
  ServerStateMessage,
  ClientMoveMessage,
  ClientRequestStateMessage,
  ClientSetPriorityStatMessage,
  ClientEquipItemMessage,
  ClientUnequipItemMessage,
  ClientSetClassMessage,
  ServerMessage,
  ClientMessage,
} from './systems/BattleTypes.js';
export {
  RESULT_PAUSE,
  MOVE_DURATION,
} from './systems/BattleTypes.js';

// Social types
export { MAX_PARTY_SIZE } from './systems/SocialTypes.js';
export type {
  FriendEntry,
  FriendRequest,
  GuildInfo,
  GuildMemberEntry,
  PartyRole,
  PartyGridPosition,
  GamePartyMember,
  GamePartyInfo,
  ChatChannelType,
  ChatMessage,
  ChatChannel,
  BlockLevel,
  ClientSocialState,
  ClientSendFriendRequestMessage,
  ClientAcceptFriendRequestMessage,
  ClientDeclineFriendRequestMessage,
  ClientRevokeFriendRequestMessage,
  ClientRemoveFriendMessage,
  ClientCreateGuildMessage,
  ClientInviteGuildMessage,
  ClientJoinGuildMessage,
  ClientLeaveGuildMessage,
  ClientCreatePartyMessage,
  ClientInvitePartyMessage,
  ClientLeavePartyMessage,
  ClientKickPartyMemberMessage,
  ClientSetPartyGridPositionMessage,
  ClientPromotePartyLeaderMessage,
  ClientDemotePartyMemberMessage,
  ClientTransferPartyOwnershipMessage,
  ClientAcceptPartyInviteMessage,
  ClientDeclinePartyInviteMessage,
  PartyInvite,
  ClientSendChatMessage,
  ClientRequestChatHistoryMessage,
  ClientBlockUserMessage,
  ClientUnblockUserMessage,
  ClientSetChatPreferencesMessage,
  ChatPreferences,
  ClientSocialMessage,
  ServerSocialStateMessage,
  ServerChatMessageMessage,
  ServerChatHistoryMessage,
} from './systems/SocialTypes.js';
