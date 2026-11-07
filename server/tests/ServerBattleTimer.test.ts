import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createPartyCombatState,
  createMonsterInstance,
  COMBAT_STEP_MS,
  COMBAT_SEND_MS,
  COMBAT_SNAPSHOT_MS,
  KILL_BEAT_MS,
  RESULT_PAUSE,
  MOVE_DURATION,
  RUN_AVAILABLE_MS,
} from '@idle-party-rpg/shared';
import type { BattleResult, BattleTimerState, PartyCombatantInit, PartyCombatState, PartyGridPosition } from '@idle-party-rpg/shared';
import { ServerBattleTimer, LIVE_LOG_RING_SIZE } from '../src/game/ServerBattleTimer.js';
import type { CombatFlush, ServerBattleCallbacks } from '../src/game/ServerBattleTimer.js';
import type { ServerParty } from '../src/game/ServerParty.js';

type Fight = 'win' | 'lose' | 'long';

/** Deterministic fights: 'win' ends at 1000 ms (victory), 'lose' at 1400 ms (defeat), 'long' runs for minutes. */
function makeCombat(fight: Fight): PartyCombatState {
  const stats = {
    win: { hp: 1000, dmg: 1000, monsterHp: 5, monsterDmg: 1 },
    lose: { hp: 1, dmg: 0, monsterHp: 10_000, monsterDmg: 100 },
    long: { hp: 1_000_000, dmg: 1, monsterHp: 1_000_000, monsterDmg: 1 },
  }[fight];
  const player: PartyCombatantInit = {
    username: 'alice',
    maxHp: stats.hp,
    baseDamage: stats.dmg,
    playerDamageType: 'physical',
    gridPosition: 4,
    className: 'Knight',
    level: 1,
    equippedSkills: [null, null, null, null, null],
  };
  const monster = createMonsterInstance(
    { id: 'dummy', name: 'Dummy', hp: stats.monsterHp, damage: stats.monsterDmg, damageType: 'physical', xp: 5, goldMin: 0, goldMax: 0 },
    4,
  );
  return createPartyCombatState([player], [monster]);
}

/** Two players act 100 ms apart, so half the lines land on steps between flushes. */
function twoPlayerLongFight(): PartyCombatState {
  const player = (username: string, gridPosition: PartyGridPosition): PartyCombatantInit => ({
    username,
    maxHp: 1_000_000,
    baseDamage: 1,
    playerDamageType: 'physical',
    gridPosition,
    className: 'Knight',
    level: 1,
    equippedSkills: [null, null, null, null, null],
  });
  const monster = createMonsterInstance(
    { id: 'dummy', name: 'Dummy', hp: 1_000_000, damage: 1, damageType: 'physical', xp: 5, goldMin: 0, goldMax: 0 },
    4,
  );
  return createPartyCombatState([player('alice', 4), player('bob', 1)], [monster]);
}

interface FakeParty {
  hasDestination: boolean;
  enterBattle: ReturnType<typeof vi.fn>;
  exitBattle: ReturnType<typeof vi.fn>;
  moveToNextTile: ReturnType<typeof vi.fn>;
}

function fakeParty(hasDestination = false): FakeParty {
  return { hasDestination, enterBattle: vi.fn(), exitBattle: vi.fn(), moveToNextTile: vi.fn(() => true) };
}

interface RecordedFlush extends CombatFlush {
  at: number;
  elapsedMs: number;
}

interface Harness {
  timer: ServerBattleTimer;
  party: FakeParty;
  flushes: RecordedFlush[];
  states: { state: BattleTimerState; at: number }[];
  ends: { result: BattleResult; at: number }[];
  moves: number[];
  createCombat: ReturnType<typeof vi.fn>;
  t0: number;
}

