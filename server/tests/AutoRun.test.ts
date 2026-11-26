import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AUTO_RUN_ROOM_MS, COMBAT_PACE, MOVE_DURATION, RUN_AVAILABLE_MS, SEED_SKILLS, UnlockSystem, createMonsterInstance, createPartyCombatState } from '@idle-party-rpg/shared';
import { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';
import type { ServerParty } from '../src/game/ServerParty.js';
import { PartySystem } from '../src/game/social/PartySystem.js';
import { DEADLY, forecastWorld, joinAlice, tileId } from './forecastFixture.js';

const LEAVE_MS = AUTO_RUN_ROOM_MS - MOVE_DURATION;

function fight(className: 'Knight' | 'Archer', monsterHp: number) {
  const monster = createMonsterInstance(
    { id: 'dummy', name: 'Dummy', hp: monsterHp, damage: 1, damageType: 'physical', xp: 5, goldMin: 0, goldMax: 0 },
    4,
  );
  return createPartyCombatState([{
    username: 'alice',
    maxHp: 1_000_000,
    baseDamage: 5,
    playerDamageType: 'physical',
    gridPosition: 4,
    className,
    level: 1,
    attack: SEED_SKILLS[`${className.toLowerCase()}_attack`],
    equippedSkills: [null, null, null, null, null],
  }], [monster], { pace: COMBAT_PACE });
}

const longFight = () => fight('Knight', 1_000_000);
/** An Archer's first arrow lands before Autorun leaves, and it is enough. */
const quickKill = () => fight('Archer', 1);

function harness(opts: { autoRun: boolean; destination: boolean; walkable?: boolean }, createCombat = longFight) {
  const state = { ...opts, walkable: opts.walkable ?? true };
  const moves: number[] = [];
  const party = {
    get hasDestination() { return state.destination; },
    enterBattle: vi.fn(),
    exitBattle: vi.fn(),
    moveToNextTile: vi.fn(() => { moves.push(Date.now()); return true; }),
  };
  const onAutoRun = vi.fn();
  const onBattleStart = vi.fn();
  const onBattleEnd = vi.fn();
  const timer = new ServerBattleTimer(party as unknown as ServerParty, createCombat, {
    onBattleStart,
    onBattleEnd,
    canMoveToNextTile: () => state.walkable,
    isAutoRun: () => state.autoRun,
    onAutoRun: () => {
      onAutoRun();
      timer.autoRunAway();
    },
  }, 'test-party');
  return { timer, state, party, moves, onAutoRun, onBattleStart, onBattleEnd };
}

const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);

