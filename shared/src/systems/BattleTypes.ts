import type { StatName, StatBlock } from './CharacterStats.js';
import type { EquipSlot } from './ItemTypes.js';
import type { PartyGridPosition } from './SocialTypes.js';
import type {
  ClientSocialState,
  ClientSocialMessage,
  ServerSocialStateMessage,
  ServerChatMessageMessage,
  ServerChatHistoryMessage,
} from './SocialTypes.js';

export type BattleTimerState = 'battle' | 'result';
export type BattleResult = 'victory' | 'defeat';
export type PartyState = 'idle' | 'moving' | 'in_battle';

export const RESULT_PAUSE = 600;      // ms to show victory/defeat before movement
export const MOVE_DURATION = 400;     // ms for tile movement (client animation)

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
}

export interface ClientMonsterState {
  name: string;
  currentHp: number;
  maxHp: number;
  level: number;
  gridPosition: PartyGridPosition;
}

export interface ClientCombatAction {
  attackerSide: 'player' | 'monster';
  attackerPos: PartyGridPosition;
  targetPos: PartyGridPosition | null;
  targetSide: 'player' | 'monster' | null;
  dodged: boolean;
}

export interface ClientCombatState {
  players: ClientPlayerCombatant[];
  monsters: ClientMonsterState[];
  tickCount: number;
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
  stats: StatBlock;
  priorityStat: StatName | null;
  inventory: Record<string, number>;
  equipment: Record<string, string | null>;
}

export interface OtherPlayerState {
  username: string;
  col: number;
  row: number;
  zone: string;
}

export type CombatLogType = 'battle' | 'victory' | 'defeat' | 'move' | 'unlock' | 'damage' | 'levelup';

export interface CombatLogEntry {
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
}

export interface ClientMoveMessage {
  type: 'move';
  col: number;
  row: number;
}

export interface ClientRequestStateMessage {
  type: 'request_state';
}

export interface ClientSetPriorityStatMessage {
  type: 'set_priority_stat';
  stat: StatName | null;
}

export interface ClientEquipItemMessage {
  type: 'equip_item';
  itemId: string;
}

export interface ClientUnequipItemMessage {
  type: 'unequip_item';
  slot: EquipSlot;
}

export type ServerMessage =
  | ServerStateMessage
  | ServerSocialStateMessage
  | ServerChatMessageMessage
  | ServerChatHistoryMessage
  | { type: 'error'; message: string };

export interface ClientSetClassMessage {
  type: 'set_class';
  className: string;
}

export type ClientMessage =
  | ClientMoveMessage
  | ClientRequestStateMessage
  | ClientSetPriorityStatMessage
  | ClientEquipItemMessage
  | ClientUnequipItemMessage
  | ClientSetClassMessage
  | ClientSocialMessage;
