import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { loadNewEngine } from '../engines.js';
import { buildRegions } from '../policy.js';
import { buildComps } from './comps.js';
import { annotateTables, memberReaches } from './gates.js';
import { PartyBuilder } from './party.js';
import { ROW_FILE_PREFIX, ROW_FILE_SUFFIX } from './rows.js';
import { buildTables, evenlySpaced, fightsPerStratum } from './tables.js';
import { ATLAS_VERSION, LONG_FIGHT_CAP_REAL_MS, XP_GRID_LEVELS } from './types.js';
import type { AtlasMeta, AtlasRunInfo, CompFamily, XpCell, XpSnapshot } from './types.js';

export const META_FILE = 'atlas.json';
export const CELLS_FILE = 'cells.jsonl';
export const SNAPSHOT_FILE = 'snapshot.json';
export const REFINE_DIR = 'refine';
export const STATS_DIR = 'stats';
const PROGRESS_INTERVAL_MS = 60_000;
export const REACH_REFUSAL = 'a member is below the level gates of this room, which need level ';

/** A worker thread doesn't inherit tsx's loader, so it starts through a small bootstrap that registers it. */
export function startWorker(entry: string, workerData: Record<string, unknown>): Worker {
  const boot = new URL('./worker-boot.mjs', import.meta.url);
  return new Worker(boot, { workerData: { ...workerData, entry: new URL(entry, import.meta.url).href } });
}

export interface AtlasOptions {
  snapshot: string;
  out: string;
  families: CompFamily[];
  fights: number;
  seed: number;
  jobs: number;
  engineRef: string;
  limitTables?: number;
  planOnly?: boolean;
}

export function readSnapshot(path: string): { content: XpSnapshot; sha1: string } {
  const raw = readFileSync(path, 'utf8');
  return { content: JSON.parse(raw) as XpSnapshot, sha1: createHash('sha1').update(raw).digest('hex') };
}

export function readMeta(atlasDir: string): AtlasMeta {
  const meta = JSON.parse(readFileSync(join(atlasDir, META_FILE), 'utf8')) as AtlasMeta;
  if (meta.version !== ATLAS_VERSION) throw new Error(`${atlasDir} is atlas version ${meta.version}, this harness reads ${ATLAS_VERSION}: rebuild it`);
  return meta;
}

export function writeMeta(atlasDir: string, meta: AtlasMeta): void {
  writeFileSync(join(atlasDir, META_FILE), JSON.stringify(meta));
}

export function readCells(atlasDir: string): XpCell[] {
  return readFileSync(join(atlasDir, CELLS_FILE), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as XpCell);
}

export function rowFiles(atlasDir: string): string[] {
  return readdirSync(atlasDir).filter(f => f.startsWith(ROW_FILE_PREFIX) && f.endsWith(ROW_FILE_SUFFIX)).sort().map(f => join(atlasDir, f));
}

export function dungeonRefusal(mod: any, dungeon: any, members: { className: string; level: number }[]): string | undefined {
  const infos = members.map((m, i) => ({ username: `${m.className}_${i}`, level: m.level, className: m.className, hasRequiredItem: true }));
  return mod.validateDungeonEntry(dungeon, infos, 'required item') ?? undefined;
}

export interface AtlasPlan {
  meta: AtlasMeta;
  cells: XpCell[];
}

