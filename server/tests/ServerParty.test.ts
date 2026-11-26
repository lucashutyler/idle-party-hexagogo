import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HexGrid,
  HexTile,
  offsetToCube,
  createMonsterInstance,
  createPartyCombatState,
  DEFAULT_MAP_ID,
  MOVE_DURATION,
  RESULT_PAUSE,
  RUN_AVAILABLE_MS,
} from '@idle-party-rpg/shared';
import type { PartyCombatantInit, PartyCombatState } from '@idle-party-rpg/shared';
import { ServerParty } from '../src/game/ServerParty.js';
import type { PartyRoute } from '../src/game/ServerParty.js';
import { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';

function corridor(length: number): HexGrid {
  const grid = new HexGrid();
  for (let col = 0; col < length; col++) {
    grid.addTile(new HexTile(offsetToCube({ col, row: 0 }), 'plains', 'briar_hollow', `room-${col}`));
  }
  return grid;
}

function tileAt(grid: HexGrid, col: number): HexTile {
  return grid.getTile(offsetToCube({ col, row: 0 }))!;
}

describe('ServerParty.setDestination', () => {
  it('queues the path to another room', () => {
    const grid = corridor(4);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);

    expect(party.setDestination(tileAt(grid, 3))).toBe(true);
    expect(party.remainingPath.map(t => t.id)).toEqual(['room-1', 'room-2', 'room-3']);
  });

  it('stops a party mid-route when the destination is the room it is standing on', () => {
    const grid = corridor(4);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);
    party.setDestination(tileAt(grid, 3));
    party.moveToNextTile();

    expect(party.setDestination(tileAt(grid, 1))).toBe(true);
    expect(party.hasDestination).toBe(false);
    expect(party.tile.id).toBe('room-1');
  });

  it('turns a party around when it has already left the requested room', () => {
    const grid = corridor(4);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);
    party.setDestination(tileAt(grid, 3));
    party.moveToNextTile();
    party.moveToNextTile();

    expect(party.setDestination(tileAt(grid, 1))).toBe(true);
    expect(party.remainingPath.map(t => t.id)).toEqual(['room-1']);
  });

  it('accepts the current room while idle without queuing anything', () => {
    const grid = corridor(2);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);

    expect(party.setDestination(tileAt(grid, 0))).toBe(true);
    expect(party.hasDestination).toBe(false);
  });
});

