import type { Factors, ReworkConfig } from './rework.js';
import { collectMonsterUsage } from './rework.js';
import type { TrialSweepRow } from './sweep.js';
import type { Baseline, CellResult, ContentSnapshot, EncounterEntry } from './types.js';

export const SPEED_TARGET = 2.3;
export const LENGTH_COMPS = ['K+P', 'K+P+M', 'K+A+P+M+B'] as const;
export const ECONOMY_COMPS = ['K+P+M', 'K+A+P+M+B'] as const;
/** Fights this short are a hit or two either way: nothing to fit. */
const QUANTIZED_TARGET_SEC = 2.5;

export type PlaceKind = 'zone' | 'room' | 'floor';

export interface Place {
  key: string;
  kind: PlaceKind;
  regionId: string;
  monsterIds: string[];
  /** Cells of this place by composition, main variant only. */
  old: Map<string, CellResult>;
  cur: Map<string, CellResult>;
}

export interface FitOptions {
  damp: number;
  /** Also nudge the monsters of places the region factor leaves outside the band. */
  monsterOutliers: boolean;
  /** log error below which a monster keeps its factor. */
  outlierThreshold: number;
}

function placeKey(c: CellResult): string {
  if (c.kind === 'zone') return `zone|${c.zoneId}`;
  if (c.kind === 'room') return `room|${c.tileIds?.[0]}`;
  return `floor|${c.dungeonId}|${c.floorIndex}`;
}

function isMainCell(c: CellResult): boolean {
  return c.levelVariant === 'mid' && c.gear === 'shop';
}

function tableIds(content: ContentSnapshot, table: readonly EncounterEntry[] | undefined): string[] {
  return [...new Set((table ?? []).flatMap(e => {
    const encounter = content.encounters[e.encounterId];
    return [...(encounter?.placements ?? []), ...(encounter?.monsterPool ?? [])].map((p: any) => p.monsterId as string);
  }))];
}

function tableOf(content: ContentSnapshot, c: CellResult): EncounterEntry[] | undefined {
  if (c.kind === 'zone') return content.zones[c.zoneId].encounterTable;
  if (c.kind === 'room') return content.world.tiles.find(t => t.id === c.tileIds?.[0])?.encounterTable;
  return content.dungeons[c.dungeonId!].floors[c.floorIndex!].encounterTable;
}

export function buildPlaces(content: ContentSnapshot, oldB: Baseline, cur: Baseline): Place[] {
  const curById = new Map(cur.cells.map(c => [c.id, c]));
  const places = new Map<string, Place>();
  for (const o of oldB.cells) {
    if (!isMainCell(o)) continue;
    const key = placeKey(o);
    let place = places.get(key);
    if (!place) {
      place = { key, kind: o.kind, regionId: o.regionId, monsterIds: tableIds(content, tableOf(content, o)), old: new Map(), cur: new Map() };
      places.set(key, place);
    }
    place.old.set(o.comp, o);
    const n = curById.get(o.id);
    if (n) place.cur.set(o.comp, n);
  }
  return [...places.values()];
}

