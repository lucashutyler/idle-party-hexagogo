import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AUTO_RUN_ROOM_MS, MOVE_DURATION, RESULT_PAUSE, RUN_AVAILABLE_MS } from '@idle-party-rpg/shared';
import { ROUTE_MOVE_GAP_MS } from '../src/game/PlayerManager.js';
import { BURROW, DEADLY, DELL, DUNGEON, ROOM, STURDY, VISIT_QUEST, setupTravel } from './routeTravelFixture.js';
import type { TravelOptions, TravelWorld } from './routeTravelFixture.js';

/** Alice alone in w0, with both halves of the dell and the way down into the burrow found. */
async function alice(opts: TravelOptions = {}): Promise<TravelWorld> {
  const w = await setupTravel(['alice'], opts);
  w.reveal('alice', 'w1', 'w2', 'nook', 'e0', 'e1', 'e2');
  return w;
}

const party = (w: TravelWorld, username = 'alice') => w.pm.partyBattles.getPartyState(w.partyOf(username))!;
const pathCols = (w: TravelWorld) => party(w).path.map(p => p.col);
const moveTo = (w: TravelWorld, room: string, accept: ('hires_leave' | 'no_way_back')[] = []) =>
  w.pm.partyBattles.handleMoveToRoom(w.partyOf('alice'), room, accept);

