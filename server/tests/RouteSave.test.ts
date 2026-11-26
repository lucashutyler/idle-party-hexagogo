import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PlayerSaveData } from '../src/game/GameStateStore.js';
import type { PlayerManager } from '../src/game/PlayerManager.js';
import { BURROW, DUNGEON, ROOM, setupTravel } from './routeTravelFixture.js';
import type { TravelWorld } from './routeTravelFixture.js';

const DOOR_CHAIN = [{ fromTileId: ROOM.w2, toTileId: ROOM.e0 }, { fromTileId: ROOM.e2, toTileId: ROOM.b0 }];

/** Alice in w0, sent towards b1: the leg to w2, then the doors into the east dell and the burrow. */
async function routedSave(usernames = ['alice']): Promise<{ w: TravelWorld; saves: PlayerSaveData[] }> {
  const w = await setupTravel(usernames);
  w.reveal('alice', 'w1', 'w2', 'e0', 'e1', 'e2');
  if (usernames.includes('bob')) {
    w.befriend('alice', 'bob');
    w.join('alice', 'bob');
  }
  expect(w.pm.partyBattles.handleMoveToRoom(w.partyOf('alice'), ROOM.b1)).toEqual({ success: true });
  const saves = JSON.parse(JSON.stringify(w.pm.getAllSaveData())) as PlayerSaveData[];
  return { w, saves };
}

function restored(w: TravelWorld, saves: PlayerSaveData[]): { pm: PlayerManager; stopped: ReturnType<typeof vi.spyOn> } {
  const pm = w.restart(saves.map(s => s.username));
  const stopped = vi.spyOn(pm.partyBattles, 'recordRouteStopped');
  pm.restoreFromSaveData(saves);
  return { pm, stopped };
}

const partyState = (pm: PlayerManager, username = 'alice') =>
  pm.partyBattles.getPartyState(pm.getSessionByUsername(username)!.getPartyId()!)!;
const cols = (pm: PlayerManager) => partyState(pm).path.map(p => p.col);
const contentChanged = (w: TravelWorld) => {
  w.bump();
  w.grids.rebuild();
};

describe('a saved route', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is written with its doors by id, and only while it has any', async () => {
    const { saves } = await routedSave();
    expect(saves[0].route).toEqual({ destinationId: ROOM.b1, doors: DOOR_CHAIN });

    const plain = await setupTravel(['alice']);
    expect(plain.pm.getAllSaveData()[0]).not.toHaveProperty('route');
  });

  it('survives a restart for a lone player', async () => {
    const { w, saves } = await routedSave();
    const { pm, stopped } = restored(w, saves);
    expect(cols(pm)).toEqual([1, 2]);
    expect(partyState(pm).route).toEqual({ destinationId: ROOM.b1, destinationMapId: BURROW, doors: 2, rooms: 7, leavesMap: true });
    expect(stopped).not.toHaveBeenCalled();
  });

  it('survives a restart through the owner\'s save in a party', async () => {
    const { w, saves } = await routedSave(['alice', 'bob']);
    const { pm } = restored(w, saves);
    expect(pm.getSessionByUsername('bob')!.getPartyId()).toBe(pm.getSessionByUsername('alice')!.getPartyId());
    expect(cols(pm)).toEqual([1, 2]);
    expect(partyState(pm).route?.doors).toBe(2);
  });

  it('survives a restart in the door room and steps through after the next fight', async () => {
    const w = await setupTravel(['alice']);
    w.reveal('alice', 'w1', 'w2', 'e0', 'e1');
    w.placeParty('alice', 'w2');
    expect(w.pm.partyBattles.handleMoveToRoom(w.partyOf('alice'), ROOM.e1)).toEqual({ success: true });
    const saves = JSON.parse(JSON.stringify(w.pm.getAllSaveData())) as PlayerSaveData[];
    const { pm, stopped } = restored(w, saves);
    expect(partyState(pm).path).toEqual([]);
    expect(partyState(pm).route?.doors).toBe(1);

    vi.advanceTimersByTime(30_000);
    expect(pm.partyBattles.getTile(pm.getSessionByUsername('alice')!.getPartyId()!)?.id).toBe(ROOM.e1);
    expect(partyState(pm).route).toBeUndefined();
    expect(stopped).not.toHaveBeenCalled();
  });

  it.each<[string, (w: TravelWorld) => void]>([
    ['its door is taken away', w => { w.world.tiles.find(t => t.id === ROOM.e2)!.transitions = []; }],
    ['its destination is gone', w => { w.world.tiles = w.world.tiles.filter(t => t.id !== ROOM.b1); }],
    ['a wall now cuts the way between two doors', w => { w.world.tiles.find(t => t.id === ROOM.e1)!.type = 'cliff'; }],
  ])('is dropped when %s, keeping the leg and saying so in the recap', async (_name, change) => {
    const { w, saves } = await routedSave();
    change(w);
    contentChanged(w);
    const { pm, stopped } = restored(w, saves);
    expect(partyState(pm).route).toBeUndefined();
    expect(cols(pm)).toEqual([1, 2]);
    expect(stopped).toHaveBeenCalledWith(pm.getSessionByUsername('alice')!.getPartyId(), 'Room w2');
  });

  it('is dropped when its first door no longer starts where the leg ends', async () => {
    const { w, saves } = await routedSave();
    saves[0].movementQueue = [{ col: 1, row: 0 }];
    const { pm, stopped } = restored(w, saves);
    expect(partyState(pm).route).toBeUndefined();
    expect(cols(pm)).toEqual([1]);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('is absent from an older save, which restores as before', async () => {
    const { w, saves } = await routedSave();
    delete saves[0].route;
    const { pm, stopped } = restored(w, saves);
    expect(cols(pm)).toEqual([1, 2]);
    expect(partyState(pm).route).toBeUndefined();
    expect(stopped).not.toHaveBeenCalled();
  });

  it('goes with the whole queue when a queued room is gone', async () => {
    const { w, saves } = await routedSave();
    saves[0].movementQueue = [{ col: 1, row: 0 }, { col: 40, row: 40 }, { col: 2, row: 0 }];
    const { pm } = restored(w, saves);
    expect(partyState(pm).path).toEqual([]);
    expect(partyState(pm).route).toBeUndefined();
  });

  it('is dropped when the saved room is gone and the party starts over', async () => {
    const { w, saves } = await routedSave();
    saves[0].position = { col: 40, row: 40 };
    const { pm } = restored(w, saves);
    expect(saves[0].route).toBeUndefined();
    expect(partyState(pm)).toMatchObject({ col: 0, row: 0, path: [] });
    expect(partyState(pm).route).toBeUndefined();
  });

  it('is dropped when an unloaded player logs back in', async () => {
    const { w, saves } = await routedSave();
    const pm = w.restart(['alice'], { alice: saves[0] });
    await pm.login(w.sockets.alice, 'alice');
    expect(saves[0].route).toBeUndefined();
    expect(partyState(pm).route).toBeUndefined();
  });

  it('is not restored beside a dungeon run', async () => {
    const { w, saves } = await routedSave();
    saves[0].dungeonRun = { dungeonId: DUNGEON.id, currentFloorIndex: 0, entrance: { col: 0, row: 0 } };
    const { pm, stopped } = restored(w, saves);
    expect(pm.partyBattles.isInDungeonRun(pm.getSessionByUsername('alice')!.getPartyId()!)).toBe(true);
    expect(partyState(pm).route).toBeUndefined();
    expect(stopped).not.toHaveBeenCalled();
  });
});
