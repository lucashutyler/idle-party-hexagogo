import {
  HexTile,
  HexGrid,
  HexPathfinder,
  cubeToOffset,
} from '@idle-party-rpg/shared';
import type { CubeCoord, PartyState, ServerPartyState } from '@idle-party-rpg/shared';

export class ServerParty {
  private pathfinder: HexPathfinder;
  private currentTile: HexTile;
  private targetTile: HexTile | null = null;
  private movementQueue: HexTile[] = [];
  private state: PartyState = 'idle';

  onStateChange?: (state: PartyState) => void;
  onTileReached?: (tile: HexTile) => void;
  onDestinationReached?: () => void;

  constructor(grid: HexGrid, startTile: HexTile) {
    this.pathfinder = new HexPathfinder(grid);
    this.currentTile = startTile;
  }

  /**
   * Restore party state from saved data.
   */
  static restore(
    grid: HexGrid,
    currentTile: HexTile,
    targetTile: HexTile | null,
    movementQueue: HexTile[],
  ): ServerParty {
    const party = new ServerParty(grid, currentTile);
    party.targetTile = targetTile;
    party.movementQueue = movementQueue;
    return party;
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

  get nextTile(): HexTile | null {
    return this.movementQueue.length > 0 ? this.movementQueue[0] : null;
  }

  setDestination(destinationTile: HexTile): boolean {
    if (!destinationTile.isTraversable) {
      return false;
    }

    const startTile = this.targetTile ?? this.currentTile;
    const path = this.pathfinder.findPath(startTile.coord, destinationTile.coord);

    if (!path || path.length <= 1) {
      return false;
    }

    this.movementQueue = path.slice(1);
    return true;
  }

  clearDestination(): void {
    this.movementQueue = [];
  }

  /**
   * Move to the next tile instantly (server-side, no tweens).
   * Returns true if movement occurred.
   */
  moveToNextTile(): boolean {
    if (this.movementQueue.length === 0) {
      return false;
    }

    const nextTile = this.movementQueue.shift()!;

    // Server movement is instant — just update position
    this.currentTile = nextTile;
    this.targetTile = null;
    this.onTileReached?.(nextTile);

    if (this.movementQueue.length === 0) {
      this.onDestinationReached?.();
    }

    return true;
  }

  enterBattle(): void {
    this.setState('in_battle');
  }

  exitBattle(): void {
    if (this.state === 'in_battle') {
      this.setState('idle');
    }
  }

  private setState(newState: PartyState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(newState);
    }
  }

  toJSON(): ServerPartyState {
    const offset = cubeToOffset(this.currentTile.coord);
    const target = this.targetTile ? cubeToOffset(this.targetTile.coord) : undefined;
    return {
      col: offset.col,
      row: offset.row,
      state: this.state,
      targetCol: target?.col,
      targetRow: target?.row,
      path: this.movementQueue.map(t => {
        const o = cubeToOffset(t.coord);
        return { col: o.col, row: o.row };
      }),
    };
  }
}
