import { performance } from 'perf_hooks';
import { GAME_VERSION, createForecastJob } from '@idle-party-rpg/shared';
import type { ForecastInput, ForecastJob, ForecastJobOptions, ForecastRequestTarget, ForecastResult } from '@idle-party-rpg/shared';

export type ForecastPriority = 'live' | 'explicit' | 'precheck';

const LANES: readonly ForecastPriority[] = ['live', 'explicit', 'precheck'];

export const FORECAST_SLICE_MS = 5;
export const FORECAST_MAX_DUTY = 0.25;
export const FORECAST_MAX_QUEUED = 512;
export const FORECAST_CACHE_SIZE = 5000;
export const FORECAST_CACHE_TTL_MS = 10 * 60 * 1000;
/** Combat steps between clock checks inside a slice, to start with; adapts to how heavy the fights are. */
export const FORECAST_STEPS_PER_CHECK = 64;
const MAX_STEPS_PER_CHECK = 4096;
export const FORECAST_REQUESTS_PER_WINDOW = 20;
export const FORECAST_REQUEST_WINDOW_MS = 60_000;

export function roomForecastKey(contentEpoch: number, partyKey: string, tileId: string): string {
  return `${GAME_VERSION}|${contentEpoch}|${partyKey}|room:${tileId}`;
}

export function dungeonForecastKey(
  contentEpoch: number,
  partyKey: string,
  dungeonId: string,
  start: { floorIndex: number; phase: number; wipes: number },
): string {
  return `${GAME_VERSION}|${contentEpoch}|${partyKey}|dungeon:${dungeonId}:${start.floorIndex}:${start.phase}:${start.wipes}`;
}

export function liveForecastKey(battleId: number, elapsedMs: number): string {
  return `battle:${battleId}:${elapsedMs}`;
}

/** A well-formed client forecast target, or null. Live battle targets are server-pushed only. */
export function parseForecastRequestTarget(raw: unknown): ForecastRequestTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const target = raw as { kind?: unknown; tileId?: unknown; dungeonId?: unknown };
  if (target.kind === 'room' && typeof target.tileId === 'string' && target.tileId) return { kind: 'room', tileId: target.tileId };
  if (target.kind === 'dungeon' && typeof target.dungeonId === 'string' && target.dungeonId) return { kind: 'dungeon', dungeonId: target.dungeonId };
  return null;
}

export interface ForecastClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ForecastWork {
  input: ForecastInput;
  opts?: Omit<ForecastJobOptions, 'key'>;
}

export interface ForecastRequest {
  key: string;
  priority: ForecastPriority;
  /** Runs at request time, so a live fight is cloned before it moves on. Null → nothing to forecast. */
  build: () => ForecastWork | null;
  /** Live forecasts pass false: they are never cached. */
  cache?: boolean;
  /** One queued job per group: a newer job drops the older one, or demotes it to pre-check priority. */
  supersede?: { group: string; previous: 'drop' | 'demote' };
  /** Called once the job settles; null when it was dropped or failed. Never called for a cached answer. */
  onDone?: (result: ForecastResult | null) => void;
}

export type ForecastAnswer =
  | { status: 'ok'; result: ForecastResult }
  | { status: 'pending' }
  | { status: 'unavailable' };

export interface ForecastServiceOptions {
  clock?: Partial<ForecastClock>;
  sliceMs?: number;
  maxDuty?: number;
  maxQueued?: number;
  cacheSize?: number;
  cacheTtlMs?: number;
  stepsPerCheck?: number;
  requestsPerWindow?: number;
  requestWindowMs?: number;
  createJob?: (input: ForecastInput, opts: ForecastJobOptions) => ForecastJob;
  /** Logs a timing summary at most this often while there is work; 0 = never. */
  logEveryMs?: number;
  log?: (line: string) => void;
}

