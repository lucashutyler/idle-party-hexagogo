import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LockTarget, NpcDefinition, QuestDefinition } from '@idle-party-rpg/shared';
import { LOCK_INSPECT_BURST, LOCK_INSPECT_GAP_MS } from '../src/game/PlayerManager.js';
import { DELL, ROOM, setupTravel } from './routeTravelFixture.js';
import type { TravelOptions, TravelWorld } from './routeTravelFixture.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';

/** An invented two-step chain: the gate quest waits on a first errand, which Ida gives in the far east room. */
const FIRST: QuestDefinition = { id: 'q_lock_first', name: 'Fetch the Lamp Oil', description: '', scope: 'party_shared', objectives: [], rewards: [] };
const GATE: QuestDefinition = {
  id: 'q_lock_gate', name: 'Mend the Gate', description: '', scope: 'party_shared', objectives: [], rewards: [], prerequisiteQuestIds: [FIRST.id],
};
const IDA: NpcDefinition = { id: 'n_lock_ida', name: 'Ida', emoji: 'I', greeting: '', questIds: [FIRST.id, GATE.id] };
const CHAIN: TravelOptions = { quests: [FIRST, GATE], npcs: [{ npc: IDA, rooms: ['e2'] }] };

const room = (tileId: string): LockTarget => ({ kind: 'room', tileId });

function complete(session: PlayerSession, ...questIds: string[]): void {
  session.quests.loadFromSaveData({
    active: [],
    completed: questIds.map(questId => ({ questId, completedAt: new Date(0).toISOString() })),
    weeklyCompletions: {},
  });
}

/** Each call is a fresh request, well clear of the last. */
function inspector(w: TravelWorld) {
  let now = 1_000_000;
  return (username: string, target: LockTarget) => {
    now += LOCK_INSPECT_GAP_MS;
    return w.pm.handleInspectLock(username, target, now)?.lock;
  };
}

