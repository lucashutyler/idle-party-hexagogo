import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { COMBAT_PACE, COMBAT_STEP_MS, MOVE_DURATION, RESULT_PAUSE, RUN_AVAILABLE_MS, paceRealMs } from '@idle-party-rpg/shared';
import type { MonsterDefinition } from '@idle-party-rpg/shared';
import { ForecastService, roomForecastKey } from '../src/game/ForecastService.js';
import { DOOR_RETREAT_GRACE_MS } from '../src/game/AutoRetreat.js';
import { DEADLY as LOSING, SAFE, forecastStub } from './forecastFixture.js';
import type { Verdict } from './forecastFixture.js';
import { BURROW, DELL, DUNGEON, ROOM, STURDY, setupTravel } from './routeTravelFixture.js';
import type { RoomKey, TravelOptions, TravelWorld } from './routeTravelFixture.js';

interface RetreatView {
  retreatHold?: { tileId: string };
  pendingRetreat?: { kind: string };
}

interface DoorWorld extends TravelWorld {
  /** Forecast keys containing one of these never finish. */
  heldForecasts: Set<string>;
  partyId: () => string;
  entry: () => RetreatView;
  /** The forecast each room gives; rooms left out win every fight. */
  verdicts: (rooms: Partial<Record<RoomKey, Verdict>>) => void;
  /** Put the party's forecasts for these rooms into the cache. */
  prefill: (...rooms: RoomKey[]) => void;
  journal: (username?: string) => string[];
  retreatLines: (username?: string) => string[];
}

const HARMLESS: MonsterDefinition = { ...STURDY, name: 'Punching Bag', damage: 0 };

/** Fights that never end, and a forecaster that answers from `verdicts`. */
async function doorWorld(usernames: string[] = ['alice'], opts: TravelOptions = {}): Promise<DoorWorld> {
  const w = await setupTravel(usernames, { monster: HARMLESS, ...opts });
  const clock = { extra: 0 };
  const stub = forecastStub(clock);
  const svc = new ForecastService({ clock: { now: () => Date.now() + clock.extra }, createJob: stub.createJob });
  w.pm.partyBattles.setForecaster(svc);
  const partyId = () => w.partyOf(usernames[0]);
  const entries = (w.pm.partyBattles as unknown as { entries: Map<string, RetreatView> }).entries;
  const journal = (username = usernames[0]) => w.logOf(username);
  return {
    ...w,
    heldForecasts: stub.gated,
    partyId,
    entry: () => entries.get(partyId())!,
    verdicts: (rooms) => {
      for (const [room, verdict] of Object.entries(rooms)) stub.verdicts.set(ROOM[room as RoomKey], verdict!);
    },
    prefill: (...rooms) => {
      const pk = w.pm.partyBattles.forecastKey(partyId())!;
      for (const room of rooms) {
        svc.request({
          key: roomForecastKey(w.content.contentEpoch, pk, ROOM[room]),
          priority: 'precheck',
          build: () => ({ input: { kind: 'room', players: [], table: [], monsters: {}, encounters: {} } }),
        });
      }
      vi.advanceTimersByTime(50);
    },
    journal,
    retreatLines: (username) => journal(username).filter(l => l.startsWith('Auto-retreat') || l.startsWith('Nowhere safer')),
  };
}

const RETREAT_LANDED_MS = RUN_AVAILABLE_MS + paceRealMs(COMBAT_PACE, COMBAT_STEP_MS) + 100;
const BACK_TO_DELL ='Auto-retreat took your party through the door from Room b0 to Room e2 — Room b0 was too dangerous (win chance 0%)';

/** Alice in e2 with the burrow behind its door: the burrow loses, unless `verdicts` says otherwise, and the dell wins. */
async function burrowArrival(opts: TravelOptions = {}, verdicts: Partial<Record<RoomKey, Verdict>> = {}): Promise<DoorWorld> {
  const w = await doorWorld(['alice'], opts);
  w.placeParty('alice', 'e2');
  w.verdicts({ b0: LOSING, b1: LOSING, e2: SAFE, ...verdicts });
  w.prefill('b0', 'b1', 'e2');
  return w;
}