describe('auto run', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('walks a room every second', () => {
    expect(AUTO_RUN_ROOM_MS).toBe(1000);
    const h = harness({ autoRun: true, destination: true });
    h.timer.start();
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS * 10 + 50);
    expect(h.moves).toHaveLength(10);
    expect(h.onBattleStart).toHaveBeenCalledTimes(11);
    for (const gap of gaps(h.moves)) {
      expect(gap).toBeGreaterThanOrEqual(AUTO_RUN_ROOM_MS);
      expect(gap).toBeLessThanOrEqual(AUTO_RUN_ROOM_MS + 5);
    }
    expect(h.onBattleEnd).not.toHaveBeenCalled();
    h.timer.destroy();
  });

  it('leaves each fight in time to finish the walk inside the second', () => {
    const h = harness({ autoRun: true, destination: true });
    h.timer.start();
    vi.advanceTimersByTime(LEAVE_MS - 1);
    expect(h.onAutoRun).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(h.onAutoRun).toHaveBeenCalledTimes(1);
    expect(h.party.moveToNextTile).toHaveBeenCalledTimes(1);
    h.timer.destroy();
  });

  it('pays a fight won before it leaves and keeps the same pace', () => {
    const h = harness({ autoRun: true, destination: true }, quickKill);
    h.timer.start();
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS * 10);
    expect(h.onAutoRun).not.toHaveBeenCalled();
    expect(h.onBattleEnd).toHaveBeenCalledTimes(10);
    expect(h.onBattleEnd).toHaveBeenLastCalledWith('victory');
    expect(h.moves).toHaveLength(10);
    for (const gap of gaps(h.moves)) expect(gap).toBeLessThanOrEqual(AUTO_RUN_ROOM_MS + 5);
    h.timer.destroy();
  });

  it('reports how long is left before it leaves, a quick win included', () => {
    const h = harness({ autoRun: true, destination: true }, quickKill);
    h.timer.start();
    expect(h.timer.autoRunLeaveMs).toBe(LEAVE_MS);
    vi.advanceTimersByTime(400);
    expect(h.timer.isFighting(h.timer.battleId)).toBe(false);
    expect(h.timer.autoRunLeaveMs).toBe(LEAVE_MS - 400);
    h.state.destination = false;
    expect(h.timer.autoRunLeaveMs).toBeUndefined();
    h.timer.destroy();
  });

  it.each([['an unfinished fight', longFight], ['a quick win', quickKill]])(
    'still reports the walk into the last room of its route, after %s',
    (_, createCombat) => {
      const h = harness({ autoRun: true, destination: true }, createCombat);
      h.party.moveToNextTile.mockImplementationOnce(() => { h.state.destination = false; return true; });
      h.timer.start();
      vi.advanceTimersByTime(LEAVE_MS + 50);
      expect(h.party.moveToNextTile).toHaveBeenCalledTimes(1);
      expect(h.timer.autoRunWalking).toBe(true);
      vi.advanceTimersByTime(MOVE_DURATION);
      expect(h.timer.autoRunWalking).toBe(false);
      h.timer.destroy();
    },
  );

  it('keeps the usual pauses after a quick win with auto run off', () => {
    const h = harness({ autoRun: false, destination: true }, quickKill);
    h.timer.start();
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS + 300);
    expect(h.onBattleEnd).toHaveBeenCalledTimes(1);
    expect(h.moves).toHaveLength(0);
    h.timer.destroy();
  });

  it('keeps the usual pauses after a quick win when the next room is still under fog', () => {
    const h = harness({ autoRun: true, destination: true, walkable: false }, quickKill);
    h.timer.start();
    vi.advanceTimersByTime(1700);
    expect(h.moves).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(h.moves).toHaveLength(1);
    h.timer.destroy();
  });

  it('stays put when the route is cleared just after a quick win', () => {
    const h = harness({ autoRun: true, destination: true }, quickKill);
    h.timer.start();
    vi.advanceTimersByTime(LEAVE_MS - 100);
    h.state.destination = false;
    h.timer.syncAutoRun();
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS * 5);
    expect(h.moves).toHaveLength(0);
    h.timer.destroy();
  });

  it('holds a restart after a quick win only until the walk would have ended', () => {
    const h = harness({ autoRun: true, destination: true }, quickKill);
    h.timer.start();
    vi.advanceTimersByTime(LEAVE_MS - 100);
    h.timer.restartBattle();
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS - LEAVE_MS + 200);
    expect(h.moves).toHaveLength(1);
    expect(h.onBattleStart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MOVE_DURATION);
    expect(h.onBattleStart).toHaveBeenCalledTimes(2);
    h.timer.destroy();
  });

  it('walks one room, not two, when the party restarts mid-walk', () => {
    const h = harness({ autoRun: true, destination: true }, quickKill);
    h.timer.start();
    vi.advanceTimersByTime(LEAVE_MS + 100);
    expect(h.moves).toHaveLength(1);
    h.timer.restartBattle();
    vi.advanceTimersByTime(MOVE_DURATION);
    expect(h.moves).toHaveLength(1);
    expect(h.onBattleStart).toHaveBeenCalledTimes(2);
    h.timer.destroy();
  });

  it('does nothing when auto run is off, there is no route, or the next room is not walkable', () => {
    for (const opts of [
      { autoRun: false, destination: true },
      { autoRun: true, destination: false },
      { autoRun: true, destination: true, walkable: false },
    ]) {
      const h = harness(opts);
      h.timer.start();
      vi.advanceTimersByTime(RUN_AVAILABLE_MS * 2);
      expect(h.onAutoRun).not.toHaveBeenCalled();
      h.timer.destroy();
    }
  });

  it('keeps manual Run shut early in a fight, and its result pause when it opens', () => {
    const h = harness({ autoRun: false, destination: true });
    h.timer.start();
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS);
    expect(h.timer.canEscape()).toBe(false);
    expect(h.timer.escapeBattle()).toBe(false);
    vi.advanceTimersByTime(RUN_AVAILABLE_MS);
    expect(h.timer.escapeBattle()).toBe(true);
    vi.advanceTimersByTime(500);
    expect(h.moves).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(h.moves).toHaveLength(1);
    h.timer.destroy();
  });

  it('never runs in place: it stands down when the next room shuts before it fires', () => {
    const h = harness({ autoRun: false, destination: true });
    h.timer.start();
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 1000);
    expect(h.timer.canEscape()).toBe(true);
    h.state.autoRun = true;
    h.timer.syncAutoRun();
    h.state.walkable = false;
    vi.advanceTimersByTime(RUN_AVAILABLE_MS);
    expect(h.onAutoRun).not.toHaveBeenCalled();
    expect(h.timer.isLive).toBe(true);
    h.timer.destroy();
  });

  it('arms mid-fight when auto run is turned on and disarms when it is turned off', () => {
    const h = harness({ autoRun: false, destination: true });
    h.timer.start();
    vi.advanceTimersByTime(RUN_AVAILABLE_MS * 2 - 3000);
    h.state.autoRun = true;
    h.timer.syncAutoRun();
    vi.advanceTimersByTime(100);
    expect(h.onAutoRun).toHaveBeenCalledTimes(1);
    h.timer.destroy();

    const off = harness({ autoRun: true, destination: true });
    off.timer.start();
    vi.advanceTimersByTime(LEAVE_MS - 200);
    off.state.autoRun = false;
    off.timer.syncAutoRun();
    vi.advanceTimersByTime(RUN_AVAILABLE_MS * 2);
    expect(off.onAutoRun).not.toHaveBeenCalled();
    off.timer.destroy();
  });
});