describe('lock info', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('gives a lone player the next step of a quest chain, naming the giver\'s room only once found', async () => {
    const w = await setupTravel(['alice'], { ...CHAIN, gates: { w1: { requiredQuestIds: [GATE.id] } } });
    const inspect = inspector(w);

    const lock = inspect('alice', room(ROOM.w1));
    expect(lock?.roomId).toBe(ROOM.w1);
    expect(lock?.onRoute).toBeUndefined();
    expect(lock?.requirements).toEqual([{
      kind: 'quest',
      questId: GATE.id,
      questName: 'Mend the Gate',
      members: [{
        username: 'alice',
        met: false,
        nextStep: {
          questId: FIRST.id,
          questName: 'Fetch the Lamp Oil',
          state: 'available',
          remaining: 2,
          giver: { npcName: 'Ida', roomId: ROOM.e2, mapId: DELL, mapName: 'Dell', zoneName: 'Test Dale' },
        },
      }],
    }]);

    w.reveal('alice', 'e2');
    expect(inspect('alice', room(ROOM.w1))?.requirements[0].members[0].nextStep?.giver?.roomName).toBe('Room e2');

    complete(w.sessions.alice, FIRST.id);
    expect(inspect('alice', room(ROOM.w1))?.requirements[0].members[0].nextStep).toMatchObject({ questId: GATE.id, remaining: 1 });
    complete(w.sessions.alice, FIRST.id, GATE.id);
    expect(inspect('alice', room(ROOM.w1))).toBeNull();
  });

  it('points at the giver\'s room on the member\'s own map first', async () => {
    const w = await setupTravel(['alice'], { quests: [FIRST, GATE], npcs: [{ npc: IDA, rooms: ['e2', 'b2'] }], gates: { b1: { requiredQuestIds: [GATE.id] } } });
    const inspect = inspector(w);
    expect(inspect('alice', room(ROOM.w1))).toBeNull();
    w.placeParty('alice', 'b0');
    expect(inspect('alice', room(ROOM.b1))?.requirements[0].members[0].nextStep?.giver).toMatchObject({ roomId: ROOM.b2, mapName: 'Burrow' });
  });

  it('lists level and quest both, with every member\'s standing and each missing member\'s own next step', async () => {
    const w = await setupTravel(['alice', 'bob'], { ...CHAIN, gates: { w1: { minLevel: 3, requiredQuestIds: [GATE.id] } } });
    w.befriend('alice', 'bob');
    w.join('alice', 'bob');
    w.levelTo('alice', 4);
    complete(w.sessions.alice, FIRST.id, GATE.id);
    complete(w.sessions.bob, FIRST.id);

    const lock = inspector(w)('alice', room(ROOM.w1));
    expect(lock?.requirements.map(r => r.kind)).toEqual(['level', 'quest']);
    expect(lock?.requirements[0]).toEqual({
      kind: 'level',
      minLevel: 3,
      members: [{ username: 'alice', met: true, level: 4 }, { username: 'bob', met: false, level: 1 }],
    });
    expect(lock?.requirements[1].members).toEqual([
      { username: 'alice', met: true },
      { username: 'bob', met: false, nextStep: expect.objectContaining({ questId: GATE.id, state: 'available', remaining: 1 }) },
    ]);
  });

  it('keeps an offline member in the count, as the gate does', async () => {
    const w = await setupTravel(['alice', 'bob'], { gates: { w1: { minLevel: 3 } } });
    w.befriend('alice', 'bob');
    w.join('alice', 'bob');
    w.levelTo('alice', 4);
    w.pm.removeConnection(w.sockets.bob);
    expect(inspector(w)('alice', room(ROOM.w1))?.requirements[0].members.map(m => [m.username, m.met])).toEqual([['alice', true], ['bob', false]]);
  });

  it('leaves out the name of a gate quest ten or more levels above the viewer', async () => {
    const far: QuestDefinition = { ...GATE, requiredLevel: 11 };
    const w = await setupTravel(['alice'], { quests: [FIRST, far], npcs: [{ npc: IDA, rooms: ['nook'] }], gates: { w1: { requiredQuestIds: [far.id] } } });
    const requirement = inspector(w)('alice', room(ROOM.w1))?.requirements[0];
    expect(requirement?.questName).toBeUndefined();
    expect(requirement?.questLevel).toBe(11);
    expect(requirement?.members[0].nextStep?.questName).toBe('Fetch the Lamp Oil');
  });

  it('says which room on the way is locked, through a door', async () => {
    const w = await setupTravel(['alice'], { gates: { e1: { minLevel: 5 } } });
    w.reveal('alice', 'w2', 'e2');
    const inspect = inspector(w);
    expect(inspect('alice', room(ROOM.e2))).toMatchObject({ roomId: ROOM.e1, onRoute: true, requirements: [{ kind: 'level', minLevel: 5 }] });
    expect(inspect('alice', room(ROOM.e2))?.roomName).toBeUndefined();
    w.reveal('alice', 'e1');
    expect(inspect('alice', room(ROOM.e2))?.roomName).toBe('Room e1');
    expect(inspect('alice', room(ROOM.e1))).toMatchObject({ roomId: ROOM.e1, requirements: [{ kind: 'level' }] });
    expect(inspect('alice', room(ROOM.e1))?.onRoute).toBeUndefined();
  });

  it('names a locked door on the only way', async () => {
    const w = await setupTravel(['alice'], { doorGate: { minLevel: 9 } });
    w.reveal('alice', 'w2');
    expect(inspector(w)('alice', room(ROOM.e1))).toMatchObject({
      roomId: ROOM.w2, onRoute: true, door: true, doorTileId: ROOM.e0, roomName: 'Room w2', requirements: [{ kind: 'level', minLevel: 9 }],
    });
  });

  it('says there is no way at all when no found door leads there, gates or not', async () => {
    const w = await setupTravel(['alice'], { gates: { e1: { minLevel: 5 } } });
    expect(inspector(w)('alice', room(ROOM.e1))).toEqual({ roomId: ROOM.e1, unreachable: true, requirements: [] });
  });

  it('answers nothing for an open room', async () => {
    const w = await setupTravel(['alice']);
    w.reveal('alice', 'w2');
    const inspect = inspector(w);
    expect(inspect('alice', room(ROOM.w2))).toBeNull();
    expect(inspect('alice', room(ROOM.e1))).toBeNull();
    expect(inspect('alice', room('r-nowhere'))).toBeNull();
  });

  it('answers a door only for the party\'s own room and one of its exits', async () => {
    const w = await setupTravel(['alice'], { doorGate: { minLevel: 9 } });
    const inspect = inspector(w);
    const door: LockTarget = { kind: 'door', fromTileId: ROOM.w2, tileId: ROOM.e0 };
    expect(inspect('alice', door)).toBeNull();

    w.placeParty('alice', 'w2');
    expect(inspect('alice', { kind: 'door', fromTileId: ROOM.w2, tileId: ROOM.e2 })).toBeNull();
    expect(inspect('alice', door)).toEqual({
      roomId: ROOM.w2,
      roomName: 'Room w2',
      door: true,
      doorTileId: ROOM.e0,
      requirements: [{ kind: 'level', minLevel: 9, members: [{ username: 'alice', met: false, level: 1 }] }],
    });
  });

  it('answers two requests a network delivers together, as when a sheet and a door dialog both ask', async () => {
    const w = await setupTravel(['alice'], { gates: { w1: { minLevel: 5 } } });
    expect(w.pm.handleInspectLock('alice', room(ROOM.w1), 5_000)?.lock).toMatchObject({ roomId: ROOM.w1 });
    expect(w.pm.handleInspectLock('alice', room(ROOM.w2), 5_010)?.lock).toMatchObject({ roomId: ROOM.w1, onRoute: true });
  });

  it('drops requests once a burst is spent, until the gap gives one back', async () => {
    const w = await setupTravel(['alice'], { gates: { w1: { minLevel: 5 } } });
    const target = room(ROOM.w1);
    for (let k = 0; k < LOCK_INSPECT_BURST; k++) expect(w.pm.handleInspectLock('alice', target, 5_000)?.lock?.roomId).toBe(ROOM.w1);
    expect(w.pm.handleInspectLock('alice', target, 5_000)).toBeNull();
    expect(w.pm.handleInspectLock('alice', target, 5_000 + LOCK_INSPECT_GAP_MS - 1)).toBeNull();
    expect(w.pm.handleInspectLock('alice', target, 5_000 + LOCK_INSPECT_GAP_MS)).toEqual({ type: 'lock_info', target, lock: expect.objectContaining({ roomId: ROOM.w1 }) });
    expect(w.pm.handleInspectLock('alice', target, 5_000 + LOCK_INSPECT_GAP_MS)).toBeNull();
  });

  it('holds a steady stream to one request per gap after the burst', async () => {
    const w = await setupTravel(['alice'], { gates: { w1: { minLevel: 5 } } });
    const target = room(ROOM.w1);
    let answered = 0;
    for (let k = 0; k < 50; k++) {
      if (w.pm.handleInspectLock('alice', target, 5_000 + k * 20)) answered++;
    }
    expect(answered).toBeLessThanOrEqual(LOCK_INSPECT_BURST + Math.floor((49 * 20) / LOCK_INSPECT_GAP_MS));
  });

  it('builds the card for a refused order from the room or door it names', async () => {
    const w = await setupTravel(['alice'], { doorGate: { minLevel: 9 }, gates: { nook: { minLevel: 4 } } });
    w.reveal('alice', 'w2');
    const routed = w.pm.partyBattles.handleMoveToRoom(w.partyOf('alice'), ROOM.e1);
    if (routed.success || !('blocked' in routed) || !routed.blocked) throw new Error('expected a gate refusal');
    expect(routed.blocked).toMatchObject({ roomId: ROOM.w2, onRoute: true, door: true, doorTileId: ROOM.e0 });
    expect(w.pm.lockForRefusal('alice', routed.blocked)).toMatchObject({ roomId: ROOM.w2, door: true, requirements: [{ kind: 'level', minLevel: 9 }] });

    const walked = w.pm.partyBattles.handleMove(w.partyOf('alice'), 1, 1);
    if (walked.success || !walked.blocked) throw new Error('expected a gate refusal');
    expect(w.pm.lockForRefusal('alice', walked.blocked)).toMatchObject({ roomId: ROOM.nook, requirements: [{ kind: 'level', minLevel: 4 }] });
  });
});
