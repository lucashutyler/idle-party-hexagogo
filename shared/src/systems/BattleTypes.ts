import type { EquipSlot, ItemDefinition } from './ItemTypes.js';
import type { PartyGridPosition } from './SocialTypes.js';
import type {
  ClientSocialState,
  ClientSocialMessage,
  ServerSocialStateMessage,
  ServerChatMessageMessage,
  ServerSyncChatMessage,
  ServerTradeProposedMessage,
  ServerTradeCancelledMessage,
  ServerTradeCompletedMessage,
} from './SocialTypes.js';
import type { SkillLoadout } from './SkillTypes.js';


export type BattleTimerState = 'battle' | 'result';
export type BattleResult = 'victory' | 'defeat';
export type PartyState = 'idle' | 'moving' | 'in_battle';

export const RESULT_PAUSE = 600;      // ms to show victory/defeat before movement
export const MOVE_DURATION = 400;     // ms for tile movement (client animation)
export const RUN_AVAILABLE_ROUNDS = 5; // rounds before "Run" becomes available
export const GAME_VERSION = '2026.04.01.1'; // Keep in sync with PATCH_NOTES in client

// --- Protocol types (server → client, client → server) ---

export type BattleVisual = 'none' | 'fighting' | 'victory' | 'defeat';

export interface ServerPartyState {
  col: number;
  row: number;
  state: PartyState;
  targetCol?: number;
  targetRow?: number;
  path: { col: number; row: number }[];
}

export interface ClientPlayerCombatant {
  username: string;
  currentHp: number;
  maxHp: number;
  gridPosition: PartyGridPosition;
  className: string;
  /** Remaining stun turns (0 or undefined = not stunned). */
  stunTurns?: number;
}

export interface ClientMonsterState {
  name: string;
  currentHp: number;
  maxHp: number;
  gridPosition: PartyGridPosition;
  /** Remaining stun turns (0 or undefined = not stunned). */
  stunTurns?: number;
}

export interface ClientCombatAction {
  attackerSide: 'player' | 'monster';
  attackerPos: PartyGridPosition;
  targetPos: PartyGridPosition | null;
  targetSide: 'player' | 'monster' | null;
  dodged: boolean;
  /** Name of the skill used (if any). */
  skillName?: string;
  /** Whether a stun was applied. */
  stunApplied?: boolean;
  /** Amount healed (if any). */
  healAmount?: number;
  /** Username of the heal target. */
  healTarget?: string;
}

export interface ClientCombatState {
  players: ClientPlayerCombatant[];
  monsters: ClientMonsterState[];
  tickCount: number;
  /** Number of full combat rounds completed. */
  roundCount: number;
  /** The action that occurred on the most recent tick. */
  lastAction?: ClientCombatAction;
}

export interface ServerBattleState {
  state: BattleTimerState;
  result?: BattleResult;
  visual: BattleVisual;
  duration: number;
  combat?: ClientCombatState;
}

export interface ClientCharacterState {
  className: string;
  level: number;
  xp: number;
  xpForNextLevel: number;
  maxHp: number;
  gold: number;
  baseDamage: number;
  damageType: string;
  skillLoadout: SkillLoadout;
  skillPoints: number;
  inventory: Record<string, number>;
  equipment: Record<string, string | null>;
  /** XP rate tracking — in-memory only, resets on server restart. */
  xpRate: { startTime: number; totalXp: number };
}

export interface ClientResetXpRateMessage {
  type: 'reset_xp_rate';
}

export interface OtherPlayerState {
  username: string;
  col: number;
  row: number;
  zone: string;
  className?: string;
}

export type CombatLogType = 'battle' | 'victory' | 'defeat' | 'move' | 'unlock' | 'damage' | 'levelup';

export interface CombatLogEntry {
  id: number;
  text: string;
  type: CombatLogType;
}

export interface ServerStateMessage {
  type: 'state';
  username: string;
  party: ServerPartyState;
  battle: ServerBattleState;
  unlocked: string[];
  mapSize: number;
  otherPlayers: OtherPlayerState[];
  combatLog: CombatLogEntry[];
  battleCount: number;
  character: ClientCharacterState;
  zoneName: string;
  social?: ClientSocialState;
  /** Item definitions for items the player currently owns (inventory + equipment). */
  itemDefinitions: Record<string, ItemDefinition>;
  /** Server version identifier — changes on restart/deploy, triggers client reload on mismatch. */
  serverVersion: string;
}

export interface ClientMoveMessage {
  type: 'move';
  col: number;
  row: number;
}

export interface ClientRequestStateMessage {
  type: 'request_state';
}

export interface ClientEquipItemMessage {
  type: 'equip_item';
  itemId: string;
}

export interface ClientUnequipItemMessage {
  type: 'unequip_item';
  slot: EquipSlot;
}

export interface ClientDestroyItemsMessage {
  type: 'destroy_items';
  itemId: string;
  count: number;
}

export interface ClientEquipItemForceDestroyMessage {
  type: 'equip_item_force_destroy';
  itemId: string;
}

export interface ServerEquipBlockedMessage {
  type: 'equip_blocked';
  itemId: string;
  blockedByItemId: string;
  blockedBySlot: EquipSlot;
}

export interface ClientUnlockSkillMessage {
  type: 'unlock_skill';
  skillId: string;
}

export interface ClientEquipSkillMessage {
  type: 'equip_skill';
  skillId: string;
  slotIndex: number;
}

export interface ClientUnequipSkillMessage {
  type: 'unequip_skill';
  slotIndex: number;
}

export type ServerMessage =
  | ServerStateMessage
  | ServerSocialStateMessage
  | ServerChatMessageMessage
  | ServerSyncChatMessage
  | ServerEquipBlockedMessage
  | ServerTradeProposedMessage
  | ServerTradeCancelledMessage
  | ServerTradeCompletedMessage
  | PlayerProfileMessage
  | { type: 'error'; message: string };

export interface ClientViewPlayerMessage {
  type: 'view_player';
  username: string;
}

export interface PlayerProfileMessage {
  type: 'player_profile';
  username: string;
  className: string;
  level: number;
  guildName: string | null;
  equipment: Record<string, string | null>;
  skillLoadout: SkillLoadout;
  itemDefinitions: Record<string, ItemDefinition>;
  partyMembers: { username: string; className?: string; level?: number }[];
}

export interface ClientRunMessage {
  type: 'run';
}

export interface ClientSetClassMessage {
  type: 'set_class';
  className: string;
}

export type ClientMessage =
  | ClientMoveMessage
  | ClientRequestStateMessage
  | ClientEquipItemMessage
  | ClientUnequipItemMessage
  | ClientDestroyItemsMessage
  | ClientEquipItemForceDestroyMessage
  | ClientSetClassMessage
  | ClientResetXpRateMessage
  | ClientUnlockSkillMessage
  | ClientEquipSkillMessage
  | ClientUnequipSkillMessage
  | ClientRunMessage
  | ClientViewPlayerMessage
  | ClientSocialMessage;
