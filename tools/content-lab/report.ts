import { COMPOSITIONS } from './policy.js';
import type { SanityLine } from './sanity.js';
import type { Baseline, CellResult, DungeonRunResult } from './types.js';

const XP_SHIFT_WEIGHT = 25;
const XP_RATIO_FLOOR = 1;

export interface PairedCell {
  old: CellResult;
  new: CellResult;
  shift: number;
}

/** |Δwin %| + 25 × |log2(XP/h ratio)|: a lost fight and a halved XP rate each read as a shift of about 25-100. */
export function shiftScore(o: Partial<CellResult>, n: Partial<CellResult>): number {
  const dWin = Math.abs((n.winPct ?? 0) - (o.winPct ?? 0));
  const ratio = Math.log2(Math.max(n.xpPerHour ?? 0, XP_RATIO_FLOOR) / Math.max(o.xpPerHour ?? 0, XP_RATIO_FLOOR));
  return dWin + XP_SHIFT_WEIGHT * Math.abs(ratio);
}

function isSimulated(c: CellResult): boolean {
  return !c.ineligible && c.winPct !== undefined;
}

export function pairCells(oldB: Baseline, newB: Baseline, filter: (c: CellResult) => boolean): PairedCell[] {
  const newById = new Map(newB.cells.map(c => [c.id, c]));
  const pairs: PairedCell[] = [];
  for (const o of oldB.cells) {
    const n = newById.get(o.id);
    if (!n || !filter(o) || !isSimulated(o) || !isSimulated(n)) continue;
    pairs.push({ old: o, new: n, shift: shiftScore(o, n) });
  }
  return pairs;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function fmtNum(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

function fmtXp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(0);
}

function ratio(n: number | null | undefined, o: number | null | undefined): string {
  if (!n || !o) return '-';
  return `x${(n / o).toFixed(2)}`;
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n');
}

export interface RegionCompRow {
  regionIndex: number;
  regionName: string;
  comp: string;
  zones: number;
  oldWin: number;
  newWin: number;
  oldSec: number | null;
  newSec: number | null;
  oldXp: number;
  newXp: number;
  oldStale: number;
  newStale: number;
  oldHp: number;
  newHp: number;
  shift: number;
}

export function regionCompRows(oldB: Baseline, newB: Baseline, filter: (c: CellResult) => boolean): RegionCompRow[] {
  const groups = new Map<string, PairedCell[]>();
  for (const p of pairCells(oldB, newB, filter)) {
    const key = `${p.old.regionIndex}|${p.old.comp}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const rows: RegionCompRow[] = [];
  for (const list of groups.values()) {
    const first = list[0].old;
    rows.push({
      regionIndex: first.regionIndex,
      regionName: first.regionName,
      comp: first.comp,
      zones: list.length,
      oldWin: mean(list.map(p => p.old.winPct!)),
      newWin: mean(list.map(p => p.new.winPct!)),
      oldSec: median(list.flatMap(p => (p.old.medianSec != null ? [p.old.medianSec] : []))),
      newSec: median(list.flatMap(p => (p.new.medianSec != null ? [p.new.medianSec] : []))),
      oldXp: mean(list.map(p => p.old.xpPerHour!)),
      newXp: mean(list.map(p => p.new.xpPerHour!)),
      oldStale: mean(list.map(p => p.old.stalematePct!)),
      newStale: mean(list.map(p => p.new.stalematePct!)),
      oldHp: mean(list.flatMap(p => (p.old.hpLostPct != null ? [p.old.hpLostPct] : []))),
      newHp: mean(list.flatMap(p => (p.new.hpLostPct != null ? [p.new.hpLostPct] : []))),
      shift: mean(list.map(p => p.shift)),
    });
  }
  return rows;
}

const compOrder = new Map(COMPOSITIONS.map((c, i) => [c.id, i]));

function regionRowCells(r: RegionCompRow): string[] {
  return [
    r.comp,
    `${fmtNum(r.oldWin)} > ${fmtNum(r.newWin)}`,
    `${fmtNum(r.oldSec, 1)} > ${fmtNum(r.newSec, 1)}`,
    `${fmtXp(r.oldXp)} > ${fmtXp(r.newXp)} (${ratio(r.newXp, r.oldXp)})`,
    `${fmtNum(r.oldStale)} > ${fmtNum(r.newStale)}`,
    `${fmtNum(r.oldHp)} > ${fmtNum(r.newHp)}`,
    fmtNum(r.shift),
  ];
}

const isMainZoneCell = (c: CellResult): boolean => c.kind === 'zone' && c.levelVariant === 'mid' && c.gear === 'shop';
const isRewarding = (c: CellResult): boolean => !c.noReward;

export function regionTableMarkdown(oldB: Baseline, newB: Baseline): string {
  const rows = regionCompRows(oldB, newB, c => isMainZoneCell(c) && isRewarding(c))
    .sort((a, b) => a.regionIndex - b.regionIndex || compOrder.get(a.comp)! - compOrder.get(b.comp)!);
  return table(
    ['#', 'Region', 'Comp', 'Win %', 'Median s', 'XP/h/member'],
    rows.map(r => [
      String(r.regionIndex + 1),
      r.regionName,
      r.comp,
      `${fmtNum(r.oldWin)} > ${fmtNum(r.newWin)}`,
      `${fmtNum(r.oldSec, 1)} > ${fmtNum(r.newSec, 1)}`,
      `${fmtXp(r.oldXp)} > ${fmtXp(r.newXp)}`,
    ]),
  );
}

function renderSanity(lines: readonly SanityLine[]): string {
  return table(['', 'Check', 'Expected', 'Measured'], lines.map(l => [l.ok ? 'PASS' : 'FAIL', l.name, l.expected, l.measured]));
}

function renderRegionSections(oldB: Baseline, newB: Baseline): string {
  const rows = regionCompRows(oldB, newB, c => isMainZoneCell(c) && isRewarding(c));
  const byRegion = new Map<number, RegionCompRow[]>();
  for (const r of rows) {
    const list = byRegion.get(r.regionIndex) ?? [];
    list.push(r);
    byRegion.set(r.regionIndex, list);
  }
  const sections = [...byRegion.values()]
    .map(list => ({ list, shift: mean(list.map(r => r.shift)) }))
    .sort((a, b) => b.shift - a.shift);
  return sections.map(({ list, shift }) => {
    const first = list[0];
    const sorted = [...list].sort((a, b) => b.shift - a.shift);
    return `### ${first.regionIndex + 1}. ${first.regionName} (mean shift ${fmtNum(shift)}, ${first.zones} zones)\n\n${table(
      ['Comp', 'Win %', 'Median s', 'XP/h/member', 'Stalemate %', 'HP lost %', 'Shift'],
      sorted.map(regionRowCells),
    )}`;
  }).join('\n\n');
}

function renderVariantSummary(oldB: Baseline, newB: Baseline): string {
  const variants: { label: string; filter: (c: CellResult) => boolean }[] = [
    { label: 'low, shop', filter: c => c.kind === 'zone' && c.levelVariant === 'low' && c.gear === 'shop' },
    { label: 'mid, shop', filter: c => isMainZoneCell(c) },
    { label: 'high, shop', filter: c => c.kind === 'zone' && c.levelVariant === 'high' && c.gear === 'shop' },
    { label: 'mid, ungeared', filter: c => c.kind === 'zone' && c.gear === 'ungeared' },
  ];
  const coreComps = COMPOSITIONS.filter(c => !c.hires).map(c => c.id);
  const headers = ['Region', 'Level / gear', ...coreComps];
  const regionNames = new Map(oldB.cells.map(c => [c.regionIndex, c.regionName]));
  const rows: string[][] = [];
  for (const [index, name] of [...regionNames].sort((a, b) => a[0] - b[0])) {
    for (const v of variants) {
      const compRows = regionCompRows(oldB, newB, c => v.filter(c) && isRewarding(c) && c.regionIndex === index);
      rows.push([
        `${index + 1}. ${name}`,
        v.label,
        ...coreComps.map(comp => {
          const r = compRows.find(x => x.comp === comp);
          return r ? `${fmtNum(r.oldWin)}>${fmtNum(r.newWin)}` : '-';
        }),
      ]);
    }
  }
  return `Mean win % across the region's zones, old > new.\n\n${table(headers, rows)}`;
}

