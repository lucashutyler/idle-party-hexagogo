import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAP_ID, HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import type { PlayerSaveData } from '../src/game/GameStateStore.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import { itemRulesContent } from './itemRulesFixture.js';
import { wrapGrids } from './testGrids.js';

function grids() {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'town', 'start', 'tile-start'));
  return wrapGrids(grid);
}

function save(inventory: unknown, equipment: Record<string, string | null> = {}): PlayerSaveData {
  return {
    username: 'alice',
    battleCount: 0,
    combatLog: [],
    unlockedKeys: ['tile-start'],
    position: { col: 0, row: 0 },
    target: null,
    movementQueue: [],
    character: { className: 'Knight', level: 3, xp: 0, inventory: inventory as Record<string, number>, equipment },
  };
}

function restoredBag(data: PlayerSaveData): { inventory?: Record<string, number>; equipment?: Record<string, string | null> } {
  const session = PlayerSession.fromSaveData(data, grids(), itemRulesContent());
  const saved = session.toSaveData({ position: { col: 0, row: 0 }, mapId: DEFAULT_MAP_ID, target: null, movementQueue: [] });
  return { inventory: saved.character?.inventory, equipment: saved.character?.equipment };
}

function inventoryLines(log: { mock: { calls: unknown[][] } }): string[] {
  return log.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('[PlayerSession] alice: inventory'));
}

describe('restoring an inventory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops stacks below one and rounds fractional stacks down, logging each change', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(restoredBag(save({ a: 1e-20, b: 1.5, c: -1, d: 3 })).inventory).toEqual({ b: 1, d: 3 });

    expect(inventoryLines(log)).toEqual([
      '[PlayerSession] alice: inventory a 1e-20 -> 0',
      '[PlayerSession] alice: inventory b 1.5 -> 1',
      '[PlayerSession] alice: inventory c -1 -> 0',
    ]);
  });

  it('drops stacks that are not numbers', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(restoredBag(save({ a: '4', b: null, c: 2 })).inventory).toEqual({ c: 2 });
    expect(inventoryLines(log)).toHaveLength(2);
  });

  it('leaves whole stacks and equipped items alone', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bag = restoredBag(save({ gem: 99, pebble: 1 }, { head: 'old_hat' }));
    expect(bag.inventory).toEqual({ gem: 99, pebble: 1 });
    expect(bag.equipment).toEqual({ head: 'old_hat' });
    expect(inventoryLines(log)).toEqual([]);
  });

  it('restores an empty bag from a save without one', () => {
    expect(restoredBag(save(undefined)).inventory).toEqual({});
  });
});
