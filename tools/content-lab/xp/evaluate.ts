import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CELLS_FILE, SNAPSHOT_FILE, STATS_DIR, readCells, readMeta, readSnapshot, rowFiles, startWorker, writeMeta } from './atlas.js';
import { createEvaluator } from './evaluator.js';
import type { AtlasSummary, ParamOverrides, XpPlan } from './plan.js';
import { assertBossPolicy, assertRewardsOnlyChange, loadPlan, planBossPolicy, planTitle } from './plan.js';
import { GOLD_FILE, RATES_FILE, goldLine, goldPart, rateLine, readRatesWithGold } from './rates-file.js';
import { NEAR_LINE_BAND, ensureSampled, sampleFile } from './refine.js';
import type { CellRate, XpSnapshot } from './types.js';

export { GOLD_FILE, RATES_FILE };
export const PLAN_SNAPSHOT_FILE = 'plan-snapshot.json';
export const PLAN_STATE_FILE = 'plan-state.json';
export const PLAN_FILE = 'plan.json';
/** Samples a run takes for itself, read by a few lines and never written to rates.jsonl. */
export const SECOND_LOOK_DIR = 'second-look';
/** A run that stops on a broken plan must not leave the last run's card looking current. */
const CARD_FILES = ['scorecard.md', 'scorecard.json', 'summary.md', 'curve.json'];
const SAMPLED_DIR = '.sampled';
/** Files one worker takes at a time: per-cell samples are small, and asking for each one spends more than it reads. */
const FILES_PER_ASSIGNMENT = 32;
const PROBE_FILES = 4;
const PROBE_ROWS_PER_FILE = 5000;

export interface EvaluateOptions {
  atlas: string;
  plan: string;
  out: string;
  jobs: number;
  /** Values for the plan's own params, so a sweep needs no new file per value. */
  params?: ParamOverrides;
}

export interface PlanRun {
  atlas: string;
  plan: string;
  snapshot: string;
  statePath?: string;
  jobs: number;
  params?: ParamOverrides;
}

export function readRates(outDir: string): CellRate[] {
  return readRatesWithGold(outDir);
}

function writeLines(target: string, lines: readonly string[]): void {
  writeFileSync(target, '');
  const batch = 20000;
  for (let i = 0; i < lines.length; i += batch) appendFileSync(target, `${lines.slice(i, i + batch).join('\n')}\n`);
}

export function writeRates(outDir: string, rates: readonly CellRate[]): void {
  writeLines(join(outDir, RATES_FILE), rates.map(rateLine));
  writeLines(join(outDir, GOLD_FILE), rates.flatMap(rate => goldLine(rate) ?? []));
}

