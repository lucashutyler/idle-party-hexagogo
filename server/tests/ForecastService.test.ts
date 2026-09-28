import { describe, it, expect, vi } from 'vitest';
import { GAME_VERSION, SEED_ENCOUNTERS, SEED_MONSTERS, SEED_SKILLS, createForecastJob, runForecast } from '@idle-party-rpg/shared';
import type { ForecastInput, ForecastJob, ForecastJobOptions, ForecastResult, PartyCombatantInit, RoomForecastInput } from '@idle-party-rpg/shared';
import {
  ForecastService,
  FORECAST_CACHE_TTL_MS,
  FORECAST_REQUEST_WINDOW_MS,
  FORECAST_REQUESTS_PER_WINDOW,
  dungeonForecastKey,
  liveForecastKey,
  parseForecastRequestTarget,
  roomForecastKey,
} from '../src/game/ForecastService.js';
import type { ForecastPriority, ForecastRequest } from '../src/game/ForecastService.js';

/** A hand-driven clock: time moves only when a job "works" or the test advances it. */
class ManualClock {
  t = 0;
  private seq = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];

  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter(timer => timer.id !== handle);
  };

  get pending(): number {
    return this.timers.length;
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.timers = this.timers.filter(timer => timer !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = Math.max(this.t, end);
  }
}

function fakeResult(key: string, winPct = 50): ForecastResult {
  return {
    key, partyKey: 'pk', sims: 10, wins: 5, losses: 5, stalemates: 0, winPct, ci: [30, 70],
    medianMs: null, p90Ms: null, atMs: 0, killEtaMs: null, reasons: [],
  };
}

interface FakeJobLog {
  key: string;
  advances: number;
  startedAt: number[];
}

/** Jobs that take `advancesNeeded` advance() calls, each costing `costMs` of clock time. */
function fakeJobs(clock: ManualClock, opts: { advancesNeeded?: (key: string) => number; costMs?: number; failKey?: string } = {}) {
  const log: FakeJobLog[] = [];
  const order: string[] = [];
  const createJob = (_input: ForecastInput, jobOpts: ForecastJobOptions): ForecastJob => {
    const needed = opts.advancesNeeded?.(jobOpts.key) ?? 1;
    const entry: FakeJobLog = { key: jobOpts.key, advances: 0, startedAt: [] };
    log.push(entry);
    return {
      get done() { return entry.advances >= needed; },
      get sims() { return entry.advances; },
      maxSims: needed,
      runSims: () => 0,
      advance: () => {
        if (opts.failKey === jobOpts.key) throw new Error('engine blew up');
        entry.startedAt.push(clock.t);
        order.push(jobOpts.key);
        entry.advances++;
        clock.t += opts.costMs ?? 1;
        return 1;
      },
      result: () => fakeResult(jobOpts.key),
    };
  };
  return { log, order, createJob };
}

const DUMMY_INPUT: ForecastInput = { kind: 'room', players: [], table: [], monsters: {}, encounters: {} };

function req(key: string, priority: ForecastPriority, extra: Partial<ForecastRequest> = {}): ForecastRequest {
  return { key, priority, build: () => ({ input: DUMMY_INPUT }), ...extra };
}

function service(clock: ManualClock, jobs: ReturnType<typeof fakeJobs>, extra: ConstructorParameters<typeof ForecastService>[0] = {}) {
  return new ForecastService({ clock, createJob: jobs.createJob, ...extra });
}

