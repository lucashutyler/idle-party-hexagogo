import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const FALLBACK_SHORT_CHARS = 48;

export interface CardMetric {
  id: string;
  title: string;
  pass: boolean | null;
  magnitude: string;
  short?: string;
  values?: Record<string, number | null>;
  /** False: this metric only reports, so its n/a isn't a gap. Absent on an older card. */
  scored?: boolean;
}

export interface Card {
  /** Plan id and any --param values. */
  title: string;
  metrics: CardMetric[];
  warnings?: string[];
  /** Fights per cell a verdict's picks were re-sampled at; 0: they weren't. Absent on an older card. */
  resampledAt?: number;
}

export function readCard(dir: string): Card {
  const raw = JSON.parse(readFileSync(join(resolve(dir), 'scorecard.json'), 'utf8')) as { plan?: string; title?: string; metrics: CardMetric[]; warnings?: string[]; resample?: { fights?: number } };
  return { title: raw.title ?? raw.plan ?? basename(resolve(dir)), metrics: raw.metrics, warnings: raw.warnings, resampledAt: raw.resample?.fights };
}

/** Two runs of one plan read apart by their folders. */
export function readCards(dirs: readonly string[]): Card[] {
  const cards = dirs.map(readCard);
  return cards.map((card, i) => (cards.filter(c => c.title === card.title).length > 1 ? { ...card, title: `${card.title} [${basename(resolve(dirs[i]))}]` } : card));
}

function verdictWord(pass: boolean | null): string {
  if (pass === null) return 'n/a';
  return pass ? 'PASS' : 'FAIL';
}

function shortOf(metric: CardMetric): string {
  if (metric.short) return metric.short;
  return metric.magnitude.length > FALLBACK_SHORT_CHARS ? `${metric.magnitude.slice(0, FALLBACK_SHORT_CHARS)}...` : metric.magnitude;
}

function cell(text: string): string {
  return text.replace(/\|/g, '/');
}

function metricIds(cards: readonly Card[]): { id: string; title: string }[] {
  const seen = new Map<string, string>();
  for (const card of cards) for (const m of card.metrics) if (!seen.has(m.id)) seen.set(m.id, m.title);
  return [...seen].map(([id, title]) => ({ id, title }));
}

/** A scored metric reading n/a measured nothing: leaving it out unmarked would make a broken plan's count look better. */
function failCount(card: Card): string {
  const judged = card.metrics.filter(m => m.pass !== null);
  const blank = card.metrics.filter(m => m.pass === null && m.scored === true).length;
  return `${judged.filter(m => !m.pass).length}/${judged.length}${blank ? ` (${blank} n/a)` : ''}`;
}

function warningCell(card: Card): string {
  if (card.warnings === undefined) return '-';
  if (card.warnings.length === 0) return 'none';
  return `${card.warnings.length}: ${card.warnings.map(w => (w.length > FALLBACK_SHORT_CHARS ? `${w.slice(0, FALLBACK_SHORT_CHARS)}...` : w)).join(' ')}`;
}

function resampledCell(card: Card): string {
  if (card.resampledAt === undefined) return '-';
  return card.resampledAt > 0 ? `at ${card.resampledAt} fights` : 'no, first reads';
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)];
}

/** One row per metric, one column per plan, read from each run's scorecard.json. */
export function renderLeaderboard(cards: readonly Card[], withValues: boolean): string {
  const ids = metricIds(cards);
  const lines = [
    '# Plan leaderboard',
    '',
    ...markdownTable(['metric', ...cards.map(c => cell(c.title))], [
      ['fails', ...cards.map(failCount)],
      ['warnings', ...cards.map(c => cell(warningCell(c)))],
      ['verdict picks re-sampled', ...cards.map(resampledCell)],
      ...ids.map(({ id, title }) => [`${id} ${title}`, ...cards.map(card => {
        const metric = card.metrics.find(m => m.id === id);
        return metric ? cell(`${verdictWord(metric.pass)}: ${shortOf(metric)}`) : '-';
      })]),
    ]),
    '',
  ];
  if (!withValues) return lines.join('\n');
  for (const { id, title } of ids) {
    const keys = [...new Set(cards.flatMap(card => Object.keys(card.metrics.find(m => m.id === id)?.values ?? {})))];
    if (keys.length === 0) continue;
    lines.push(`## ${id} ${title}`, '', ...markdownTable(['value', ...cards.map(c => cell(c.title))], keys.map(key => [key, ...cards.map(card => {
      const value = card.metrics.find(m => m.id === id)?.values?.[key];
      return value === undefined || value === null ? '-' : `${Math.round(value * 1000) / 1000}`;
    })])), '');
  }
  return lines.join('\n');
}
