import Phaser from 'phaser';
import { Party } from '../entities/Party';

export type BattleTimerState = 'moving' | 'battle';
export type BattleResult = 'victory' | 'defeat';

const BATTLE_DURATION = 1200;  // ms for battle animation
const RESULT_DURATION = 600;   // ms to show result before continuing
const DEFEAT_CHANCE = 0.2;     // 20% chance to lose

export interface BattleTimerCallbacks {
  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
}

export class BattleTimer {
  private scene: Phaser.Scene;
  private party: Party;
  private state: BattleTimerState = 'battle';

  private battleTimer?: Phaser.Time.TimerEvent;
  private resultTimer?: Phaser.Time.TimerEvent;

  // UI elements
  private battleText?: Phaser.GameObjects.Text;

  // Events
  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;

  constructor(scene: Phaser.Scene, party: Party, callbacks?: BattleTimerCallbacks) {
    this.scene = scene;
    this.party = party;

    // Set up callbacks BEFORE triggering first battle
    if (callbacks) {
      this.onBattleStart = callbacks.onBattleStart;
      this.onBattleEnd = callbacks.onBattleEnd;
      this.onStateChange = callbacks.onStateChange;
    }

    // Create battle text (hidden initially)
    this.battleText = scene.add.text(0, 0, '', {
      fontSize: '24px',
      fontFamily: 'Arial',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 4,
    });
    this.battleText.setOrigin(0.5);
    this.battleText.setDepth(200);
    this.battleText.setVisible(false);

    // Start the battle loop immediately
    this.triggerBattle();
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
    this.hideBattleText();
  }

  private triggerBattle(): void {
    this.setState('battle');
    this.party.enterBattle();
    this.onBattleStart?.();

    // Show battle text
    this.showBattleText('⚔️ BATTLE! ⚔️', 'fighting');

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

    // Show result text
    this.showBattleText(
      isDefeat ? '💀 DEFEAT!' : '✓ VICTORY!',
      isDefeat ? 'defeat' : 'victory'
    );

    // After showing result, resolve the battle
    this.resultTimer = this.scene.time.addEvent({
      delay: RESULT_DURATION,
      callback: () => this.resolveBattle(result),
      callbackScope: this,
    });
  }

  private resolveBattle(result: BattleResult): void {
    this.hideBattleText();
    this.party.exitBattle();
    this.onBattleEnd?.(result);

    // Move to next tile if we have a destination (regardless of victory/defeat)
    // Victory unlocks new tiles (handled by onBattleEnd callback)
    // Defeat just continues movement through already-unlocked tiles
    if (this.party.hasDestination) {
      this.party.moveToNextTile();
    }
    this.setState('moving');

    // When movement completes (or immediately if no movement), trigger next battle
    const checkMovementComplete = () => {
      if (this.party.currentState === 'idle') {
        this.triggerBattle();
      } else {
        // Still moving, check again next frame
        this.scene.time.delayedCall(50, checkMovementComplete);
      }
    };

    // Small delay to let movement tween start (or proceed immediately if no movement)
    this.scene.time.delayedCall(50, checkMovementComplete);
  }

  private showBattleText(text: string, type: 'fighting' | 'victory' | 'defeat'): void {
    if (!this.battleText) return;

    // Kill any existing tweens
    this.scene.tweens.killTweensOf(this.battleText);

    const sprite = this.party.getSprite();
    this.battleText.setText(text);
    this.battleText.setPosition(sprite.x, sprite.y - 50);
    this.battleText.setScale(1);
    this.battleText.setVisible(true);

    // Set color based on type
    switch (type) {
      case 'fighting':
        this.battleText.setColor('#ffff44');
        // Pulsing animation during fight
        this.scene.tweens.add({
          targets: this.battleText,
          scaleX: 1.1,
          scaleY: 1.1,
          duration: 150,
          yoyo: true,
          repeat: -1,
        });
        break;
      case 'victory':
        this.battleText.setColor('#44ff44');
        // Pop-in animation for victory
        this.battleText.setScale(0.5);
        this.scene.tweens.add({
          targets: this.battleText,
          scaleX: 1.2,
          scaleY: 1.2,
          duration: 200,
          ease: 'Back.easeOut',
        });
        break;
      case 'defeat':
        this.battleText.setColor('#ff4444');
        // Shake animation for defeat
        this.scene.tweens.add({
          targets: this.battleText,
          x: sprite.x - 5,
          duration: 50,
          yoyo: true,
          repeat: 3,
        });
        break;
    }
  }

  private hideBattleText(): void {
    if (!this.battleText) return;

    this.scene.tweens.killTweensOf(this.battleText);
    this.battleText.setVisible(false);
    this.battleText.setScale(1);
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
   * Update battle text position to follow party.
   */
  update(): void {
    if (this.battleText?.visible) {
      const sprite = this.party.getSprite();
      // Only update Y position, X might be tweening for shake effect
      this.battleText.y = sprite.y - 50;
      if (this.state === 'battle') {
        this.battleText.x = sprite.x;
      }
    }
  }

  destroy(): void {
    this.clearTimers();
    this.battleText?.destroy();
  }
}
