import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REFINE_DIR, readCells, readMeta, simulateCells } from './atlas.js';
import type { JobReport } from './atlas.js';
import type { XpCell } from './types.js';

const REFINE_SEED_OFFSET = 7919;
export const DEFAULT_REFINE_FIGHTS = 400;
/** Win %, low inclusive, high exclusive. 24 fights read a true 90 % cell below 80 % one time in twelve, so this reaches further than the line's own noise. */
export const NEAR_LINE_BAND: [number, number] = [70, 100];

export function sampleDir(atlas: string, fights: number): string {
  return join(resolve(atlas), REFINE_DIR, `f${fights}`);
}

export function cellFile(dir: string, cellId: number): string {
  return join(dir, `c${cellId}.bin`);
}

/** Where a cell's fresh sample is: the atlas's own if it has one, else `extra`, a folder for samples that must leave the atlas untouched. */
export function sampleFile(atlas: string, fights: number, cellId: number, extra?: string): string {
  const shared = cellFile(sampleDir(atlas, fights), cellId);
  return extra && !existsSync(shared) ? cellFile(extra, cellId) : shared;
}

/**
 * Simulates a fresh sample of any of these cells not sampled yet. One file per cell, renamed into place when complete, with
 * a seed that depends only on the cell: combat doesn't depend on the XP rule, so every plan shares them and runs can overlap.
 * With `extra`, a new sample goes there and the atlas is only read.
 */
export async function ensureSampled(atlas: string, cellIds: readonly number[], fights: number, jobs: number, onReport?: (report: JobReport) => void, extra?: string): Promise<number> {
  const root = resolve(atlas);
  const dir = extra ?? sampleDir(root, fights);
  mkdirSync(dir, { recursive: true });
  const meta = readMeta(root);
  const cells = readCells(root);
  const byTable = new Map<number, XpCell[]>();
  let missing = 0;
  for (const id of new Set(cellIds)) {
    if (existsSync(sampleFile(root, fights, id, extra))) continue;
    if (cells[id].ineligible) throw new Error(`cell ${id} is ineligible: ${cells[id].ineligible}`);
    const list = byTable.get(cells[id].table) ?? [];
    list.push(cells[id]);
    byTable.set(cells[id].table, list);
    missing++;
  }
  if (missing > 0) await simulateCells({ atlasDir: root, cellDir: dir, byTable, fights, seed: meta.seed + REFINE_SEED_OFFSET, jobs, onReport });
  return missing;
}