describe('ServerParty door routes', () => {
  function isle(prefix: string, length: number): HexGrid {
    const grid = new HexGrid();
    for (let col = 0; col < length; col++) {
      grid.addTile(new HexTile(offsetToCube({ col, row: 0 }), 'plains', 'briar_hollow', `${prefix}-${col}`));
    }
    return grid;
  }

  /** Walk room-0 → room-2, cross into isle b at b-0, walk to b-2, cross again into b-0's twin c-0. */
  function routed() {
    const a = corridor(4);
    const b = isle('b', 3);
    const party = new ServerParty(a, tileAt(a, 0), 'a');
    const route: PartyRoute = {
      destinationId: 'c-1',
      destinationMapId: 'c',
      doors: [
        { fromTileId: 'room-2', toTileId: 'b-0', toMapId: 'b' },
        { fromTileId: 'b-2', toTileId: 'c-0', toMapId: 'c' },
      ],
      legLengths: [2, 1],
    };
    party.setRoute([tileAt(a, 1), tileAt(a, 2)], route);
    return { a, b, party, route };
  }

  it('has somewhere to go while a door is left, and owes the door step once the leg is walked', () => {
    const { party } = routed();
    expect(party.hasDestination).toBe(true);
    expect(party.doorStepDue).toBe(false);
    party.moveToNextTile();
    party.moveToNextTile();
    expect(party.remainingPath).toEqual([]);
    expect(party.hasDestination).toBe(true);
    expect(party.doorStepDue).toBe(true);
  });

  it('crosses into the next map, walks the next leg and drops the route with its last door', () => {
    const { b, party } = routed();
    party.moveToNextTile();
    party.moveToNextTile();
    party.crossDoor(b, b.getTileById('b-0')!, 'b', [b.getTileById('b-1')!, b.getTileById('b-2')!]);
    expect(party.currentMapId).toBe('b');
    expect(party.tile.id).toBe('b-0');
    expect(party.previousTile).toBeNull();
    expect(party.remainingPath.map(t => t.id)).toEqual(['b-1', 'b-2']);
    expect(party.plannedRoute?.doors.map(d => d.toTileId)).toEqual(['c-0']);
    expect(party.plannedRoute?.legLengths).toEqual([1]);

    party.moveToNextTile();
    party.moveToNextTile();
    expect(party.doorStepDue).toBe(true);
    const c = isle('c', 2);
    party.crossDoor(c, c.getTileById('c-0')!, 'c', [c.getTileById('c-1')!]);
    expect(party.plannedRoute).toBeNull();
    expect(party.hasDestination).toBe(true);
    expect(party.doorStepDue).toBe(false);
    expect(party.toJSON().route).toBeUndefined();
    party.moveToNextTile();
    expect(party.hasDestination).toBe(false);
  });

  it('reports the doors and every room still ahead while a door is left', () => {
    const { party } = routed();
    expect(party.toJSON().route).toEqual({ destinationId: 'c-1', destinationMapId: 'c', doors: 2, rooms: 7, leavesMap: true });
    expect(party.toJSON().path.map(p => p.col)).toEqual([1, 2]);
    party.moveToNextTile();
    expect(party.toJSON().route?.rooms).toBe(6);
  });

  it('says a route stays on its map when every door does', () => {
    const a = corridor(6);
    const party = new ServerParty(a, tileAt(a, 0), 'a');
    party.setRoute([tileAt(a, 1)], { destinationId: 'room-5', destinationMapId: 'a', doors: [{ fromTileId: 'room-1', toTileId: 'room-4', toMapId: 'a' }], legLengths: [1] });
    expect(party.toJSON().route?.leavesMap).toBe(false);
  });

  it.each([
    ['a new walk', (p: ServerParty, g: HexGrid) => { expect(p.setDestination(tileAt(g, 3))).toBe(true); }],
    ['a stop', (p: ServerParty) => p.clearDestination()],
    ['a retreat', (p: ServerParty, g: HexGrid) => p.retreatTo(tileAt(g, 1))],
    ['a relocation', (p: ServerParty, g: HexGrid) => p.relocateTo(tileAt(g, 3))],
    ['a map switch', (p: ServerParty) => { const other = corridor(2); p.switchMap(other, tileAt(other, 0), 'z'); }],
  ])('drops the door route on %s', (_name, act) => {
    const { a, party } = routed();
    act(party, a);
    expect(party.plannedRoute).toBeNull();
    expect(party.toJSON().route).toBeUndefined();
  });

  it('keeps the door route when a walk is refused', () => {
    const { party } = routed();
    const island = new HexTile(offsetToCube({ col: 9, row: 9 }), 'plains', 'briar_hollow', 'island');
    expect(party.setDestination(island)).toBe(false);
    expect(party.plannedRoute?.doors).toHaveLength(2);
    expect(party.remainingPath.map(t => t.id)).toEqual(['room-1', 'room-2']);
  });

  it('puts queue and route back together from a snapshot, and saves the doors by id', () => {
    const { a, party } = routed();
    const snapshot = party.routeSnapshot();
    party.setDestination(tileAt(a, 3));
    party.restoreRoute(snapshot);
    expect(party.remainingPath.map(t => t.id)).toEqual(['room-1', 'room-2']);
    expect(party.routeSave()).toEqual({
      destinationId: 'c-1',
      doors: [{ fromTileId: 'room-2', toTileId: 'b-0' }, { fromTileId: 'b-2', toTileId: 'c-0' }],
    });
    party.clearDestination();
    expect(party.routeSave()).toBeUndefined();
  });
});

