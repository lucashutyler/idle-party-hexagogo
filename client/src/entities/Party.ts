import Phaser from 'phaser';
import {
  cubeToPixel,
  offsetToCube,
  MOVE_DURATION,
} from '@idle-party-rpg/shared';
import type { ServerPartyState, BattleVisual } from '@idle-party-rpg/shared';

// Party colors for different states
const PARTY_COLOR_DEFAULT = 0x44ff88;   // Green (default/victory - keep moving!)
const PARTY_COLOR_FIGHTING = 0xffaa44;  // Orange (in combat)
const PARTY_COLOR_DEFEAT = 0xff6b6b;    // Coral red (lost)

/**
 * Pure rendering puppet — no game logic.
 * Position and visual state are driven entirely by `applyServerState()`.
 */
export class Party {
  private scene: Phaser.Scene;
  private sprite: Phaser.GameObjects.Arc;
  private offsetX: number;
  private offsetY: number;

  private lastCol: number;
  private lastRow: number;
  private moveTween?: Phaser.Tweens.Tween;
  private battleTween?: Phaser.Tweens.Tween;

  constructor(
    scene: Phaser.Scene,
    startCol: number,
    startRow: number,
    offsetX: number = 0,
    offsetY: number = 0,
  ) {
    this.scene = scene;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.lastCol = startCol;
    this.lastRow = startRow;

    // Create party sprite (simple circle for now)
    const pixel = cubeToPixel(offsetToCube({ col: startCol, row: startRow }));
    this.sprite = scene.add.circle(
      pixel.x + offsetX,
      pixel.y + offsetY,
      15,
      PARTY_COLOR_DEFAULT,
    );
    this.sprite.setStrokeStyle(3, 0xffffff);
    this.sprite.setDepth(100);
  }

  /**
   * Apply the latest server state.
   * @param party   Server-provided party position/state
   * @param visual  Current battle visual from server
   * @param snap    If true, teleport instead of tween (used on initial connect)
   */
  applyServerState(party: ServerPartyState, visual: BattleVisual, snap: boolean): void {
    const posChanged = party.col !== this.lastCol || party.row !== this.lastRow;

    if (posChanged) {
      const pixel = cubeToPixel(offsetToCube({ col: party.col, row: party.row }));
      const targetX = pixel.x + this.offsetX;
      const targetY = pixel.y + this.offsetY;

      if (snap) {
        // Teleport (initial state or reconnect)
        this.sprite.setPosition(targetX, targetY);
      } else {
        // Kill any stacking tween
        if (this.moveTween) {
          this.moveTween.stop();
          this.moveTween = undefined;
        }

        this.moveTween = this.scene.tweens.add({
          targets: this.sprite,
          x: targetX,
          y: targetY,
          duration: MOVE_DURATION,
          ease: 'Quad.easeInOut',
          onComplete: () => {
            this.moveTween = undefined;
          },
        });
      }

      this.lastCol = party.col;
      this.lastRow = party.row;
    }

    // Apply battle visual
    this.applyBattleVisual(visual);
  }

  private applyBattleVisual(visual: BattleVisual): void {
    // Update color
    let color: number;
    switch (visual) {
      case 'fighting':
        color = PARTY_COLOR_FIGHTING;
        break;
      case 'defeat':
        color = PARTY_COLOR_DEFEAT;
        break;
      case 'victory':
      default:
        color = PARTY_COLOR_DEFAULT;
    }
    this.sprite.setFillStyle(color);

    // Manage throb animation
    if (visual === 'fighting' && !this.battleTween) {
      this.battleTween = this.scene.tweens.add({
        targets: this.sprite,
        scaleX: 1.2,
        scaleY: 1.2,
        duration: 150,
        yoyo: true,
        repeat: -1,
      });
    } else if (visual !== 'fighting' && this.battleTween) {
      this.battleTween.stop();
      this.battleTween = undefined;
      this.sprite.setScale(1);
    }
  }

  /**
   * Get the sprite for camera following.
   */
  getSprite(): Phaser.GameObjects.Arc {
    return this.sprite;
  }

  /**
   * Destroy the party sprite and clean up tweens.
   */
  destroy(): void {
    this.moveTween?.stop();
    this.battleTween?.stop();
    this.sprite.destroy();
  }
}