describe('ForecastService slicing', () => {
  it('works in slices of at most 5 ms and rests three times as long between them', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { advancesNeeded: () => 40, costMs: 1 });
    const svc = service(clock, jobs);
    const done = vi.fn();
    expect(svc.request(req('a', 'explicit', { onDone: done }))).toEqual({ status: 'pending' });

    clock.advance(0);
    expect(jobs.log[0].advances).toBe(5);
    clock.advance(14);
    expect(jobs.log[0].advances).toBe(5);
    clock.advance(1);
    expect(jobs.log[0].advances).toBe(10);

    clock.advance(1000);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }));
    const starts = jobs.log[0].startedAt;
    const sliceStarts = starts.filter((_t, i) => i % 5 === 0);
    for (let i = 1; i < sliceStarts.length; i++) expect(sliceStarts[i] - sliceStarts[i - 1]).toBeGreaterThanOrEqual(20);
    const stats = svc.stats();
    expect(stats.longestSliceMs).toBeLessThanOrEqual(5);
    expect(stats.busyMs / clock.t).toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it('checks the clock between chunks, so a slice overruns by one chunk at most', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { advancesNeeded: () => 10, costMs: 3 });
    const svc = service(clock, jobs);
    svc.request(req('a', 'precheck'));
    clock.advance(0);
    expect(jobs.log[0].advances).toBe(2);
    expect(svc.stats().longestSliceMs).toBe(6);
  });

  it('yields between slices even when new work arrives mid-slice', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { advancesNeeded: () => 1, costMs: 5 });
    const svc = service(clock, jobs);
    svc.request(req('a', 'explicit', { onDone: () => { svc.request(req('b', 'explicit')); } }));
    clock.advance(0);
    expect(jobs.log.map(j => j.advances)).toEqual([1, 0]);
    clock.advance(14);
    expect(jobs.log[1].advances).toBe(0);
    clock.advance(1);
    expect(jobs.log[1].advances).toBe(1);
  });

  it('runs live before explicit before pre-check, and round-robins inside a lane', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { advancesNeeded: key => (key.startsWith('long') ? 10 : 1), costMs: 5 });
    const svc = service(clock, jobs);
    svc.request(req('pre', 'precheck'));
    svc.request(req('long1', 'explicit'));
    svc.request(req('long2', 'explicit'));
    svc.request(req('live', 'live'));
    clock.advance(10_000);
    expect(jobs.order.slice(0, 5)).toEqual(['live', 'long1', 'long2', 'long1', 'long2']);
    expect(jobs.order[jobs.order.length - 1]).toBe('pre');
  });

  it('drops a job whose engine throws and keeps going', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { failKey: 'bad' });
    const svc = service(clock, jobs);
    const bad = vi.fn();
    const good = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.request(req('bad', 'explicit', { onDone: bad }));
    svc.request(req('good', 'explicit', { onDone: good }));
    clock.advance(1000);
    expect(bad).toHaveBeenCalledWith(null);
    expect(good).toHaveBeenCalledWith(expect.objectContaining({ key: 'good' }));
    expect(svc.stats().jobsFailed).toBe(1);
    err.mockRestore();
  });

  it('answers unavailable when there is nothing to build', () => {
    const clock = new ManualClock();
    const svc = service(clock, fakeJobs(clock));
    expect(svc.request({ key: 'x', priority: 'explicit', build: () => null })).toEqual({ status: 'unavailable' });
    expect(svc.queued).toBe(0);
  });

  it('stops for good on shutdown', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { advancesNeeded: () => 100 });
    const svc = service(clock, jobs);
    svc.request(req('a', 'explicit'));
    clock.advance(0);
    svc.stop();
    expect(clock.pending).toBe(0);
    const before = jobs.log[0].advances;
    clock.advance(10_000);
    expect(jobs.log[0].advances).toBe(before);
    expect(svc.request(req('b', 'explicit'))).toEqual({ status: 'unavailable' });
  });

  it('logs a timing summary while busy', () => {
    const clock = new ManualClock();
    const lines: string[] = [];
    const svc = service(clock, fakeJobs(clock, { advancesNeeded: () => 200 }), { logEveryMs: 100, log: line => lines.push(line) });
    svc.request(req('a', 'explicit'));
    clock.advance(1000);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^\[Forecast\] \d+ jobs \(\d+ sims\).*longest slice/);
  });
});

