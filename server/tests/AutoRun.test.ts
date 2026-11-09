import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { COMBAT_PACE, RUN_AVAILABLE_MS, createMonsterInstance, createPartyCombatState } from '@idle-party-rpg/shared';
import { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';
import type { ServerParty } from '../src/game/ServerParty.js';
import { PartySystem } from '../src/game/social/PartySystem.js';

function longFight() {
  const monster = createMonsterInstance(
    { id: 'dummy', name: 'Dummy', hp: 1_000_000, damage: 1, damageType: 'physical', xp: 5, goldMin: 0, goldMax: 0 },
    4,
  );
  return createPartyCombatState([{
    username: 'alice',
    maxHp: 1_000_000,
    baseDamage: 1,
    playerDamageType: 'physical',
    gridPosition: 4,
    className: 'Knight',
    level: 1,
    equippedSkills: [null, null, null, null, null],
  }], [monster], { pace: COMBAT_PACE });
}

function harness(opts: { autoRun: boolean; destination: boolean; walkable?: boolean }) {
  const state = { ...opts, walkable: opts.walkable ?? true };
  const party = {
    get hasDestination() { return state.destination; },
    enterBattle: vi.fn(),
    exitBattle: vi.fn(),
    moveToNextTile: vi.fn(() => true),
  };
  const onAutoRun = vi.fn();
  const timer = new ServerBattleTimer(party as unknown as ServerParty, longFight, {
    canMoveToNextTile: () => state.walkable,
    isAutoRun: () => state.autoRun,
    onAutoRun: () => {
      onAutoRun();
      timer.escapeBattle();
    },
  }, 'test-party');
  return { timer, state, party, onAutoRun };
}

describe('auto run', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs as soon as Run opens when the party has a route', () => {
    const h = harness({ autoRun: true, destination: true });
    h.timer.start();
    vi.advanceTimersByTime(RUN_AVAILABLE_MS - 500);
    expect(h.onAutoRun).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(h.onAutoRun).toHaveBeenCalledTimes(1);
    expect(h.timer.currentState).toBe('result');
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
    vi.advanceTimersByTime(1000);
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
