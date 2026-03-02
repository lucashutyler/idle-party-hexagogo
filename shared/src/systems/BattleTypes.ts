import type { StatName, StatBlock } from './CharacterStats.js';
import type { EquipSlot } from './ItemTypes.js';

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

export interface ClientMonsterState {
  name: string;
  currentHp: number;
  maxHp: number;
  level: number;
}

export interface ClientCombatState {
  playerHp: number;
  playerMaxHp: number;
  monsters: ClientMonsterState[];
  tickCount: number;
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
}

export type CombatLogType = 'battle' | 'victory' | 'defeat' | 'move' | 'unlock' | 'damage' | 'levelup';

export interface CombatLogEntry {
  text: string;
  type: CombatLogType;
}

export interface ServerStateMessage {
  type: 'state';
  party: ServerPartyState;
  battle: ServerBattleState;
  unlocked: string[];
  mapSize: number;
  otherPlayers: OtherPlayerState[];
  combatLog: CombatLogEntry[];
  battleCount: number;
  character: ClientCharacterState;
  zoneName: string;
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
  | { type: 'error'; message: string };

export type ClientMessage =
  | ClientMoveMessage
  | ClientRequestStateMessage
  | ClientSetPriorityStatMessage
  | ClientEquipItemMessage
  | ClientUnequipItemMessage;
