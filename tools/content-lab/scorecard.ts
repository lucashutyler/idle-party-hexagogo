import { ECONOMY_COMPS, LENGTH_COMPS, SPEED_TARGET } from './fit.js';
import { collectMonsterUsage, staleDescriptions } from './rework.js';
import type { EffectSweepRow, TrialSweepRow, ZoneSweepRow } from './sweep.js';
import type { Baseline, CellResult, ContentSnapshot } from './types.js';

const SAFE_COMPS = ['K+P', 'K+P+M', 'K+A+P+M+B'];
const HIRE_COMPS = ['K+hires', 'A+hires', 'P+hires', 'M+hires', 'B+hires'];
const SOLO_COMPS = ['K', 'A', 'P', 'M', 'B'];
const MITIGATION_CLASSES = ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'];

const isMain = (c: CellResult): boolean => c.kind === 'zone' && c.levelVariant === 'mid' && c.gear === 'shop' && !c.noReward;
const isLow = (c: CellResult): boolean => c.kind === 'zone' && c.levelVariant === 'low' && c.gear === 'shop' && !c.noReward;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

function pct(part: number, total: number): string {
  return `${part}/${total} (${total ? Math.round((100 * part) / total) : 0} %)`;
}

function table(headers: string[], rows: (string | number)[][]): string {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

interface Pair {
  o: CellResult;
  n: CellResult;
}

function pairs(oldB: Baseline, cur: Baseline, filter: (c: CellResult) => boolean): Pair[] {
  const byId = new Map(cur.cells.map(c => [c.id, c]));
  return oldB.cells.filter(filter).flatMap(o => {
    const n = byId.get(o.id);
    return n && !o.ineligible && !n.ineligible ? [{ o, n }] : [];
  });
}

const label = (c: CellResult): string => `${c.zoneName} (R${c.regionIndex + 1} L${c.level})`;

function regionsOf(all: readonly Pair[]): number[] {
  return [...new Set(all.map(p => p.o.regionIndex))].sort((a, b) => a - b);
}

function t1(all: Pair[]): string[] {
  const lines: string[] = ['## T1 Fight length'];
  for (const comp of LENGTH_COMPS) {
    const rows = all.filter(p => p.o.comp === comp && p.o.medianSec && p.n.medianSec);
    const ok = rows.filter(p => Math.abs(p.n.medianSec! / (p.o.medianSec! / SPEED_TARGET) - 1) <= 0.3);
    const bad = rows.filter(p => !ok.includes(p) && p.o.medianSec! / SPEED_TARGET >= 2.5);
    lines.push(`- ${comp}: zones within +-30 %: ${pct(ok.length, rows.length)}; out of band excluding sub-2.5 s targets: ${bad.length}${bad.length ? ` [${bad.map(p => `${label(p.o)} ${p.o.medianSec}>${p.n.medianSec}`).join(', ')}]` : ''}`);
  }
  const rows = regionsOf(all).map(r => {
    const cols = LENGTH_COMPS.map(comp => {
      const list = all.filter(p => p.o.regionIndex === r && p.o.comp === comp && p.o.medianSec && p.n.medianSec);
      const ratio = median(list.map(p => p.n.medianSec!)) / (median(list.map(p => p.o.medianSec!)) / SPEED_TARGET);
      return `${median(list.map(p => p.o.medianSec!)).toFixed(0)}>${median(list.map(p => p.n.medianSec!)).toFixed(1)} (${ratio.toFixed(2)})`;
    });
    return [`R${r + 1}`, ...cols];
  });
  lines.push('', table(['Region', ...LENGTH_COMPS.map(c => `${c} old>new (vs target)`)], rows));
  return lines;
}

function t2(all: Pair[]): string[] {
  const lines: string[] = ['## T2 Economy'];
  for (const field of ['xpPerHour', 'goldPerHour'] as const) {
    for (const comp of ECONOMY_COMPS) {
      const rows = all.filter(p => p.o.comp === comp && p.o[field]);
      const ok = rows.filter(p => Math.abs(p.n[field]! / p.o[field]! - 1) <= 0.15);
      const bad = rows.filter(p => !ok.includes(p)).map(p => `${label(p.o)} x${(p.n[field]! / p.o[field]!).toFixed(2)}`);
      lines.push(`- ${field} ${comp}: zones within +-15 %: ${pct(ok.length, rows.length)}${bad.length ? ` [${bad.join(', ')}]` : ''}`);
    }
  }
  const rows = regionsOf(all).map(r => [`R${r + 1}`, ...ECONOMY_COMPS.flatMap(comp => (['xpPerHour', 'goldPerHour'] as const).map(field => {
    const list = all.filter(p => p.o.regionIndex === r && p.o.comp === comp && p.o[field]);
    return (mean(list.map(p => p.n[field]!)) / mean(list.map(p => p.o[field]!))).toFixed(2);
  }))]);
  lines.push('', table(['Region', ...ECONOMY_COMPS.flatMap(c => [`${c} XP/h`, `${c} gold/h`])], rows));
  return lines;
}

function t3(oldB: Baseline, cur: Baseline, all: Pair[]): string[] {
  const lines: string[] = ['## T3 Safety'];
  const low = pairs(oldB, cur, isLow);
  for (const comp of SAFE_COMPS) {
    const mid = all.filter(p => p.o.comp === comp);
    const lows = low.filter(p => p.o.comp === comp);
    const badMid = mid.filter(p => p.n.winPct! < 97);
    const badLow = lows.filter(p => p.n.winPct! < 90);
    lines.push(`- ${comp}: mid >= 97 %: ${pct(mid.length - badMid.length, mid.length)}${badMid.length ? ` [${badMid.map(p => `${label(p.o)} ${p.n.winPct}`).join(', ')}]` : ''}; low >= 90 %: ${pct(lows.length - badLow.length, lows.length)}${badLow.length ? ` [${badLow.map(p => `${label(p.o)} ${p.n.winPct}`).join(', ')}]` : ''}`);
  }
  const trio = all.filter(p => p.o.comp === 'K+P+M');
  const hp = trio.map(p => p.n.hpLostPct ?? 0);
  const under = trio.filter(p => p.o.regionIndex >= 1 && (p.n.hpLostPct ?? 0) < 10).map(p => `${label(p.o)} ${p.n.hpLostPct}`);
  lines.push(`- K+P+M HP lost on wins: min ${Math.min(...hp)}, median ${median(hp)}, max ${Math.max(...hp)}; in 10-35: ${pct(hp.filter(v => v >= 10 && v <= 35).length, hp.length)}; below 10 from R2 on: ${under.join(', ') || 'none'}`);
  lines.push('', table(['Region', ...SAFE_COMPS.map(c => `${c} min win / mean HP lost`)], regionsOf(all).map(r => [`R${r + 1}`, ...SAFE_COMPS.map(comp => {
    const list = all.filter(p => p.o.regionIndex === r && p.o.comp === comp);
    return `${Math.min(...list.map(p => p.n.winPct!))} / ${mean(list.map(p => p.n.hpLostPct ?? 0)).toFixed(0)}`;
  })])));
  return lines;
}

function t4(all: Pair[]): string[] {
  const lines: string[] = ['## T4 Solo and hires'];
  for (const comp of HIRE_COMPS) {
    const list = all.filter(p => p.o.comp === comp);
    const bad = list.filter(p => p.n.winPct! < 85);
    lines.push(`- ${comp}: >= 85 %: ${pct(list.length - bad.length, list.length)}${bad.length ? ` [${bad.map(p => `${label(p.o)} ${p.n.winPct}`).join(', ')}]` : ''}`);
  }
  lines.push('', table(['Region', ...SOLO_COMPS.map(c => `${c} zones won >= 50 % (best win; old > new mean win; stalemate %)`)], regionsOf(all).map(r => [`R${r + 1}`, ...SOLO_COMPS.map(comp => {
    const list = all.filter(p => p.o.regionIndex === r && p.o.comp === comp);
    return `${list.filter(p => p.n.winPct! >= 50).length}/${list.length} (${Math.max(...list.map(p => p.n.winPct!))}; ${mean(list.map(p => p.o.winPct!)).toFixed(0)}>${mean(list.map(p => p.n.winPct!)).toFixed(0)}; ${mean(list.map(p => p.n.stalematePct!)).toFixed(0)})`;
  })])));
  const zones = [...new Set(all.map(p => p.o.zoneId))];
  let groupBeats = 0;
  for (const z of zones) {
    const inZone = all.filter(p => p.o.zoneId === z);
    const solo = Math.max(...inZone.filter(p => SOLO_COMPS.includes(p.o.comp)).map(p => p.n.xpPerHour ?? 0));
    const group = inZone.find(p => p.o.comp === 'K+P+M')?.n.xpPerHour ?? 0;
    if (group > solo) groupBeats++;
  }
  lines.push('', `- K+P+M XP/h per member above the best solo: ${pct(groupBeats, zones.length)} of zones`);
  return lines;
}

function t5(live: ContentSnapshot, reworked: ContentSnapshot): string[] {
  const usage = collectMonsterUsage(live);
  const used = [...usage.keys()].map(id => reworked.monsters[id]).filter(m => m && !m.passive);
  const tiers: Record<string, number> = {};
  const intervals: Record<string, number> = {};
  for (const m of used) {
    tiers[m.tier] = (tiers[m.tier] ?? 0) + 1;
    intervals[m.attackInterval] = (intervals[m.attackInterval] ?? 0) + 1;
  }
  return ['## T5 Monster fields', `- referenced non-passive: ${used.length}; with level ${used.filter(m => m.level).length}, tier ${used.filter(m => m.tier).length}, interval ${used.filter(m => m.attackInterval).length}`, `- tiers ${JSON.stringify(tiers)}`, `- intervals ${JSON.stringify(intervals)}`];
}

function t6(oldB: Baseline, cur: Baseline): string[] {
  const newBy = new Map(cur.dungeons.map(d => [`${d.dungeonId}|${d.comp}`, d]));
  const rows: (string | number)[][] = [];
  const bossCells = (b: Baseline): Map<string, CellResult> => new Map(b.cells.filter(c => c.kind === 'floor' && c.isBoss).map(c => [`${c.dungeonId}|${c.comp}`, c]));
  const oldFloors = bossCells(oldB);
  const newFloors = bossCells(cur);
  for (const o of oldB.dungeons) {
    const n = newBy.get(`${o.dungeonId}|${o.comp}`);
    if (o.ineligible || !n || n.ineligible || o.comp.includes('hires')) continue;
    const of = oldFloors.get(`${o.dungeonId}|${o.comp}`);
    const nf = newFloors.get(`${o.dungeonId}|${o.comp}`);
    const flag = (n.forecast?.winPct ?? 0) + 5 < (o.clearPct ?? 0) ? 'WORSE' : '';
    rows.push([o.dungeonName, o.comp, o.level, o.clearPct ?? '-', n.clearPct ?? '-', n.forecast?.winPct ?? '-', `${of?.medianSec ?? '-'}>${nf?.medianSec ?? '-'}`, nf?.winPct ?? '-', flag]);
  }
  return ['## T6 Dungeons', table(['Dungeon', 'Comp', 'Lv', 'Old clear %', 'New single-run %', 'New forecast %', 'Boss median s', 'Boss fight win %', ''], rows)];
}

function rooms(oldB: Baseline, cur: Baseline): string[] {
  const list = pairs(oldB, cur, c => c.kind === 'room' && SAFE_COMPS.includes(c.comp) && !c.noReward);
  const bad = list.filter(p => p.n.winPct! < Math.min(97, p.o.winPct!));
  const off = list.filter(p => p.o.medianSec && p.n.medianSec && p.o.medianSec / SPEED_TARGET >= 2.5 && Math.abs(p.n.medianSec / (p.o.medianSec / SPEED_TARGET) - 1) > 0.3);
  const hired = pairs(oldB, cur, c => c.kind === 'room' && HIRE_COMPS.includes(c.comp) && !c.noReward);
  const badHired = hired.filter(p => p.n.winPct! < Math.min(85, p.o.winPct!));
  return [
    '## Rooms with their own tables',
    `- cells below min(97, old): ${pct(bad.length, list.length)}${bad.length ? ` [${bad.map(p => `${p.o.zoneName} ${p.o.comp} L${p.o.level} ${p.o.winPct}>${p.n.winPct} (${p.o.medianSec}>${p.n.medianSec} s)`).join(', ')}]` : ''}`,
    `- length out of +-30 %: ${pct(off.length, list.length)}`,
    `- hire cells below min(85, old): ${pct(badHired.length, hired.length)}${badHired.length ? ` [${badHired.map(p => `${p.o.zoneName} ${p.o.comp} L${p.o.level} ${p.o.winPct}>${p.n.winPct}`).join(', ')}]` : ''}`,
  ];
}

/** What the sweep passes wrote; each part is left out when its files are missing. */
export interface SweepResults {
  subsets?: { old: ZoneSweepRow[]; cur: ZoneSweepRow[] };
  seats?: { old: ZoneSweepRow[]; cur: ZoneSweepRow[] };
  dungeons?: { old: TrialSweepRow[]; cur: TrialSweepRow[] };
  builds?: { old: TrialSweepRow[]; cur: TrialSweepRow[] };
  effects?: EffectSweepRow[];
}

function zoneSweep(title: string, rows: { old: ZoneSweepRow[]; cur: ZoneSweepRow[] }): string[] {
  const oldBy = new Map(rows.old.map(r => [`${r.zoneId}|${r.comp}`, r]));
  const regions = [...new Set(rows.cur.map(r => r.regionIndex))].sort((a, b) => a - b);
  const comps = [...new Set(rows.cur.map(r => r.comp))];
  const body = comps.map(comp => {
    const list = rows.cur.filter(r => r.comp === comp && !r.noReward).map(n => ({ n, o: oldBy.get(`${n.zoneId}|${comp}`)! }));
    return [
      comp,
      `${list.filter(p => p.o.winPct >= 90).length} > ${list.filter(p => p.n.winPct >= 90).length}`,
      mean(list.map(p => p.o.winPct)).toFixed(0) + ' > ' + mean(list.map(p => p.n.winPct)).toFixed(0),
      ...regions.map(r => {
        const inRegion = list.filter(p => p.n.regionIndex === r);
        return `${mean(inRegion.map(p => p.o.winPct)).toFixed(0)}>${mean(inRegion.map(p => p.n.winPct)).toFixed(0)}`;
      }),
    ];
  });
  return [`## ${title}`, table(['Party', 'Zones won >= 90 %', 'Mean win', ...regions.map(r => `R${r + 1}`)], body)];
}

function trialKey(r: TrialSweepRow): string {
  return `${r.dungeonId}|${r.comp}|${r.level}`;
}

function trialSweep(title: string, rows: { old: TrialSweepRow[]; cur: TrialSweepRow[] }, all: boolean): string[] {
  const oldBy = new Map(rows.old.map(r => [trialKey(r), r]));
  const compared = rows.cur.map(n => ({ n, o: oldBy.get(trialKey(n)) }));
  const worse = compared.filter(p => (p.n.forecastPct ?? 0) + 5 < (p.o?.clearPct ?? 0));
  const shown = all ? compared : worse;
  const body = shown.map(({ n, o }) => [n.dungeonName, n.comp, n.level, o?.clearPct ?? '-', n.clearPct, Math.round(n.forecastPct ?? 0), n.floorWins.map(v => Math.round(v ?? 0)).join('/'), `${o?.bossMedianSec ?? '-'}>${n.bossMedianSec ?? '-'}`]);
  return [`## ${title}`, `- below old by more than 5 points: ${pct(worse.length, compared.length)}`, ...(body.length ? ['', table(['Dungeon', 'Party', 'Lv', 'Old clear', 'New single run', 'Forecast', 'Floor wins', 'Boss s'], body)] : [])];
}

function effectsSection(rows: readonly EffectSweepRow[]): string[] {
  const groups = new Map<string, Partial<Record<EffectSweepRow['variant'], EffectSweepRow>>>();
  for (const r of rows) {
    const key = `${r.place}|${r.monsterId}|${r.comp}|${r.gear}`;
    groups.set(key, { ...groups.get(key), [r.variant]: r });
  }
  const differs = (a: EffectSweepRow, b: EffectSweepRow, timeShare: number): boolean =>
    Math.abs(a.winPct - b.winPct) >= 5 || Math.abs(a.deaths - b.deaths) >= 0.2 || (!!a.medianSec && !!b.medianSec && Math.abs(a.medianSec / b.medianSec - 1) > timeShare);
  const line = (a: EffectSweepRow, b: EffectSweepRow): string => `${a.monsterName} ${a.comp}${a.gear === 'ungeared' ? ' ungeared' : ''}: win ${b.winPct}>${a.winPct}, ${b.medianSec ?? '-'}>${a.medianSec ?? '-'} s, dead ${b.deaths}>${a.deaths}`;
  const all = [...groups.values()].filter(g => g['as authored'] && g['no enrage'] && g['no skills']);
  const enrage = all.filter(g => differs(g['as authored']!, g['no enrage']!, 0.05));
  const skills = all.filter(g => differs(g['as authored']!, g['no skills']!, 0.1));
  return [
    '## Do enrage and monster skills change a boss fight?',
    `- cells: ${all.length}. Enrage changes win, deaths or time: ${enrage.length}. Monster skills do: ${skills.length}.`,
    ...enrage.map(g => `- enrage (off > on): ${line(g['as authored']!, g['no enrage']!)}`),
    ...skills.map(g => `- skills (off > on): ${line(g['as authored']!, g['no skills']!)}`),
  ];
}

/** Knight + Priest per member against a solo Priest: strong together, measured on the same rooms. */
function soloAgainstDuo(all: Pair[]): string[] {
  const duo = new Map(all.filter(p => p.o.comp === 'K+P').map(p => [p.o.zoneId, p.n.xpPerHour ?? 0]));
  const lines = ['## Solo against the duo (K+P XP/h per member over solo XP/h, zones the solo wins)'];
  for (const comp of ['K', 'P']) {
    const ratios = all.filter(p => p.o.comp === comp && (p.n.xpPerHour ?? 0) > 0).map(p => (duo.get(p.o.zoneId) ?? 0) / p.n.xpPerHour!);
    lines.push(`- ${comp}: ${ratios.length} zones; median x${median(ratios).toFixed(2)}; above x1: ${ratios.filter(r => r > 1).length}; x1.5 or more: ${ratios.filter(r => r >= 1.5).length}`);
  }
  return lines;
}

function zoneMonsterDrops(content: ContentSnapshot, zoneId: string): { id: string; share: number }[] {
  const table = content.zones[zoneId].encounterTable ?? [];
  const total = table.reduce((sum, e) => sum + e.weight, 0) || 1;
  const shares = new Map<string, number>();
  for (const e of table) {
    const encounter = content.encounters[e.encounterId];
    for (const p of [...(encounter?.placements ?? []), ...(encounter?.monsterPool ?? [])]) {
      const count = (p.min !== undefined && p.max !== undefined) ? (p.min + p.max) / 2 : 1;
      shares.set(p.monsterId, (shares.get(p.monsterId) ?? 0) + (e.weight / total) * count);
    }
  }
  return [...shares].map(([id, share]) => ({ id, share }));
}

/** Expected scaled drops per hour against the old engine; exempt drops are left out, they don't scale by design. */
function dropParity(all: Pair[], live: ContentSnapshot, reworked: ContentSnapshot, oldPause: number, newPause: number): string[] {
  const rows: { label: string; ratio: number }[] = [];
  for (const p of all) {
    if (!(ECONOMY_COMPS as readonly string[]).includes(p.o.comp) || !p.o.medianSec || !p.n.medianSec) continue;
    let oldRate = 0;
    let newRate = 0;
    for (const { id, share } of zoneMonsterDrops(live, p.o.zoneId)) {
      const before = live.monsters[id]?.drops ?? [];
      const after = reworked.monsters[id]?.drops ?? [];
      before.forEach((d: any, i: number) => {
        if (after[i]?.chance === d.chance) return;
        oldRate += (share * d.chance) / (p.o.medianSec! + oldPause);
        newRate += (share * after[i].chance) / (p.n.medianSec! + newPause);
      });
    }
    if (oldRate > 0) rows.push({ label: `${label(p.o)} ${p.o.comp}`, ratio: newRate / oldRate });
  }
  const ratios = rows.map(r => r.ratio);
  const ok = rows.filter(r => Math.abs(r.ratio - 1) <= 0.15);
  return [
    `- scaled drops per hour vs old: median x${median(ratios).toFixed(2)}, range x${Math.min(...ratios).toFixed(2)}-${Math.max(...ratios).toFixed(2)}; within +-15 %: ${pct(ok.length, rows.length)}`,
  ];
}

function regionTable(all: Pair[]): string[] {
  const rows: string[][] = [];
  for (const r of regionsOf(all)) {
    for (const comp of SAFE_COMPS) {
      const list = all.filter(p => p.o.regionIndex === r && p.o.comp === comp);
      const timed = list.filter(p => p.o.medianSec && p.n.medianSec);
      const span = (f: (c: CellResult) => number, digits = 0): string => `${mean(list.map(p => f(p.o))).toFixed(digits)} > ${mean(list.map(p => f(p.n))).toFixed(digits)}`;
      rows.push([
        `R${r + 1}`,
        comp,
        span(c => c.winPct ?? 0),
        `${median(timed.map(p => p.o.medianSec!)).toFixed(0)} > ${median(timed.map(p => p.n.medianSec!)).toFixed(1)}`,
        span(c => c.hpLostPct ?? 0, 1),
        span(c => c.xpPerHour ?? 0),
      ]);
    }
  }
  return ['## Region table (old > reworked; means over zones, median of zone medians for time)', table(['Region', 'Comp', 'Win %', 'Median s', 'HP lost %', 'XP/h per member'], rows)];
}

function mitigationTable(oldB: Baseline, live: ContentSnapshot, reworked: ContentSnapshot, mod: any): string[] {
  const rows: string[][] = [];
  const regions = [...new Set(oldB.cells.filter(isMain).map(c => c.regionId))];
  for (const regionId of regions) {
    const cells = oldB.cells.filter(c => isMain(c) && c.regionId === regionId);
    const level = median(cells.map(c => c.level));
    const row = [`R${cells[0].regionIndex + 1} L${level}`];
    for (const className of MITIGATION_CLASSES) {
      const equipment = (oldB.meta.gear as any)[regionId][className];
      const rating = (content: ContentSnapshot): [number, number] => {
        const raw = mod.computeEquipmentBonuses(equipment, content.items, level);
        const b = mod.mergeSetBonusesIntoEquip(raw, mod.computeActiveSetBonuses(equipment, content.sets, className).bonuses);
        return [(b.damageReductionMin + b.damageReductionMax) / 2, (b.magicReductionMin + b.magicReductionMax) / 2];
      };
      const [dr0, mr0] = rating(live);
      const [dr, mr] = rating(reworked);
      row.push(`DR ${dr0.toFixed(0)} > ${dr.toFixed(0)} (${(100 * mod.ratingMitigation(dr, level)).toFixed(0)} %), MR ${mr0.toFixed(0)} > ${mr.toFixed(0)} (${(100 * mod.ratingMitigation(mr, level)).toFixed(0)} %)`);
    }
    rows.push(row);
  }
  return ['## T7 Shop kit rating and on-level mitigation', table(['Region', ...MITIGATION_CLASSES], rows)];
}

function untouched(live: ContentSnapshot & Record<string, any>, reworked: ContentSnapshot & Record<string, any>): string[] {
  const lines = ['## T10 Sections and ids'];
  for (const section of Object.keys(live)) {
    if (section === 'world' || section === 'skillSlotSchedules' || section === 'designNotes') {
      lines.push(`- ${section}: ${JSON.stringify(live[section]) === JSON.stringify(reworked[section]) ? 'identical' : 'CHANGED'}`);
      continue;
    }
    const a = live[section];
    const b = reworked[section];
    const added = Object.keys(b).filter(k => !(k in a));
    const removed = Object.keys(a).filter(k => !(k in b));
    const changed = Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    lines.push(`- ${section}: ${Object.keys(a).length} entries, added ${added.length}, removed ${removed.length}, changed ${changed.length}`);
  }
  const stale = staleDescriptions(reworked);
  lines.push('', `- descriptions still saying round, turn or tick: ${stale.length}${stale.length ? ` [${stale.map(s => `${s.section}/${s.id}`).join(', ')}]` : ''}`);
  return lines;
}

export function renderScorecard(oldB: Baseline, cur: Baseline, live: ContentSnapshot, reworked: ContentSnapshot, mod: any, sweeps: SweepResults = {}): string {
  const all = pairs(oldB, cur, isMain);
  return [
    ...t1(all), '',
    ...t2(all), ...dropParity(all, live, reworked, oldB.meta.pauseMs / 1000, cur.meta.pauseMs / 1000), '',
    ...t3(oldB, cur, all), '',
    ...t4(all), '',
    ...soloAgainstDuo(all), '',
    ...t5(live, reworked), '',
    ...t6(oldB, cur), '',
    ...(sweeps.builds ? [...trialSweep('Authored builds (grant items, swapped skills, chosen seats)', sweeps.builds, true), ''] : []),
    ...(sweeps.dungeons ? [...trialSweep('Every class combination each door admits', sweeps.dungeons, false), ''] : []),
    ...(sweeps.effects ? [...effectsSection(sweeps.effects), ''] : []),
    ...(sweeps.subsets ? [...zoneSweep('Every class combination in every zone, old > new win %', sweeps.subsets), ''] : []),
    ...(sweeps.seats ? [...zoneSweep('The seats the game hands an unadjusted K+P+M, old > new win %', sweeps.seats), ''] : []),
    ...mitigationTable(oldB, live, reworked, mod), '',
    ...rooms(oldB, cur), '',
    ...untouched(live, reworked), '',
    ...regionTable(all), '',
  ].join('\n');
}
