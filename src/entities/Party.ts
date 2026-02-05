import Phaser from 'phaser';
import { CubeCoord } from '../utils/HexUtils';
import { HexTile } from '../map/HexTile';
import { HexGrid } from '../map/HexGrid';
import { HexPathfinder } from '../map/HexPathfinder';

export type PartyState = 'idle' | 'moving' | 'in_battle';
export type BattleVisualState = 'none' | 'fighting' | 'victory' | 'defeat';

const MOVE_DURATION = 300; // ms per tile movement

// Party colors for different states
const PARTY_COLOR_DEFAULT = 0x44ff88;   // Green (default/victory - keep moving!)
const PARTY_COLOR_FIGHTING = 0xffaa44;  // Orange (in combat)
const PARTY_COLOR_DEFEAT = 0xff6b6b;    // Coral red (lost)

export class Party {
  private scene: Phaser.Scene;
  private sprite: Phaser.GameObjects.Arc;
  private pathfinder: HexPathfinder;

  private currentTile: HexTile;
  private targetTile: HexTile | null = null;  // Tile we're currently moving towards
  private movementQueue: HexTile[] = [];
  private battleTween?: Phaser.Tweens.Tween;
  private state: PartyState = 'idle';

  // Event callbacks
  onStateChange?: (state: PartyState) => void;
  onTileReached?: (tile: HexTile) => void;
  onDestinationReached?: () => void;

  constructor(
    scene: Phaser.Scene,
    grid: HexGrid,
    startTile: HexTile,
    offsetX: number = 0,
    offsetY: number = 0
  ) {
    this.scene = scene;
    this.pathfinder = new HexPathfinder(grid);
    this.currentTile = startTile;

    // Create party sprite (simple circle for now)
    const pos = startTile.pixelPosition;
    this.sprite = scene.add.circle(
      pos.x + offsetX,
      pos.y + offsetY,
      15,
      0xff6b6b
    );
    this.sprite.setStrokeStyle(3, 0xffffff);
    this.sprite.setDepth(100);
  }

  get position(): CubeCoord {
    return this.currentTile.coord;
  }

  get tile(): HexTile {
    return this.currentTile;
  }

  get currentState(): PartyState {
    return this.state;
  }

  get hasDestination(): boolean {
    return this.movementQueue.length > 0;
  }

  get remainingPath(): HexTile[] {
    return [...this.movementQueue];
  }

  /**
   * Get the next tile in the movement queue without removing it.
   */
  get nextTile(): HexTile | null {
    return this.movementQueue.length > 0 ? this.movementQueue[0] : null;
  }

  /**
   * Set a new destination. Calculates path and queues movement.
   * Returns true if a valid path was found.
   */
  setDestination(destinationTile: HexTile): boolean {
    if (!destinationTile.isTraversable) {
      return false;
    }

    // If we're mid-movement, calculate path from where we're heading, not where we are
    const startTile = this.targetTile ?? this.currentTile;
    const path = this.pathfinder.findPath(startTile.coord, destinationTile.coord);

    if (!path || path.length <= 1) {
      return false;
    }

    // Remove start tile from path (we're already there or heading there)
    this.movementQueue = path.slice(1);
    return true;
  }

  /**
   * Clear the current movement queue.
   */
  clearDestination(): void {
    this.movementQueue = [];
  }

  /**
   * Move to the next tile in the queue.
   * Called by the battle timer after each battle.
   * Returns true if movement occurred.
   */
  moveToNextTile(): boolean {
    if (this.movementQueue.length === 0) {
      return false;
    }

    if (this.state === 'moving') {
      return false;
    }

    const nextTile = this.movementQueue.shift()!;
    this.targetTile = nextTile;  // Track where we're heading
    this.setState('moving');

    const targetPos = nextTile.pixelPosition;
    const offsetX = this.sprite.x - this.currentTile.pixelPosition.x;
    const offsetY = this.sprite.y - this.currentTile.pixelPosition.y;

    this.scene.tweens.add({
      targets: this.sprite,
      x: targetPos.x + offsetX,
      y: targetPos.y + offsetY,
      duration: MOVE_DURATION,
      ease: 'Quad.easeInOut',
      onComplete: () => {
        this.currentTile = nextTile;
        this.targetTile = null;  // Clear target, we've arrived
        this.setState('idle');
        this.onTileReached?.(nextTile);

        if (this.movementQueue.length === 0) {
          this.onDestinationReached?.();
        }
      },
    });

    return true;
  }

  /**
   * Set battle state (visual feedback).
   */
  enterBattle(): void {
    this.setState('in_battle');
    this.setBattleVisual('fighting');

    // Visual feedback: continuous throb animation during battle
    this.battleTween = this.scene.tweens.add({
      targets: this.sprite,
      scaleX: 1.2,
      scaleY: 1.2,
      duration: 150,
      yoyo: true,
      repeat: -1,  // Loop forever until stopped
    });
  }

  /**
   * Exit battle state with result.
   */
  exitBattle(result?: 'victory' | 'defeat'): void {
    // Stop the throb animation
    if (this.battleTween) {
      this.battleTween.stop();
      this.battleTween = undefined;
      // Reset scale to normal
      this.sprite.setScale(1);
    }

    if (this.state === 'in_battle') {
      this.setState('idle');
    }

    if (result) {
      this.setBattleVisual(result);
    }
  }

  /**
   * Set the visual state of the party (color indicator).
   */
  setBattleVisual(visualState: BattleVisualState): void {
    let color: number;
    switch (visualState) {
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
  }

  private setState(newState: PartyState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(newState);
    }
  }

  /**
   * Get the sprite for camera following.
   */
  getSprite(): Phaser.GameObjects.Arc {
    return this.sprite;
  }

  /**
   * Destroy the party sprite.
   */
  destroy(): void {
    this.sprite.destroy();
  }
}
