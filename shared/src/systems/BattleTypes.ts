export type BattleTimerState = 'battle' | 'result';
export type BattleResult = 'victory' | 'defeat';
export type PartyState = 'idle' | 'moving' | 'in_battle';

export const BATTLE_DURATION = 2000;  // 2 seconds of fighting (legacy, used as default)
export const MIN_BATTLE_DURATION = 2000;   // Minimum battle duration (ms)
export const MAX_BATTLE_DURATION = 10000;  // Maximum battle duration (ms)
export const RESULT_PAUSE = 600;      // ms to show victory/defeat before movement
export const MOVE_DURATION = 400;     // ms for tile movement (client animation)
export const DEFEAT_CHANCE = 0.2;     // 20% chance to lose

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

export interface ServerBattleState {
  state: BattleTimerState;
  result?: BattleResult;
  visual: BattleVisual;
  duration: number;
}

export interface OtherPlayerState {
  username: string;
  col: number;
  row: number;
}

export type CombatLogType = 'battle' | 'victory' | 'defeat' | 'move' | 'unlock';

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
}

export interface ClientMoveMessage {
  type: 'move';
  col: number;
  row: number;
}

export interface ClientLoginMessage {
  type: 'login';
  username: string;
}

export interface ServerLoginSuccessMessage {
  type: 'login_success';
  username: string;
}

export interface ServerLoginErrorMessage {
  type: 'login_error';
  message: string;
}

export type ServerMessage =
  | ServerStateMessage
  | ServerLoginSuccessMessage
  | ServerLoginErrorMessage
  | { type: 'error'; message: string };

export interface ClientRequestStateMessage {
  type: 'request_state';
}

export type ClientMessage = ClientMoveMessage | ClientLoginMessage | ClientRequestStateMessage;
