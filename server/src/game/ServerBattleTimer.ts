import {
  BATTLE_DURATION,
  RESULT_DURATION,
  DEFEAT_CHANCE,
  MOVE_DURATION,
} from '@idle-party-rpg/shared';
import type { BattleTimerState, BattleResult, BattleVisual } from '@idle-party-rpg/shared';
import { ServerParty } from './ServerParty';

export interface ServerBattleCallbacks {
  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
  canMoveToNextTile?: () => boolean;
}

export class ServerBattleTimer {
  private party: ServerParty;
  private state: BattleTimerState = 'moving';
  private currentVisual: BattleVisual = 'none';
  private currentResult?: BattleResult;

  private battleTimeout?: ReturnType<typeof setTimeout>;
  private resultTimeout?: ReturnType<typeof setTimeout>;
  private moveTimeout?: ReturnType<typeof setTimeout>;

  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
  canMoveToNextTile?: () => boolean;

  constructor(party: ServerParty, callbacks?: ServerBattleCallbacks) {
    this.party = party;

    if (callbacks) {
      this.onBattleStart = callbacks.onBattleStart;
      this.onBattleEnd = callbacks.onBattleEnd;
      this.onStateChange = callbacks.onStateChange;
      this.canMoveToNextTile = callbacks.canMoveToNextTile;
    }

    // Start the battle loop
    setTimeout(() => this.triggerBattle(), 100);
  }

  start(): void {
    if (this.state !== 'battle') {
      this.triggerBattle();
    }
  }

  stop(): void {
    this.clearTimers();
  }

  private triggerBattle(): void {
    this.setState('battle');
    this.currentVisual = 'fighting';
    this.party.enterBattle();
    this.onBattleStart?.();

    this.battleTimeout = setTimeout(() => this.showBattleResult(), BATTLE_DURATION);
  }

  private showBattleResult(): void {
    const isDefeat = Math.random() < DEFEAT_CHANCE;
    const result: BattleResult = isDefeat ? 'defeat' : 'victory';

    this.currentResult = result;
    this.currentVisual = result === 'victory' ? 'victory' : 'defeat';
    this.party.exitBattle();
    this.onBattleEnd?.(result);

    this.resultTimeout = setTimeout(() => this.resolveBattle(result), RESULT_DURATION);
  }

  private resolveBattle(result: BattleResult): void {
    this.currentVisual = 'none';

    const canMove = this.party.hasDestination && (
      result === 'victory' ||
      (this.canMoveToNextTile?.() ?? false)
    );

    if (canMove) {
      this.party.moveToNextTile();
    }
    this.setState('moving');

    // Wait for move duration then trigger next battle
    this.moveTimeout = setTimeout(() => this.triggerBattle(), MOVE_DURATION);
  }

  private clearTimers(): void {
    if (this.battleTimeout) {
      clearTimeout(this.battleTimeout);
      this.battleTimeout = undefined;
    }
    if (this.resultTimeout) {
      clearTimeout(this.resultTimeout);
      this.resultTimeout = undefined;
    }
    if (this.moveTimeout) {
      clearTimeout(this.moveTimeout);
      this.moveTimeout = undefined;
    }
  }

  private setState(newState: BattleTimerState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(newState);
    }
  }

  get currentState(): BattleTimerState {
    return this.state;
  }

  get visual(): BattleVisual {
    return this.currentVisual;
  }

  get lastResult(): BattleResult | undefined {
    return this.currentResult;
  }

  destroy(): void {
    this.clearTimers();
  }
}
