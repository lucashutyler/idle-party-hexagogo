import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CellGold, CellRate } from './types.js';

export const RATES_FILE = 'rates.jsonl';
/** Kept apart so a gold change can't move rates.jsonl, which runs compare byte for byte. */
export const GOLD_FILE = 'gold.jsonl';

export function goldPart(part: string): string {
  return `${part}.gold`;
}

export function rateLine(rate: CellRate): string {
  const { g: _gold, ...xp } = rate;
  return JSON.stringify(xp);
}

export function goldLine(rate: CellRate): string | undefined {
  return rate.g ? JSON.stringify({ c: rate.c, ...rate.g }) : undefined;
}

export function readRatesWithGold(outDir: string): CellRate[] {
  const rates = readFileSync(join(outDir, RATES_FILE), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as CellRate);
  const goldPath = join(outDir, GOLD_FILE);
  if (!existsSync(goldPath)) return rates;
  const gold = new Map<number, CellGold>();
  for (const line of readFileSync(goldPath, 'utf8').split('\n')) {
    if (!line) continue;
    const { c, ...rest } = JSON.parse(line) as CellGold & { c: number };
    gold.set(c, rest);
  }
  for (const rate of rates) {
    const held = gold.get(rate.c);
    if (held) rate.g = held;
  }
  return rates;
}
