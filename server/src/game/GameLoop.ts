import {
  HexGrid,
  UnlockSystem,
  generateWorldMap,
  getStartingPosition,
  offsetToCube,
} from '@idle-party-rpg/shared';
import type { BattleResult, ServerStateMessage } from '@idle-party-rpg/shared';
import { ServerParty } from './ServerParty';
import { ServerBattleTimer } from './ServerBattleTimer';

export class GameLoop {
  private grid: HexGrid;
  private party: ServerParty;
  private battleTimer: ServerBattleTimer;
  private unlockSystem: UnlockSystem;

  private onStateChange?: () => void;

  constructor(onStateChange?: () => void) {
    this.onStateChange = onStateChange;

    // Generate world map
    this.grid = generateWorldMap();
    const startPos = getStartingPosition();
    const startCoord = offsetToCube(startPos);
    const startTile = this.grid.getTile(startCoord);

    if (!startTile) {
      throw new Error('Invalid starting position');
    }

    // Initialize unlock system
    this.unlockSystem = new UnlockSystem(this.grid, startTile);

    // Initialize party
    this.party = new ServerParty(this.grid, startTile);

    // Initialize battle timer with game logic callbacks
    this.battleTimer = new ServerBattleTimer(this.party, {
      onStateChange: () => {
        this.broadcastState();
      },
      onBattleEnd: (result: BattleResult) => {
        if (result === 'victory') {
          this.unlockSystem.unlockAdjacentTiles(this.party.tile);
        }
        this.broadcastState();
      },
      canMoveToNextTile: () => {
        const nextTile = this.party.nextTile;
        return nextTile ? this.unlockSystem.isUnlocked(nextTile) : false;
      },
    });

    this.party.onTileReached = () => {
      this.broadcastState();
    };

    console.log(`Game loop started. Map: ${this.grid.size} tiles, ${this.unlockSystem.unlockedCount} unlocked`);
  }

  /**
   * Handle a move command from a client.
   */
  handleMove(col: number, row: number): boolean {
    const coord = offsetToCube({ col, row });
    const tile = this.grid.getTile(coord);

    if (!tile || !tile.isTraversable) {
      return false;
    }

    const success = this.party.setDestination(tile);

    if (success && this.battleTimer.currentState === 'moving') {
      this.battleTimer.start();
    }

    this.broadcastState();
    return success;
  }

  /**
   * Get the current game state for sending to clients.
   */
  getState(): Omit<ServerStateMessage, 'type'> {
    return {
      party: this.party.toJSON(),
      battle: {
        state: this.battleTimer.currentState,
        result: this.battleTimer.lastResult,
        visual: this.battleTimer.visual,
      },
      unlocked: this.unlockSystem.getUnlockedKeys(),
      mapSize: this.grid.size,
    };
  }

  private broadcastState(): void {
    this.onStateChange?.();
  }

  destroy(): void {
    this.battleTimer.destroy();
  }
}