describe('moving by room id', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('walks to the door, steps through it like any room and walks on, one fight per room, hires kept', async () => {
    const w = await alice();
    w.hire('alice');
    const fights = w.watchFights('alice');

    expect(moveTo(w, ROOM.e1)).toEqual({ success: true });
    expect(pathCols(w)).toEqual([1, 2]);
    expect(party(w).route).toEqual({ destinationId: ROOM.e1, destinationMapId: DELL, doors: 1, rooms: 4, leavesMap: false });

    const restart = vi.spyOn(w.timerOf('alice'), 'restartBattle');
    vi.advanceTimersByTime(30_000);

    expect(w.roomOf('alice')).toBe(ROOM.e1);
    expect(party(w).route).toBeUndefined();
    expect(fights.slice(0, 3)).toEqual([ROOM.w1, ROOM.w2, ROOM.e0]);
    expect(fights.slice(3).every(room => room === ROOM.e1)).toBe(true);
    expect(restart).not.toHaveBeenCalled();
    expect(w.hires('alice')).toBe(1);
    expect(w.logOf('alice')).toContain('Traveled to Room e0.');
  });

  it('keeps path the current leg and reports the route only while a door is still ahead', async () => {
    const w = await alice();
    moveTo(w, ROOM.e2);
    expect(party(w).route?.doors).toBe(1);
    for (let i = 0; i < 600 && w.roomOf('alice') !== ROOM.e0; i++) vi.advanceTimersByTime(50);
    expect(w.roomOf('alice')).toBe(ROOM.e0);
    expect(party(w).route).toBeUndefined();
    expect(pathCols(w)).toEqual([5, 6]);
  });

  it('asks before a route to another map leaves the hires behind, changing nothing until it is accepted', async () => {
    const w = await alice();
    w.hire('alice');
    w.sessions.alice.quests.accept(VISIT_QUEST, { playerLevel: 1, partySize: 1 });

    expect(moveTo(w, ROOM.b1)).toEqual({
      success: false,
      confirm: [{ kind: 'hires_leave', names: ['Brin'], mapName: 'Dell' }],
    });
    expect(party(w).path).toEqual([]);
    expect(party(w).route).toBeUndefined();

    expect(moveTo(w, ROOM.b1, ['hires_leave'])).toEqual({ success: true });
    expect(party(w).route?.leavesMap).toBe(true);
    vi.advanceTimersByTime(60_000);

    expect(w.pm.partyBattles.getMapId(w.partyOf('alice'))).toBe(BURROW);
    expect(w.roomOf('alice')).toBe(ROOM.b1);
    expect(w.hires('alice')).toBe(0);
    expect(w.logOf('alice')).toContain('Brin parts ways with the party.');
    expect(w.logOf('alice')).toContain('Traveled to Room b0.');
    expect(w.sessions.alice.isTileIdUnlocked(ROOM.b0)).toBe(true);
    expect(w.sessions.alice.isTileUnlocked(w.tile('b1'))).toBe(true);
    expect(w.sessions.alice.quests.getProgress(VISIT_QUEST.id)?.progress).toEqual([1]);
  });

  it('warns that a one-way drop has no way back, but not a door pair', async () => {
    const w = await alice();
    expect(moveTo(w, ROOM.b2)).toEqual({ success: true });
    w.reveal('alice', 'b1');
    expect(moveTo(w, ROOM.p1)).toEqual({ success: false, confirm: [{ kind: 'no_way_back' }] });
    expect(moveTo(w, ROOM.p1, ['no_way_back'])).toEqual({ success: true });
  });

  it('walks a door room with Autorun and keeps a room a second through the door', async () => {
    const w = await alice({ monster: STURDY });
    w.placeParty('alice', 'w2');
    w.pm.handleSetAutoRun('alice', true);
    vi.advanceTimersByTime(10);
    expect(moveTo(w, ROOM.e1)).toEqual({ success: true });
    expect(party(w).path).toEqual([]);
    expect(w.pm.partyBattles.getBattleState(w.partyOf('alice'))!.autoRunLeaveMs).toBeDefined();
    expect(w.timerOf('alice').walksOn).toBe(true);

    const starts: number[] = [];
    vi.spyOn(w.sessions.alice, 'incrementBattleCount').mockImplementation(() => { starts.push(Date.now()); });
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS * 3);
    expect(w.roomOf('alice')).toBe(ROOM.e1);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(AUTO_RUN_ROOM_MS);
    expect(starts[1] - starts[0]).toBeLessThanOrEqual(AUTO_RUN_ROOM_MS + 5);
  });

  it('crosses on Run from a door room', async () => {
    const w = await alice({ monster: STURDY });
    w.placeParty('alice', 'w2');
    moveTo(w, ROOM.e1);
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 1_000);
    expect(w.pm.partyBattles.escapeBattle(w.partyOf('alice'))).toBe(true);
    vi.advanceTimersByTime(RESULT_PAUSE + MOVE_DURATION);
    expect(w.roomOf('alice')).toBe(ROOM.e0);
  });

  it('crosses after a defeat in a door room', async () => {
    const w = await alice({ monster: DEADLY });
    w.placeParty('alice', 'w2');
    moveTo(w, ROOM.e1);
    vi.advanceTimersByTime(120_000);
    expect([ROOM.e0, ROOM.e1]).toContain(w.roomOf('alice'));
  });

  it('crosses after a skip retreat in a door room', async () => {
    const w = await alice({ monster: STURDY });
    w.placeParty('alice', 'w2');
    moveTo(w, ROOM.e1);
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 1_000);
    const timer = w.timerOf('alice');
    expect(timer.retreat(timer.battleId, 'Your party slips away from the fight.')).toBe(true);
    vi.advanceTimersByTime(RESULT_PAUSE + MOVE_DURATION);
    expect(w.roomOf('alice')).toBe(ROOM.e0);
  });
});

