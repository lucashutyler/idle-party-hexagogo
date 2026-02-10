import {
  BATTLE_DURATION,
  RESULT_DURATION,
  DEFEAT_CHANCE,
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
  private state: BattleTimerState = 'battle';
  private currentVisual: BattleVisual = 'none';
  private currentResult?: BattleResult;

  private battleTimeout?: ReturnType<typeof setTimeout>;
  private resultTimeout?: ReturnType<typeof setTimeout>;

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

    // Always fighting — start the loop immediately
    this.triggerBattle();
  }

  private triggerBattle(): void {
    this.currentVisual = 'fighting';
    this.party.enterBattle();
    this.setState('battle');
    this.onBattleStart?.();

    this.battleTimeout = setTimeout(() => this.showBattleResult(), BATTLE_DURATION);
  }

  private showBattleResult(): void {
    const isDefeat = Math.random() < DEFEAT_CHANCE;
    const result: BattleResult = isDefeat ? 'defeat' : 'victory';

    this.currentResult = result;
    this.currentVisual = result === 'victory' ? 'victory' : 'defeat';
    this.party.exitBattle();

    // Move during the result window (server-instant; client tweens the animation)
    const canMove = this.party.hasDestination && (
      result === 'victory' ||
      (this.canMoveToNextTile?.() ?? false)
    );

    if (canMove) {
      this.party.moveToNextTile();
    }

    this.setState('result');
    this.onBattleEnd?.(result);

    // After the result/celebration window, next battle begins
    this.resultTimeout = setTimeout(() => this.resolveBattle(), RESULT_DURATION);
  }

  private resolveBattle(): void {
    this.currentVisual = 'none';

    // Always fight — next battle immediately
    this.triggerBattle();
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
