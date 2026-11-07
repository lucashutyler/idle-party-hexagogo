import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineAdapter } from './engines.js';
import { loadNewEngine, loadOldEngine } from './engines.js';
import type { FitMode, PackSampler } from './fit.js';
import { fit } from './fit.js';
import { installContent } from './install.js';
import type { ReworkConfig } from './rework.js';
import { DEFAULT_REWORK_CONFIG, renderChangelog, rework, staleDescriptions } from './rework.js';
import type { SweepResults } from './scorecard.js';
import { renderScorecard } from './scorecard.js';
import { COMPOSITIONS, POLICY_SUMMARY, buildGearTable, buildRegions, chooseLoadout } from './policy.js';
import { renderCompare } from './report.js';
import type { BuildScenario, SweepMode, TrialSweepRow } from './sweep.js';
import { SWEEP_FORECAST_SIMS, SWEEP_SIMS, runSweep } from './sweep.js';
import type { SanityLine } from './sanity.js';
import { runSanity } from './sanity.js';
import type { CellRun, LabContext } from './sim.js';
import { PartyFactory, buildCells, composeDungeonRuns, hashSeed, makeRng, runCell } from './sim.js';
import type { Baseline, Cell, ClassName, ContentSnapshot, DungeonForecast, DungeonRunResult, CellResult } from './types.js';
import { CLASS_NAMES } from './types.js';

interface Args {
  command: string;
  snapshot: string;
  oldBundle: string;
  oldRef: string;
  out: string;
  n: number;
  variantN: number;
  seed: number;
  jobs: number;
  engine?: 'old' | 'new';
  shard?: [number, number];
  shardOut?: string;
  limitZones?: number;
  flag: (name: string) => string | undefined;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const shard = flag('shard')?.split('/').map(Number) as [number, number] | undefined;
  const limit = flag('limit-zones');
  return {
    command: argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run',
    snapshot: flag('snapshot') ?? 'data/live-export/content.json',
    oldBundle: flag('old-bundle') ?? '',
    oldRef: flag('old-ref') ?? 'origin/main',
    out: flag('out') ?? 'data/content-lab',
    n: Number(flag('n') ?? 60),
    variantN: Number(flag('variant-n') ?? 30),
    seed: Number(flag('seed') ?? 20261103),
    jobs: Number(flag('jobs') ?? Math.max(1, availableParallelism() - 1)),
    engine: flag('engine') as Args['engine'],
    shard,
    shardOut: flag('shard-out'),
    limitZones: limit ? Number(limit) : undefined,
    flag,
  };
}

function loadSnapshot(path: string): { content: ContentSnapshot; sha1: string } {
  const raw = readFileSync(path, 'utf8');
  return { content: JSON.parse(raw) as ContentSnapshot, sha1: createHash('sha1').update(raw).digest('hex') };
}

function makeContext(content: ContentSnapshot, args: Args): LabContext {
  const { regions, zoneRegion } = buildRegions(content);
  if (args.limitZones !== undefined) {
    for (const r of regions) r.zoneIds = r.zoneIds.slice(0, args.limitZones);
  }
  return { content, regions, zoneRegion, gear: buildGearTable(content, regions), seed: args.seed, n: args.n, variantN: args.variantN };
}

function engineFor(name: 'old' | 'new', args: Args): Promise<EngineAdapter> {
  if (name === 'new') return loadNewEngine();
  if (!args.oldBundle) throw new Error('--old-bundle is required for the old engine');
  return loadOldEngine(args.oldBundle);
}

/** Floors of one dungeon must land in one shard so that its runs can be composed. */
function shardKey(cell: Cell): string {
  return cell.kind === 'floor' ? `dungeon|${cell.dungeonId}` : cell.id;
}

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const FORECAST_SIMS = 60;

async function runShard(args: Args): Promise<void> {
  const { content } = loadSnapshot(args.snapshot);
  const engine = await engineFor(args.engine!, args);
  const ctx = makeContext(content, args);
  const log: string[] = [];
  const cells = buildCells(ctx, engine.module, log);
  const [index, total] = args.shard!;
  const parties = new PartyFactory(ctx, engine);
  const results: CellResult[] = [];
  const floorRuns = new Map<string, CellRun[]>();
  for (const cell of cells) {
    if (fnv(shardKey(cell)) % total !== index) continue;
    const run = runCell(ctx, engine, parties, cell);
    results.push(run.result);
    if (cell.kind === 'floor') {
      const key = `${cell.dungeonId}|${cell.comp}`;
      const list = floorRuns.get(key) ?? [];
      list.push(run);
      floorRuns.set(key, list);
    }
  }
  const dungeons: DungeonRunResult[] = [];
  for (const [key, floors] of floorRuns) {
    const [dungeonId, comp] = key.split('|');
    const run = composeDungeonRuns(ctx, engine, content.dungeons[dungeonId], comp, floors);
    if (engine.name === 'new' && !run.ineligible) run.forecast = forecastDungeon(ctx, engine, parties, floors[0].result, content.dungeons[dungeonId], args);
    dungeons.push(run);
  }
  writeFileSync(args.shardOut!, JSON.stringify({ results, dungeons }));
}