function cellRow(p: PairedCell, label: string): string[] {
  const { old: o, new: n } = p;
  return [
    label,
    o.comp,
    String(o.level),
    `${fmtNum(o.winPct)} > ${fmtNum(n.winPct)}`,
    `${fmtNum(o.stalematePct)} > ${fmtNum(n.stalematePct)}`,
    `${fmtNum(o.medianSec, 1)} > ${fmtNum(n.medianSec, 1)}`,
    `${fmtNum(o.p90Sec, 1)} > ${fmtNum(n.p90Sec, 1)}`,
    `${fmtNum(o.hpLostPct)} > ${fmtNum(n.hpLostPct)}`,
    `${fmtNum(o.deaths, 1)} > ${fmtNum(n.deaths, 1)}`,
    `${fmtXp(o.xpPerHour)} > ${fmtXp(n.xpPerHour)}`,
    `${fmtXp(o.goldPerHour)} > ${fmtXp(n.goldPerHour)}`,
    fmtNum(p.shift),
  ];
}

const CELL_HEADERS = ['Where', 'Comp', 'Lv', 'Win %', 'Stale %', 'Med s', 'P90 s', 'HP lost %', 'Dead', 'XP/h', 'Gold/h', 'Shift'];

function renderZoneOverview(oldB: Baseline, newB: Baseline): string {
  const pairs = pairCells(oldB, newB, c => isMainZoneCell(c) && isRewarding(c));
  const byZone = new Map<string, PairedCell[]>();
  for (const p of pairs) {
    const list = byZone.get(p.old.zoneId) ?? [];
    list.push(p);
    byZone.set(p.old.zoneId, list);
  }
  const shown = ['K', 'A', 'P', 'M', 'B', 'K+P+M', 'K+A+P+M+B'];
  const rows = [...byZone.values()]
    .map(list => ({ list, shift: mean(list.map(p => p.shift)) }))
    .sort((a, b) => b.shift - a.shift)
    .map(({ list, shift }) => [
      `${list[0].old.zoneName} (R${list[0].old.regionIndex + 1})`,
      String(list[0].old.level),
      fmtNum(shift),
      ...shown.map(comp => {
        const p = list.find(x => x.old.comp === comp);
        return p ? `${fmtNum(p.old.winPct)}>${fmtNum(p.new.winPct)}` : '-';
      }),
    ]);
  return table(['Zone', 'Lv', 'Shift', ...shown], rows);
}

