import {
  MIN_BATTLE_DURATION,
  MAX_BATTLE_DURATION,
  RESULT_PAUSE,
  MOVE_DURATION,
  DEFEAT_CHANCE,
} from '@idle-party-rpg/shared';
import type { BattleTimerState, BattleResult, BattleVisual } from '@idle-party-rpg/shared';
import { ServerParty } from './ServerParty';

export interface ServerBattleCallbacks {
  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
  onMove?: () => void;
  canMoveToNextTile?: () => boolean;
}

export class ServerBattleTimer {
  private party: ServerParty;
  private state: BattleTimerState = 'battle';
  private currentVisual: BattleVisual = 'none';
  private currentResult?: BattleResult;
  private battleDuration: number = MIN_BATTLE_DURATION;

  private battleTimeout?: ReturnType<typeof setTimeout>;
  private resultTimeout?: ReturnType<typeof setTimeout>;
  private moveTimeout?: ReturnType<typeof setTimeout>;

  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
  onMove?: () => void;
  canMoveToNextTile?: () => boolean;

  constructor(party: ServerParty, callbacks?: ServerBattleCallbacks) {
    this.party = party;

    if (callbacks) {
      this.onBattleStart = callbacks.onBattleStart;
      this.onBattleEnd = callbacks.onBattleEnd;
      this.onStateChange = callbacks.onStateChange;
      this.onMove = callbacks.onMove;
      this.canMoveToNextTile = callbacks.canMoveToNextTile;
    }

    // Always fighting — start the loop immediately
    this.triggerBattle();
  }

  private triggerBattle(): void {
    this.battleDuration = MIN_BATTLE_DURATION +
      Math.floor(Math.random() * (MAX_BATTLE_DURATION - MIN_BATTLE_DURATION));
    this.currentVisual = 'fighting';
    this.party.enterBattle();

    // Add "Battle begins!" log BEFORE the state change broadcast,
    // so the client sees it in the same message as the 'battle' state transition.
    this.onBattleStart?.();
    this.setState('battle');

    this.battleTimeout = setTimeout(() => this.showBattleResult(), this.battleDuration);
  }

  private showBattleResult(): void {
    const isDefeat = Math.random() < DEFEAT_CHANCE;
    const result: BattleResult = isDefeat ? 'defeat' : 'victory';

    this.currentResult = result;
    this.currentVisual = result === 'victory' ? 'victory' : 'defeat';
    this.party.exitBattle();

    // Notify battle end (unlocks adjacent tiles on victory) before move check,
    // so newly unlocked tiles are available for movement this cycle.
    this.onBattleEnd?.(result);

    const canMove = this.party.hasDestination && (
      result === 'victory' ||
      (this.canMoveToNextTile?.() ?? false)
    );

    this.setState('result');

    if (canMove) {
      // Pause for celebration, then move, then next battle after move completes
      this.resultTimeout = setTimeout(() => {
        this.party.moveToNextTile();
        this.onMove?.();
        this.currentVisual = 'none';
        this.onStateChange?.(this.state); // broadcast updated position
        this.moveTimeout = setTimeout(() => this.triggerBattle(), MOVE_DURATION);
      }, RESULT_PAUSE);
    } else {
      // No movement — full 1s celebration, then next battle
      this.resultTimeout = setTimeout(() => {
        this.currentVisual = 'none';
        this.triggerBattle();
      }, RESULT_PAUSE + MOVE_DURATION);
    }
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

  get currentDuration(): number {
    return this.battleDuration;
  }

  destroy(): void {
    this.clearTimers();
  }
}