describe('route refusals', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('refuses a room that is gone or cannot be walked into', async () => {
    const w = await alice();
    expect(moveTo(w, 'r-nowhere')).toEqual({ success: false, reason: 'gone' });
    expect(moveTo(w, ROOM.x3)).toEqual({ success: false, reason: 'not_walkable' });
  });

  it('refuses inside a dungeon', async () => {
    const w = await alice();
    w.pm.partyBattles.restoreDungeonRun(w.partyOf('alice'), { dungeonId: DUNGEON.id, currentFloorIndex: 0, entrance: { col: 0, row: 0 } });
    expect(moveTo(w, ROOM.e1)).toEqual({ success: false, reason: 'in_dungeon' });
  });

  it('knows no way through a door room nobody in the party has found', async () => {
    const w = await setupTravel(['alice']);
    expect(moveTo(w, ROOM.e1)).toEqual({ success: false, reason: 'no_route' });
  });

  it('uses a door room only an offline member has found', async () => {
    const w = await setupTravel(['alice', 'bob']);
    w.befriend('alice', 'bob');
    w.join('alice', 'bob');
    w.reveal('bob', 'w2');
    w.pm.removeConnection(w.sockets.bob);
    expect(moveTo(w, ROOM.e1)).toEqual({ success: true });
  });

  it('says which door locks the only way', async () => {
    const w = await alice({ doorGate: { minLevel: 9 } });
    const result = moveTo(w, ROOM.e1);
    expect(result).toMatchObject({ success: false, blocked: { kind: 'level', minLevel: 9 } });
    expect((result as { blocked: { reason: string } }).blocked.reason)
      .toBe('The way there passes a locked door in Room w2. Level 9 is required to enter this room.');
  });

  it('goes round a locked door when another is open', async () => {
    const w = await alice({ shortcutGate: { minLevel: 9 } });
    expect(moveTo(w, ROOM.e1)).toEqual({ success: true });
    expect(pathCols(w)).toEqual([1, 2]);

    const open = await alice({ shortcutGate: { minLevel: 1 } });
    expect(moveTo(open, ROOM.e1)).toEqual({ success: true });
    expect(pathCols(open)).toEqual([1]);
  });

  it('says a gated room on a later leg is on the way, naming it only once found', async () => {
    const w = await setupTravel(['alice'], { gates: { e1: { minLevel: 5 } } });
    w.reveal('alice', 'w2', 'e2');
    expect((moveTo(w, ROOM.e2) as { blocked: { reason: string } }).blocked.reason)
      .toBe('The way there passes a room on the way. Level 5 is required to enter this room.');
    w.reveal('alice', 'e1');
    expect((moveTo(w, ROOM.e2) as { blocked: { reason: string } }).blocked.reason)
      .toBe('The way there passes Room e1. Level 5 is required to enter this room.');
    expect((moveTo(w, ROOM.e1) as { blocked: { reason: string } }).blocked.reason).toBe('Level 5 is required to enter this room.');
  });

  it('leaves the old queue and route as they were when an order is refused', async () => {
    const w = await alice({ gates: { nook: { minLevel: 5 } } });
    moveTo(w, ROOM.e1);
    const before = party(w);
    expect(moveTo(w, ROOM.nook)).toMatchObject({ success: false, blocked: { kind: 'level' } });
    expect(w.pm.partyBattles.handleMove(w.partyOf('alice'), 1, 1)).toMatchObject({ success: false, blocked: { kind: 'level' } });
    expect(party(w)).toEqual(before);
  });

  it('keeps col and row moves to the party\'s area, refusing another area as before', async () => {
    const w = await alice();
    expect(w.pm.partyBattles.handleMove(w.partyOf('alice'), 5, 0)).toEqual({ success: false });
    expect(w.pm.partyBattles.handleMove(w.partyOf('alice'), 2, 0)).toEqual({ success: true });
    expect(pathCols(w)).toEqual([1, 2]);
    expect(party(w).route).toBeUndefined();
  });

  it('drops a second move by room id sent within the gap', async () => {
    const w = await alice();
    expect(w.pm.handleMoveToRoom('alice', ROOM.e1, [], 10_000)).toEqual({ success: true });
    expect(w.pm.handleMoveToRoom('alice', ROOM.w1, [], 10_000 + ROUTE_MOVE_GAP_MS - 1)).toBeNull();
    expect(party(w).route?.destinationId).toBe(ROOM.e1);
    expect(w.pm.handleMoveToRoom('alice', ROOM.w1, [], 10_000 + ROUTE_MOVE_GAP_MS)).toEqual({ success: true });
    expect(party(w).route).toBeUndefined();
  });
});