function renderCellTable(oldB: Baseline, newB: Baseline, filter: (c: CellResult) => boolean, label: (c: CellResult) => string): string {
  const rows = pairCells(oldB, newB, filter).sort((a, b) => b.shift - a.shift).map(p => cellRow(p, label(p.old)));
  return table(CELL_HEADERS, rows);
}

function renderNoRewardZones(b: Baseline): string {
  const zones = [...new Map(b.cells.filter(c => c.kind === 'zone' && c.noReward).map(c => [c.zoneId, `${c.zoneName} (R${c.regionIndex + 1})`])).values()];
  return `Zones whose every monster pays no XP are left out of the tables above and below (${zones.length}): ${zones.join(', ')}.`;
}

function renderDungeons(oldB: Baseline, newB: Baseline): string {
  const newByKey = new Map(newB.dungeons.map(d => [`${d.dungeonId}|${d.comp}`, d]));
  const rows: { shift: number; cells: string[] }[] = [];
  const ineligible: string[] = [];
  for (const o of oldB.dungeons) {
    const n = newByKey.get(`${o.dungeonId}|${o.comp}`) as DungeonRunResult;
    if (!n) continue;
    if (o.ineligible) {
      if (!o.comp.includes('hires')) ineligible.push(`${o.dungeonName} / ${o.comp}: ${o.ineligible}`);
      continue;
    }
    const shift = Math.abs((n.clearPct ?? 0) - (o.clearPct ?? 0));
    rows.push({
      shift,
      cells: [
        `${o.dungeonName} (R${o.regionIndex + 1})`,
        o.comp,
        String(o.level),
        `${fmtNum(o.clearPct)} > ${fmtNum(n.clearPct)}`,
        `${fmtNum(o.medianRunSec)} > ${fmtNum(n.medianRunSec)}`,
        `${fmtXp(o.xpPerHour)} > ${fmtXp(n.xpPerHour)}`,
        `${fmtNum(o.meanDeaths, 1)} > ${fmtNum(n.meanDeaths, 1)}`,
      ],
    });
  }
  rows.sort((a, b) => b.shift - a.shift);
  const main = table(['Dungeon', 'Comp', 'Lv', 'Clear %', 'Median run s', 'XP/h', 'Dead per run'], rows.map(r => r.cells));
  const note = 'Solo-plus-hires cells are ineligible everywhere in dungeons: hires wait at the entrance.';
  const list = ineligible.length ? `\n\nIneligible by entry rules:\n\n${ineligible.map(i => `- ${i}`).join('\n')}` : '';
  return `${note}\n\n${main}${list}`;
}

