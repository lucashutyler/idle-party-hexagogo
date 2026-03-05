import {
  RESULT_PAUSE,
  MOVE_DURATION,
} from '@idle-party-rpg/shared';
import type { BattleTimerState, BattleResult, BattleVisual } from '@idle-party-rpg/shared';
import type { PartyCombatState } from '@idle-party-rpg/shared';
import { processPartyTick } from '@idle-party-rpg/shared';
import { ServerParty } from './ServerParty.js';

const TICK_INTERVAL = 1000; // 1 second per combat tick

export interface ServerBattleCallbacks {
  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
  onMove?: () => void;
  canMoveToNextTile?: () => boolean;
  onCombatTick?: (state: PartyCombatState, logEntries: string[]) => void;
}

export class ServerBattleTimer {
  private party: ServerParty;
  private state: BattleTimerState = 'battle';
  private currentVisual: BattleVisual = 'none';
  private currentResult?: BattleResult;
  private battleDuration: number = 0;

  private resultTimeout?: ReturnType<typeof setTimeout>;
  private moveTimeout?: ReturnType<typeof setTimeout>;
  private tickInterval?: ReturnType<typeof setInterval>;

  private combatState: PartyCombatState | null = null;
  private createCombat: () => PartyCombatState;

  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
  onMove?: () => void;
  canMoveToNextTile?: () => boolean;
  onCombatTick?: (state: PartyCombatState, logEntries: string[]) => void;

  constructor(party: ServerParty, createCombat: () => PartyCombatState, callbacks?: ServerBattleCallbacks) {
    this.party = party;
    this.createCombat = createCombat;

    if (callbacks) {
      this.onBattleStart = callbacks.onBattleStart;
      this.onBattleEnd = callbacks.onBattleEnd;
      this.onStateChange = callbacks.onStateChange;
      this.onMove = callbacks.onMove;
      this.canMoveToNextTile = callbacks.canMoveToNextTile;
      this.onCombatTick = callbacks.onCombatTick;
    }

    // Always fighting — start the loop immediately
    this.triggerBattle();
  }

  private triggerBattle(): void {
    this.combatState = this.createCombat();
    this.battleDuration = 0;
    this.currentVisual = 'fighting';
    this.party.enterBattle();

    this.onBattleStart?.();
    this.setState('battle');

    // Start the tick loop
    this.tickInterval = setInterval(() => this.processCombatTick(), TICK_INTERVAL);
  }

  private processCombatTick(): void {
    if (!this.combatState || this.combatState.finished) return;

    const tickResult = processPartyTick(this.combatState);
    this.battleDuration += TICK_INTERVAL;

    // Notify listeners of the tick (damage log entries, HP updates)
    this.onCombatTick?.(this.combatState, tickResult.logEntries);

    if (tickResult.finished) {
      // Clear tick interval
      if (this.tickInterval) {
        clearInterval(this.tickInterval);
        this.tickInterval = undefined;
      }

      const result: BattleResult = tickResult.result === 'victory' ? 'victory' : 'defeat';
      this.showBattleResult(result);
    }
  }

  private showBattleResult(result: BattleResult): void {
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
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
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

  get currentCombat(): PartyCombatState | null {
    return this.combatState;
  }

  destroy(): void {
    this.clearTimers();
  }
}
