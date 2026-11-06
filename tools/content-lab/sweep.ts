import type { EngineAdapter } from './engines.js';
import type { Equipment } from './policy.js';
import { CLASS_SEATS, SOLO_SEAT, chooseLoadout, classSubsets, defaultSeats } from './policy.js';
import type { LabContext } from './sim.js';
import { PartyFactory, composeDungeonRuns, runCell } from './sim.js';
import type { Cell, CellResult, ClassName, CompositionSpec, ContentSnapshot } from './types.js';

export type SweepMode = 'subsets' | 'dungeons' | 'seats' | 'builds' | 'effects';

/** One member of a hand-specified party: what an authored trial tells its players to bring. */
export interface BuildMember {
  className: ClassName;
  seat?: number;
  /** Slot > item, on top of the region's shop gear. */
  equip?: Equipment;
  /** Skill slot index > skill id, on top of the default loadout. */
  skills?: Record<string, string | null>;
}

export interface BuildScenario {
  label: string;
  dungeonId: string;
  levels: number[];
  party: BuildMember[];
}

export interface ZoneSweepRow {
  zoneId: string;
  zoneName: string;
  regionIndex: number;
  level: number;
  comp: string;
  winPct: number;
  medianSec: number | null;
  hpLostPct: number | null;
  xpPerHour: number;
  stalematePct: number;
  noReward: boolean;
}

export interface TrialSweepRow {
  dungeonId: string;
  dungeonName: string;
  regionIndex: number;
  comp: string;
  level: number;
  minLevel: number;
  label?: string;
  /** Sequential floors, no regroups. */
  clearPct: number;
  medianRunSec: number | null;
  bossMedianSec: number | null;
  bossWinPct: number | null;
  floorWins: (number | null)[];
  floorSecs: (number | null)[];
  /** New engine only. */
  forecastPct?: number;
  firstTryPct?: number;
}

/** What a boss's enrage and a monster's skills are worth: the same fight with each switched off. */
export interface EffectSweepRow {
  monsterId: string;
  monsterName: string;
  place: string;
  regionIndex: number;
  level: number;
  comp: string;
  gear: string;
  variant: 'as authored' | 'no enrage' | 'no skills';
  winPct: number;
  medianSec: number | null;
  hpLostPct: number | null;
  deaths: number;
}

export interface SweepOptions {
  sims: number;
  forecastSims: number;
  scenarios: readonly BuildScenario[];
  /** Picks this job's share of the work. */
  mine: (key: string) => boolean;
}

function zoneBase(ctx: LabContext, zoneId: string, kind: Cell['kind']): Pick<Cell, 'kind' | 'regionId' | 'regionName' | 'regionIndex' | 'zoneId' | 'zoneName'> {
  const region = ctx.zoneRegion.get(zoneId)!;
  return { kind, regionId: region.id, regionName: region.name, regionIndex: region.index, zoneId, zoneName: ctx.content.zones[zoneId].displayName };
}

function tablePaysNoXp(content: ContentSnapshot, table: readonly { encounterId: string }[]): boolean {
  const monsters = table.flatMap(e => {
    const encounter = content.encounters[e.encounterId];
    return [...(encounter?.placements ?? []), ...(encounter?.monsterPool ?? [])].map((p: any) => content.monsters[p.monsterId]);
  });
  return monsters.length > 0 && monsters.every((m: any) => !m?.xp);
}

function zoneRow(ctx: LabContext, engine: EngineAdapter, parties: PartyFactory, zoneId: string, comp: string, sims: number, id: string): ZoneSweepRow {
  const zone = ctx.content.zones[zoneId];
  const table = zone.encounterTable ?? [];
  const level = Math.round((zone.levelRange[0] + zone.levelRange[1]) / 2);
  const cell: Cell = { ...zoneBase(ctx, zoneId, 'zone'), id: `${id}|${zoneId}|${comp}`, level, levelVariant: 'mid', gear: 'shop', comp, table, sims };
  const r: CellResult = runCell(ctx, engine, parties, cell).result;
  return {
    zoneId,
    zoneName: zone.displayName,
    regionIndex: cell.regionIndex,
    level,
    comp,
    winPct: r.winPct ?? 0,
    medianSec: r.medianSec ?? null,
    hpLostPct: r.hpLostPct ?? null,
    xpPerHour: r.xpPerHour ?? 0,
    stalematePct: r.stalematePct ?? 0,
    noReward: tablePaysNoXp(ctx.content, table),
  };
}