/** The real forecast, counted the way the game counts it. */
function forecastDungeon(ctx: LabContext, engine: EngineAdapter, parties: PartyFactory, cell: CellResult, dungeon: any, args: Args): DungeonForecast {
  const { players } = parties.get(cell);
  const key = `${args.seed}|${dungeon.id}|${cell.comp}`;
  const entrance = ctx.content.world.tiles.find(t => t.dungeonId === dungeon.id);
  const result = engine.module.runForecast(
    { kind: 'dungeon', players, dungeon, monsters: ctx.content.monsters, encounters: ctx.content.encounters, fallbackTable: entrance ? ctx.content.zones[entrance.zone].encounterTable ?? [] : [], pace: engine.module.COMBAT_PACE },
    { key, maxSims: FORECAST_SIMS, minSims: FORECAST_SIMS },
  );
  return {
    sims: result.sims,
    winPct: result.winPct,
    medianMs: result.medianMs,
    floors: (result.floors ?? []).map((f: any) => ({ floor: f.floor, winPct: f.winPct, medianMs: f.medianMs })),
  };
}

function shardArgv(args: Args, engine: string, i: number, shardOut: string): string[] {
  const argv = [
    'shard', '--engine', engine, '--shard', `${i}/${args.jobs}`, '--shard-out', shardOut,
    '--snapshot', args.snapshot, '--n', String(args.n), '--variant-n', String(args.variantN), '--seed', String(args.seed),
  ];
  if (args.oldBundle) argv.push('--old-bundle', args.oldBundle);
  if (args.limitZones !== undefined) argv.push('--limit-zones', String(args.limitZones));
  return argv;
}

function runChild(script: string, argv: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = fork(script, argv, { stdio: 'inherit' });
    child.on('exit', code => (code === 0 ? done() : fail(new Error(`shard exited with ${code}: ${argv.join(' ')}`))));
  });
}

function gearSummary(ctx: LabContext): Record<string, unknown> {
  return Object.fromEntries(ctx.regions.map(r => [r.id, ctx.gear.get(r.id)]));
}

function loadoutSummary(ctx: LabContext): Record<string, unknown> {
  const levels = [...new Set(Object.values(ctx.content.zones).map(z => Math.round((z.levelRange[0] + z.levelRange[1]) / 2)))].sort((a, b) => a - b);
  const byClass: Record<string, unknown> = {};
  for (const className of CLASS_NAMES as readonly ClassName[]) {
    byClass[className] = Object.fromEntries(levels.map(l => [l, chooseLoadout(ctx.content, className, l)]));
  }
  return byClass;
}