describe('checks at the door', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stops in the door room when a member who joined on the way may not pass', async () => {
    const w = await setupTravel(['alice', 'bob'], { doorGate: { minLevel: 2 } });
    w.reveal('alice', 'w1', 'w2', 'e0', 'e1');
    w.levelTo('alice', 3);
    w.befriend('alice', 'bob');
    expect(moveTo(w, ROOM.e1)).toEqual({ success: true });
    w.join('alice', 'bob');
    const stopped = vi.spyOn(w.pm.partyBattles, 'recordRouteStopped');
    const restart = vi.spyOn(w.timerOf('alice'), 'restartBattle');

    vi.advanceTimersByTime(30_000);
    expect(w.roomOf('alice')).toBe(ROOM.w2);
    expect(party(w).route).toBeUndefined();
    expect(w.logOf('alice')).toContain('Your party stopped at Room w2: Level 2 is required to enter this room.');
    expect(stopped).toHaveBeenCalledWith(w.partyOf('alice'), 'Room w2');
    expect(restart).not.toHaveBeenCalled();
  });

  it('stops in the door room when the door was taken away', async () => {
    const w = await alice();
    moveTo(w, ROOM.e1);
    w.world.tiles.find(t => t.id === ROOM.w2)!.transitions = [];
    w.bump();
    const stopped = vi.spyOn(w.pm.partyBattles, 'recordRouteStopped');

    vi.advanceTimersByTime(30_000);
    expect(w.roomOf('alice')).toBe(ROOM.w2);
    expect(w.logOf('alice')).toContain('Your party stopped at Room w2: the way on has changed.');
    expect(stopped).toHaveBeenCalledOnce();
  });
});

describe('what ends a route', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function routed(opts: TravelOptions = {}): Promise<TravelWorld> {
    const w = await alice(opts);
    expect(moveTo(w, ROOM.e1)).toEqual({ success: true });
    expect(party(w).route).toBeDefined();
    return w;
  }

  it.each<[string, (w: TravelWorld) => void]>([
    ['Stop', w => w.pm.partyBattles.stopTravel(w.partyOf('alice'))],
    ['a new move by room id', w => { moveTo(w, ROOM.w1); }],
    ['a col and row move', w => { w.pm.partyBattles.handleMove(w.partyOf('alice'), 1, 0); }],
    ['a relocation', w => w.pm.partyBattles.relocateParty(w.partyOf('alice'), w.tile('w1'), DELL)],
    ['a restored dungeon run', w => w.pm.partyBattles.restoreDungeonRun(w.partyOf('alice'), { dungeonId: DUNGEON.id, currentFloorIndex: 0, entrance: { col: 0, row: 0 } })],
    ['entering a dungeon', w => { expect(w.pm.partyBattles.enterDungeon(w.partyOf('alice'), DUNGEON.id)).toEqual({ success: true }); }],
  ])('%s', async (_name, act) => {
    const w = await routed();
    act(w);
    expect(party(w).route).toBeUndefined();
  });

  it('a manual trip through a door', async () => {
    const w = await routed();
    w.placeParty('alice', 'w2');
    moveTo(w, ROOM.e1);
    expect(party(w).route).toBeDefined();
    expect(w.pm.handleEnterTransition('alice', ROOM.e0)).toEqual({ success: true });
    expect(party(w).route).toBeUndefined();
  });

  it('an auto-retreat relocation, which counts as a stopped route', async () => {
    const w = await routed({ monster: STURDY });
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 1_000);
    const timer = w.timerOf('alice');
    const entry = (w.pm.partyBattles as unknown as { entries: Map<string, { pendingRetreat?: unknown }> }).entries.get(w.partyOf('alice'))!;
    entry.pendingRetreat = { battleId: timer.battleId, kind: 'relocate', winPct: 10, cause: 'room', target: w.tile('nook') };
    const stopped = vi.spyOn(w.pm.partyBattles, 'recordRouteStopped');
    expect(timer.retreat(timer.battleId, 'Your party falls back to a safer room.')).toBe(true);
    expect(party(w).route).toBeUndefined();
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('a world change, with a journal line for the door route', async () => {
    const w = await routed();
    const stopped = vi.spyOn(w.pm.partyBattles, 'recordRouteStopped');
    w.grids.rebuild();
    w.pm.partyBattles.refreshAllPartyTiles(w.grids);
    expect(party(w).route).toBeUndefined();
    expect(party(w).path).toEqual([]);
    expect(w.logOf('alice')).toContain('The world changed, so your party stopped at Room w0.');
    expect(stopped).toHaveBeenCalledWith(w.partyOf('alice'), 'Room w0');
  });
});