describe('PartySystem auto run', () => {
  it('is per party, off by default, and reports whether it changed', () => {
    const parties = new PartySystem();
    const ids = new Map<string, string | null>();
    const get = (u: string) => ids.get(u) ?? null;
    const set = (u: string, id: string | null) => { ids.set(u, id); };
    const a = parties.createParty('a', get, set);
    const b = parties.createParty('b', get, set);
    if (typeof a === 'string' || typeof b === 'string') throw new Error('party not created');

    expect(parties.isAutoRun(a.id)).toBe(false);
    expect(parties.setAutoRun(a.id, true)).toBe(true);
    expect(parties.setAutoRun(a.id, true)).toBe(false);
    expect(parties.isAutoRun(a.id)).toBe(true);
    expect(parties.isAutoRun(b.id)).toBe(false);
    expect(parties.setAutoRun(a.id, false)).toBe(true);
    expect(parties.setAutoRun('missing', true)).toBe(false);
  });
});

describe('auto run through the party battle manager', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('refuses a manual Run early in a fight, while auto run leaves at once', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = await forecastWorld();
    const unlock = (w.session as unknown as { forceUnlockTileArea(t: unknown): void });
    unlock.forceUnlockTileArea(w.tileAt(1, 1));
    expect(w.pm.partyBattles.handleMove(w.partyId, 2, 1).success).toBe(true);
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS + 300);
    expect(w.pm.partyBattles.canEscape(w.partyId)).toBe(false);
    expect(w.pm.partyBattles.escapeBattle(w.partyId)).toBe(false);
    expect(w.journal()).not.toContain('Escaped the battle!');

    expect(w.pm.handleSetAutoRun('alice', true)).toBe(true);
    expect(w.pm.partyBattles.getBattleState(w.partyId)?.autoRunWalking).toBe(true);
    expect(w.pm.partyBattles.getBattleState(w.partyId)?.autoRunLeaveMs).toBeLessThanOrEqual(AUTO_RUN_ROOM_MS - MOVE_DURATION);
    vi.advanceTimersByTime(100);
    expect(w.entry().serverParty.tile.id).toBe(tileId(2, 1));
    expect(w.journal().join('\n')).toContain('Moved to');
    expect(w.journal()).not.toContain('Escaped the battle!');
    expect(w.pm.partyBattles.getBattleState(w.partyId)?.autoRunWalking).toBe(true);
    vi.advanceTimersByTime(MOVE_DURATION);
    expect(w.pm.partyBattles.getBattleState(w.partyId)?.autoRunWalking).toBeUndefined();
    w.pm.partyBattles.destroyEntry(w.partyId);
    vi.restoreAllMocks();
  });

  it('forecasts the room it stops in, not the ones auto run walks through', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = await forecastWorld();
    const unlock = (w.session as unknown as { forceUnlockTileArea(t: unknown): void });
    unlock.forceUnlockTileArea(w.tileAt(1, 1));
    unlock.forceUnlockTileArea(w.tileAt(2, 1));
    w.pm.partyBattles.setForecaster(w.svc);
    const request = vi.spyOn(w.svc, 'request');
    w.pm.handleSetAutoRun('alice', true);
    expect(w.pm.partyBattles.handleMove(w.partyId, 3, 1).success).toBe(true);
    const rooms = w.entry().serverParty.remainingPath.map(t => t.id);
    expect(rooms.length).toBeGreaterThan(1);

    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS * rooms.length + 300);

    expect(w.entry().serverParty.tile.id).toBe(tileId(3, 1));
    const asked = request.mock.calls.map(([job]) => job.key);
    for (const passed of rooms.slice(0, -1)) expect(asked).not.toContain(w.roomKey(passed));
    expect(asked).toContain(w.roomKey(tileId(3, 1)));
    w.pm.partyBattles.destroyEntry(w.partyId);
    vi.restoreAllMocks();
  });

  it('says nothing about walking when a join opens the next room mid-fight', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = await forecastWorld({ defaultEncounter: 'brutes' });
    // Alice has explored only the room she stands in, so the next one is fogged.
    (w.session as unknown as { unlockSystem: UnlockSystem }).unlockSystem = UnlockSystem.fromKeys(w.grid, [tileId(1, 1)]);
    w.pm.handleSetAutoRun('alice', true);
    expect(w.pm.partyBattles.handleMove(w.partyId, 2, 1).success).toBe(true);
    expect(w.pm.partyBattles.getBattleState(w.partyId)?.autoRunWalking).toBeUndefined();
    const battleId = w.entry().battleTimer.battleId;

    await joinAlice(w, 'bob', 'Priest');

    expect(w.pm.partyBattles.getBattleState(w.partyId)?.autoRunWalking).toBeUndefined();
    w.pm.partyBattles.setForecaster(w.svc);
    expect(w.pm.partyBattles.liveForecastResync(w.partyId)).not.toEqual([]);
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 500);
    expect(w.entry().battleTimer.battleId).toBe(battleId);

    w.pm.partyBattles.handleMove(w.partyId, 2, 1);
    expect(w.pm.partyBattles.getBattleState(w.partyId)?.autoRunWalking).toBe(true);
    w.pm.partyBattles.destroyEntry(w.partyId);
    vi.restoreAllMocks();
  });

  it('asks for no live forecast of an elite fight it is walking past', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = await forecastWorld({ defaultEncounter: 'brutes' });
    const unlock = (w.session as unknown as { forceUnlockTileArea(t: unknown): void });
    unlock.forceUnlockTileArea(w.tileAt(1, 1));
    unlock.forceUnlockTileArea(w.tileAt(2, 1));
    w.pm.handleSetAutoRun('alice', true);
    expect(w.pm.partyBattles.handleMove(w.partyId, 3, 1).success).toBe(true);
    w.pm.partyBattles.setForecaster(w.svc);
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS + 100);

    const battleId = w.entry().battleTimer.battleId;
    expect(w.pm.partyBattles.getBattleState(w.partyId)?.autoRunWalking).toBe(true);
    expect(w.pm.partyBattles.liveForecastResync(w.partyId)).toEqual([]);
    expect(w.stub.jobs.filter(j => j.key.startsWith(`battle:${battleId}:`))).toEqual([]);
    w.pm.partyBattles.destroyEntry(w.partyId);
    vi.restoreAllMocks();
  });

  it('still lets auto-retreat act on a fight the party stays in after all', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = await forecastWorld();
    const unlock = (w.session as unknown as { forceUnlockTileArea(t: unknown): void });
    unlock.forceUnlockTileArea(w.tileAt(1, 1));
    unlock.forceUnlockTileArea(w.tileAt(2, 1));
    w.stub.fallback.verdict = DEADLY;
    w.pm.partyBattles.setForecaster(w.svc);
    w.pm.handleSetAutoRun('alice', true);
    expect(w.pm.partyBattles.handleMove(w.partyId, 3, 1).success).toBe(true);
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS + 300);

    w.pm.partyBattles.stopTravel(w.partyId);
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 500);

    expect(w.journal().join('\n')).toContain('Avoided Ogre');
    w.pm.partyBattles.destroyEntry(w.partyId);
    vi.restoreAllMocks();
  });

  it('stops in the room it has reached, wherever the sender last saw it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = await forecastWorld();
    const unlock = (w.session as unknown as { forceUnlockTileArea(t: unknown): void });
    unlock.forceUnlockTileArea(w.tileAt(1, 1));
    unlock.forceUnlockTileArea(w.tileAt(2, 1));
    w.pm.handleSetAutoRun('alice', true);
    expect(w.pm.partyBattles.handleMove(w.partyId, 3, 1).success).toBe(true);
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS);
    const reached = w.entry().serverParty.tile.id;
    expect(reached).not.toBe(tileId(1, 1));

    w.pm.partyBattles.stopTravel(w.partyId);
    vi.advanceTimersByTime(AUTO_RUN_ROOM_MS * 3);

    expect(w.entry().serverParty.tile.id).toBe(reached);
    expect(w.entry().serverParty.remainingPath).toHaveLength(0);
    w.pm.partyBattles.destroyEntry(w.partyId);
    vi.restoreAllMocks();
  });
});