function midrange(values: readonly number[]): number | null {
  return values.length ? (Math.min(...values) + Math.max(...values)) / 2 : null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** log(new / target) of the fight length, midway between the compositions so that none is favoured. */
export function lengthError(place: Place): number | null {
  const errors: number[] = [];
  for (const comp of LENGTH_COMPS) {
    const o = place.old.get(comp)?.medianSec;
    const n = place.cur.get(comp)?.medianSec;
    if (!o || !n) continue;
    const target = o / SPEED_TARGET;
    if (target < QUANTIZED_TARGET_SEC) continue;
    errors.push(Math.log(n / target));
  }
  return midrange(errors);
}

export function rateError(place: Place, field: 'xpPerHour' | 'goldPerHour'): number | null {
  const errors: number[] = [];
  for (const comp of ECONOMY_COMPS) {
    const o = place.old.get(comp)?.[field];
    const n = place.cur.get(comp)?.[field];
    if (!o || !n) continue;
    errors.push(Math.log(n / o));
  }
  return midrange(errors);
}

/** What a per-fight chance has to be multiplied by to keep drops per hour. */
function killRateRatio(place: Place, oldPauseSec: number, newPauseSec: number): number | null {
  const ratios: number[] = [];
  for (const comp of ECONOMY_COMPS) {
    const o = place.old.get(comp)?.medianSec;
    const n = place.cur.get(comp)?.medianSec;
    if (o == null || n == null) continue;
    ratios.push((n + newPauseSec) / (o + oldPauseSec));
  }
  return ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
}

/** A monster answers to its zones when it has any; rooms and floors only speak for monsters unique to them. */
function placesByMonster(places: readonly Place[]): Map<string, Place[]> {
  const map = new Map<string, Place[]>();
  for (const p of places) {
    for (const id of p.monsterIds) {
      const list = map.get(id) ?? [];
      list.push(p);
      map.set(id, list);
    }
  }
  for (const [id, list] of map) {
    const zones = list.filter(p => p.kind === 'zone');
    if (zones.length) map.set(id, zones);
  }
  return map;
}

const MONSTER_FACTOR_RANGE: [number, number] = [0.05, 12];

function nudge(f: Factors, id: string, logDelta: number): void {
  f.monsters = f.monsters ?? {};
  const next = (f.monsters[id] ?? 1) * Math.exp(logDelta);
  f.monsters[id] = Number(Math.min(MONSTER_FACTOR_RANGE[1], Math.max(MONSTER_FACTOR_RANGE[0], next)).toFixed(4));
}

function fitLength(config: ReworkConfig, places: readonly Place[], opts: FitOptions): string[] {
  const report: string[] = [];
  const byRegion = new Map<string, number[]>();
  for (const p of places) {
    if (p.kind !== 'zone') continue;
    const e = lengthError(p);
    if (e === null) continue;
    byRegion.set(p.regionId, [...(byRegion.get(p.regionId) ?? []), e]);
  }
  config.hp.regions = config.hp.regions ?? {};
  const regionShift = new Map<string, number>();
  for (const [regionId, errors] of byRegion) {
    const shift = -opts.damp * median(errors);
    regionShift.set(regionId, shift);
    config.hp.regions[regionId] = Number(((config.hp.regions[regionId] ?? 1) * Math.exp(shift)).toFixed(4));
    report.push(`hp region ${regionId}: ${median(errors).toFixed(3)} > x${config.hp.regions[regionId]}`);
  }
  if (!opts.monsterOutliers) return report;
  for (const [id, list] of placesByMonster(places)) {
    const errors = list.map(p => {
      const e = lengthError(p);
      return e === null ? null : e + (regionShift.get(p.regionId) ?? 0);
    }).filter((e): e is number => e !== null);
    if (!errors.length) continue;
    const e = errors.reduce((a, b) => a + b, 0) / errors.length;
    if (Math.abs(e) >= opts.outlierThreshold) nudge(config.hp, id, -opts.damp * e);
  }
  return report;
}

function fitRate(factors: Factors, field: 'xpPerHour' | 'goldPerHour', places: readonly Place[], opts: FitOptions): void {
  for (const [id, list] of placesByMonster(places)) {
    const errors = list.map(p => rateError(p, field)).filter((e): e is number => e !== null);
    if (errors.length) nudge(factors, id, -opts.damp * (errors.reduce((a, b) => a + b, 0) / errors.length));
  }
}

function fitDrops(config: ReworkConfig, places: readonly Place[], oldB: Baseline, cur: Baseline): void {
  config.drop.global = 1;
  config.drop.regions = {};
  config.drop.monsters = {};
  for (const [id, list] of placesByMonster(places)) {
    const ratios = list.map(p => killRateRatio(p, oldB.meta.pauseMs / 1000, cur.meta.pauseMs / 1000)).filter((r): r is number => r !== null);
    if (ratios.length) config.drop.monsters[id] = Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(3));
  }
}

const FULL_PARTY_MIN = 3;
const ENRAGE_MIN_SECONDS = 60;
const WINNER_PCT = 50;

/** The door's largest party, up to a trio: a duo is under-built only where more than two may enter. */
function wellBuiltSize(dungeon: any): number {
  return Math.min(FULL_PARTY_MIN, dungeon.entryRequirements?.maxPartySize ?? FULL_PARTY_MIN);
}