describe('ForecastService dedupe, bounds and supersession', () => {
  it('runs one job per key and tells every listener', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock);
    const svc = service(clock, jobs);
    const a = vi.fn();
    const b = vi.fn();
    svc.request(req('k', 'precheck', { onDone: a }));
    svc.request(req('k', 'explicit', { onDone: b }));
    expect(jobs.log).toHaveLength(1);
    clock.advance(100);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('promotes a queued pre-check when someone asks for it explicitly', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { costMs: 5 });
    const svc = service(clock, jobs);
    svc.request(req('first', 'precheck'));
    svc.request(req('other', 'explicit'));
    svc.request(req('wanted', 'precheck'));
    svc.request(req('wanted', 'explicit'));
    clock.advance(1000);
    expect(jobs.order).toEqual(['other', 'wanted', 'first']);
  });

  it('holds at most maxQueued jobs, dropping the oldest of the lowest priority', () => {
    const clock = new ManualClock();
    const svc = service(clock, fakeJobs(clock), { maxQueued: 3 });
    const dropped = vi.fn();
    svc.request(req('p1', 'precheck', { onDone: dropped }));
    svc.request(req('p2', 'precheck'));
    svc.request(req('e1', 'explicit'));
    expect(svc.request(req('p3', 'precheck'))).toEqual({ status: 'pending' });
    expect(dropped).toHaveBeenCalledWith(null);
    expect(svc.queued).toBe(3);

    expect(svc.request(req('l1', 'live'))).toEqual({ status: 'pending' });
    expect(svc.request(req('l2', 'live'))).toEqual({ status: 'pending' });
    expect(svc.request(req('l3', 'live'))).toEqual({ status: 'pending' });
    expect(svc.request(req('p4', 'precheck'))).toEqual({ status: 'unavailable' });
    expect(svc.queued).toBe(3);
    expect(svc.stats().jobsDropped).toBe(4);
  });

  it('keeps one live job per party: a newer one drops the older', () => {
    const clock = new ManualClock();
    const svc = service(clock, fakeJobs(clock));
    const older = vi.fn();
    const newer = vi.fn();
    svc.request(req(liveForecastKey(7, 0), 'live', { cache: false, supersede: { group: 'live:p', previous: 'drop' }, onDone: older }));
    svc.request(req(liveForecastKey(7, 3000), 'live', { cache: false, supersede: { group: 'live:p', previous: 'drop' }, onDone: newer }));
    expect(older).toHaveBeenCalledWith(null);
    clock.advance(100);
    expect(newer).toHaveBeenCalledWith(expect.objectContaining({ key: 'battle:7:3000' }));
    expect(svc.get('battle:7:3000')).toBeNull();
  });

  it("gives a player's latest explicit request the explicit lane and demotes the one before", () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { costMs: 5 });
    const svc = service(clock, jobs);
    const first = vi.fn();
    svc.request(req('someone-else', 'precheck'));
    svc.request(req('room-a', 'explicit', { supersede: { group: 'explicit:alice', previous: 'demote' }, onDone: first }));
    svc.request(req('room-b', 'explicit', { supersede: { group: 'explicit:alice', previous: 'demote' } }));
    clock.advance(1000);
    expect(jobs.order).toEqual(['room-b', 'someone-else', 'room-a']);
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ key: 'room-a' }));
  });
});

describe('ForecastService cache', () => {
  it('serves results for 10 minutes', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock);
    const svc = service(clock, jobs);
    svc.request(req('k', 'precheck'));
    clock.advance(100);
    expect(svc.request(req('k', 'explicit'))).toEqual({ status: 'ok', result: expect.objectContaining({ key: 'k' }) });
    clock.advance(FORECAST_CACHE_TTL_MS);
    expect(svc.get('k')).toBeNull();
    expect(svc.request(req('k', 'explicit'))).toEqual({ status: 'pending' });
    expect(jobs.log).toHaveLength(2);
  });

  it('evicts the least recently used result beyond its size', () => {
    const clock = new ManualClock();
    const svc = service(clock, fakeJobs(clock), { cacheSize: 2 });
    for (const key of ['a', 'b']) svc.request(req(key, 'precheck'));
    clock.advance(100);
    expect(svc.get('a')).not.toBeNull();
    svc.request(req('c', 'precheck'));
    clock.advance(100);
    expect(svc.get('a')).not.toBeNull();
    expect(svc.get('b')).toBeNull();
    expect(svc.get('c')).not.toBeNull();
  });

  it('never caches live forecasts', () => {
    const clock = new ManualClock();
    const svc = service(clock, fakeJobs(clock));
    svc.request(req('battle:1:0', 'live', { cache: false }));
    clock.advance(100);
    expect(svc.get('battle:1:0')).toBeNull();
    expect(svc.stats().cached).toBe(0);
  });

  it('keys go stale with the game version and every content change', () => {
    expect(roomForecastKey(4, 'pkA', 'room-1')).toBe(`${GAME_VERSION}|4|pkA|room:room-1`);
    expect(roomForecastKey(5, 'pkA', 'room-1')).not.toBe(roomForecastKey(4, 'pkA', 'room-1'));
    expect(roomForecastKey(4, 'pkB', 'room-1')).not.toBe(roomForecastKey(4, 'pkA', 'room-1'));
    expect(dungeonForecastKey(4, 'pkA', 'caves', { floorIndex: 2, phase: 1, wipes: 3 })).toBe(`${GAME_VERSION}|4|pkA|dungeon:caves:2:1:3`);
    expect(liveForecastKey(12, 4500)).toBe('battle:12:4500');
  });
});

