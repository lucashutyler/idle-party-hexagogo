import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { loadNewEngine } from '../engines.js';
import { buildRegions } from '../policy.js';
import { hashSeed, makeRng } from '../sim.js';
import { SNAPSHOT_FILE, readMeta, readSnapshot } from './atlas.js';
import { runFight } from './fight.js';
import type { FightKit } from './fight.js';
import { PartyBuilder } from './party.js';
import { cellFile } from './refine.js';
import { ROW_FILE_PREFIX, ROW_FILE_SUFFIX, RowWriter } from './rows.js';
import { fightsPerStratum } from './tables.js';
import { FALLBACK_ENCOUNTER, RESULT_TIMEOUT } from './types.js';
import type { XpCell } from './types.js';

const { atlasDir, cellDir, workerId, fights, seed } = workerData as { atlasDir: string; cellDir?: string; workerId: number; fights: number; seed: number };
const port = parentPort!;

async function main(): Promise<void> {
  const meta = readMeta(atlasDir);
  const { content } = readSnapshot(join(atlasDir, SNAPSHOT_FILE));
  const engine = await loadNewEngine();
  const { regions } = buildRegions(content);
  const builder = new PartyBuilder(content, regions, engine);
  const monsterIndex = new Map(meta.monsters.map((id, i) => [id, i]));
  const encounterIndex = new Map(meta.encounters.map((id, i) => [id, i]));
  const kit: FightKit = { mod: engine.module, content, monsterIndex };
  const shared = cellDir ? null : new RowWriter(join(atlasDir, `${ROW_FILE_PREFIX}${String(workerId).padStart(3, '0')}${ROW_FILE_SUFFIX}`));

  const runTable = (tableIndex: number, cells: XpCell[]): void => {
    const table = meta.tables[tableIndex];
    const region = regions[table.regionIndex];
    const byFamily: Record<string, { cells: number; fights: number; cpuMs: number }> = {};
    let total = 0;
    let timeouts = 0;
    let rowBytes = 0;
    const sharedBefore = shared?.bytes ?? 0;
    for (const cell of cells) {
      const comp = meta.comps[cell.comp];
      const started = performance.now();
      const party = builder.build(comp, cell.level, region);
      const cellKey = `${table.key}|${comp.id}|${cell.level}`;
      const finalPath = cellDir ? cellFile(cellDir, cell.id) : '';
      const scratchPath = `${finalPath}.${process.pid}.${workerId}.tmp`;
      const writer = shared ?? new RowWriter(scratchPath);
      let cellFights = 0;
      for (const stratum of table.strata) {
        const sims = fightsPerStratum(stratum.share, fights);
        const encounter = stratum.encounterId === null ? FALLBACK_ENCOUNTER : encounterIndex.get(stratum.encounterId);
        if (encounter === undefined) throw new Error(`encounter ${stratum.encounterId} is missing from the atlas dictionary`);
        for (let i = 0; i < sims; i++) {
          const rng = makeRng(hashSeed(`${seed}|${cellKey}|${stratum.encounterId ?? ''}|${i}`));
          const outcome = runFight(kit, party.players, table, stratum.encounterId, rng);
          if (outcome.result === RESULT_TIMEOUT) timeouts++;
          writer.write({ cell: cell.id, encounter, ...outcome });
          cellFights++;
        }
      }
      if (!shared) {
        writer.close();
        renameSync(scratchPath, finalPath);
        rowBytes += writer.bytes;
      }
      const stats = byFamily[comp.family] ?? { cells: 0, fights: 0, cpuMs: 0 };
      stats.cells++;
      stats.fights += cellFights;
      stats.cpuMs += performance.now() - started;
      byFamily[comp.family] = stats;
      total += cellFights;
    }
    if (shared) {
      shared.flush();
      rowBytes = shared.bytes - sharedBefore;
    }
    port.postMessage({ report: { table: tableIndex, fights: total, timeouts, rowBytes, byFamily } });
  };

  port.on('message', (msg: { stop?: boolean; table?: number; cells?: XpCell[] }) => {
    if (msg.stop) {
      shared?.close();
      port.postMessage({ stopped: true });
      port.close();
      return;
    }
    runTable(msg.table!, msg.cells!);
  });
  port.postMessage({ ready: true });
}

main().catch(err => {
  throw err;
});