function isTankAndHealer(comp: string): boolean {
  const members = comp.split('+');
  return members.includes('K') && members.includes('P');
}

/**
 * Trial bosses: the slowest eligible party of full size with a tank and a healer, else the slowest winner of that size.
 * Open-world capstones, where hires and duos are expected: the slowest winner at all.
 */
export function enrageTimes(places: readonly Place[], trials: readonly TrialSweepRow[], reworked: ContentSnapshot, id: string): number[] {
  const times: number[] = [];
  for (const dungeon of Object.values<any>(reworked.dungeons)) {
    (dungeon.floors ?? []).forEach((floor: any, floorIndex: number) => {
      if (!tableIds(reworked, floor.encounterTable).includes(id)) return;
      const rows = trials.filter(t => t.dungeonId === dungeon.id && !t.label && t.comp.split('+').length >= wellBuiltSize(dungeon) && (t.floorWins[floorIndex] ?? 0) >= WINNER_PCT);
      const tanked = rows.filter(t => isTankAndHealer(t.comp));
      for (const t of tanked.length ? tanked : rows) {
        const sec = t.floorSecs[floorIndex];
        if (sec != null) times.push(sec);
      }
    });
  }
  for (const place of places) {
    if (place.kind === 'floor' || !place.monsterIds.includes(id)) continue;
    for (const cell of place.cur.values()) {
      if (!cell.ineligible && cell.medianSec != null && (cell.winPct ?? 0) >= WINNER_PCT && cell.comp.includes('+')) times.push(cell.medianSec);
    }
    for (const cell of place.old.values()) {
      if (cell.comp.includes('hires') && cell.medianSec != null && (cell.winPct ?? 0) >= WINNER_PCT) times.push(cell.medianSec / SPEED_TARGET);
    }
  }
  return times;
}

function fitEnrage(config: ReworkConfig, places: readonly Place[], reworked: ContentSnapshot, factor: number, trials: readonly TrialSweepRow[]): void {
  config.enrage = {};
  for (const [id] of collectMonsterUsage(reworked)) {
    const monster = reworked.monsters[id];
    if (!monster || monster.passive || (monster.tier !== 'boss' && monster.tier !== 'raid')) continue;
    const times = enrageTimes(places, trials, reworked, id);
    if (!times.length) continue;
    const afterSeconds = Math.max(ENRAGE_MIN_SECONDS, Math.ceil((Math.max(...times) * factor) / 10) * 10);
    const hasCheckpoints = Object.values<any>(reworked.dungeons).some(d => (d.floors ?? []).some((f: any) => f.isBoss && tableIds(reworked, f.encounterTable).includes(id)));
    config.enrage[id] = { afterSeconds, ...(hasCheckpoints ? config.enrageSteps : {}) };
  }
}

/** Sampled monster counts of one encounter table entry. */
export type PackSampler = (encounterId: string, zoneId: string) => Record<string, number>[];

interface GoldStratum {
  share: number;
  sec: number;
  packs: Record<string, number>[];
}

interface GoldCell {
  key: string;
  regionId: string;
  shares: number;
  target: number;
  strata: GoldStratum[];
  monsters: Set<string>;
}

const GOLD_SHARE_COMPS: Record<string, number> = { 'K+P+M': 3, 'K+A+P+M+B': 5 };
/** A cell that would pay nothing at all counts as this far off, so that nothing is priced out of a zone. */
const GOLD_ZERO_LOG_ERROR = 3;
/** Never above the authored roll, and never so low that the order between monsters stops meaning anything. */
const GOLD_FACTOR_GRID = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1];
/** Only ordinary monsters this poor may stop paying: a coin roll this small is all rounding anyway. */
const GOLD_MAY_ZERO_BELOW = 3;