describe('auto-retreat back through a door', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('takes a party that arrived in a losing room back through the door once the grace is over, and keeps it there', async () => {
    const w = await burrowArrival();
    expect(w.pm.partyBattles.enterTransition(w.partyId(), ROOM.b0)).toEqual({ success: true });
    expect(w.entry().pendingRetreat?.kind).toBe('door');

    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS - 100);
    expect(w.roomOf('alice')).toBe(ROOM.b0);
    expect(w.retreatLines()).toEqual([]);

    vi.advanceTimersByTime(200);
    expect(w.pm.partyBattles.getMapId(w.partyId())).toBe(DELL);
    expect(w.roomOf('alice')).toBe(ROOM.e2);
    expect(w.entry().retreatHold).toEqual({ tileId: ROOM.e2 });
    expect(w.retreatLines()).toEqual([BACK_TO_DELL]);
    expect(w.journal()).toContain('Traveled to Room e2.');

    vi.advanceTimersByTime(120_000);
    expect(w.roomOf('alice')).toBe(ROOM.e2);
    expect(w.retreatLines()).toEqual([BACK_TO_DELL]);
  });

  it('counts the trip back in the recap like any relocation', async () => {
    const w = await burrowArrival();
    const recorded = vi.spyOn(w.pm.partyBattles, 'recordRetreat');
    w.pm.partyBattles.enterTransition(w.partyId(), ROOM.b0);
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS + 100);
    expect(recorded).toHaveBeenCalledWith(w.partyId(), expect.objectContaining({ kind: 'relocate', from: 'Room b0', to: 'Room e2', winPct: 0 }));
  });

  it('prefers a safe room on the same map, without waiting for the grace', async () => {
    const w = await burrowArrival({}, { b1: SAFE });
    w.pm.partyBattles.enterTransition(w.partyId(), ROOM.b0);
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + RESULT_PAUSE + MOVE_DURATION + 200);
    expect(w.roomOf('alice')).toBe(ROOM.b1);
    expect(w.retreatLines()).toEqual(['Auto-retreat moved your party from Room b0 to Room b1 — Room b0 was too dangerous (win chance 0%)']);
  });

  it('forecasts the room behind the door first when it is unknown, slipping away meanwhile', async () => {
    const w = await doorWorld();
    w.heldForecasts.add(ROOM.e2);
    w.placeParty('alice', 'e2');
    w.verdicts({ b0: LOSING, b1: LOSING, e2: SAFE });
    w.prefill('b0', 'b1');
    w.pm.partyBattles.enterTransition(w.partyId(), ROOM.b0);
    vi.advanceTimersByTime(RETREAT_LANDED_MS);
    expect(w.journal().filter(l => l.startsWith('Avoided'))).toHaveLength(1);
    expect(w.roomOf('alice')).toBe(ROOM.b0);

    w.heldForecasts.clear();
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS);
    expect(w.roomOf('alice')).toBe(ROOM.e2);
    expect(w.retreatLines()).toEqual([BACK_TO_DELL]);
  });

  it('gives a party that came through a door on its route the same grace, stops the route and does not head back through', async () => {
    const w = await doorWorld();
    w.reveal('alice', 'w2', 'e0', 'e1', 'e2');
    w.placeParty('alice', 'w2');
    w.verdicts({ e0: LOSING, e1: LOSING, w2: SAFE });
    w.prefill('e0', 'e1', 'w2');
    expect(w.pm.partyBattles.handleMoveToRoom(w.partyId(), ROOM.e2)).toEqual({ success: true });
    const stopped = vi.spyOn(w.pm.partyBattles, 'recordRouteStopped');

    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 100);
    expect(w.pm.partyBattles.escapeBattle(w.partyId())).toBe(true);
    for (let i = 0; i < 100 && w.roomOf('alice') !== ROOM.e0; i++) vi.advanceTimersByTime(10);
    expect(w.roomOf('alice')).toBe(ROOM.e0);
    const crossedAt = Date.now();
    expect(w.pm.partyBattles.getPath(w.partyId()).map(t => t.id)).toEqual([ROOM.e1, ROOM.e2]);

    vi.advanceTimersByTime(crossedAt + DOOR_RETREAT_GRACE_MS - 100 - Date.now());
    expect(w.roomOf('alice')).toBe(ROOM.e0);
    expect(stopped).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(w.roomOf('alice')).toBe(ROOM.w2);
    expect(stopped).toHaveBeenCalledWith(w.partyId(), 'Room e0');
    expect(w.pm.partyBattles.getPartyState(w.partyId())!.route).toBeUndefined();
    expect(w.pm.partyBattles.getPath(w.partyId())).toEqual([]);

    vi.advanceTimersByTime(120_000);
    expect(w.roomOf('alice')).toBe(ROOM.w2);
    expect(w.retreatLines()).toEqual(['Auto-retreat took your party through the door from Room e0 to Room w2 — Room e0 was too dangerous (win chance 0%)']);
  });

  it.each([
    ['the door', { backDoorGate: { minLevel: 2 } }],
    ['the room behind it', { gates: { w2: { minLevel: 2 } } }],
  ] as [string, TravelOptions][])('holds when %s is gated for one member', async (_what, opts) => {
    const w = await doorWorld(['alice', 'bob'], opts);
    w.befriend('alice', 'bob');
    w.join('alice', 'bob');
    expect(w.pm.partyBattles.getMembers(w.partyId())?.size).toBe(2);
    w.levelTo('alice', 3);
    w.placeParty('alice', 'w2');
    w.verdicts({ e0: LOSING, e1: LOSING, w2: SAFE });
    w.prefill('e0', 'e1', 'w2');
    expect(w.pm.partyBattles.enterTransition(w.partyId(), ROOM.e0)).toEqual({ success: true });

    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS + 60_000);
    expect(w.roomOf('alice')).toBe(ROOM.e0);
    expect(w.retreatLines()).toEqual(['Nowhere safer to retreat from Room e0 — fighting on']);
  });

  it('never takes a door while the party has a hire, even one that would stay with it', async () => {
    const w = await doorWorld();
    w.reveal('alice', 'e0', 'e1');
    w.placeParty('alice', 'w2');
    w.hire('alice');
    w.pm.partyBattles.henchmenChanged(w.partyId());
    w.verdicts({ e0: LOSING, e1: LOSING, w2: SAFE });
    w.prefill('e0', 'e1', 'w2');
    expect(w.pm.partyBattles.enterTransition(w.partyId(), ROOM.e0)).toEqual({ success: true });
    expect(w.hires('alice')).toBe(1);

    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS + 60_000);
    expect(w.roomOf('alice')).toBe(ROOM.e0);
    expect(w.hires('alice')).toBe(1);
    expect(w.retreatLines()).toEqual(['Nowhere safer to retreat from Room e0 — fighting on']);
  });

  it('calls the trip back off when a hire joins during the grace, and decides again with the hire', async () => {
    const w = await burrowArrival();
    w.pm.partyBattles.enterTransition(w.partyId(), ROOM.b0);
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS / 2);
    expect(w.entry().pendingRetreat?.kind).toBe('door');

    w.hire('alice');
    w.pm.partyBattles.henchmenChanged(w.partyId());
    expect(w.entry().pendingRetreat).toBeUndefined();
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS + 60_000);

    expect(w.pm.partyBattles.getMapId(w.partyId())).toBe(BURROW);
    expect(w.roomOf('alice')).toBe(ROOM.b0);
    expect(w.hires('alice')).toBe(1);
    expect(w.retreatLines()).toEqual(['Nowhere safer to retreat from Room b0 — fighting on']);
  });

  it('calls the trip back off when a player moves the party', async () => {
    const w = await burrowArrival();
    w.pm.partyBattles.enterTransition(w.partyId(), ROOM.b0);
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS / 2);
    expect(w.pm.partyBattles.handleMoveToRoom(w.partyId(), ROOM.b1)).toEqual({ success: true });
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS);
    expect(w.pm.partyBattles.getMapId(w.partyId())).toBe(BURROW);
    expect(w.retreatLines().some(l => l.startsWith('Auto-retreat took'))).toBe(false);
  });

  it('does nothing with auto-retreat off', async () => {
    const w = await burrowArrival();
    w.pm.handleSetCombatPrefs('alice', 0);
    w.pm.partyBattles.enterTransition(w.partyId(), ROOM.b0);
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS + 60_000);
    expect(w.roomOf('alice')).toBe(ROOM.b0);
    expect(w.retreatLines()).toEqual([]);
  });

  it('never takes a door the party could not come back through', async () => {
    const w = await doorWorld();
    w.placeParty('alice', 'b1');
    w.reveal('alice', 'b0', 'b2', 'p0', 'p1');
    w.verdicts({ b0: LOSING, b1: LOSING, b2: LOSING, p0: SAFE });
    w.prefill('b0', 'b1', 'b2', 'p0');
    w.pm.partyBattles.restartBattle(w.partyId());
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS + 60_000);
    expect(w.pm.partyBattles.getMapId(w.partyId())).toBe(BURROW);
    expect(w.roomOf('alice')).toBe(ROOM.b1);
    expect(w.retreatLines()).toEqual(['Nowhere safer to retreat from Room b1 — fighting on']);
  });

  it('calls the trip back off when the door locks during the grace', async () => {
    const w = await burrowArrival();
    w.pm.partyBattles.enterTransition(w.partyId(), ROOM.b0);
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS / 2);
    w.world.tiles.find(t => t.id === ROOM.b0)!.transitions![0].entryRequirements = { minLevel: 5 };
    w.bump();
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS + 60_000);
    expect(w.pm.partyBattles.getMapId(w.partyId())).toBe(BURROW);
    expect(w.retreatLines().some(l => l.startsWith('Auto-retreat took'))).toBe(false);
  });

  /** Alice owns a party with Bob, who has auto-retreat off, and has just come through the burrow door. */
  async function pairInBurrow(): Promise<DoorWorld> {
    const w = await doorWorld(['alice', 'bob']);
    w.befriend('alice', 'bob');
    w.join('alice', 'bob');
    w.pm.handleSetCombatPrefs('bob', 0);
    w.placeParty('alice', 'e2');
    w.verdicts({ b0: LOSING, b1: LOSING, e2: SAFE });
    w.prefill('b0', 'b1', 'e2');
    w.pm.partyBattles.enterTransition(w.partyId(), ROOM.b0);
    expect(w.entry().pendingRetreat?.kind).toBe('door');
    return w;
  }

  it('calls the trip back off when the party passes to an owner with auto-retreat off', async () => {
    const w = await pairInBurrow();
    expect(w.pm.transferPartyOwnership('alice', 'bob')).toBe(true);
    expect(w.entry().pendingRetreat).toBeUndefined();
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS + 60_000);
    expect(w.pm.partyBattles.getMapId(w.partyId())).toBe(BURROW);
    expect(w.journal().filter(l => l.startsWith('Avoided') || l.startsWith('Auto-retreat') || l.startsWith('Nowhere'))).toEqual([]);
  });

  it('crosses no door once the setting is off, even with nothing telling it so', async () => {
    const w = await pairInBurrow();
    const getPartyId = (u: string) => w.pm.getSessionByUsername(u)?.getPartyId() ?? null;
    expect(w.pm.parties.transferOwnership('alice', 'bob', getPartyId)).toBe(true);
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS + 60_000);
    expect(w.pm.partyBattles.getMapId(w.partyId())).toBe(BURROW);
    expect(w.retreatLines()).toEqual([]);
  });

  it('never takes a door from inside a dungeon', async () => {
    const w = await burrowArrival({ dungeonAt: 'b0' });
    w.pm.partyBattles.enterTransition(w.partyId(), ROOM.b0);
    expect(w.pm.partyBattles.enterDungeon(w.partyId(), DUNGEON.id)).toEqual({ success: true });
    vi.advanceTimersByTime(DOOR_RETREAT_GRACE_MS + 60_000);
    expect(w.pm.partyBattles.getDungeonRunInfo(w.partyId())).not.toBeNull();
    expect(w.pm.partyBattles.getMapId(w.partyId())).toBe(BURROW);
    expect(w.retreatLines()).toEqual([]);
  });
});
