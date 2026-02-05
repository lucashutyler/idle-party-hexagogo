import Phaser from 'phaser';
import { Party } from '../entities/Party';

export type BattleTimerState = 'moving' | 'battle';
export type BattleResult = 'victory' | 'defeat';

const BATTLE_DURATION = 2000;  // 2 seconds of fighting (orange)
const RESULT_DURATION = 1000;  // 1 second to show victory/defeat before moving
const DEFEAT_CHANCE = 0.2;     // 20% chance to lose

export interface BattleTimerCallbacks {
  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
  canMoveToNextTile?: () => boolean; // Check if next tile is accessible (e.g., unlocked)
}

export class BattleTimer {
  private scene: Phaser.Scene;
  private party: Party;
  private state: BattleTimerState = 'battle';

  private battleTimer?: Phaser.Time.TimerEvent;
  private resultTimer?: Phaser.Time.TimerEvent;

  // Events
  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
  canMoveToNextTile?: () => boolean;

  constructor(scene: Phaser.Scene, party: Party, callbacks?: BattleTimerCallbacks) {
    this.scene = scene;
    this.party = party;

    // Set up callbacks BEFORE triggering first battle
    if (callbacks) {
      this.onBattleStart = callbacks.onBattleStart;
      this.onBattleEnd = callbacks.onBattleEnd;
      this.onStateChange = callbacks.onStateChange;
      this.canMoveToNextTile = callbacks.canMoveToNextTile;
    }

    // Start the battle loop after a brief delay to let the scene render first
    this.scene.time.delayedCall(100, () => {
      this.triggerBattle();
    });
  }

  /**
   * Start moving to a destination (called when player clicks a tile).
   * Triggers a battle immediately if not already in battle.
   */
  start(): void {
    if (this.state !== 'battle') {
      this.triggerBattle();
    }
  }

  /**
   * Stop the battle loop entirely.
   */
  stop(): void {
    this.clearTimers();
  }

  private triggerBattle(): void {
    this.setState('battle');
    this.party.enterBattle();
    this.onBattleStart?.();

    // Determine battle outcome after the fight
    this.battleTimer = this.scene.time.addEvent({
      delay: BATTLE_DURATION,
      callback: () => this.showBattleResult(),
      callbackScope: this,
    });
  }

  private showBattleResult(): void {
    // Determine battle outcome
    const isDefeat = Math.random() < DEFEAT_CHANCE;
    const result: BattleResult = isDefeat ? 'defeat' : 'victory';

    // Update party visual to show result
    this.party.exitBattle(result);

    // Notify immediately so fog reveals right away on victory
    this.onBattleEnd?.(result);

    // After showing result, resolve the battle (movement)
    this.resultTimer = this.scene.time.addEvent({
      delay: RESULT_DURATION,
      callback: () => this.resolveBattle(result),
      callbackScope: this,
    });
  }

  private resolveBattle(result: BattleResult): void {

    // Determine if we can move to the next tile
    // Victory always allows movement (unlocks happen in onBattleEnd callback)
    // Defeat only allows movement if the next tile is already accessible (unlocked)
    const canMove = this.party.hasDestination && (
      result === 'victory' ||
      (this.canMoveToNextTile?.() ?? false)
    );

    if (canMove) {
      this.party.moveToNextTile();
    }
    this.setState('moving');

    // When movement completes, trigger next battle
    const checkMovementComplete = () => {
      if (this.party.currentState === 'idle') {
        this.triggerBattle();
      } else {
        // Still moving, check again next frame
        this.scene.time.delayedCall(50, checkMovementComplete);
      }
    };

    // Small delay to let movement tween start
    this.scene.time.delayedCall(50, checkMovementComplete);
  }

  private clearTimers(): void {
    if (this.battleTimer) {
      this.battleTimer.destroy();
      this.battleTimer = undefined;
    }
    if (this.resultTimer) {
      this.resultTimer.destroy();
      this.resultTimer = undefined;
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

  /**
   * Update method (kept for compatibility, no longer needed for text positioning).
   */
  update(): void {
    // No-op - battle text is now HTML-based
  }

  destroy(): void {
    this.clearTimers();
  }
}