function populatedZones(ctx: LabContext): string[] {
  return ctx.regions.flatMap(r => r.zoneIds).filter(z => (ctx.content.zones[z].encounterTable ?? []).length > 0);
}

/** Every class combination in every zone: who a party without the textbook roles leaves behind. */
function sweepSubsets(ctx: LabContext, engine: EngineAdapter, opts: SweepOptions): ZoneSweepRow[] {
  const comps = classSubsets();
  const parties = new PartyFactory(ctx, engine, comps);
  return populatedZones(ctx).filter(opts.mine).flatMap(z => comps.map(c => zoneRow(ctx, engine, parties, z, c.id, opts.sims, 'subset')));
}

const SEAT_PARTIES: readonly CompositionSpec[] = (['Knight', 'Priest', 'Mage'] as const).map((leader): CompositionSpec => {
  const rest = (['Knight', 'Priest', 'Mage'] as const).filter(c => c !== leader);
  const humans: ClassName[] = [leader, ...rest];
  return { id: `${leader[0]}-leads`, humans, hires: false, seats: defaultSeats(humans.length) };
});

/** An unadjusted party on the seats the game hands out, with each class as the leader. */
function sweepSeats(ctx: LabContext, engine: EngineAdapter, opts: SweepOptions): ZoneSweepRow[] {
  const parties = new PartyFactory(ctx, engine, SEAT_PARTIES);
  return populatedZones(ctx).filter(opts.mine).flatMap(z => SEAT_PARTIES.map(c => zoneRow(ctx, engine, parties, z, c.id, opts.sims, 'seats')));
}

function dungeonFloors(ctx: LabContext, engine: EngineAdapter, parties: PartyFactory, dungeon: any, zoneId: string, comp: string, level: number, sims: number) {
  return dungeon.floors.map((floor: any, floorIndex: number) => runCell(ctx, engine, parties, {
    ...zoneBase(ctx, zoneId, 'floor'),
    id: `sweep|${dungeon.id}|${floorIndex}|${comp}|${level}`,
    level,
    levelVariant: 'mid',
    gear: 'shop',
    comp,
    table: floor.encounterTable ?? [],
    sims,
    dungeonId: dungeon.id,
    dungeonName: dungeon.name,
    floorIndex,
    floorCount: dungeon.floors.length,
    isBoss: !!floor.isBoss,
  }));
}

function trialRow(ctx: LabContext, engine: EngineAdapter, players: any[], floors: any[], dungeon: any, zoneId: string, comp: string, level: number, opts: SweepOptions, label?: string): TrialSweepRow {
  const run = composeDungeonRuns(ctx, engine, dungeon, comp, floors);
  const boss = floors[floors.length - 1].result;
  const row: TrialSweepRow = {
    dungeonId: dungeon.id,
    dungeonName: dungeon.name,
    regionIndex: ctx.zoneRegion.get(zoneId)!.index,
    comp,
    level,
    minLevel: dungeon.entryRequirements?.minLevel ?? 1,
    clearPct: run.clearPct ?? 0,
    medianRunSec: run.medianRunSec ?? null,
    bossMedianSec: boss.medianSec ?? null,
    bossWinPct: boss.winPct ?? null,
    floorWins: floors.map((f: any) => f.result.winPct ?? null),
    floorSecs: floors.map((f: any) => f.result.medianSec ?? null),
    ...(label ? { label } : {}),
  };
  if (engine.name === 'new') {
    const forecast = engine.module.runForecast(
      { kind: 'dungeon', players, dungeon, monsters: ctx.content.monsters, encounters: ctx.content.encounters, fallbackTable: ctx.content.zones[zoneId].encounterTable ?? [], pace: engine.module.COMBAT_PACE },
      { key: `${ctx.seed}|${dungeon.id}|${comp}|${level}`, maxSims: opts.forecastSims, minSims: opts.forecastSims },
    );
    row.forecastPct = forecast.winPct;
    row.firstTryPct = forecast.firstTryPct;
  }
  return row;
}