export async function planAtlas(options: AtlasOptions): Promise<AtlasPlan> {
  const { content, sha1 } = readSnapshot(options.snapshot);
  const engine = await loadNewEngine();
  const mod = engine.module;
  const { regions, zoneRegion } = buildRegions(content);
  const built = buildTables(content, mod, zoneRegion, regions);
  const tables = options.limitTables ? evenlySpaced(built.tables, options.limitTables).map((t, index) => ({ ...t, index })) : built.tables;
  annotateTables(tables, built.tileKeys, content, mod, Math.max(...XP_GRID_LEVELS));
  const comps = buildComps(options.families);
  const builder = new PartyBuilder(content, regions, engine);
  const cells: XpCell[] = [];
  let expectedFights = 0;
  let eligible = 0;
  for (const table of tables) {
    const region = regions[table.regionIndex];
    const fightsPerCell = table.strata.reduce((sum, s) => sum + fightsPerStratum(s.share, options.fights), 0);
    const dungeon = table.dungeonId ? content.dungeons[table.dungeonId] : undefined;
    comps.forEach((comp, compIndex) => {
      for (const level of XP_GRID_LEVELS) {
        const gap = level - table.roomLevel;
        if (gap < comp.band[0] || gap > comp.band[1]) continue;
        if (comp.members.some(m => level + m.levelOffset < 1)) continue;
        const lowest = Math.min(...comp.members.map(m => level + m.levelOffset));
        if (!memberReaches(table, lowest)) {
          cells.push({ id: cells.length, table: table.index, comp: compIndex, level, hires: [], xpMult: 1, ineligible: `${REACH_REFUSAL}${table.reachLevel ?? 'none'}` });
          continue;
        }
        const party = builder.build(comp, level, region);
        let ineligible = party.unavailable;
        if (dungeon && !ineligible) {
          ineligible = comp.hires !== 'none' ? 'hires wait at the dungeon entrance' : dungeonRefusal(mod, dungeon, party.members);
        }
        const cell: XpCell = { id: cells.length, table: table.index, comp: compIndex, level, hires: party.hires, xpMult: party.xpMult };
        if (ineligible) {
          cell.ineligible = ineligible;
        } else {
          eligible++;
          expectedFights += fightsPerCell;
        }
        cells.push(cell);
      }
    });
  }
  const pauseMs = mod.KILL_BEAT_MS + mod.RESULT_PAUSE + mod.MOVE_DURATION;
  const realStepMs = mod.paceRealMs(mod.COMBAT_PACE, mod.COMBAT_STEP_MS);
  const retreatFightMs = Math.ceil(mod.RUN_AVAILABLE_MS / realStepMs) * realStepMs;
  const meta: AtlasMeta = {
    version: ATLAS_VERSION,
    createdAt: new Date().toISOString(),
    snapshotSha1: sha1,
    engineRef: options.engineRef,
    seed: options.seed,
    fightsPerCell: options.fights,
    families: options.families,
    grid: XP_GRID_LEVELS,
    limitTables: options.limitTables,
    pauseMs,
    retreatMs: retreatFightMs + mod.RESULT_PAUSE + mod.MOVE_DURATION,
    autoRetreatBelowPct: mod.DEFAULT_COMBAT_PREFS.autoRetreatBelowPct,
    rewardMultiplier: mod.COMBAT_PACE.rewardMultiplier,
    clock: mod.COMBAT_PACE.clock,
    longFightCapMs: LONG_FIGHT_CAP_REAL_MS,
    monsters: Object.keys(content.monsters).sort(),
    encounters: Object.keys(content.encounters).sort(),
    tables,
    comps,
    log: built.log,
    cellCount: cells.length,
    eligibleCellCount: eligible,
    expectedFights,
  };
  return { meta, cells };
}

export interface JobReport {
  table: number;
  fights: number;
  timeouts: number;
  rowBytes: number;
  byFamily: Record<string, { cells: number; fights: number; cpuMs: number }>;
}

export interface SimulateOptions {
  atlasDir: string;
  /** One finished file per cell in this folder, instead of rows-*.bin in the atlas. */
  cellDir?: string;
  byTable: ReadonlyMap<number, XpCell[]>;
  fights: number;
  seed: number;
  jobs: number;
  onReport?(report: JobReport): void;
}

