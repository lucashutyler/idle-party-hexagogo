export type BattleTimerState = 'battle' | 'result';
export type BattleResult = 'victory' | 'defeat';
export type PartyState = 'idle' | 'moving' | 'in_battle';

export const BATTLE_DURATION = 2000;  // 2 seconds of fighting
export const RESULT_DURATION = 1000;  // 1 second to show victory/defeat before moving
export const DEFEAT_CHANCE = 0.2;     // 20% chance to lose
export const MOVE_DURATION = 300;     // ms per tile movement (client animation)

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
}

export interface ServerStateMessage {
  type: 'state';
  party: ServerPartyState;
  battle: ServerBattleState;
  unlocked: string[];
  mapSize: number;
}

export interface ClientMoveMessage {
  type: 'move';
  col: number;
  row: number;
}

export type ServerMessage = ServerStateMessage | { type: 'error'; message: string };
export type ClientMessage = ClientMoveMessage;