/** Evaluates these row files and writes rates.jsonl to `out`, sorted by cell. */
async function runWorkers(run: PlanRun, out: string, files: readonly string[]): Promise<void> {
  const chunkSize = files.length > run.jobs * FILES_PER_ASSIGNMENT ? FILES_PER_ASSIGNMENT : 1;
  const queue = [...files];
  const tmp = join(out, '.eval');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const parts: string[] = [];
  await Promise.all(Array.from({ length: Math.min(run.jobs, Math.max(1, files.length)) }, (_, workerId) => new Promise<void>((done, fail) => {
    const part = join(tmp, `${workerId}.jsonl`);
    parts.push(part);
    const worker = startWorker('./evaluate-worker.ts', { atlas: run.atlas, plan: run.plan, snapshot: run.snapshot, statePath: run.statePath, part, params: run.params });
    const assign = (): void => {
      const next = queue.splice(0, chunkSize);
      worker.postMessage(next.length ? { files: next } : { stop: true });
    };
    worker.on('message', (msg: { ready?: boolean; fileDone?: boolean }) => {
      if (msg.ready || msg.fileDone) assign();
    });
    worker.on('error', fail);
    worker.on('exit', code => (code === 0 ? done() : fail(new Error(`evaluate worker ${workerId} exited with ${code}`))));
  })));
  const merged = (paths: readonly string[]): string[] => {
    const lines = paths.flatMap(part => {
      try {
        return readFileSync(part, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    });
    return lines.sort((a, b) => Number(a.slice(5, a.indexOf(',', 5))) - Number(b.slice(5, b.indexOf(',', 5))));
  };
  writeLines(join(out, RATES_FILE), merged(parts));
  writeLines(join(out, GOLD_FILE), merged(parts.map(goldPart)));
  rmSync(tmp, { recursive: true, force: true });
}

export function withFirstSample(fresh: CellRate, base: CellRate): CellRate {
  return { ...fresh, first: base.first ?? { n: base.n, win: base.win, ms: base.ms, kph: base.kph, xp: base.xp } };
}

function mergeFresh(base: readonly CellRate[], fresh: ReadonlyMap<number, CellRate>): CellRate[] {
  return base.map(rate => {
    const again = fresh.get(rate.c);
    return again ? withFirstSample(again, rate) : rate;
  });
}

/** This plan's payout over cells already sampled by ensureSampled. */
export async function evaluateSampled(run: PlanRun, out: string, cellIds: readonly number[], fights: number, extra?: string): Promise<Map<number, CellRate>> {
  const scratch = join(out, SAMPLED_DIR);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  await runWorkers(run, scratch, cellIds.map(id => sampleFile(run.atlas, fights, id, extra)));
  const rates = new Map(readRates(scratch).map(rate => [rate.c, rate]));
  rmSync(scratch, { recursive: true, force: true });
  return rates;
}

/** Throws when a plan paid nothing anywhere: a real rule pays something, so this is a broken plan. */
export function assertPlanPays(planId: string, rates: readonly CellRate[]): void {
  if (rates.length > 0 && rates.every(rate => rate.xpf.every(xp => xp === 0))) {
    throw new Error(`plan ${planId} paid nothing in all ${rates.length} cells. If payout reads a variable set in retuneContent or prepare, that variable is empty on the worker threads: return it from prepare and read ctx.state`);
  }
}

/** Throws when payout differs between this thread and the workers: it read module state set after import, or something outside its arguments. */
export function assertPayoutsAgree(plan: XpPlan, sample: ReadonlyMap<number, CellRate>, workerRates: ReadonlyMap<number, CellRate>): void {
  for (const [cell, here] of sample) {
    const there = workerRates.get(cell);
    if (!there) continue;
    if (here.xpf.some((xp, m) => xp !== there.xpf[m])) {
      throw new Error(`plan ${plan.id} pays cell ${cell} differently here (${here.xpf.join(', ')}) and on a worker thread (${there.xpf.join(', ')}). Payout runs on workers with a fresh copy of the module, so it can't read state set in retuneContent or prepare, or use randomness: return that state from prepare and read ctx.state`);
    }
  }
}

async function probePayouts(plan: XpPlan, atlas: string, snapshotPath: string, state: unknown, workerRates: readonly CellRate[]): Promise<void> {
  const mod: any = await import('../../../shared/src/index.js');
  const evaluateFile = createEvaluator({ meta: readMeta(atlas), cells: readCells(atlas), content: readSnapshot(snapshotPath).content, plan, state, mod });
  const sample = new Map<number, CellRate>();
  for (const file of rowFiles(atlas).slice(0, PROBE_FILES)) evaluateFile(file, rate => sample.set(rate.c, rate), PROBE_ROWS_PER_FILE);
  assertPayoutsAgree(plan, sample, new Map(workerRates.map(rate => [rate.c, rate])));
}

function nullPlanPath(): string {
  return fileURLToPath(new URL('./plans/null-plan.ts', import.meta.url));
}

/** Near-line cells of the atlas sampled again. Win rates don't depend on the XP rule, so this runs once per atlas, for every plan. */
export async function refineNearLine(atlasDir: string, fights: number, jobs: number): Promise<void> {
  const atlas = resolve(atlasDir);
  const dir = join(atlas, STATS_DIR);
  mkdirSync(dir, { recursive: true });
  const run: PlanRun = { atlas, plan: nullPlanPath(), snapshot: join(atlas, SNAPSHOT_FILE), jobs };
  await runWorkers(run, dir, rowFiles(atlas));
  const stats = readRates(dir);
  const [low, high] = NEAR_LINE_BAND;
  const cells = stats.filter(rate => rate.win >= low && rate.win < high).map(rate => rate.c);
  const started = Date.now();
  console.log(`[refine] ${cells.length} cells read ${low} % to ${high} %; sampling each with ${fights} fights`);
  let simulatedFights = 0;
  await ensureSampled(atlas, cells, fights, jobs, report => {
    simulatedFights += report.fights;
  });
  const meta = readMeta(atlas);
  meta.refine = { fights, band: NEAR_LINE_BAND, cells, simulatedFights, wallSeconds: Math.round((Date.now() - started) / 1000) };
  writeMeta(atlas, meta);
  writeRates(dir, mergeFresh(stats, await evaluateSampled(run, dir, cells, fights)));
  console.log(`[refine] done: ${simulatedFights} fights in ${meta.refine.wallSeconds}s`);
}

/** Win rates and fight times don't depend on the XP rule, so one pass with an all-zero plan is what retuneContent reads. */
async function ensureStats(atlas: string, jobs: number): Promise<CellRate[]> {
  const dir = join(atlas, STATS_DIR);
  if (existsSync(join(dir, RATES_FILE))) return readRates(dir);
  mkdirSync(dir, { recursive: true });
  const run: PlanRun = { atlas, plan: nullPlanPath(), snapshot: join(atlas, SNAPSHOT_FILE), jobs };
  await runWorkers(run, dir, rowFiles(atlas));
  const { refine } = readMeta(atlas);
  if (refine) writeRates(dir, mergeFresh(readRates(dir), await evaluateSampled(run, dir, refine.cells, refine.fights)));
  return readRates(dir);
}

export async function evaluatePlan(options: EvaluateOptions): Promise<void> {
  const atlas = resolve(options.atlas);
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const plan = await loadPlan(options.plan, options.params);
  const title = planTitle(plan.id, options.params);
  const started = Date.now();
  const meta = readMeta(atlas);
  assertBossPolicy(planBossPolicy(plan), [...new Set(meta.tables.flatMap(t => (t.dungeonId ? [t.dungeonId] : [])))]);
  let snapshotPath = join(atlas, SNAPSHOT_FILE);
  let statePath: string | undefined;
  let state: unknown;
  for (const stale of [PLAN_FILE, PLAN_STATE_FILE, RATES_FILE, GOLD_FILE, ...CARD_FILES]) rmSync(join(out, stale), { force: true });
  rmSync(join(out, SECOND_LOOK_DIR), { recursive: true, force: true });
  if (plan.retuneContent || plan.prepare) {
    const summary: AtlasSummary = { tables: meta.tables, comps: meta.comps, cells: readCells(atlas), rates: await ensureStats(atlas, options.jobs) };
    let { content } = readSnapshot(snapshotPath);
    if (plan.retuneContent) {
      const before: XpSnapshot = JSON.parse(JSON.stringify(content));
      content = plan.retuneContent(content, summary);
      assertRewardsOnlyChange(before, content);
      snapshotPath = join(out, PLAN_SNAPSHOT_FILE);
      mkdirSync(dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, JSON.stringify(content));
    }
    if (plan.prepare) {
      const json = JSON.stringify(plan.prepare(content, summary));
      if (json === undefined) throw new Error(`plan ${plan.id}: prepare must return a JSON value`);
      statePath = join(out, PLAN_STATE_FILE);
      writeFileSync(statePath, json);
      state = JSON.parse(json);
    }
  }
  const run: PlanRun = { atlas, plan: resolve(options.plan), snapshot: snapshotPath, statePath, jobs: options.jobs, params: options.params };
  await runWorkers(run, out, rowFiles(atlas));
  const base = readRates(out);
  assertPlanPays(plan.id, base);
  await probePayouts(plan, atlas, snapshotPath, state, base);
  if (meta.refine) writeRates(out, mergeFresh(base, await evaluateSampled(run, out, meta.refine.cells, meta.refine.fights)));
  writeFileSync(join(out, PLAN_FILE), JSON.stringify({ id: plan.id, title, describe: plan.describe, params: plan.params ?? {}, overrides: options.params ?? {}, planPath: resolve(options.plan), atlas, cellsFile: CELLS_FILE, snapshot: snapshotPath, statePath, elapsedSec: Math.round((Date.now() - started) / 1000) }, null, 2));
  console.log(`[eval] ${title}: ${base.length} cells in ${Math.round((Date.now() - started) / 1000)}s`);
}
