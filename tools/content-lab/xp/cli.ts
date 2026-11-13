import './repo-resolve.mjs';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { runAtlas } from './atlas.js';
import { ALL_FAMILIES } from './comps.js';
import { evaluatePlan, refineNearLine } from './evaluate.js';
import { readCards, renderLeaderboard } from './leaderboard.js';
import { parseParamFlags } from './plan.js';
import { DEFAULT_REFINE_FIGHTS } from './refine.js';
import { runRework } from './rework.js';
import { compareRuns, renderScorecardFiles } from './scorecard.js';
import type { ScorecardOptions } from './scorecard.js';
import { compareDataFolder, compareMonsterAudit, mergeSkills } from './snapshot.js';
import { DEFAULT_FIGHTS_PER_CELL } from './types.js';
import type { CompFamily } from './types.js';

const DEFAULT_SEED = 20261106;
const DEFAULT_TOPUP_FIGHTS = DEFAULT_REFINE_FIGHTS;

function engineRef(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? '';
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const need = (name: string): string => {
    const value = flag(name);
    if (value === undefined) throw new Error(`--${name} is required`);
    return value;
  };
  const repeated = (name: string): string[] => argv.flatMap((arg, i) => (arg === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  const jobs = Number(flag('jobs') ?? Math.max(1, availableParallelism() - 1));
  const scorecardFlags = (): Omit<ScorecardOptions, 'atlas' | 'out'> => ({
    baselineCurve: flag('baseline-curve'),
    activeHours: Number(flag('active-hours') ?? 2),
    reentrySeconds: Number(flag('reentry-seconds') ?? 15),
    jobs,
    topupFights: Number(flag('topup-fights') ?? DEFAULT_TOPUP_FIGHTS),
    sampleDir: flag('sample-dir'),
  });

  if (command === 'snapshot') {
    const out = need('out');
    mkdirSync(dirname(resolve(out)), { recursive: true });
    const merged = mergeSkills(need('base'), need('skills'), need('slots'), out);
    console.log(`[snapshot] ${out}: ${merged.skills} skills, ${merged.attackSkills} Attack skills`);
    return;
  }
  if (command === 'check-content') {
    const base = need('base');
    const md = [
      '# Content checks',
      '',
      `Private copy: ${base}`,
      '',
      '## Private copy against the monster audit',
      '',
      ...compareMonsterAudit(base, need('audit')),
      '',
      '## Server data folder against the export',
      '',
      ...compareDataFolder(base, need('data')),
      '',
    ].join('\n');
    writeFileSync(need('out'), md);
    console.log(md);
    return;
  }
  if (command === 'atlas') {
    const families = (flag('families')?.split(',') ?? [...ALL_FAMILIES]) as CompFamily[];
    await runAtlas({
      snapshot: need('snapshot'),
      out: need('out'),
      families,
      fights: Number(flag('fights') ?? DEFAULT_FIGHTS_PER_CELL),
      seed: Number(flag('seed') ?? DEFAULT_SEED),
      jobs,
      engineRef: flag('engine-ref') ?? engineRef(),
      limitTables: flag('limit-tables') ? Number(flag('limit-tables')) : undefined,
      planOnly: argv.includes('--plan-only'),
    });
    const refineFights = Number(flag('refine-fights') ?? DEFAULT_REFINE_FIGHTS);
    if (!argv.includes('--plan-only') && refineFights > 0) await refineNearLine(need('out'), refineFights, jobs);
    return;
  }
  if (command === 'eval') {
    await evaluatePlan({ atlas: need('atlas'), plan: need('plan'), out: need('out'), jobs, params: parseParamFlags(repeated('param')) });
    return;
  }
  if (command === 'scorecard') {
    const out = need('out');
    const paths = await renderScorecardFiles({ atlas: need('atlas'), out, ...scorecardFlags() });
    console.log(`[scorecard] ${paths.join(', ')}`);
    return;
  }
  if (command === 'run-plan') {
    const out = need('out');
    await evaluatePlan({ atlas: need('atlas'), plan: need('plan'), out, jobs, params: parseParamFlags(repeated('param')) });
    const paths = await renderScorecardFiles({ atlas: need('atlas'), out, ...scorecardFlags() });
    console.log(`[scorecard] ${paths.join(', ')}`);
    return;
  }
  if (command === 'leaderboard') {
    const skipped = new Set(['--md']);
    const dirs = argv.slice(1).filter((arg, i, list) => !arg.startsWith('--') && !skipped.has(list[i - 1]));
    if (dirs.length === 0) throw new Error('leaderboard needs at least one out dir');
    const md = renderLeaderboard(readCards(dirs), argv.includes('--values'));
    const target = flag('md');
    if (target) writeFileSync(target, md);
    console.log(md);
    return;
  }
  if (command === 'rework') {
    const { summary, summaryPath } = await runRework(need('snapshot'), need('rework'), need('out'));
    console.log(summary);
    console.log(`[rework] ${need('out')}, ${summaryPath}`);
    return;
  }
  if (command === 'compare') {
    const out = need('md');
    const md = compareRuns({ atlas: need('atlas-a'), out: need('out-a') }, { atlas: need('atlas-b'), out: need('out-b') }, flag('label-a') ?? 'a', flag('label-b') ?? 'b');
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, md);
    console.log(`[compare] ${out}`);
    return;
  }
  throw new Error('commands: snapshot, check-content, rework, atlas, eval, scorecard, run-plan, compare, leaderboard');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