/** Runs the cells on worker threads, one table at a time. */
export async function simulateCells(options: SimulateOptions): Promise<void> {
  const queue = [...options.byTable.keys()];
  await Promise.all(Array.from({ length: Math.min(options.jobs, Math.max(1, queue.length)) }, (_, workerId) => new Promise<void>((done, fail) => {
    const worker = startWorker('./atlas-worker.ts', { atlasDir: options.atlasDir, cellDir: options.cellDir, workerId, fights: options.fights, seed: options.seed });
    const assign = (): void => {
      const table = queue.shift();
      if (table === undefined) {
        worker.postMessage({ stop: true });
        return;
      }
      worker.postMessage({ table, cells: options.byTable.get(table) });
    };
    worker.on('message', (msg: { ready?: boolean; stopped?: boolean; report?: JobReport }) => {
      if (msg.report) options.onReport?.(msg.report);
      if (msg.stopped) return;
      assign();
    });
    worker.on('error', fail);
    worker.on('exit', code => (code === 0 ? done() : fail(new Error(`atlas worker ${workerId} exited with ${code}`))));
  })));
}

export async function runAtlas(options: AtlasOptions): Promise<AtlasMeta> {
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  for (const file of rowFiles(out)) rmSync(file);
  rmSync(join(out, REFINE_DIR), { recursive: true, force: true });
  rmSync(join(out, STATS_DIR), { recursive: true, force: true });
  const { meta, cells } = await planAtlas(options);
  copyFileSync(options.snapshot, join(out, SNAPSHOT_FILE));
  writeFileSync(join(out, CELLS_FILE), `${cells.map(c => JSON.stringify(c)).join('\n')}\n`);
  writeMeta(out, meta);
  console.log(`[atlas] ${meta.tables.length} tables, ${meta.comps.length} compositions, ${meta.cellCount} cells (${meta.eligibleCellCount} eligible), about ${meta.expectedFights} fights`);
  if (options.planOnly) return meta;

  const byTable = new Map<number, XpCell[]>();
  for (const cell of cells) {
    if (cell.ineligible) continue;
    const list = byTable.get(cell.table) ?? [];
    list.push(cell);
    byTable.set(cell.table, list);
  }
  const tableCount = byTable.size;
  const started = Date.now();
  const run: AtlasRunInfo = { jobs: options.jobs, wallSeconds: 0, fights: 0, rowBytes: 0, byFamily: {}, timeouts: 0 };
  let nextProgress = Date.now() + PROGRESS_INTERVAL_MS;
  let tablesDone = 0;
  const absorb = (report: JobReport): void => {
    tablesDone++;
    run.fights += report.fights;
    run.rowBytes += report.rowBytes;
    run.timeouts += report.timeouts;
    for (const [family, stats] of Object.entries(report.byFamily)) {
      const total = run.byFamily[family] ?? { cells: 0, fights: 0, cpuMs: 0 };
      total.cells += stats.cells;
      total.fights += stats.fights;
      total.cpuMs += stats.cpuMs;
      run.byFamily[family] = total;
    }
    if (Date.now() >= nextProgress) {
      nextProgress = Date.now() + PROGRESS_INTERVAL_MS;
      const seconds = (Date.now() - started) / 1000;
      const eta = run.fights > 0 ? (seconds * (meta.expectedFights - run.fights)) / run.fights : 0;
      console.log(`[atlas] ${run.fights}/${meta.expectedFights} fights in ${Math.round(seconds)}s, ${Math.round(run.fights / seconds)}/s, about ${Math.round(eta)}s left, ${tablesDone}/${tableCount} tables done`);
    }
  };
  await simulateCells({ atlasDir: out, byTable, fights: options.fights, seed: options.seed, jobs: options.jobs, onReport: absorb });
  run.wallSeconds = Math.round((Date.now() - started) / 1000);
  meta.run = run;
  writeMeta(out, meta);
  console.log(`[atlas] done: ${run.fights} fights in ${run.wallSeconds}s, ${Math.round(run.rowBytes / 1e6)} MB, ${run.timeouts} fights ran past the ${Math.round(LONG_FIGHT_CAP_REAL_MS / 3_600_000)} h cap`);
  for (const [family, stats] of Object.entries(run.byFamily)) {
    console.log(`[atlas]   ${family}: ${stats.cells} cells, ${stats.fights} fights, ${(stats.cpuMs / Math.max(1, stats.fights)).toFixed(2)} ms/fight`);
  }
  return meta;
}