function placedDungeons(ctx: LabContext): { dungeon: any; zoneId: string; levels: number[] }[] {
  return Object.values<any>(ctx.content.dungeons).flatMap(dungeon => {
    const entrance = ctx.content.world.tiles.find(t => t.dungeonId === dungeon.id);
    if (!entrance || !ctx.zoneRegion.has(entrance.zone)) return [];
    const req = dungeon.entryRequirements ?? {};
    const [lo, hi] = ctx.content.zones[entrance.zone].levelRange;
    let mid = Math.round((lo + hi) / 2);
    if (req.minLevel !== undefined) mid = Math.max(mid, req.minLevel);
    if (req.maxLevel !== undefined) mid = Math.min(mid, req.maxLevel);
    return [{ dungeon, zoneId: entrance.zone, levels: [...new Set([req.minLevel ?? lo, mid])] }];
  });
}

/** Every class combination the door admits, at the entry level and at the zone's level. */
function sweepDungeons(ctx: LabContext, engine: EngineAdapter, opts: SweepOptions): TrialSweepRow[] {
  const comps = classSubsets();
  const parties = new PartyFactory(ctx, engine, comps);
  const rows: TrialSweepRow[] = [];
  for (const { dungeon, zoneId, levels } of placedDungeons(ctx)) {
    if (!opts.mine(dungeon.id)) continue;
    for (const level of levels) {
      for (const comp of comps) {
        const members = comp.humans.map((className, i) => ({ username: `${className}_${i}`, level, className, hasRequiredItem: true }));
        if (engine.module.validateDungeonEntry(dungeon, members, 'required item')) continue;
        const floors = dungeonFloors(ctx, engine, parties, dungeon, zoneId, comp.id, level, opts.sims);
        const { players } = parties.get({ regionId: ctx.zoneRegion.get(zoneId)!.id, level, gear: 'shop', comp: comp.id });
        rows.push(trialRow(ctx, engine, players, floors, dungeon, zoneId, comp.id, level, opts));
      }
    }
  }
  return rows;
}

function scenarioPlayers(ctx: LabContext, engine: EngineAdapter, scenario: BuildScenario, regionId: string, level: number): any[] {
  const taken = new Set<number>();
  return scenario.party.map((m, i) => {
    const seat = m.seat ?? (scenario.party.length === 1 ? SOLO_SEAT : [...CLASS_SEATS[m.className], 0, 1, 2, 3, 4, 5, 6, 7, 8].find(s => !taken.has(s))!);
    taken.add(seat);
    const skillIds = chooseLoadout(ctx.content, m.className, level);
    for (const [slot, id] of Object.entries(m.skills ?? {})) skillIds[Number(slot)] = id;
    return engine.buildHuman({
      className: m.className,
      username: `${m.className}_${i}`,
      gridPosition: seat,
      level,
      equipment: { ...ctx.gear.get(regionId)![m.className], ...m.equip },
      skillIds,
    }, ctx.content);
  });
}

/** Hand-written builds (grant items, swapped skills, chosen seats); one fight table per floor, no shared party factory. */
function sweepBuilds(ctx: LabContext, engine: EngineAdapter, opts: SweepOptions): TrialSweepRow[] {
  const rows: TrialSweepRow[] = [];
  for (const scenario of opts.scenarios) {
    if (!opts.mine(scenario.label)) continue;
    const dungeon = ctx.content.dungeons[scenario.dungeonId];
    const entrance = ctx.content.world.tiles.find(t => t.dungeonId === scenario.dungeonId);
    if (!dungeon || !entrance) continue;
    const region = ctx.zoneRegion.get(entrance.zone)!;
    for (const level of scenario.levels) {
      const players = scenarioPlayers(ctx, engine, scenario, region.id, level);
      const fixed = { get: () => ({ players, humanCount: players.length, hireCount: 0, xpMultiplier: 1, hires: [] as string[] }) } as unknown as PartyFactory;
      const floors = dungeonFloors(ctx, engine, fixed, dungeon, entrance.zone, scenario.label, level, opts.sims);
      rows.push(trialRow(ctx, engine, players, floors, dungeon, entrance.zone, scenario.label, level, opts, scenario.label));
    }
  }
  return rows;
}

const EFFECT_PARTIES: readonly { comp: string; gear: Cell['gear'] }[] = [
  { comp: 'K+P', gear: 'shop' },
  { comp: 'K+P+M', gear: 'shop' },
  { comp: 'K+P+M', gear: 'ungeared' },
  { comp: 'K+A+P+M+B', gear: 'shop' },
];
const NO_ENRAGE_SECONDS = 86400;

interface EffectFight {
  monsterId: string;
  place: string;
  zoneId: string;
  level: number;
  table: readonly { encounterId: string; weight: number }[];
}