function renderMeta(oldB: Baseline, newB: Baseline): string {
  const lines = [
    `- Snapshot sha1: ${newB.meta.snapshotSha1}`,
    `- Engines: old ${oldB.meta.engineRef}, new ${newB.meta.engineRef}`,
    `- N: ${newB.meta.n} per cell, ${newB.meta.variantN} per variant cell, seed ${newB.meta.seed}`,
    `- Pause per fight: old ${oldB.meta.pauseMs} ms, new ${newB.meta.pauseMs} ms`,
    `- Shift score: |delta win %| + ${XP_SHIFT_WEIGHT} x |log2(XP/h ratio)|, higher = bigger change`,
    `- Cells: ${oldB.cells.length}`,
    ...newB.meta.log.map(l => `- ${l}`),
  ];
  const policies = Object.entries(newB.meta.policies)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => `- **${k}**: ${String(v)}`);
  return `${lines.join('\n')}\n\nPolicies (full tables in baseline-*.json, meta.policies, meta.gear, meta.loadouts):\n\n${policies.join('\n')}`;
}

export function renderCompare(oldB: Baseline, newB: Baseline, sanity: readonly SanityLine[]): string {
  return [
    '# Content lab: old vs new combat engine',
    '## Run',
    renderMeta(oldB, newB),
    '## Sanity checks',
    renderSanity(sanity),
    '## Per region, per composition (sorted by shift)',
    renderNoRewardZones(newB),
    'Values are old > new. Win % and XP/h are means across zones; median s is the median of zone medians over winning fights.',
    renderRegionSections(oldB, newB),
    '## Per region: level ends and ungeared',
    renderVariantSummary(oldB, newB),
    '## Per zone overview (sorted by shift)',
    renderZoneOverview(oldB, newB),
    '## Per zone, every composition (sorted by shift)',
    renderCellTable(oldB, newB, c => isMainZoneCell(c) && isRewarding(c), c => `${c.zoneName} (R${c.regionIndex + 1})`),
    '## Rooms with their own encounter table (sorted by shift)',
    renderCellTable(oldB, newB, c => c.kind === 'room', c => `${c.tileIds?.length ?? 1} room(s) from ${c.tileIds?.[0] ?? ''} in ${c.zoneName} (R${c.regionIndex + 1})`),
    '## Dungeons: whole runs (sorted by clear % shift)',
    renderDungeons(oldB, newB),
    '## Dungeon floors (sorted by shift)',
    renderCellTable(oldB, newB, c => c.kind === 'floor', c => `${c.dungeonName} floor ${(c.floorIndex ?? 0) + 1}/${c.floorCount ?? '?'}${c.isBoss ? ' boss' : ''}`),
    '',
  ].join('\n\n');
}
