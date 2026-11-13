import { appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { SNAPSHOT_FILE, readCells, readMeta, readSnapshot } from './atlas.js';
import { goldLine, goldPart, rateLine } from './rates-file.js';
import { createEvaluator } from './evaluator.js';
import { loadPlan, readPlanState } from './plan.js';

const { atlas, plan: planPath, snapshot, statePath, part, params } = workerData as { atlas: string; plan: string; snapshot: string; statePath?: string; part: string; params?: Record<string, number> };
const port = parentPort!;
const FLUSH_LINES = 512;

async function main(): Promise<void> {
  const mod: any = await import('../../../shared/src/index.js');
  const atlasSnapshot = join(atlas, SNAPSHOT_FILE);
  const evaluateFile = createEvaluator({
    meta: readMeta(atlas),
    cells: readCells(atlas),
    content: readSnapshot(snapshot).content,
    plan: await loadPlan(planPath, params),
    state: readPlanState(statePath),
    mod,
    ...(resolve(snapshot) === resolve(atlasSnapshot) ? {} : { atlasContent: readSnapshot(atlasSnapshot).content }),
  });
  let lines: string[] = [];
  let goldLines: string[] = [];
  const flush = (): void => {
    if (lines.length) appendFileSync(part, `${lines.join('\n')}\n`);
    if (goldLines.length) appendFileSync(goldPart(part), `${goldLines.join('\n')}\n`);
    lines = [];
    goldLines = [];
  };
  writeFileSync(part, '');
  writeFileSync(goldPart(part), '');
  port.on('message', (msg: { stop?: boolean; files?: string[] }) => {
    if (msg.stop) {
      port.close();
      return;
    }
    for (const file of msg.files!) {
      evaluateFile(file, rate => {
        lines.push(rateLine(rate));
        const line = goldLine(rate);
        if (line) goldLines.push(line);
        if (lines.length >= FLUSH_LINES) flush();
      });
    }
    flush();
    port.postMessage({ fileDone: true });
  });
  port.postMessage({ ready: true });
}

main().catch(err => {
  throw err;
});
