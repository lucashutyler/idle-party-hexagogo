import type { Combatant, EngineAdapter, Rng } from './engines.js';
import type { Equipment, Region } from './policy.js';
import { COMPOSITIONS, CORE_COMPOSITIONS, chooseHires, chooseLoadout, humanSeats, xpMultiplier } from './policy.js';
import type { Cell, CellMetrics, CellResult, ClassName, CompositionSpec, ContentSnapshot, DungeonRunResult, EncounterEntry, FightEnd, StratumResult } from './types.js';

export interface LabContext {
  content: ContentSnapshot;
  regions: Region[];
  zoneRegion: Map<string, Region>;
  gear: Map<string, Record<ClassName, Equipment>>;
  seed: number;
  n: number;
  variantN: number;
}

/** 32-bit FNV-1a; cell, entry and sim index pick the stream, so results don't depend on sharding. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32, the generator behind the engine's createRng; the old engine has no seeded generator of its own. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function midLevel(range: [number, number]): number {
  return Math.round((range[0] + range[1]) / 2);
}

function tablePaysNoXp(content: ContentSnapshot, table: readonly EncounterEntry[]): boolean {
  if (table.length === 0) return false;
  const monsters = table.flatMap(entry => {
    const encounter = content.encounters[entry.encounterId];
    return [...(encounter?.placements ?? []), ...(encounter?.monsterPool ?? [])].map((p: any) => content.monsters[p.monsterId]);
  });
  return monsters.length > 0 && monsters.every((m: any) => !m?.xp);
}

function dungeonEligibility(mod: any, dungeon: any, comp: CompositionSpec, level: number): string | undefined {
  if (comp.hires) return 'hires wait at the dungeon entrance';
  const members = comp.humans.map((className, i) => ({ username: `${className}_${i}`, level, className, hasRequiredItem: true }));
  return mod.validateDungeonEntry(dungeon, members, 'required item') ?? undefined;
}

export function buildCells(ctx: LabContext, mod: any, log: string[]): Cell[] {
  const { content } = ctx;
  const cells: Cell[] = [];
  const base = (zoneId: string, kind: Cell['kind']): Pick<Cell, 'kind' | 'regionId' | 'regionName' | 'regionIndex' | 'zoneId' | 'zoneName'> => {
    const region = ctx.zoneRegion.get(zoneId)!;
    return { kind, regionId: region.id, regionName: region.name, regionIndex: region.index, zoneId, zoneName: content.zones[zoneId].displayName };
  };

  for (const region of ctx.regions) {
    for (const zoneId of region.zoneIds) {
      const zone = content.zones[zoneId];
      const table = zone.encounterTable ?? [];
      const noReward = tablePaysNoXp(content, table);
      if (table.length === 0) log.push(`zone ${zoneId}: empty encounter table, simulated with the engine's fallback pack`);
      const [lo, hi] = zone.levelRange;
      const mid = midLevel(zone.levelRange);
      for (const comp of COMPOSITIONS) {
        cells.push({ ...base(zoneId, 'zone'), id: `zone|${zoneId}|${comp.id}|mid|shop`, level: mid, levelVariant: 'mid', gear: 'shop', comp: comp.id, table, sims: ctx.n, noReward });
      }
      const variants = [
        { level: lo, levelVariant: 'low', gear: 'shop' },
        { level: hi, levelVariant: 'high', gear: 'shop' },
        { level: mid, levelVariant: 'mid', gear: 'ungeared' },
      ] as const;
      for (const comp of CORE_COMPOSITIONS) {
        for (const v of variants) {
          cells.push({ ...base(zoneId, 'zone'), id: `zone|${zoneId}|${comp.id}|${v.levelVariant}|${v.gear}`, comp: comp.id, table, sims: ctx.variantN, noReward, ...v });
        }
      }
    }
  }

  const overrideGroups = new Map<string, { zoneId: string; table: EncounterEntry[]; tileIds: string[] }>();
  for (const t of content.world.tiles) {
    if (!t.encounterTable?.length) continue;
    const key = `${t.zone}|${JSON.stringify(t.encounterTable)}`;
    const group = overrideGroups.get(key) ?? { zoneId: t.zone, table: t.encounterTable, tileIds: [] };
    group.tileIds.push(t.id);
    overrideGroups.set(key, group);
  }
  for (const group of overrideGroups.values()) {
    if (!ctx.zoneRegion.has(group.zoneId)) continue;
    for (const comp of COMPOSITIONS) {
      cells.push({
        ...base(group.zoneId, 'room'),
        id: `room|${group.tileIds[0]}|${comp.id}`,
        level: midLevel(content.zones[group.zoneId].levelRange),
        levelVariant: 'mid',
        gear: 'shop',
        comp: comp.id,
        table: group.table,
        sims: ctx.n,
        noReward: tablePaysNoXp(content, group.table),
        tileIds: group.tileIds,
      });
    }
  }

  for (const dungeon of Object.values(content.dungeons)) {
    const entrance = content.world.tiles.find(t => t.dungeonId === dungeon.id);
    if (!entrance || !ctx.zoneRegion.has(entrance.zone)) {
      log.push(`dungeon ${dungeon.id}: no placed entrance, skipped`);
      continue;
    }
    const req = dungeon.entryRequirements ?? {};
    let level = midLevel(content.zones[entrance.zone].levelRange);
    if (req.minLevel !== undefined) level = Math.max(level, req.minLevel);
    if (req.maxLevel !== undefined) level = Math.min(level, req.maxLevel);
    (dungeon.floors ?? []).forEach((floor: any, floorIndex: number) => {
      for (const comp of COMPOSITIONS) {
        cells.push({
          ...base(entrance.zone, 'floor'),
          id: `floor|${dungeon.id}|${floorIndex}|${comp.id}`,
          level,
          levelVariant: 'mid',
          gear: 'shop',
          comp: comp.id,
          table: floor.encounterTable ?? [],
          sims: ctx.n,
          dungeonId: dungeon.id,
          dungeonName: dungeon.name,
          floorIndex,
          floorCount: dungeon.floors.length,
          isBoss: !!floor.isBoss,
          ineligible: dungeonEligibility(mod, dungeon, comp, level),
        });
      }
    });
  }
  return cells;
}

interface Party {
  players: Combatant[];
  humanCount: number;
  hireCount: number;
  xpMultiplier: number;
  hires: string[];
}

export class PartyFactory {
  private readonly cache = new Map<string, Party>();

  constructor(private readonly ctx: LabContext, private readonly engine: EngineAdapter, private readonly extraComps: readonly CompositionSpec[] = []) {}

  get(cell: Pick<Cell, 'regionId' | 'level' | 'gear' | 'comp'>): Party {
    const key = `${cell.regionId}|${cell.level}|${cell.gear}|${cell.comp}`;
    let party = this.cache.get(key);
    if (!party) {
      party = this.build(cell);
      this.cache.set(key, party);
    }
    return party;
  }

  private build(cell: Pick<Cell, 'regionId' | 'level' | 'gear' | 'comp'>): Party {
    const { content } = this.ctx;
    const comp = [...this.extraComps, ...COMPOSITIONS].find(c => c.id === cell.comp)!;
    const region = this.ctx.regions.find(r => r.id === cell.regionId)!;
    const skillIds: (string | null)[] = [];
    const players = humanSeats(comp.humans, comp.hires, comp.seats).map(spec => {
      const loadout = chooseLoadout(content, spec.className, cell.level);
      skillIds.push(...loadout);
      const equipment = cell.gear === 'shop' ? this.ctx.gear.get(region.id)![spec.className] : {};
      return this.engine.buildHuman({ ...spec, level: cell.level, equipment, skillIds: loadout }, content);
    });
    const hires = comp.hires ? chooseHires(content, region, comp.humans[0], cell.level, players[0].gridPosition) : [];
    const reserved = new Set(players.map(p => p.username));
    for (const hire of hires) {
      const def = content.henchmen[hire.henchmanId];
      let name = def.name;
      for (let i = 2; reserved.has(name); i++) name = `${def.name} #${i}`;
      reserved.add(name);
      players.push(this.engine.buildHire(hire, def, content, name));
      skillIds.push(...def.skillIds);
    }
    return { players, humanCount: comp.humans.length, hireCount: hires.length, xpMultiplier: xpMultiplier(skillIds, content.skills), hires: hires.map(h => h.henchmanId) };
  }
}

interface WeightedFight {
  end: FightEnd;
  weight: number;
}

function weightedQuantile(items: readonly { value: number; weight: number }[], q: number): number {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  let cum = 0;
  for (const item of sorted) {
    cum += item.weight;
    if (cum >= q * total - 1e-12) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function metricsOf(fights: readonly WeightedFight[], pauseMs: number): CellMetrics {
  let total = 0;
  let wins = 0;
  let losses = 0;
  let stalemates = 0;
  let timeMs = 0;
  let xp = 0;
  let gold = 0;
  let deaths = 0;
  let hpLost = 0;
  const winTimes: { value: number; weight: number }[] = [];
  for (const { end, weight } of fights) {
    total += weight;
    timeMs += weight * (end.ms + pauseMs);
    deaths += weight * end.dead;
    if (end.result === 'victory') {
      wins += weight;
      xp += weight * end.xpPerMember;
      gold += weight * end.goldPerMember;
      hpLost += weight * end.hpLostFrac;
      winTimes.push({ value: end.ms, weight });
    } else if (end.result === 'defeat') {
      losses += weight;
    } else {
      stalemates += weight;
    }
  }
  const hasWins = winTimes.length > 0;
  return {
    sims: fights.length,
    winPct: round((100 * wins) / total),
    lossPct: round((100 * losses) / total),
    stalematePct: round((100 * stalemates) / total),
    medianSec: hasWins ? round(weightedQuantile(winTimes, 0.5) / 1000) : null,
    p90Sec: hasWins ? round(weightedQuantile(winTimes, 0.9) / 1000) : null,
    hpLostPct: hasWins ? round((100 * hpLost) / wins) : null,
    deaths: round(deaths / total, 2),
    xpPerHour: Math.round((xp / timeMs) * 3_600_000),
    goldPerHour: Math.round((gold / timeMs) * 3_600_000),
  };
}

function strataOf(table: readonly EncounterEntry[]): { entry: EncounterEntry | null; share: number }[] {
  const weights = new Map<string, number>();
  for (const e of table) {
    if (e.weight > 0) weights.set(e.encounterId, (weights.get(e.encounterId) ?? 0) + e.weight);
  }
  if (weights.size === 0) return [{ entry: table[0] ?? null, share: 1 }];
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  return [...weights].map(([encounterId, weight]) => ({ entry: { encounterId, weight: 1 }, share: weight / total }));
}

export interface CellRun {
  result: CellResult;
  fights: WeightedFight[];
}

export function runCell(ctx: LabContext, engine: EngineAdapter, parties: PartyFactory, cell: Cell): CellRun {
  const { table: _table, sims: _sims, ...rest } = cell;
  if (cell.ineligible) return { result: rest, fights: [] };
  const party = parties.get(cell);
  if (cell.comp.includes('hires') && party.hireCount === 0) {
    return { result: { ...rest, ineligible: 'no hires offered on this map' }, fights: [] };
  }
  const fights: WeightedFight[] = [];
  const strata: StratumResult[] = [];
  for (const { entry, share } of strataOf(cell.table)) {
    const sims = Math.max(3, Math.round(cell.sims * share));
    const key = entry?.encounterId ?? '';
    const local: FightEnd[] = [];
    for (let i = 0; i < sims; i++) {
      const end = engine.fight({
        players: party.players,
        table: entry ? [entry] : [],
        zoneId: cell.zoneId,
        content: ctx.content,
        xpMultiplier: party.xpMultiplier,
        humanCount: party.humanCount,
        hireCount: party.hireCount,
        memberLevel: cell.level,
        rng: makeRng(hashSeed(`${ctx.seed}|${cell.id}|${key}|${i}`)),
      });
      local.push(end);
      fights.push({ end, weight: share / sims });
    }
    const m = metricsOf(local.map(end => ({ end, weight: 1 })), engine.pauseMs);
    strata.push({ encounterId: key, sharePct: round(share * 100), sims, winPct: m.winPct, medianSec: m.medianSec });
  }
  return {
    result: { ...rest, ...metricsOf(fights, engine.pauseMs), strata, ...(party.hires.length ? { hires: party.hires } : {}) },
    fights,
  };
}

/** Floor fights are independent (HP resets), so a run resamples each floor's fights in order until one is lost. */
export function composeDungeonRuns(ctx: LabContext, engine: EngineAdapter, dungeon: any, comp: string, floors: readonly CellRun[]): DungeonRunResult {
  const first = floors[0].result;
  const base = {
    dungeonId: dungeon.id,
    dungeonName: dungeon.name,
    regionId: first.regionId,
    regionName: first.regionName,
    regionIndex: first.regionIndex,
    level: first.level,
    comp,
  };
  if (first.ineligible) return { ...base, ineligible: first.ineligible };
  const rng = makeRng(hashSeed(`${ctx.seed}|dungeon|${dungeon.id}|${comp}`));
  const pick = (fights: readonly WeightedFight[]): FightEnd => {
    let roll = rng();
    for (const f of fights) {
      roll -= f.weight;
      if (roll <= 0) return f.end;
    }
    return fights[fights.length - 1].end;
  };
  const runs = ctx.n * 5;
  let clears = 0;
  let timeMs = 0;
  let xp = 0;
  let gold = 0;
  let deaths = 0;
  const clearTimes: number[] = [];
  for (let i = 0; i < runs; i++) {
    let runMs = 0;
    let cleared = true;
    for (const floor of floors) {
      const end = pick(floor.fights);
      runMs += end.ms + engine.pauseMs;
      deaths += end.dead;
      if (end.result !== 'victory') {
        cleared = false;
        break;
      }
      xp += end.xpPerMember;
      gold += end.goldPerMember;
    }
    timeMs += runMs;
    if (cleared) {
      clears++;
      clearTimes.push(runMs);
    }
  }
  clearTimes.sort((a, b) => a - b);
  return {
    ...base,
    runs,
    clearPct: round((100 * clears) / runs),
    medianRunSec: clearTimes.length ? round(clearTimes[Math.floor((clearTimes.length - 1) / 2)] / 1000) : null,
    xpPerHour: Math.round((xp / timeMs) * 3_600_000),
    goldPerHour: Math.round((gold / timeMs) * 3_600_000),
    meanDeaths: round(deaths / runs, 2),
  };
}