describe('ForecastService rate limit', () => {
  it('allows 20 requests a minute per player', () => {
    const clock = new ManualClock();
    const svc = service(clock, fakeJobs(clock));
    for (let i = 0; i < FORECAST_REQUESTS_PER_WINDOW; i++) {
      expect(svc.allowRequest('alice')).toBe(true);
      clock.advance(100);
    }
    expect(svc.allowRequest('alice')).toBe(false);
    expect(svc.allowRequest('bob')).toBe(true);
    clock.advance(FORECAST_REQUEST_WINDOW_MS - 1950);
    expect(svc.allowRequest('alice')).toBe(true);
    expect(svc.allowRequest('alice')).toBe(false);
  });
});

describe('parseForecastRequestTarget', () => {
  it('accepts rooms and dungeons only', () => {
    expect(parseForecastRequestTarget({ kind: 'room', tileId: 't1', extra: 1 })).toEqual({ kind: 'room', tileId: 't1' });
    expect(parseForecastRequestTarget({ kind: 'dungeon', dungeonId: 'd1' })).toEqual({ kind: 'dungeon', dungeonId: 'd1' });
    expect(parseForecastRequestTarget({ kind: 'battle', battleId: 3 })).toBeNull();
    expect(parseForecastRequestTarget({ kind: 'room', tileId: '' })).toBeNull();
    expect(parseForecastRequestTarget({ kind: 'room', tileId: 5 })).toBeNull();
    expect(parseForecastRequestTarget('room')).toBeNull();
    expect(parseForecastRequestTarget(null)).toBeNull();
  });
});

describe('ForecastService with the real engine', () => {
  it('slicing does not change the answer', () => {
    const player: PartyCombatantInit = {
      username: 'alice', maxHp: 40, baseDamage: 6, playerDamageType: 'physical', gridPosition: 4,
      className: 'Knight', level: 3, equippedSkills: [SEED_SKILLS['knight_guard'] ?? null, null, null, null, null],
    };
    const input: RoomForecastInput = {
      kind: 'room',
      players: [player],
      table: [{ encounterId: Object.keys(SEED_ENCOUNTERS)[0], weight: 1 }],
      monsters: SEED_MONSTERS,
      encounters: SEED_ENCOUNTERS,
    };
    const expected = runForecast(input, { key: 'real-room' });

    const clock = new ManualClock();
    let steps = 0;
    const svc = new ForecastService({
      clock,
      stepsPerCheck: 16,
      createJob: (jobInput, opts) => {
        const job = createForecastJob(jobInput, opts);
        return {
          get done() { return job.done; },
          get sims() { return job.sims; },
          maxSims: job.maxSims,
          runSims: n => job.runSims(n),
          advance: n => {
            const used = job.advance(n);
            steps += used;
            clock.t += 1;
            return used;
          },
          result: () => job.result(),
        };
      },
    });
    const done = vi.fn();
    svc.request({ key: 'real-room', priority: 'explicit', build: () => ({ input }), onDone: done });
    clock.advance(10 * 60 * 1000);
    expect(steps).toBeGreaterThan(0);
    expect(svc.stats().slices).toBeGreaterThan(1);
    expect(done).toHaveBeenCalledWith(expected);
  });
});