function harness(
  fights: Fight | (() => PartyCombatState),
  opts: { hasDestination?: boolean; callbacks?: Partial<ServerBattleCallbacks> } = {},
): Harness {
  const t0 = Date.now();
  const party = fakeParty(opts.hasDestination ?? false);
  const flushes: RecordedFlush[] = [];
  const states: { state: BattleTimerState; at: number }[] = [];
  const ends: { result: BattleResult; at: number }[] = [];
  const moves: number[] = [];
  const createCombat = vi.fn(typeof fights === 'function' ? fights : () => makeCombat(fights));
  const timer = new ServerBattleTimer(party as unknown as ServerParty, createCombat, {
    onCombatFlush: (f) => flushes.push({ ...f, events: [...f.events], log: [...f.log], at: Date.now() - t0, elapsedMs: f.combat.elapsedMs }),
    onStateChange: (s) => states.push({ state: s, at: Date.now() - t0 }),
    onBattleEnd: (r) => ends.push({ result: r, at: Date.now() - t0 }),
    onMove: () => moves.push(Date.now() - t0),
    canMoveToNextTile: () => false,
    ...opts.callbacks,
  }, 'test-party');
  return { timer, party, flushes, states, ends, moves, createCombat, t0 };
}

describe('ServerBattleTimer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('lifecycle', () => {
    it('does not fight until start(), and start() is idempotent', () => {
      const h = harness('long');
      vi.advanceTimersByTime(5000);
      expect(h.createCombat).not.toHaveBeenCalled();
      expect(h.timer.currentCombat).toBeNull();
      expect(h.timer.isStarted).toBe(false);

      h.timer.start();
      h.timer.start();
      expect(h.createCombat).toHaveBeenCalledTimes(1);
      const id = h.timer.battleId;
      vi.advanceTimersByTime(1000);
      h.timer.start();
      expect(h.createCombat).toHaveBeenCalledTimes(1);
      expect(h.timer.battleId).toBe(id);
      h.timer.destroy();
    });

    it('treats restartBattle on a never-started timer as start()', () => {
      const h = harness('long');
      h.timer.restartBattle();
      expect(h.timer.isStarted).toBe(true);
      expect(h.createCombat).toHaveBeenCalledTimes(1);
      h.timer.start();
      expect(h.createCombat).toHaveBeenCalledTimes(1);
      h.timer.destroy();
    });

    it('accepts destroy() before start(), after which it never fights', () => {
      const h = harness('long');
      h.timer.destroy();
      h.timer.start();
      h.timer.restartBattle();
      vi.advanceTimersByTime(10_000);
      expect(h.createCombat).not.toHaveBeenCalled();
      expect(h.flushes).toHaveLength(0);
    });

    it('hands out process-wide unique, increasing battle ids (restarts included)', () => {
      const a = harness('long');
      const b = harness('long');
      a.timer.start();
      b.timer.start();
      const first = a.timer.battleId;
      const second = b.timer.battleId;
      a.timer.restartBattle();
      const third = a.timer.battleId;
      expect(new Set([first, second, third]).size).toBe(3);
      expect(second).toBeGreaterThan(first);
      expect(third).toBeGreaterThan(second);
      a.timer.destroy();
      b.timer.destroy();
    });

    it('destroy() stops stepping, flushing and every pending callback', () => {
      const h = harness('win', { hasDestination: true });
      h.timer.start();
      vi.advanceTimersByTime(1000);
      expect(h.timer.currentCombat!.finished).toBe(true);
      const flushCount = h.flushes.length;
      h.timer.destroy();
      vi.advanceTimersByTime(60_000);
      expect(h.flushes).toHaveLength(flushCount);
      expect(h.ends).toHaveLength(0);
      expect(h.moves).toHaveLength(0);
      expect(h.createCombat).toHaveBeenCalledTimes(1);
      expect(h.timer.isLive).toBe(false);
    });
  });

  describe('cadence and batching', () => {
    it('steps every COMBAT_STEP_MS with a fixed dt and tracks the duration as combat time', () => {
      const h = harness('long');
      h.timer.start();
      vi.advanceTimersByTime(COMBAT_STEP_MS * 10);
      const combat = h.timer.currentCombat!;
      expect(combat.elapsedMs).toBe(1000);
      expect(combat.tickCount).toBe(10);
      expect(h.timer.currentDuration).toBe(1000);
      vi.advanceTimersByTime(COMBAT_STEP_MS * 3);
      expect(combat.elapsedMs).toBe(1300);
      h.timer.destroy();
    });

    it('flushes a full snapshot immediately on start', () => {
      const h = harness('long');
      h.timer.start();
      expect(h.flushes).toHaveLength(1);
      expect(h.flushes[0]).toMatchObject({ snapshot: 'full', events: [], log: [], elapsedMs: 0, battleId: h.timer.battleId });
      h.timer.destroy();
    });

    it('batches events and log lines every COMBAT_SEND_MS of combat time, with a dynamic snapshot every ≥ COMBAT_SNAPSHOT_MS', () => {
      const h = harness('long');
      h.timer.start();
      vi.advanceTimersByTime(10_000);
      const live = h.flushes.slice(1);
      expect(live.length).toBeGreaterThan(10);

      for (const f of live) {
        expect(f.elapsedMs % COMBAT_SEND_MS).toBe(0);
        expect(f.snapshot === 'dynamic' || f.events.length > 0 || f.log.length > 0).toBe(true);
        expect(f.snapshot).not.toBe('full');
      }
      for (let i = 1; i < live.length; i++) {
        expect(live[i].elapsedMs - live[i - 1].elapsedMs).toBeGreaterThanOrEqual(COMBAT_SEND_MS);
      }

      const snapshotTimes = [0, ...live.filter(f => f.snapshot === 'dynamic').map(f => f.elapsedMs)];
      for (let i = 1; i < snapshotTimes.length; i++) {
        const gap = snapshotTimes[i] - snapshotTimes[i - 1];
        expect(gap).toBeGreaterThanOrEqual(COMBAT_SNAPSHOT_MS);
        expect(gap).toBeLessThan(COMBAT_SNAPSHOT_MS + COMBAT_SEND_MS);
      }

      const ids = live.flatMap(f => f.events.map(e => e.id));
      expect(ids).toEqual(ids.map((_, i) => i + 1));
      expect(live[0].events[0].kind).toBe('battle_start');
      expect(live.every(f => f.battleId === h.timer.battleId)).toBe(true);
      h.timer.destroy();
    });

    it('keeps a ring of the last live log lines for resync, cleared on each new battle', () => {
      const h = harness('long');
      h.timer.start();
      vi.advanceTimersByTime(5000);
      const delivered = h.flushes.flatMap(f => f.log);
      expect(h.timer.recentLog).toEqual(delivered.slice(-LIVE_LOG_RING_SIZE));

      vi.advanceTimersByTime(30_000);
      const all = h.flushes.flatMap(f => f.log);
      expect(all.length).toBeGreaterThan(LIVE_LOG_RING_SIZE);
      expect(h.timer.recentLog).toEqual(all.slice(-LIVE_LOG_RING_SIZE));

      h.timer.restartBattle();
      expect(h.timer.recentLog).toEqual([]);
      h.timer.destroy();
    });

    it('holds only lines already flushed, and flushPending sends the rest at once', () => {
      const h = harness(twoPlayerLongFight);
      h.timer.start();
      let sawPending = false;
      for (let step = 0; step < 50; step++) {
        vi.advanceTimersByTime(COMBAT_STEP_MS);
        const delivered = h.flushes.flatMap(f => f.log);
        expect(h.timer.recentLog).toEqual(delivered.slice(-LIVE_LOG_RING_SIZE));

        const flushCount = h.flushes.length;
        h.timer.flushPending();
        if (h.flushes.length === flushCount) continue;
        sawPending = true;
        const pending = h.flushes[h.flushes.length - 1];
        expect(pending.snapshot).toBeNull();
        expect(pending.events.length + pending.log.length).toBeGreaterThan(0);
        expect(h.timer.recentLog).toEqual(h.flushes.flatMap(f => f.log).slice(-LIVE_LOG_RING_SIZE));
      }
      expect(sawPending).toBe(true);

      const flushCount = h.flushes.length;
      h.timer.flushPending();
      expect(h.flushes).toHaveLength(flushCount);
      h.timer.destroy();
    });
  });

  describe('battle end sequencing', () => {
    it('flushes the finish at once, then kill beat → result → move → next battle', () => {
      const h = harness('win', { hasDestination: true });
      h.timer.start();
      const firstId = h.timer.battleId;

      vi.advanceTimersByTime(1000);
      const finish = h.flushes[h.flushes.length - 1];
      expect(finish.at).toBe(1000);
      expect(finish.snapshot).toBe('dynamic');
      expect(finish.events.map(e => e.kind)).toContain('battle_end');
      expect(finish.events.find(e => e.kind === 'battle_end')!.result).toBe('victory');
      expect(h.timer.currentState).toBe('battle');
      expect(h.timer.isLive).toBe(true);
      expect(h.ends).toHaveLength(0);

      vi.advanceTimersByTime(KILL_BEAT_MS - 1);
      expect(h.ends).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(h.ends).toEqual([{ result: 'victory', at: 1000 + KILL_BEAT_MS }]);
      expect(h.timer.currentState).toBe('result');
      expect(h.timer.visual).toBe('victory');
      expect(h.states.map(s => s.state)).toEqual(['result']);
      expect(h.timer.isLive).toBe(false);

      vi.advanceTimersByTime(RESULT_PAUSE);
      expect(h.moves).toEqual([1000 + KILL_BEAT_MS + RESULT_PAUSE]);
      expect(h.party.moveToNextTile).toHaveBeenCalledTimes(1);
      expect(h.timer.visual).toBe('none');
      expect(h.createCombat).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(MOVE_DURATION);
      expect(h.createCombat).toHaveBeenCalledTimes(2);
      expect(h.timer.battleId).not.toBe(firstId);
      expect(h.timer.currentState).toBe('battle');
      expect(h.timer.lastResult).toBeUndefined();
      expect(h.flushes[h.flushes.length - 1]).toMatchObject({ snapshot: 'full', battleId: h.timer.battleId });
      h.timer.destroy();
    });

    it('starts the next battle after the full result window when the party does not move', () => {
      const h = harness('lose');
      h.timer.start();
      vi.advanceTimersByTime(1400 + KILL_BEAT_MS);
      expect(h.ends).toEqual([{ result: 'defeat', at: 1400 + KILL_BEAT_MS }]);
      vi.advanceTimersByTime(RESULT_PAUSE + MOVE_DURATION - 1);
      expect(h.createCombat).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(h.createCombat).toHaveBeenCalledTimes(2);
      expect(h.moves).toHaveLength(0);
      h.timer.destroy();
    });
  });

  describe('Run gating', () => {
    it('allows escape only from RUN_AVAILABLE_MS of combat time', () => {
      const h = harness('long');
      h.timer.start();
      vi.advanceTimersByTime(RUN_AVAILABLE_MS - COMBAT_STEP_MS);
      expect(h.timer.canEscape()).toBe(false);
      expect(h.timer.escapeBattle()).toBe(false);
      vi.advanceTimersByTime(COMBAT_STEP_MS);
      expect(h.timer.canEscape()).toBe(true);

      const before = h.timer.battleId;
      expect(h.timer.escapeBattle()).toBe(true);
      expect(h.ends).toHaveLength(0);
      expect(h.timer.battleId).not.toBe(before);
      expect(h.timer.canEscape()).toBe(false);
      h.timer.destroy();
    });

    it('refuses escape during the kill beat, so a won fight is still paid out', () => {
      const h = harness('long');
      h.timer.start();
      vi.advanceTimersByTime(RUN_AVAILABLE_MS + 500);
      expect(h.timer.canEscape()).toBe(true);

      const combat = h.timer.currentCombat!;
      combat.monsters[0].currentHp = 1;
      vi.advanceTimersByTime(1000);
      expect(combat.finished).toBe(true);
      expect(combat.elapsedMs).toBeGreaterThanOrEqual(RUN_AVAILABLE_MS);

      expect(h.timer.canEscape()).toBe(false);
      expect(h.timer.escapeBattle()).toBe(false);
      vi.advanceTimersByTime(KILL_BEAT_MS);
      expect(h.ends.map(e => e.result)).toEqual(['victory']);
      h.timer.destroy();
    });
  });

  describe('settlePendingResult', () => {
    it('grants a finished fight exactly once, even when the kill beat later fires', () => {
      const h = harness('win');
      h.timer.start();
      vi.advanceTimersByTime(1000);
      expect(h.ends).toHaveLength(0);

      h.timer.settlePendingResult();
      h.timer.settlePendingResult();
      expect(h.ends.map(e => e.result)).toEqual(['victory']);
      expect(h.timer.lastResult).toBe('victory');

      vi.advanceTimersByTime(KILL_BEAT_MS);
      expect(h.ends).toHaveLength(1);
      expect(h.timer.currentState).toBe('result');
      vi.advanceTimersByTime(RESULT_PAUSE + MOVE_DURATION);
      expect(h.createCombat).toHaveBeenCalledTimes(2);
      h.timer.destroy();
    });

    it('does nothing while the fight is still going or already shown', () => {
      const h = harness('win');
      h.timer.start();
      vi.advanceTimersByTime(500);
      h.timer.settlePendingResult();
      expect(h.ends).toHaveLength(0);
      vi.advanceTimersByTime(500 + KILL_BEAT_MS);
      expect(h.ends).toHaveLength(1);
      h.timer.settlePendingResult();
      expect(h.ends).toHaveLength(1);
      h.timer.destroy();
    });

    it('is applied by restartBattle, which then fights again at once with no move', () => {
      const h = harness('win', { hasDestination: true });
      h.timer.start();
      vi.advanceTimersByTime(1000);
      h.timer.restartBattle();
      expect(h.ends.map(e => e.result)).toEqual(['victory']);
      expect(h.createCombat).toHaveBeenCalledTimes(2);
      expect(h.moves).toHaveLength(0);
      vi.advanceTimersByTime(KILL_BEAT_MS - 1);
      expect(h.ends).toHaveLength(1);
      h.timer.destroy();
    });
  });

  describe('failure guard', () => {
    it('survives a throwing createCombat with exponential backoff, no extra battle starts, then fights normally', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      let calls = 0;
      const onBattleStart = vi.fn();
      const h = harness(() => {
        calls++;
        if (calls <= 2) throw new Error(`boom ${calls}`);
        return makeCombat('long');
      }, { callbacks: { onBattleStart } });

      expect(() => h.timer.start()).not.toThrow();
      expect(error).toHaveBeenCalledTimes(1);
      expect(h.timer.currentCombat).toBeNull();
      expect(h.timer.currentState).toBe('result');
      expect(h.timer.visual).toBe('none');
      expect(h.states.map(s => s.state)).toEqual(['result']);

      vi.advanceTimersByTime(999);
      expect(calls).toBe(1);
      vi.advanceTimersByTime(1);
      expect(calls).toBe(2);
      expect(error).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1999);
      expect(calls).toBe(2);
      vi.advanceTimersByTime(1);
      expect(calls).toBe(3);
      expect(h.timer.isLive).toBe(true);
      expect(h.timer.currentState).toBe('battle');
      expect(onBattleStart).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(2);
      h.timer.destroy();
    });

    it('caps the backoff at 30 s and logs once per failing battle', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const h = harness('long', { callbacks: { onCombatFlush: () => { throw new Error('socket exploded'); } } });
      h.timer.start();
      const retryTimes: number[] = [];
      let last = h.createCombat.mock.calls.length;
      for (let t = 0; t < 200_000; t += 1000) {
        vi.advanceTimersByTime(1000);
        if (h.createCombat.mock.calls.length !== last) {
          last = h.createCombat.mock.calls.length;
          retryTimes.push(Date.now() - h.t0);
        }
      }
      const gaps = retryTimes.map((t, i) => t - (i === 0 ? 0 : retryTimes[i - 1]));
      expect(gaps.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
      expect(gaps.slice(6).every(g => g === 30000)).toBe(true);
      expect(error).toHaveBeenCalledTimes(h.createCombat.mock.calls.length);
      h.timer.destroy();
    });

    it('never retries a throwing onBattleEnd (no double grant) and moves on to the next battle', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      let grants = 0;
      const h = harness('win', {
        hasDestination: true,
        callbacks: {
          onBattleEnd: () => {
            grants++;
            if (grants === 1) throw new Error('reward table broke');
          },
        },
      });
      h.timer.start();
      vi.advanceTimersByTime(1000 + KILL_BEAT_MS);
      expect(grants).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(h.timer.currentCombat).toBeNull();

      h.timer.settlePendingResult();
      expect(grants).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(h.createCombat).toHaveBeenCalledTimes(2);
      expect(grants).toBe(1);
      vi.advanceTimersByTime(1000 + KILL_BEAT_MS);
      expect(grants).toBe(2);
      h.timer.destroy();
    });

    it('does not retry after destroy()', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const h = harness(() => { throw new Error('always'); });
      h.timer.start();
      expect(h.createCombat).toHaveBeenCalledTimes(1);
      h.timer.destroy();
      vi.advanceTimersByTime(120_000);
      expect(h.createCombat).toHaveBeenCalledTimes(1);
    });
  });

  describe('retreat', () => {
    it('refuses before Run is available, then ends the fight as a retreat without a result', () => {
      const h = harness('long');
      h.timer.start();
      const battleId = h.timer.battleId;
      vi.advanceTimersByTime(RUN_AVAILABLE_MS - 500);
      expect(h.timer.retreat(battleId, 'Your party slips away.')).toBe(false);
      vi.advanceTimersByTime(500);
      expect(h.timer.retreat(battleId + 1, 'nope')).toBe(false);
      expect(h.timer.retreat(battleId, 'Your party slips away.')).toBe(true);

      const last = h.flushes[h.flushes.length - 1];
      expect(last.battleId).toBe(battleId);
      expect(last.snapshot).toBe('dynamic');
      expect(last.events.filter(e => e.kind === 'battle_end').map(e => e.result)).toEqual(['retreat']);
      expect(last.log).toContain('Your party slips away.');
      expect(h.timer.currentCombat!.result).toBe('retreat');
      expect(h.timer.visual).toBe('retreat');
      expect(h.timer.currentState).toBe('result');
      expect(h.timer.lastResult).toBeUndefined();
      expect(h.ends).toEqual([]);
      expect(h.timer.retreat(battleId, 'again')).toBe(false);

      vi.advanceTimersByTime(RESULT_PAUSE + MOVE_DURATION);
      expect(h.createCombat).toHaveBeenCalledTimes(2);
      expect(h.timer.battleId).not.toBe(battleId);
      expect(h.timer.visual).toBe('fighting');
      expect(h.ends).toEqual([]);
      h.timer.destroy();
    });

    it('lets onRetreat set a route, then walks it after the result pause', () => {
      let party: FakeParty | null = null;
      const h = harness('long', {
        callbacks: {
          onRetreat: () => { party!.hasDestination = true; },
          canMoveToNextTile: () => true,
        },
      });
      party = h.party;
      h.timer.start();
      vi.advanceTimersByTime(RUN_AVAILABLE_MS);
      expect(h.timer.retreat(h.timer.battleId, 'Falling back.')).toBe(true);
      vi.advanceTimersByTime(RESULT_PAUSE - 1);
      expect(h.party.moveToNextTile).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(h.party.moveToNextTile).toHaveBeenCalledTimes(1);
      h.timer.destroy();
    });

    it('scheduleRetreat waits until Run is available', () => {
      const h = harness('long');
      h.timer.start();
      const battleId = h.timer.battleId;
      h.timer.scheduleRetreat(battleId, 0, 'Slipping away.');
      vi.advanceTimersByTime(RUN_AVAILABLE_MS - COMBAT_STEP_MS);
      expect(h.timer.isFighting(battleId)).toBe(true);
      vi.advanceTimersByTime(2 * COMBAT_STEP_MS);
      expect(h.timer.isFighting(battleId)).toBe(false);
      expect(h.timer.currentCombat!.result).toBe('retreat');
      expect(h.timer.currentCombat!.elapsedMs).toBeGreaterThanOrEqual(RUN_AVAILABLE_MS);
      h.timer.destroy();
    });

    it('a scheduled retreat dies with its battle', () => {
      const h = harness('long');
      h.timer.start();
      const first = h.timer.battleId;
      h.timer.scheduleRetreat(first, RUN_AVAILABLE_MS, 'Slipping away.');
      vi.advanceTimersByTime(2000);
      h.timer.restartBattle();
      const second = h.timer.battleId;
      vi.advanceTimersByTime(RUN_AVAILABLE_MS * 2);
      expect(h.timer.battleId).toBe(second);
      expect(h.timer.isFighting(second)).toBe(true);
      expect(h.flushes.some(f => f.events.some(e => e.result === 'retreat'))).toBe(false);
      h.timer.destroy();
    });

    it('never retreats from a decided fight', () => {
      const h = harness('win');
      h.timer.start();
      const battleId = h.timer.battleId;
      h.timer.scheduleRetreat(battleId, 0, 'Slipping away.');
      vi.advanceTimersByTime(1000);
      expect(h.timer.isFighting(battleId)).toBe(false);
      vi.advanceTimersByTime(KILL_BEAT_MS);
      expect(h.ends.map(e => e.result)).toEqual(['victory']);
      vi.advanceTimersByTime(RUN_AVAILABLE_MS * 2);
      expect(h.flushes.some(f => f.events.some(e => e.result === 'retreat'))).toBe(false);
      h.timer.destroy();
    });
  });
});
