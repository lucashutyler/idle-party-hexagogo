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