export interface ForecastServiceStats {
  jobsDone: number;
  jobsDropped: number;
  jobsFailed: number;
  sims: number;
  slices: number;
  busyMs: number;
  longestSliceMs: number;
  queued: number;
  cached: number;
}

type Listener = (result: ForecastResult | null) => void;

interface QueuedJob {
  key: string;
  priority: ForecastPriority;
  job: ForecastJob;
  cache: boolean;
  listeners: Listener[];
  groups: string[];
}

interface CachedResult {
  result: ForecastResult;
  at: number;
}

const DEFAULT_CLOCK: ForecastClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Runs forecast jobs on the main thread in short, spaced slices and caches their results.
 * See docs/architecture/combat.md (forecasting).
 */
export class ForecastService {
  private readonly clock: ForecastClock;
  private readonly sliceMs: number;
  private readonly maxDuty: number;
  private readonly maxQueued: number;
  private readonly cacheSize: number;
  private readonly cacheTtlMs: number;
  private stepsPerCheck: number;
  private readonly requestsPerWindow: number;
  private readonly requestWindowMs: number;
  private readonly createJob: (input: ForecastInput, opts: ForecastJobOptions) => ForecastJob;
  private readonly logEveryMs: number;
  private readonly log: (line: string) => void;

  private readonly lanes: Record<ForecastPriority, QueuedJob[]> = { live: [], explicit: [], precheck: [] };
  private readonly byKey = new Map<string, QueuedJob>();
  private readonly groups = new Map<string, QueuedJob>();
  private readonly cache = new Map<string, CachedResult>();
  private readonly requestTimes = new Map<string, number[]>();
  private timer: unknown = null;
  private slicing = false;
  private nextSliceAt = 0;
  private stopped = false;
  private readonly totals: Omit<ForecastServiceStats, 'queued' | 'cached'> = {
    jobsDone: 0, jobsDropped: 0, jobsFailed: 0, sims: 0, slices: 0, busyMs: 0, longestSliceMs: 0,
  };
  private window = { ...this.totals, since: 0 };

  constructor(opts: ForecastServiceOptions = {}) {
    this.clock = { ...DEFAULT_CLOCK, ...opts.clock };
    this.sliceMs = opts.sliceMs ?? FORECAST_SLICE_MS;
    this.maxDuty = Math.min(1, Math.max(0.01, opts.maxDuty ?? FORECAST_MAX_DUTY));
    this.maxQueued = Math.max(1, opts.maxQueued ?? FORECAST_MAX_QUEUED);
    this.cacheSize = Math.max(1, opts.cacheSize ?? FORECAST_CACHE_SIZE);
    this.cacheTtlMs = opts.cacheTtlMs ?? FORECAST_CACHE_TTL_MS;
    this.stepsPerCheck = Math.max(1, opts.stepsPerCheck ?? FORECAST_STEPS_PER_CHECK);
    this.requestsPerWindow = opts.requestsPerWindow ?? FORECAST_REQUESTS_PER_WINDOW;
    this.requestWindowMs = opts.requestWindowMs ?? FORECAST_REQUEST_WINDOW_MS;
    this.createJob = opts.createJob ?? createForecastJob;
    this.logEveryMs = opts.logEveryMs ?? 0;
    this.log = opts.log ?? (line => console.log(line));
    this.window.since = this.clock.now();
  }

  /** A cached, unexpired result. */
  get(key: string): ForecastResult | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (this.clock.now() - hit.at > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit.result;
  }

  /** Answer from the cache, or queue (or join) a job for `key`. */
  request(req: ForecastRequest): ForecastAnswer {
    if (this.stopped) return { status: 'unavailable' };
    if (req.cache !== false) {
      const cached = this.get(req.key);
      if (cached) return { status: 'ok', result: cached };
    }

    let queued = this.byKey.get(req.key);
    if (queued) {
      if (rank(req.priority) < rank(queued.priority)) this.moveTo(queued, req.priority);
    } else {
      if (!this.makeRoom(req.priority)) return { status: 'unavailable' };
      const job = this.buildJob(req);
      if (!job) return { status: 'unavailable' };
      queued = { key: req.key, priority: req.priority, job, cache: req.cache !== false, listeners: [], groups: [] };
      this.lanes[req.priority].push(queued);
      this.byKey.set(req.key, queued);
    }
    if (req.onDone) queued.listeners.push(req.onDone);
    if (req.supersede) this.supersede(queued, req.supersede.group, req.supersede.previous);
    this.schedule();
    return { status: 'pending' };
  }