/** Boss floors and room capstones that field a boss or carry a telegraphed or healing monster skill. */
function effectFights(ctx: LabContext): EffectFight[] {
  const { content } = ctx;
  const interesting = (id: string): boolean => {
    const m = content.monsters[id];
    return !!m && !m.passive && (m.tier === 'boss' || m.tier === 'raid');
  };
  const idsOf = (table: readonly { encounterId: string }[]): string[] => table.flatMap(e => {
    const encounter = content.encounters[e.encounterId];
    return [...(encounter?.placements ?? []), ...(encounter?.monsterPool ?? [])].map((p: any) => p.monsterId as string);
  });
  const fights: EffectFight[] = [];
  for (const { dungeon, zoneId, levels } of placedDungeons(ctx)) {
    for (const floor of dungeon.floors) {
      const boss = idsOf(floor.encounterTable ?? []).find(interesting);
      if (floor.isBoss && boss) fights.push({ monsterId: boss, place: dungeon.name, zoneId, level: levels[levels.length - 1], table: floor.encounterTable });
    }
  }
  const seen = new Set<string>();
  for (const tile of content.world.tiles) {
    const boss = idsOf(tile.encounterTable ?? []).find(interesting);
    if (!boss || seen.has(boss) || !ctx.zoneRegion.has(tile.zone)) continue;
    seen.add(boss);
    const [lo, hi] = content.zones[tile.zone].levelRange;
    fights.push({ monsterId: boss, place: tile.name ?? content.zones[tile.zone].displayName, zoneId: tile.zone, level: Math.round((lo + hi) / 2), table: tile.encounterTable! });
  }
  return fights;
}

function withoutEnrage(content: ContentSnapshot): ContentSnapshot {
  const monsters = Object.fromEntries(Object.entries(content.monsters).map(([id, m]) => [id, m.tier === 'boss' || m.tier === 'raid' ? { ...m, enrage: { afterSeconds: NO_ENRAGE_SECONDS } } : m]));
  return { ...content, monsters };
}

function withoutSkills(content: ContentSnapshot): ContentSnapshot {
  const monsters = Object.fromEntries(Object.entries(content.monsters).map(([id, m]) => [id, { ...m, skills: [] }]));
  return { ...content, monsters };
}

function sweepEffects(ctx: LabContext, engine: EngineAdapter, opts: SweepOptions): EffectSweepRow[] {
  const rows: EffectSweepRow[] = [];
  const variants: [EffectSweepRow['variant'], ContentSnapshot][] = [
    ['as authored', ctx.content],
    ['no enrage', withoutEnrage(ctx.content)],
    ['no skills', withoutSkills(ctx.content)],
  ];
  for (const fight of effectFights(ctx)) {
    if (!opts.mine(`${fight.place}|${fight.monsterId}`)) continue;
    const region = ctx.zoneRegion.get(fight.zoneId)!;
    for (const { comp, gear } of EFFECT_PARTIES) {
      for (const [variant, content] of variants) {
        const variantCtx = { ...ctx, content };
        const parties = new PartyFactory(variantCtx, engine);
        const cell: Cell = { ...zoneBase(ctx, fight.zoneId, 'floor'), id: `effects|${fight.place}|${fight.monsterId}|${comp}|${gear}|${variant}`, level: fight.level, levelVariant: 'mid', gear, comp, table: [...fight.table], sims: opts.sims };
        const r = runCell(variantCtx, engine, parties, cell).result;
        rows.push({ monsterId: fight.monsterId, monsterName: content.monsters[fight.monsterId].name, place: fight.place, regionIndex: region.index, level: fight.level, comp, gear, variant, winPct: r.winPct ?? 0, medianSec: r.medianSec ?? null, hpLostPct: r.hpLostPct ?? null, deaths: r.deaths ?? 0 });
      }
    }
  }
  return rows;
}

export function runSweep(mode: SweepMode, ctx: LabContext, engine: EngineAdapter, opts: SweepOptions): (ZoneSweepRow | TrialSweepRow | EffectSweepRow)[] {
  if (mode === 'effects') return sweepEffects(ctx, engine, opts);
  if (mode === 'subsets') return sweepSubsets(ctx, engine, opts);
  if (mode === 'seats') return sweepSeats(ctx, engine, opts);
  if (mode === 'dungeons') return sweepDungeons(ctx, engine, opts);
  return sweepBuilds(ctx, engine, opts);
}

export const SWEEP_SIMS = 40;
export const SWEEP_FORECAST_SIMS = 40;