describe('ServerBattleTimer stepping after a battle', () => {
  function longFight(): PartyCombatState {
    const player: PartyCombatantInit = {
      username: 'alice',
      maxHp: 1_000_000,
      baseDamage: 1,
      playerDamageType: 'physical',
      gridPosition: 4,
      className: 'Knight',
      level: 1,
      equippedSkills: [null, null, null, null, null],
    };
    const monster = createMonsterInstance(
      { id: 'dummy', name: 'Dummy', hp: 1_000_000, damage: 1, damageType: 'physical', xp: 5, goldMin: 0, goldMax: 0 },
      4,
    );
    return createPartyCombatState([player], [monster]);
  }

  function escapedOnRoute() {
    const grid = corridor(4);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);
    party.setDestination(tileAt(grid, 3));
    const onMove = vi.fn();
    const timer = new ServerBattleTimer(party, longFight, { onMove, canMoveToNextTile: () => true });
    timer.start();
    vi.advanceTimersByTime(RUN_AVAILABLE_MS);
    expect(timer.escapeBattle()).toBe(true);
    expect(timer.currentState).toBe('result');
    return { grid, party, onMove, timer };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('takes the queued step once the result pause is over', () => {
    const { party, onMove, timer } = escapedOnRoute();

    vi.advanceTimersByTime(RESULT_PAUSE - 1);
    expect(onMove).not.toHaveBeenCalled();
    expect(party.tile.id).toBe('room-0');

    vi.advanceTimersByTime(1);
    expect(onMove).toHaveBeenCalledOnce();
    expect(party.tile.id).toBe('room-1');
    timer.destroy();
  });

  function atDoor(crosses: boolean) {
    const grid = corridor(2);
    const party = new ServerParty(grid, tileAt(grid, 0), DEFAULT_MAP_ID);
    party.setRoute([], { destinationId: 'far', destinationMapId: 'elsewhere', doors: [{ fromTileId: 'room-0', toTileId: 'far', toMapId: 'elsewhere' }], legLengths: [0] });
    const onMove = vi.fn();
    const onBattleStart = vi.fn();
    const onDoorStep = vi.fn(() => {
      party.clearDestination();
      return crosses;
    });
    const timer = new ServerBattleTimer(party, longFight, { onMove, onBattleStart, onDoorStep, canMoveToNextTile: () => party.doorStepDue });
    timer.start();
    vi.advanceTimersByTime(RUN_AVAILABLE_MS);
    expect(timer.walksOn).toBe(true);
    expect(timer.escapeBattle()).toBe(true);
    return { party, onMove, onBattleStart, onDoorStep, timer };
  }

  it.each([[true], [false]])('starts exactly one fight a walk after a door step (crossed: %s)', (crosses) => {
    const { party, onMove, onBattleStart, onDoorStep, timer } = atDoor(crosses);
    vi.advanceTimersByTime(RESULT_PAUSE);
    expect(onDoorStep).toHaveBeenCalledOnce();
    expect(onMove).not.toHaveBeenCalled();
    expect(onBattleStart).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MOVE_DURATION - 1);
    expect(onBattleStart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onBattleStart).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(MOVE_DURATION * 5);
    expect(onBattleStart).toHaveBeenCalledTimes(2);
    expect(party.tile.id).toBe('room-0');
    timer.destroy();
  });

  it('does not report a move when the party stops during the result pause', () => {
    const { grid, party, onMove, timer } = escapedOnRoute();
    const escapedBattleId = timer.battleId;

    expect(party.setDestination(tileAt(grid, 0))).toBe(true);
    expect(party.hasDestination).toBe(false);
    vi.advanceTimersByTime(RESULT_PAUSE);

    expect(onMove).not.toHaveBeenCalled();
    expect(party.tile.id).toBe('room-0');

    vi.advanceTimersByTime(MOVE_DURATION);
    expect(timer.battleId).not.toBe(escapedBattleId);
    timer.destroy();
  });
});