  /** Sliding-window rate limit per requester. Counts the request when allowed. */
  allowRequest(requester: string): boolean {
    const now = this.clock.now();
    const recent = (this.requestTimes.get(requester) ?? []).filter(t => now - t < this.requestWindowMs);
    if (recent.length >= this.requestsPerWindow) {
      this.requestTimes.set(requester, recent);
      return false;
    }
    recent.push(now);
    this.requestTimes.set(requester, recent);
    return true;
  }

  get queued(): number {
    return this.lanes.live.length + this.lanes.explicit.length + this.lanes.precheck.length;
  }

  stats(): ForecastServiceStats {
    return { ...this.totals, queued: this.queued, cached: this.cache.size };
  }

  /** Stop slicing and forget queued work (shutdown). */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    for (const lane of LANES) this.lanes[lane].length = 0;
    this.byKey.clear();
    this.groups.clear();
  }

  private buildJob(req: ForecastRequest): ForecastJob | null {
    try {
      const work = req.build();
      if (!work) return null;
      return this.createJob(work.input, { ...work.opts, key: req.key });
    } catch (err) {
      console.error(`[Forecast] building ${req.key} failed:`, err);
      return null;
    }
  }

  /** Frees a slot for a job of `priority`: drops the oldest job of the lowest priority, unless that is higher. */
  private makeRoom(priority: ForecastPriority): boolean {
    if (this.queued < this.maxQueued) return true;
    for (let i = LANES.length - 1; i >= 0; i--) {
      const lane = this.lanes[LANES[i]];
      if (lane.length === 0) continue;
      if (i < rank(priority)) return false;
      this.drop(lane[0]);
      return true;
    }
    return true;
  }

  private supersede(job: QueuedJob, group: string, previous: 'drop' | 'demote'): void {
    const older = this.groups.get(group);
    this.groups.set(group, job);
    if (!job.groups.includes(group)) job.groups.push(group);
    if (!older || older === job || !this.byKey.has(older.key)) return;
    older.groups = older.groups.filter(g => g !== group);
    if (previous === 'drop') this.drop(older);
    else if (rank(older.priority) < rank('precheck')) this.moveTo(older, 'precheck');
  }

  private moveTo(job: QueuedJob, priority: ForecastPriority): void {
    this.removeFromLane(job);
    job.priority = priority;
    this.lanes[priority].push(job);
  }

  private removeFromLane(job: QueuedJob): void {
    const lane = this.lanes[job.priority];
    const index = lane.indexOf(job);
    if (index >= 0) lane.splice(index, 1);
  }

  private forget(job: QueuedJob): void {
    this.removeFromLane(job);
    if (this.byKey.get(job.key) === job) this.byKey.delete(job.key);
    for (const group of job.groups) {
      if (this.groups.get(group) === job) this.groups.delete(group);
    }
  }

  private drop(job: QueuedJob, failed = false): void {
    this.forget(job);
    if (failed) {
      this.totals.jobsFailed++;
      this.window.jobsFailed++;
    } else {
      this.totals.jobsDropped++;
      this.window.jobsDropped++;
    }
    this.settle(job, null);
  }

  private finish(job: QueuedJob): void {
    const result = job.job.result();
    this.forget(job);
    this.totals.jobsDone++;
    this.window.jobsDone++;
    this.totals.sims += job.job.sims;
    this.window.sims += job.job.sims;
    if (job.cache) {
      this.cache.delete(job.key);
      this.cache.set(job.key, { result, at: this.clock.now() });
      while (this.cache.size > this.cacheSize) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    this.settle(job, result);
  }

  private settle(job: QueuedJob, result: ForecastResult | null): void {
    for (const listener of job.listeners) {
      try {
        listener(result);
      } catch (err) {
        console.error(`[Forecast] listener for ${job.key} failed:`, err);
      }
    }
  }

  private head(): QueuedJob | null {
    for (const lane of LANES) {
      if (this.lanes[lane].length > 0) return this.lanes[lane][0];
    }
    return null;
  }

  private schedule(): void {
    if (this.stopped || this.slicing || this.timer !== null || this.queued === 0) return;
    const delay = Math.max(0, this.nextSliceAt - this.clock.now());
    this.timer = this.clock.setTimeout(() => this.runSlice(), delay);
  }

  private runSlice(): void {
    this.timer = null;
    if (this.stopped) return;
    this.slicing = true;
    const start = this.clock.now();
    try {
      this.work(start + this.sliceMs);
    } finally {
      const end = this.clock.now();
      const used = Math.max(0, end - start);
      this.totals.slices++;
      this.window.slices++;
      this.totals.busyMs += used;
      this.window.busyMs += used;
      this.totals.longestSliceMs = Math.max(this.totals.longestSliceMs, used);
      this.window.longestSliceMs = Math.max(this.window.longestSliceMs, used);
      this.nextSliceAt = end + (used * (1 - this.maxDuty)) / this.maxDuty;
      this.maybeLog(end);
      this.slicing = false;
      this.schedule();
    }
  }

  private work(deadline: number): void {
    let unfinished: QueuedJob | null = null;
    for (let job = this.head(); job; job = this.head()) {
      unfinished = job;
      try {
        const before = this.clock.now();
        job.job.advance(this.stepsPerCheck);
        this.tuneChunk(this.clock.now() - before);
        if (job.job.done) {
          unfinished = null;
          this.finish(job);
        }
      } catch (err) {
        console.error(`[Forecast] job ${job.key} failed:`, err);
        unfinished = null;
        this.drop(job, true);
      }
      if (this.clock.now() >= deadline) break;
    }
    // Round-robin within a lane, so one long raid forecast can't hold up the rooms behind it.
    if (unfinished && this.byKey.get(unfinished.key) === unfinished) this.moveTo(unfinished, unfinished.priority);
  }

  /** Keep one chunk near an eighth of a slice, so a slice overruns its budget by little. */
  private tuneChunk(tookMs: number): void {
    if (tookMs > this.sliceMs / 8) this.stepsPerCheck = Math.max(1, Math.floor(this.stepsPerCheck / 2));
    else if (tookMs < this.sliceMs / 32) this.stepsPerCheck = Math.min(MAX_STEPS_PER_CHECK, this.stepsPerCheck * 2);
  }

  private maybeLog(now: number): void {
    if (this.logEveryMs <= 0) return;
    const span = now - this.window.since;
    if (span < this.logEveryMs) return;
    const w = this.window;
    if (w.slices > 0) {
      this.log(`[Forecast] ${w.jobsDone} jobs (${w.sims} sims), ${w.jobsDropped} dropped, ${w.jobsFailed} failed in ${w.slices} slices; `
        + `busy ${w.busyMs.toFixed(1)} ms (${((100 * w.busyMs) / span).toFixed(1)} % of ${(span / 1000).toFixed(0)} s), `
        + `longest slice ${w.longestSliceMs.toFixed(2)} ms, queue ${this.queued}, cache ${this.cache.size}`);
    }
    this.window = { jobsDone: 0, jobsDropped: 0, jobsFailed: 0, sims: 0, slices: 0, busyMs: 0, longestSliceMs: 0, since: now };
  }
}

function rank(priority: ForecastPriority): number {
  return LANES.indexOf(priority);
}