/** Jobs of `steps` combat steps at `msPerStep` each, honouring the chunk size they are handed. */
function steppedJobs(clock: ManualClock, spec: (key: string) => { steps: number; msPerStep: number }) {
  const chunks: { key: string; steps: number }[] = [];
  const createJob = (_input: ForecastInput, jobOpts: ForecastJobOptions): ForecastJob => {
    const { steps, msPerStep } = spec(jobOpts.key);
    let used = 0;
    return {
      get done() { return used >= steps; },
      get sims() { return used >= steps ? 1 : 0; },
      maxSims: 1,
      runSims: () => 0,
      advance: (max: number) => {
        const n = Math.min(max, steps - used);
        used += n;
        clock.t += n * msPerStep;
        chunks.push({ key: jobOpts.key, steps: n });
        return n;
      },
      result: () => fakeResult(jobOpts.key),
    };
  };
  return { chunks, createJob };
}

describe('ForecastService chunk sizing', () => {
  it('sizes chunks by cost per step, so cheap jobs finishing early do not blow up the next heavy one', () => {
    const clock = new ManualClock();
    const jobs = steppedJobs(clock, key => (key === 'raid' ? { steps: 200_000, msPerStep: 0.006 } : { steps: 3, msPerStep: 0.0001 }));
    const svc = new ForecastService({ clock, createJob: jobs.createJob });
    for (let i = 0; i < 20; i++) svc.request(req(`room-${i}`, 'explicit'));
    svc.request(req('raid', 'explicit'));
    clock.advance(60_000);

    expect(svc.stats().jobsDone).toBe(21);
    expect(Math.max(...jobs.chunks.filter(c => c.key === 'raid').map(c => c.steps))).toBeLessThanOrEqual(512);
    expect(svc.stats().longestSliceMs).toBeLessThan(5 + 5 / 8 + 0.5);
  });
});

describe('ForecastService dropping superseded and cancelled work', () => {
  const drop = (group: string) => ({ supersede: { group, previous: 'drop' as const } });

  it("drops a player's older explicit job when they ask for something else", () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { costMs: 5 });
    const svc = service(clock, jobs);
    const first = vi.fn();
    svc.request(req('room-a', 'explicit', { ...drop('explicit:alice'), onDone: first }));
    svc.request(req('room-b', 'explicit', { ...drop('explicit:alice') }));
    expect(first).toHaveBeenCalledWith(null);
    expect(svc.queued).toBe(1);
    clock.advance(1000);
    expect(jobs.order).toEqual(['room-b']);
  });

  it('keeps the older job running for anyone else still waiting on it', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { costMs: 5 });
    const svc = service(clock, jobs);
    const alice = vi.fn();
    const bob = vi.fn();
    const precheck = vi.fn();
    svc.request(req('shared', 'explicit', { ...drop('explicit:alice'), onDone: alice }));
    svc.request(req('shared', 'explicit', { ...drop('explicit:bob'), onDone: bob }));
    svc.request(req('pre', 'precheck', { onDone: precheck }));
    svc.request(req('pre', 'explicit', { ...drop('explicit:carol') }));
    svc.request(req('neighbour', 'precheck'));
    svc.request(req('neighbour', 'explicit', { ...drop('explicit:dave') }));
    svc.request(req('room-b', 'explicit', { ...drop('explicit:alice') }));
    svc.request(req('room-c', 'explicit', { ...drop('explicit:carol') }));
    svc.request(req('room-d', 'explicit', { ...drop('explicit:dave') }));

    expect(alice).toHaveBeenCalledWith(null);
    clock.advance(1000);
    expect(bob).toHaveBeenCalledWith(expect.objectContaining({ key: 'shared' }));
    expect(precheck).toHaveBeenCalledWith(expect.objectContaining({ key: 'pre' }));
    expect(jobs.order).toEqual(['shared', 'room-b', 'room-c', 'room-d', 'pre', 'neighbour']);
    expect(svc.get('neighbour')).not.toBeNull();
  });

  it('cancels a live job by its group', () => {
    const clock = new ManualClock();
    const jobs = fakeJobs(clock, { advancesNeeded: () => 100 });
    const svc = service(clock, jobs);
    const live = vi.fn();
    svc.request(req(liveForecastKey(7, 0), 'live', { cache: false, ...drop('live:p'), onDone: live }));
    svc.request(req('room', 'explicit'));
    svc.cancelGroup('live:p');
    svc.cancelGroup('live:nobody');
    expect(live).toHaveBeenCalledWith(null);
    expect(svc.queued).toBe(1);
    clock.advance(10_000);
    expect(jobs.order.every(k => k === 'room')).toBe(true);
  });
});
