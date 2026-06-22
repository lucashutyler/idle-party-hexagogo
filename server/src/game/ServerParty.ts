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
  private mapId: string;

  onStateChange?: (state: PartyState) => void;
  onTileReached?: (tile: HexTile) => void;
  onDestinationReached?: () => void;

  constructor(grid: HexGrid, startTile: HexTile, mapId: string) {
    this.pathfinder = new HexPathfinder(grid);
    this.currentTile = startTile;
    this.mapId = mapId;
  }

  /**
   * Restore party state from saved data.
   */
  static restore(
    grid: HexGrid,
    currentTile: HexTile,
    targetTile: HexTile | null,
    movementQueue: HexTile[],
    mapId: string,
  ): ServerParty {
    const party = new ServerParty(grid, currentTile, mapId);
    party.targetTile = targetTile;
    party.movementQueue = movementQueue;
    return party;
  }

  get position(): CubeCoord {
    return this.currentTile.coord;
  }

  /** The map this party is currently on. */
  get currentMapId(): string {
    return this.mapId;
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

  /** Force-relocate the party to a new tile, clearing all movement state. */
  relocateTo(tile: HexTile): void {
    this.currentTile = tile;
    this.targetTile = null;
    this.movementQueue = [];
  }

  /**
   * Move the party to a different map: swap the pathfinder to the new map's grid,
   * snap to `tile`, and clear all movement state. `relocateTo` alone is insufficient
   * because the pathfinder is bound to a single grid.
   */
  switchMap(grid: HexGrid, tile: HexTile, mapId: string): void {
    this.pathfinder = new HexPathfinder(grid);
    this.mapId = mapId;
    this.currentTile = tile;
    this.targetTile = null;
    this.movementQueue = [];
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
