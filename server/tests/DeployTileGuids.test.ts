import { describe, it, expect } from 'vitest';
import { preserveTileGuids } from '../src/game/GameLoop.js';
import type { WorldTileDefinition } from '@idle-party-rpg/shared';

function tile(over: Partial<WorldTileDefinition> & { mapId: string; col: number; row: number }): WorldTileDefinition {
  return {
    id: '',
    type: 'plains',
    zone: 'z',
    name: `${over.mapId} ${over.col},${over.row}`,
    ...over,
  } as WorldTileDefinition;
}

describe('preserveTileGuids', () => {
  it('carries a live GUID onto the matching snapshot room', () => {
    const live = [tile({ id: 'guid-a', mapId: 'overworld', col: 3, row: 4 })];
    const snap = [tile({ id: 'stale', mapId: 'overworld', col: 3, row: 4 })];

    preserveTileGuids(live, snap);

    expect(snap[0].id).toBe('guid-a');
  });

  it('does NOT let one map\'s room claim another map\'s GUID at the same coordinates', () => {
    // The bug: a (col,row)-only key collapses both maps onto one entry, so
    // whichever room came last in the flat array won — and then BOTH snapshot
    // rooms were assigned that single GUID.
    const live = [
      tile({ id: 'guid-overworld', mapId: 'overworld', col: 3, row: 4 }),
      tile({ id: 'guid-crypt', mapId: 'crypt', col: 3, row: 4 }),
    ];
    const snap = [
      tile({ id: '', mapId: 'overworld', col: 3, row: 4 }),
      tile({ id: '', mapId: 'crypt', col: 3, row: 4 }),
    ];

    preserveTileGuids(live, snap);

    expect(snap[0].id).toBe('guid-overworld');
    expect(snap[1].id).toBe('guid-crypt');
  });

  it('never assigns the same GUID to two rooms', () => {
    const live = [
      tile({ id: 'guid-a', mapId: 'overworld', col: 0, row: 0 }),
      tile({ id: 'guid-b', mapId: 'crypt', col: 0, row: 0 }),
      tile({ id: 'guid-c', mapId: 'crypt', col: 1, row: 0 }),
    ];
    const snap = [
      tile({ id: '', mapId: 'overworld', col: 0, row: 0 }),
      tile({ id: '', mapId: 'crypt', col: 0, row: 0 }),
      tile({ id: '', mapId: 'crypt', col: 1, row: 0 }),
      tile({ id: '', mapId: 'sewers', col: 0, row: 0 }),
    ];

    preserveTileGuids(live, snap);

    const ids = snap.map(t => t.id);
    expect(ids.every(id => !!id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('mints a fresh GUID for a room with no live counterpart', () => {
    const live = [tile({ id: 'guid-a', mapId: 'overworld', col: 0, row: 0 })];
    const snap = [tile({ id: '', mapId: 'overworld', col: 9, row: 9 })];

    preserveTileGuids(live, snap);

    expect(snap[0].id).toBeTruthy();
    expect(snap[0].id).not.toBe('guid-a');
  });

  it('keeps a snapshot room\'s own id when nothing live matches it', () => {
    const live: WorldTileDefinition[] = [];
    const snap = [tile({ id: 'snapshot-own', mapId: 'overworld', col: 0, row: 0 })];

    preserveTileGuids(live, snap);

    expect(snap[0].id).toBe('snapshot-own');
  });

  it('breaks a tie when a malformed snapshot already contains duplicate ids', () => {
    // Defence in depth: nothing downstream detects a duplicate GUID, so a bad
    // snapshot must not be able to write one into the live world.
    const live: WorldTileDefinition[] = [];
    const snap = [
      tile({ id: 'dupe', mapId: 'overworld', col: 0, row: 0 }),
      tile({ id: 'dupe', mapId: 'crypt', col: 0, row: 0 }),
    ];

    preserveTileGuids(live, snap);

    expect(snap[0].id).toBe('dupe');
    expect(snap[1].id).not.toBe('dupe');
  });

  it('ignores live rooms that have no id yet', () => {
    const live = [tile({ id: '', mapId: 'overworld', col: 0, row: 0 })];
    const snap = [tile({ id: 'snapshot-own', mapId: 'overworld', col: 0, row: 0 })];

    preserveTileGuids(live, snap);

    expect(snap[0].id).toBe('snapshot-own');
  });
});