export function goldRollOptions(m: { goldMin: number; goldMax: number; tier?: string }): [number, number][] {
  const rolls: [number, number][] = GOLD_FACTOR_GRID.map(f => {
    const lo = Math.round(m.goldMin * f);
    return [lo, Math.max(lo, 1, Math.round(m.goldMax * f))];
  });
  if (m.goldMax >= 1) rolls.push([0, 1]);
  if (m.goldMax < GOLD_MAY_ZERO_BELOW && (m.tier ?? 'trash') === 'trash') rolls.push([0, 0]);
  return rolls;
}
/** How much a cell's share of its region's mean error weighs against its own error. */
const GOLD_REGION_WEIGHT = 1;
/** Above this many values a roll's distribution is replaced by its mean: it no longer rounds visibly. */
const GOLD_EXACT_SUM_LIMIT = 400;

/** E[ceil(sum of rolls / shares)] of one pack, as the reward split pays it. */
function packGold(pack: Record<string, number>, shares: number, ranges: Record<string, [number, number]>): number {
  const entries = Object.entries(pack);
  const mean = entries.reduce((sum, [id, count]) => {
    const [lo, hi] = ranges[id] ?? [0, 0];
    return sum + (count * (lo + hi)) / 2;
  }, 0);
  if (mean > GOLD_EXACT_SUM_LIMIT) return mean / shares + 0.5;
  let dist = new Map<number, number>([[0, 1]]);
  for (const [id, count] of entries) {
    const [lo, hi] = ranges[id] ?? [0, 0];
    for (let i = 0; i < count; i++) {
      const next = new Map<number, number>();
      for (const [sum, p] of dist) {
        for (let roll = lo; roll <= hi; roll++) next.set(sum + roll, (next.get(sum + roll) ?? 0) + p / (hi - lo + 1));
      }
      dist = next;
    }
  }
  let expected = 0;
  for (const [sum, p] of dist) expected += p * Math.ceil(sum / shares);
  return expected;
}

function goldRate(cell: GoldCell, ranges: Record<string, [number, number]>, pauseSec: number): number {
  let gold = 0;
  let sec = 0;
  for (const s of cell.strata) {
    const perFight = s.packs.reduce((sum, pack) => sum + packGold(pack, cell.shares, ranges), 0) / s.packs.length;
    gold += s.share * perFight;
    sec += s.share * (s.sec + pauseSec);
  }
  return sec > 0 ? (gold / sec) * 3600 : 0;
}

function goldCellError(cell: GoldCell, ranges: Record<string, [number, number]>, pauseSec: number): number {
  const rate = goldRate(cell, ranges, pauseSec);
  return rate > 0 ? Math.log(rate / cell.target) : GOLD_ZERO_LOG_ERROR;
}

/**
 * Gold rolls are whole numbers and every member's share rounds up, so low-level rolls cannot be
 * scaled by a factor. Coordinate descent over each monster's roll, on the measured fight times.
 */
