import { describe, it, expect } from 'vitest';
import { preserveTileGuids } from '../src/game/GameLoop.js';
import type { QuestDefinition, WorldTileDefinition } from '@idle-party-rpg/shared';

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
    // The bug: a (col,row)-only key collapsed both maps onto one entry, one shared GUID.
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
    // Nothing downstream detects a duplicate GUID.
    const live: WorldTileDefinition[] = [];
    const snap = [
      tile({ id: 'dupe', mapId: 'overworld', col: 0, row: 0 }),
      tile({ id: 'dupe', mapId: 'crypt', col: 0, row: 0 }),
    ];

    preserveTileGuids(live, snap);

    expect(snap[0].id).toBe('dupe');
    expect(snap[1].id).not.toBe('dupe');
  });

  it('repoints a transition at a room whose id the deploy replaced', () => {
    const live = [tile({ id: 'live-dock', mapId: 'overworld', col: 2, row: 3 })];
    const snap = [
      tile({ id: 'draft-dock', mapId: 'overworld', col: 2, row: 3 }),
      tile({ id: 'far-door', mapId: 'crypt', col: 0, row: 0, transitions: [{ mapId: 'overworld', tileId: 'draft-dock' }] }),
    ];

    preserveTileGuids(live, snap);

    expect(snap[0].id).toBe('live-dock');
    expect(snap[1].transitions).toEqual([{ mapId: 'overworld', tileId: 'live-dock' }]);
  });

  it('repoints a quest visit objective at a room whose id the deploy replaced', () => {
    const live = [tile({ id: 'live-goal', mapId: 'overworld', col: 4, row: 5 })];
    const snap = [tile({ id: 'draft-goal', mapId: 'overworld', col: 4, row: 5 })];
    const quests: QuestDefinition[] = [{
      id: 'q', name: 'Q', description: '', scope: 'solo',
      objectives: [{ kind: 'visit', tileId: 'draft-goal' }, { kind: 'kill', monsterId: 'm', count: 1 }],
      rewards: [],
    }];

    preserveTileGuids(live, snap, quests);

    expect(quests[0].objectives[0]).toEqual({ kind: 'visit', tileId: 'live-goal' });
    expect(quests[0].objectives[1]).toEqual({ kind: 'kill', monsterId: 'm', count: 1 });
  });

  it('follows a room through a swap so a link never jumps to the room that took its old id', () => {
    const live = [
      tile({ id: 'X', mapId: 'overworld', col: 1, row: 0 }),
      tile({ id: 'Y', mapId: 'overworld', col: 0, row: 0 }),
    ];
    const snap = [
      tile({ id: 'X', mapId: 'overworld', col: 0, row: 0 }),
      tile({ id: 'Z', mapId: 'overworld', col: 1, row: 0 }),
      tile({ id: 'door', mapId: 'crypt', col: 0, row: 0, transitions: [{ mapId: 'overworld', tileId: 'X' }] }),
    ];

    preserveTileGuids(live, snap);

    expect(snap[0].id).toBe('Y');
    expect(snap[2].transitions?.[0].tileId).toBe('Y');
  });

  it('leaves a link alone when its id was kept by one room of a duplicate pair', () => {
    const live: WorldTileDefinition[] = [];
    const snap = [
      tile({ id: 'dupe', mapId: 'overworld', col: 0, row: 0 }),
      tile({ id: 'dupe', mapId: 'crypt', col: 0, row: 0 }),
      tile({ id: 'door', mapId: 'sewers', col: 0, row: 0, transitions: [{ mapId: 'overworld', tileId: 'dupe' }] }),
    ];

    preserveTileGuids(live, snap);

    expect(snap[2].transitions?.[0].tileId).toBe('dupe');
  });

  it('ignores live rooms that have no id yet', () => {
    const live = [tile({ id: '', mapId: 'overworld', col: 0, row: 0 })];
    const snap = [tile({ id: 'snapshot-own', mapId: 'overworld', col: 0, row: 0 })];

    preserveTileGuids(live, snap);

    expect(snap[0].id).toBe('snapshot-own');
  });
});