function loadScenarios(args: Args, out: string): BuildScenario[] {
  const path = args.flag('scenarios') ?? join(out, 'scenarios.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as BuildScenario[]) : [];
}

async function runSweepShard(args: Args): Promise<void> {
  const { content } = loadSnapshot(args.snapshot);
  const engine = await engineFor(args.engine!, args);
  const [index, total] = args.shard!;
  const rows = runSweep(args.flag('mode') as SweepMode, makeContext(content, args), engine, {
    sims: args.n,
    forecastSims: SWEEP_FORECAST_SIMS,
    scenarios: loadScenarios(args, resolve(args.out)),
    mine: key => fnv(key) % total === index,
  });
  writeFileSync(args.shardOut!, JSON.stringify(rows));
}

/** Writes sweep-<mode>-<engine>.json; old-engine sweeps of an unchanged export can be reused between passes. */
async function runSweepCommand(args: Args, out: string): Promise<void> {
  const script = fileURLToPath(import.meta.url);
  const engines = (args.engine ? [args.engine] : ['old', 'new']) as ('old' | 'new')[];
  const n = args.flag('n') ? args.n : SWEEP_SIMS;
  for (const mode of (args.flag('mode') ?? 'subsets,dungeons,seats,builds').split(',')) {
    for (const engine of engines) {
      const snapshot = engine === 'old' ? args.flag('old-snapshot') ?? args.snapshot : args.flag('new-snapshot') ?? args.snapshot;
      const dir = join(out, `.sweep-${mode}-${engine}`);
      mkdirSync(dir, { recursive: true });
      const files = Array.from({ length: args.jobs }, (_, i) => join(dir, `${i}.json`));
      const started = Date.now();
      await Promise.all(files.map((file, i) => {
        const argv = ['sweep-shard', '--mode', mode, '--engine', engine, '--shard', `${i}/${args.jobs}`, '--shard-out', file, '--snapshot', snapshot, '--n', String(n), '--seed', String(args.seed), '--out', out];
        if (args.oldBundle) argv.push('--old-bundle', args.oldBundle);
        if (args.flag('scenarios')) argv.push('--scenarios', args.flag('scenarios')!);
        return runChild(script, argv);
      }));
      const rows = files.flatMap(file => JSON.parse(readFileSync(file, 'utf8')) as unknown[]);
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(join(out, `sweep-${mode}-${engine}.json`), JSON.stringify(rows));
      console.log(`[sweep ${mode} ${engine}] ${rows.length} rows in ${Math.round((Date.now() - started) / 1000)}s`);
    }
  }
}

async function runEngine(name: 'old' | 'new', args: Args): Promise<Baseline> {
  const started = Date.now();
  const { content, sha1 } = loadSnapshot(args.snapshot);
  const engine = await engineFor(name, args);
  const ctx = makeContext(content, args);
  const log: string[] = [];
  const cells = buildCells(ctx, engine.module, log);
  const tmpDir = join(resolve(args.out), `.shards-${name}`);
  mkdirSync(tmpDir, { recursive: true });
  const script = fileURLToPath(import.meta.url);
  const files = Array.from({ length: args.jobs }, (_, i) => join(tmpDir, `${i}.json`));
  console.log(`[${name}] ${cells.length} cells across ${args.jobs} shards`);
  await Promise.all(files.map((file, i) => runChild(script, shardArgv(args, name, i, file))));

  const order = new Map(cells.map((c, i) => [c.id, i]));
  const merged: CellResult[] = [];
  const dungeons: DungeonRunResult[] = [];
  for (const file of files) {
    const shard = JSON.parse(readFileSync(file, 'utf8')) as { results: CellResult[]; dungeons: DungeonRunResult[] };
    merged.push(...shard.results);
    dungeons.push(...shard.dungeons);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  merged.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  dungeons.sort((a, b) => a.regionIndex - b.regionIndex || a.dungeonId.localeCompare(b.dungeonId) || a.comp.localeCompare(b.comp));

  log.push(`solo-plus-hires compositions use up to two hires per class (see policies.hires); ${COMPOSITIONS.filter(c => c.hires).length} such compositions`);
  log.push('set bonuses come through the real set code, but the greedy per-slot gear picks do not chase sets');
  return {
    meta: {
      engine: name,
      engineRef: name === 'new' ? execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() : args.oldRef,
      snapshotSha1: sha1,
      n: args.n,
      variantN: args.variantN,
      seed: args.seed,
      pauseMs: engine.pauseMs,
      policies: POLICY_SUMMARY,
      gear: gearSummary(ctx),
      loadouts: loadoutSummary(ctx),
      log,
      elapsedSec: Math.round((Date.now() - started) / 1000),
    },
    cells: merged,
    dungeons,
  };
}

function writeSanity(lines: SanityLine[], out: string): void {
  for (const l of lines) console.log(`${l.ok ? 'PASS' : 'FAIL'}  ${l.name}\n      expected: ${l.expected}\n      measured: ${l.measured}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'sanity.json'), JSON.stringify(lines, null, 2));
}

async function loadSeedSkills(): Promise<Record<string, any>> {
  const mod: any = await import('../../shared/src/index.js');
  return mod.SEED_SKILLS;
}

function loadConfig(path: string): ReworkConfig {
  return { ...DEFAULT_REWORK_CONFIG, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<ReworkConfig>) };
}

async function runRework(args: Args, out: string): Promise<void> {
  const { content } = loadSnapshot(args.snapshot);
  const config = loadConfig(args.flag('config') ?? join(out, 'rework-config.json'));
  const result = rework(content, config, await loadSeedSkills(), { force: args.flag('force') === 'true' });
  writeFileSync(join(out, 'reworked.json'), JSON.stringify(result.content, null, 2));
  writeFileSync(join(out, 'changelog.md'), renderChangelog(result.changelog));
  console.log(`[rework] ${result.changelog.length} entries changed`);
  for (const s of staleDescriptions(result.content)) console.log(`[rework] stale description ${s.section}/${s.id}: ${s.text}`);
}

function readBaseline(path: string): Baseline {
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

const PACK_SAMPLES = 24;

async function packSampler(content: ContentSnapshot): Promise<PackSampler> {
  const mod: any = (await loadNewEngine()).module;
  return (encounterId, zoneId) => {
    const rng = makeRng(hashSeed(`gold|${encounterId}`));
    return Array.from({ length: PACK_SAMPLES }, () => {
      const counts: Record<string, number> = {};
      const table = [{ encounterId, weight: 1 }];
      for (const m of mod.createEncounter(zoneId, content.monsters, content.zones, content.encounters, table, rng)) counts[m.id] = (counts[m.id] ?? 0) + 1;
      return counts;
    });
  };
}

async function runFit(args: Args, out: string): Promise<void> {
  const configPath = args.flag('config') ?? join(out, 'rework-config.json');
  const config = loadConfig(configPath);
  const live = loadSnapshot(args.snapshot).content;
  const reworked = loadSnapshot(args.flag('reworked') ?? join(out, 'reworked.json')).content;
  const modes = (args.flag('modes') ?? 'hp,xp,gold,drop').split(',') as FitMode[];
  const report = fit(config, live, reworked, readBaseline(join(out, 'baseline-old.json')), readBaseline(join(out, args.flag('out-file') ?? 'measured.json')), modes, {
    damp: Number(args.flag('damp') ?? 0.8),
    monsterOutliers: args.flag('monster-outliers') === 'true',
    outlierThreshold: Number(args.flag('outlier-threshold') ?? 0.1),
    enrageFactor: Number(args.flag('enrage-factor') ?? 1.6),
    hpLostTarget: Number(args.flag('hp-lost-target') ?? 15),
    sample: await packSampler(live),
    trials: existsSync(join(out, 'sweep-dungeons-new.json')) ? (JSON.parse(readFileSync(join(out, 'sweep-dungeons-new.json'), 'utf8')) as TrialSweepRow[]) : [],
  });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(report.join('\n'));
}

function loadSweeps(out: string): SweepResults {
  const read = <T>(name: string): T | undefined => {
    const path = join(out, name);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
  };
  const both = <T>(mode: string): { old: T[]; cur: T[] } | undefined => {
    const old = read<T[]>(`sweep-${mode}-old.json`);
    const cur = read<T[]>(`sweep-${mode}-new.json`);
    return old && cur ? { old, cur } : undefined;
  };
  return { subsets: both('subsets'), seats: both('seats'), dungeons: both('dungeons'), builds: both('builds'), effects: read('sweep-effects-new.json') };
}

async function runScorecard(args: Args, out: string): Promise<void> {
  const md = renderScorecard(
    readBaseline(join(out, 'baseline-old.json')),
    readBaseline(join(out, args.flag('out-file') ?? 'measured.json')),
    loadSnapshot(args.snapshot).content,
    loadSnapshot(args.flag('reworked') ?? join(out, 'reworked.json')).content,
    (await loadNewEngine()).module,
    loadSweeps(out),
  );
  writeFileSync(join(out, 'scorecard.md'), md);
  console.log(md);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'shard') return runShard(args);
  if (args.command === 'sweep-shard') return runSweepShard(args);
  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });

  if (args.command === 'install') {
    const dataDir = resolve(args.flag('data') ?? 'server/data');
    const written = installContent(loadSnapshot(args.flag('snapshot') ?? join(out, 'reworked.json')).content, dataDir);
    console.log(`[install] wrote ${written.length} content files to ${dataDir}. Stop the dev server first; player saves are left alone.`);
    return;
  }
  if (args.command === 'rework') return runRework(args, out);
  if (args.command === 'sweep') return runSweepCommand(args, out);
  if (args.command === 'measure') {
    const baseline = await runEngine('new', args);
    writeFileSync(join(out, args.flag('out-file') ?? 'measured.json'), JSON.stringify(baseline));
    console.log(`[measure] done in ${baseline.meta.elapsedSec}s`);
    return;
  }
  if (args.command === 'fit') return runFit(args, out);
  if (args.command === 'scorecard') return runScorecard(args, out);

  if (args.command === 'sanity' || args.command === 'run') {
    const { content } = loadSnapshot(args.snapshot);
    const lines = runSanity(await loadNewEngine(), await engineFor('old', args), content);
    writeSanity(lines, out);
    if (args.command === 'sanity') return;
  }
  if (args.command === 'run') {
    for (const name of ['old', 'new'] as const) {
      if (args.engine && args.engine !== name) continue;
      const baseline = await runEngine(name, args);
      writeFileSync(join(out, `baseline-${name}.json`), JSON.stringify(baseline));
      console.log(`[${name}] done in ${baseline.meta.elapsedSec}s`);
    }
  }
  if (args.command === 'run' || args.command === 'report') {
    const read = (name: string): Baseline => JSON.parse(readFileSync(join(out, `baseline-${name}.json`), 'utf8')) as Baseline;
    const sanity = JSON.parse(readFileSync(join(out, 'sanity.json'), 'utf8')) as SanityLine[];
    writeFileSync(join(out, 'compare.md'), renderCompare(read('old'), read('new'), sanity));
    console.log(`wrote ${join(out, 'compare.md')}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