function fitGoldRanges(config: ReworkConfig, live: ContentSnapshot, reworked: ContentSnapshot, oldB: Baseline, cur: Baseline, sample: PackSampler): string[] {
  const curById = new Map(cur.cells.map(c => [c.id, c]));
  const cells: GoldCell[] = [];
  const packCache = new Map<string, Record<string, number>[]>();
  for (const o of oldB.cells) {
    if (o.kind !== 'zone' || !isMainCell(o) || !(o.comp in GOLD_SHARE_COMPS) || o.noReward || !o.goldPerHour) continue;
    const n = curById.get(o.id);
    if (!n?.strata?.length) continue;
    const strata = n.strata.map(s => {
      const key = `${s.encounterId}|${o.zoneId}`;
      if (!packCache.has(key)) packCache.set(key, sample(s.encounterId, o.zoneId));
      return { share: s.sharePct / 100, sec: s.medianSec ?? 0, packs: packCache.get(key)! };
    });
    const monsters = new Set(strata.flatMap(s => s.packs.flatMap(p => Object.keys(p))));
    cells.push({ key: o.id, regionId: o.regionId, shares: GOLD_SHARE_COMPS[o.comp], target: o.goldPerHour, strata, monsters });
  }
  const ranges: Record<string, [number, number]> = {};
  for (const cell of cells) {
    for (const id of cell.monsters) {
      const m = live.monsters[id];
      if (m && !ranges[id]) ranges[id] = [Math.round(m.goldMin * 0.45), Math.max(m.goldMax > 0 ? 1 : 0, Math.round(m.goldMax * 0.45))];
    }
  }
  const pause = cur.meta.pauseMs / 1000;
  const groups = new Map<string, GoldCell[]>();
  for (const c of cells) {
    const key = `${c.regionId}|${c.shares}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const groupError = (group: readonly GoldCell[]): number => {
    const made = group.reduce((sum, c) => sum + goldRate(c, ranges, pause), 0);
    const target = group.reduce((sum, c) => sum + c.target, 0);
    return made > 0 ? Math.log(made / target) : GOLD_ZERO_LOG_ERROR;
  };
  for (let pass = 0; pass < 3; pass++) {
    for (const id of Object.keys(ranges)) {
      const m = { ...live.monsters[id], tier: reworked.monsters[id]?.tier };
      if (!(m.goldMax > 0)) continue;
      const related = cells.filter(c => c.monsters.has(id));
      const relatedGroups = [...new Set(related.map(c => `${c.regionId}|${c.shares}`))].map(k => groups.get(k)!);
      const options = new Map<string, [number, number]>();
      for (const option of goldRollOptions(m)) options.set(option.join('-'), option);
      let best = ranges[id];
      let bestScore = Infinity;
      for (const option of options.values()) {
        ranges[id] = option;
        const score = related.reduce((sum, c) => sum + goldCellError(c, ranges, pause) ** 2, 0)
          + relatedGroups.reduce((sum, g) => sum + GOLD_REGION_WEIGHT * g.length * groupError(g) ** 2, 0);
        if (score < bestScore - 1e-9) {
          bestScore = score;
          best = option;
        }
      }
      ranges[id] = best;
    }
  }
  config.goldRanges = ranges;
  const errors = cells.map(c => Math.abs(goldCellError(c, ranges, pause)));
  return [`gold ranges: ${Object.keys(ranges).length} monsters; predicted cells within 15 %: ${errors.filter(e => e <= Math.log(1.15)).length}/${errors.length}`];
}

/** Moves each region's damage so that its median zone loses the target share of party HP. */
function fitDamage(config: ReworkConfig, oldB: Baseline, cur: Baseline, target: number, damp: number): string[] {
  const curById = new Map(cur.cells.map(c => [c.id, c]));
  const byRegion = new Map<string, number[]>();
  for (const o of oldB.cells) {
    if (o.kind !== 'zone' || !isMainCell(o) || o.comp !== 'K+P+M' || o.noReward) continue;
    const lost = curById.get(o.id)?.hpLostPct;
    if (lost == null) continue;
    byRegion.set(o.regionId, [...(byRegion.get(o.regionId) ?? []), lost]);
  }
  const report: string[] = [];
  config.damage.regions = config.damage.regions ?? {};
  for (const [regionId, values] of byRegion) {
    const m = median(values);
    const shift = Math.exp(damp * Math.log(target / Math.max(m, 1)));
    config.damage.regions[regionId] = Number(((config.damage.regions[regionId] ?? 1) * shift).toFixed(4));
    report.push(`damage region ${regionId}: median HP lost ${m} > x${config.damage.regions[regionId]}`);
  }
  return report;
}

export type FitMode = 'hp' | 'xp' | 'gold' | 'drop' | 'enrage' | 'damage';

export function fit(config: ReworkConfig, live: ContentSnapshot, reworked: ContentSnapshot, oldB: Baseline, cur: Baseline, modes: readonly FitMode[], opts: FitOptions & { enrageFactor: number; hpLostTarget: number; sample: PackSampler; trials: readonly TrialSweepRow[] }): string[] {
  const places = buildPlaces(live, oldB, cur);
  const report: string[] = [];
  if (modes.includes('hp')) report.push(...fitLength(config, places, opts));
  if (modes.includes('xp')) fitRate(config.xp, 'xpPerHour', places, opts);
  if (modes.includes('gold')) report.push(...fitGoldRanges(config, live, reworked, oldB, cur, opts.sample));
  if (modes.includes('damage')) report.push(...fitDamage(config, oldB, cur, opts.hpLostTarget, opts.damp));
  if (modes.includes('drop')) fitDrops(config, places, oldB, cur);
  if (modes.includes('enrage')) fitEnrage(config, places, reworked, opts.enrageFactor, opts.trials);
  return report;
}
