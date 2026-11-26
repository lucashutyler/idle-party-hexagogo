import {
  HexTile,
  HexGrid,
  HexPathfinder,
  cubeToOffset,
} from '@idle-party-rpg/shared';
import type { CubeCoord, PartyState, ServerPartyState } from '@idle-party-rpg/shared';

export interface RouteDoorStep {
  fromTileId: string;
  toTileId: string;
  toMapId: string;
}

/** The doors still ahead of the current leg. Ids only: a grid rebuild makes new HexTiles. */
export interface PartyRoute {
  destinationId: string;
  destinationMapId: string;
  doors: RouteDoorStep[];
  /** `legLengths[k]` is the number of room steps in the leg after `doors[k]`. */
  legLengths: number[];
}

export interface SavedPartyRoute {
  destinationId: string;
  doors: { fromTileId: string; toTileId: string }[];
}

export interface RouteSnapshot {
  queue: HexTile[];
  route: PartyRoute | null;
}

export class ServerParty {
  private pathfinder: HexPathfinder;
  private currentTile: HexTile;
  private targetTile: HexTile | null = null;
  private movementQueue: HexTile[] = [];
  private route: PartyRoute | null = null;
  private state: PartyState = 'idle';
  private mapId: string;
  private lastRoom: HexTile | null = null;
  private retreatTarget: HexTile | null = null;

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
    return this.movementQueue.length > 0 || this.route !== null;
  }

  /** The leg is walked and the party stands in the room of the next door. */
  get doorStepDue(): boolean {
    return this.movementQueue.length === 0 && this.route?.doors[0]?.fromTileId === this.currentTile.id;
  }

  get plannedRoute(): Readonly<PartyRoute> | null {
    return this.route;
  }

  get remainingPath(): HexTile[] {
    return [...this.movementQueue];
  }

  get nextTile(): HexTile | null {
    return this.movementQueue.length > 0 ? this.movementQueue[0] : null;
  }

  /** The room the party last walked in from; never set by a retreat, cleared by any relocation or map change. */
  get previousTile(): HexTile | null {
    return this.lastRoom;
  }

  /** Whether the whole route is the single step a retreat queued. */
  get isRetreatStepQueued(): boolean {
    return this.retreatTarget !== null && this.movementQueue.length === 1 && this.movementQueue[0] === this.retreatTarget;
  }

  /** A walk within this map. Refused, it leaves the queue and any door route as they were. */
  setDestination(destinationTile: HexTile): boolean {
    if (!destinationTile.isTraversable) {
      return false;
    }

    const startTile = this.targetTile ?? this.currentTile;
    if (destinationTile.key === startTile.key) {
      this.movementQueue = [];
      this.route = null;
      return true;
    }

    const path = this.pathfinder.findPath(startTile.coord, destinationTile.coord);

    if (!path || path.length <= 1) {
      return false;
    }

    this.movementQueue = path.slice(1);
    this.route = null;
    return true;
  }

  /** Walk `firstLeg`, then take the route's doors in turn. */
  setRoute(firstLeg: HexTile[], route: PartyRoute): void {
    this.movementQueue = [...firstLeg];
    this.route = route.doors.length > 0 ? copyRoute(route) : null;
  }

  clearDestination(): void {
    this.movementQueue = [];
    this.route = null;
  }

  /** Replace the route with a single step to `tile`; that step won't count as the room the party came from. */
  retreatTo(tile: HexTile): void {
    this.movementQueue = [tile];
    this.route = null;
    this.retreatTarget = tile;
  }

  /** The queue and door route together, so a refused order can put both back. */
  routeSnapshot(): RouteSnapshot {
    return { queue: [...this.movementQueue], route: this.route ? copyRoute(this.route) : null };
  }

  restoreRoute(snapshot: RouteSnapshot): void {
    this.movementQueue = [...snapshot.queue];
    this.route = snapshot.route ? copyRoute(snapshot.route) : null;
  }

  /** Put back a saved door route; the queue it continues from is restored separately. */
  restoreSavedRoute(route: PartyRoute): void {
    this.route = route.doors.length > 0 ? copyRoute(route) : null;
  }

  routeSave(): SavedPartyRoute | undefined {
    if (!this.route) return undefined;
    return {
      destinationId: this.route.destinationId,
      doors: this.route.doors.map(d => ({ fromTileId: d.fromTileId, toTileId: d.toTileId })),
    };
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
    const retreating = nextTile === this.retreatTarget;
    this.retreatTarget = null;
    this.lastRoom = retreating ? null : this.currentTile;

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
    this.route = null;
    this.lastRoom = null;
    this.retreatTarget = null;
  }

  /**
   * Move the party to a different map: swap the pathfinder to the new map's grid,
   * snap to `tile`, and clear all movement state. `relocateTo` alone is insufficient
   * because the pathfinder is bound to a single grid.
   */
  switchMap(grid: HexGrid, tile: HexTile, mapId: string): void {
    this.enterMap(grid, tile, mapId);
    this.route = null;
  }

  /** Step through the route's next door to `arrival`, then walk `nextLeg`. */
  crossDoor(grid: HexGrid, arrival: HexTile, mapId: string, nextLeg: HexTile[]): void {
    this.enterMap(grid, arrival, mapId);
    this.movementQueue = [...nextLeg];
    if (!this.route) return;
    this.route.doors.shift();
    this.route.legLengths.shift();
    if (this.route.doors.length === 0) this.route = null;
  }

  enterBattle(): void {
    this.setState('in_battle');
  }

  exitBattle(): void {
    if (this.state === 'in_battle') {
      this.setState('idle');
    }
  }

  toJSON(): ServerPartyState {
    const offset = cubeToOffset(this.currentTile.coord);
    const target = this.targetTile ? cubeToOffset(this.targetTile.coord) : undefined;
    const json: ServerPartyState = {
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
    const route = this.route;
    if (route) {
      json.route = {
        destinationId: route.destinationId,
        destinationMapId: route.destinationMapId,
        doors: route.doors.length,
        rooms: this.movementQueue.length + route.doors.length + route.legLengths.reduce((sum, n) => sum + n, 0),
        leavesMap: this.routeLeavesMap(route),
      };
    }
    return json;
  }

  private routeLeavesMap(route: PartyRoute): boolean {
    let mapId = this.mapId;
    for (const door of route.doors) {
      if (door.toMapId !== mapId) return true;
      mapId = door.toMapId;
    }
    return false;
  }

  private enterMap(grid: HexGrid, tile: HexTile, mapId: string): void {
    this.pathfinder = new HexPathfinder(grid);
    this.mapId = mapId;
    this.currentTile = tile;
    this.targetTile = null;
    this.movementQueue = [];
    this.lastRoom = null;
    this.retreatTarget = null;
  }

  private setState(newState: PartyState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(newState);
    }
  }
}

function copyRoute(route: PartyRoute): PartyRoute {
  return {
    destinationId: route.destinationId,
    destinationMapId: route.destinationMapId,
    doors: route.doors.map(d => ({ ...d })),
    legLengths: [...route.legLengths],
  };
}
