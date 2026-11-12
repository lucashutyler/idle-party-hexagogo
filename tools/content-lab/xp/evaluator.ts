import { FightGold, roundCellGold } from './gold.js';
import { xpRulesOf } from './plan.js';
import type { FightView, HireView, MemberView, MonsterGroup, MonsterInfo, PartyView, PayoutContext, XpPlan } from './plan.js';
import { forEachRow } from './rows.js';
import { FALLBACK_ENCOUNTER, RESULT_NAMES, RESULT_DEFEAT, RESULT_STALEMATE, RESULT_TIMEOUT, RESULT_VICTORY } from './types.js';
import type { AtlasMeta, BossSplit, CellGold, CellRate, FightRow, XpCell, XpSnapshot } from './types.js';

/** Three skips in ten fights end a stay in the room, so from here on the skip rate isn't one a party can keep up. */
const RELOCATE_SKIP_SHARE = 0.1;

interface StratumTally {
  encounter: number;
  fights: number;
  wins: number;
  winsInHorizon: number;
  pastHorizon: number;
  defeats: number;
  stalemates: number;
  timeouts: number;
  ms: number;
  winMs: number;
  damage: number;
  minHp: number;
  deaths: number;
  kills: number;
  xp: Float64Array;
  gold: GoldTally;
  atlasGold?: GoldTally;
}

interface GoldTally {
  coin: number;
  drops: Float64Array;
}

/** A cell's gold, summed across its strata. */
class GoldSum {
  coin = 0;
  retreatCoin = 0;
  bossCoin = 0;
  restCoin = 0;
  readonly drops: Float64Array;
  readonly retreatDrops: Float64Array;

  constructor(members: number) {
    this.drops = new Float64Array(members);
    this.retreatDrops = new Float64Array(members);
  }

  add(tally: GoldTally, fights: number, share: number, skipped: boolean, boss: boolean): void {
    for (let m = 0; m < this.drops.length; m++) {
      const sold = (share * tally.drops[m]) / fights;
      this.drops[m] += sold;
      if (!skipped) this.retreatDrops[m] += sold;
    }
    const paid = (share * tally.coin) / fights;
    this.coin += paid;
    if (!skipped) this.retreatCoin += paid;
    if (boss) this.bossCoin += paid;
    else this.restCoin += paid;
  }
}

export interface EvaluatorEnv {
  meta: AtlasMeta;
  cells: readonly XpCell[];
  content: XpSnapshot;
  plan: XpPlan;
  /** What the plan's prepare returned, after a JSON round trip. */
  state?: unknown;
  mod: any;
  /** The atlas's own content, when `content` is a plan's retune of it: gold is read off both. */
  atlasContent?: XpSnapshot;
}

/** Evaluates one row file, emitting a rate per complete cell. With `maxRows`, stops there and leaves out the cell it stopped inside. */
export type EvaluateFile = (file: string, emit: (rate: CellRate) => void, maxRows?: number) => void;

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** `createMonsterInstance`'s level, HP, damage and skills, which the XP rules read. */
export function monsterInfoOf(mod: any, id: string, def: any): MonsterInfo {
  const instance = mod.createMonsterInstance(def);
  return {
    id,
    xp: def.xp,
    hp: def.hp,
    maxHp: instance.maxHp,
    damage: instance.damage,
    level: instance.level,
    levelSource: instance.levelSource,
    authored: instance.levelSource === 'authored',
    tier: mod.effectiveMonsterTier(def),
    passive: !!def.passive,
    ...(instance.skills ? { skills: instance.skills } : {}),
  };
}

export function createEvaluator(env: EvaluatorEnv): EvaluateFile {
  const { meta, cells, content, plan, state, mod, atlasContent } = env;
  const monsterInfo: MonsterInfo[] = meta.monsters.map(id => monsterInfoOf(mod, id, content.monsters[id]));
  const rules = xpRulesOf(mod);
  const encounterIndex = new Map(meta.encounters.map((id, i) => [id, i]));
  const gold = new FightGold(meta.monsters, content, mod, meta.rewardMultiplier);
  const atlasGold = atlasContent ? new FightGold(meta.monsters, atlasContent, mod, meta.rewardMultiplier) : undefined;
  const groupPool: MonsterGroup[] = [];
  const view: FightView = { result: 'victory', won: false, realMs: 0, partyDamage: 0, minHpFrac: 1, deaths: 0, pastHorizon: false, encounterId: null, monsters: [] };

  const contextOf = (cell: XpCell): { ctx: PayoutContext; members: MemberView[] } => {
    const comp = meta.comps[cell.comp];
    const members: MemberView[] = comp.members.map((m, index) => ({ index, className: m.className, level: cell.level + m.levelOffset, role: m.role }));
    const hireDetails: HireView[] = cell.hires.map(id => ({ id, className: content.henchmen[id]?.className, level: content.henchmen[id]?.level ?? 0 }));
    const party: PartyView = { compId: comp.id, family: comp.family, members, hires: cell.hires, hireDetails, shareCount: members.length + cell.hires.length, xpMultiplier: cell.xpMult };
    return {
      members,
      ctx: {
        party,
        table: meta.tables[cell.table],
        rewardMultiplier: meta.rewardMultiplier,
        pauseMs: meta.pauseMs,
        params: plan.params ?? {},
        state,
        rules,
      },
    };
  };

  const pay = (member: MemberView, ctx: PayoutContext): number => {
    const xp = plan.payout(view, member, ctx);
    if (typeof xp !== 'number' || !Number.isFinite(xp) || xp < 0) {
      throw new Error(`plan ${plan.id} paid ${String(xp)} to ${member.className} L${member.level} of ${ctx.party.compId} at ${ctx.table.label} after a ${view.result}: payout must return a finite number, zero or more`);
    }
    return xp;
  };

  const finishCell = (cell: XpCell, members: MemberView[], tallies: Map<number, StratumTally>): CellRate => {
    const table = meta.tables[cell.table];
    const forecastSims: number = mod.FORECAST_SIM_BUDGET[table.boss ? 'boss' : 'trash'];
    let win = 0;
    let fwin = 0;
    let hz = 0;
    let loss = 0;
    let stale = 0;
    let to = 0;
    let ms = 0;
    let winMsWeight = 0;
    let winMs = 0;
    let hp = 0;
    let deaths = 0;
    let kills = 0;
    let dmg = 0;
    let skip = 0;
    let fights = 0;
    let rawTime = 0;
    let retreatTime = 0;
    let retreatKills = 0;
    const xpf = new Float64Array(members.length);
    const retreatXp = new Float64Array(members.length);
    const goldSum = new GoldSum(members.length);
    const atlasSum = atlasGold ? new GoldSum(members.length) : undefined;
    const strata: CellRate['st'] = [];
    const bossSide = { share: 0, ms: 0, win: 0, xpf: new Float64Array(members.length) };
    const restSide = { share: 0, ms: 0, xpf: new Float64Array(members.length) };
    for (const stratum of table.strata) {
      const encounter = stratum.encounterId === null ? FALLBACK_ENCOUNTER : encounterIndex.get(stratum.encounterId)!;
      const t = tallies.get(encounter);
      if (!t) continue;
      const share = stratum.share;
      const winRate = t.wins / t.fights;
      const forecastRate = t.winsInHorizon / t.fights;
      const meanMs = t.ms / t.fights;
      fights += t.fights;
      win += share * winRate;
      fwin += share * forecastRate;
      hz += (share * t.pastHorizon) / t.fights;
      loss += (share * t.defeats) / t.fights;
      stale += (share * t.stalemates) / t.fights;
      to += (share * t.timeouts) / t.fights;
      ms += share * meanMs;
      if (t.wins > 0) {
        winMs += (share * t.winMs) / t.wins;
        winMsWeight += share;
      }
      hp += (share * t.minHp) / t.fights;
      deaths += (share * t.deaths) / t.fights;
      kills += (share * t.kills) / t.fights;
      dmg += (share * t.damage) / t.fights;
      rawTime += share * (meanMs + meta.pauseMs);
      const forecastN = Math.max(1, Math.floor(share * forecastSims));
      const skipped = table.kind === 'room' && mod.wilsonInterval(forecastRate, forecastN)[1] * 100 < meta.autoRetreatBelowPct;
      if (skipped) skip += share;
      retreatTime += share * (skipped ? meta.retreatMs : meanMs + meta.pauseMs);
      if (!skipped) retreatKills += (share * t.kills) / t.fights;
      const side = stratum.boss ? bossSide : restSide;
      side.share += share;
      side.ms += share * meanMs;
      if (stratum.boss) bossSide.win += share * winRate;
      for (let m = 0; m < members.length; m++) {
        const each = (share * t.xp[m]) / t.fights;
        xpf[m] += each;
        side.xpf[m] += each;
        if (!skipped) retreatXp[m] += each;
      }
      goldSum.add(t.gold, t.fights, share, skipped, stratum.boss);
      atlasSum?.add(t.atlasGold!, t.fights, share, skipped, stratum.boss);
      strata.push([encounter, round(share, 4), t.fights, round(winRate * 100, 1), Math.round(meanMs)]);
    }
    const skipsLast = skip < RELOCATE_SKIP_SHARE;
    const perSide = (values: Float64Array, share: number): number[] => [...values].map(x => round(share > 0 ? x / share : 0, 2));
    const bossSplit: BossSplit | undefined = table.kind === 'room' && table.boss && bossSide.share > 0 ? {
      share: round(bossSide.share, 4),
      ms: Math.round(bossSide.ms / bossSide.share),
      win: round(bossSide.win / bossSide.share, 4),
      xpf: perSide(bossSide.xpf, bossSide.share),
      restMs: restSide.share > 0 ? Math.round(restSide.ms / restSide.share) : 0,
      restXpf: perSide(restSide.xpf, restSide.share),
    } : undefined;
    const rawRates = [...xpf].map(x => round((x / rawTime) * 3_600_000, 1));
    const perHour = (raw: number, retreat: number): number => (skipsLast ? retreat / retreatTime : raw / rawTime) * 3_600_000;
    const bossCoinOf = (sum: GoldSum): CellGold['bs'] => (bossSplit ? { coin: sum.bossCoin / bossSide.share, rest: restSide.share > 0 ? sum.restCoin / restSide.share : 0 } : undefined);
    const bossGold = bossCoinOf(goldSum);
    const atlasBossGold = atlasSum && bossCoinOf(atlasSum);
    return {
      c: cell.id,
      n: fights,
      win: round(win * 100, 1),
      loss: round(loss * 100, 1),
      stale: round(stale * 100, 1),
      to: round(to * 100, 1),
      hz: round(hz * 100, 1),
      fwin: round(fwin * 100, 1),
      ms: Math.round(ms),
      winMs: winMsWeight > 0 ? Math.round(winMs / winMsWeight) : null,
      hp: round(hp, 3),
      deaths: round(deaths, 2),
      kills: round(kills, 2),
      dmg: Math.round(dmg),
      kph: Math.round((skipsLast ? retreatKills / retreatTime : kills / rawTime) * 3_600_000),
      skip: round(skip, 3),
      reloc: table.kind === 'room' && mod.wilsonInterval(fwin, forecastSims)[1] * 100 < meta.autoRetreatBelowPct ? 1 : 0,
      xp: skipsLast ? [...retreatXp].map(x => round((x / retreatTime) * 3_600_000, 1)) : rawRates,
      raw: rawRates,
      xpf: [...xpf].map(x => round(x, 2)),
      st: strata,
      ...(bossSplit ? { bs: bossSplit } : {}),
      g: roundCellGold({
        cf: goldSum.coin,
        ch: perHour(goldSum.coin, goldSum.retreatCoin),
        cr: (goldSum.coin / rawTime) * 3_600_000,
        df: [...goldSum.drops],
        dh: [...goldSum.drops].map((x, m) => perHour(x, goldSum.retreatDrops[m])),
        ...(bossGold ? { bs: bossGold } : {}),
        ...(atlasSum ? { atlas: { ch: perHour(atlasSum.coin, atlasSum.retreatCoin), df: [...atlasSum.drops], ...(atlasBossGold ? { bs: atlasBossGold } : {}) } } : {}),
      }),
    };
  };

  return (file, emit, maxRows) => {
    let current: XpCell | null = null;
    let context: { ctx: PayoutContext; members: MemberView[] } | null = null;
    let tallies = new Map<number, StratumTally>();
    let seen = 0;
    let stopped = false;
    forEachRow(file, (row: FightRow) => {
      if (maxRows !== undefined && seen >= maxRows) {
        stopped = true;
        return false;
      }
      seen++;
      if (!current || current.id !== row.cell) {
        if (current && context) emit(finishCell(current, context.members, tallies));
        current = cells[row.cell];
        context = contextOf(current);
        tallies = new Map();
      }
      const { ctx, members } = context!;
      const coinFactor = ctx.table.kind === 'floor' ? rules.floorPayFactor(ctx.table.floorCoinFactor) : 1;
      let tally = tallies.get(row.encounter);
      if (!tally) {
        tally = { encounter: row.encounter, fights: 0, wins: 0, winsInHorizon: 0, pastHorizon: 0, defeats: 0, stalemates: 0, timeouts: 0, ms: 0, winMs: 0, damage: 0, minHp: 0, deaths: 0, kills: 0, xp: new Float64Array(members.length), gold: { coin: 0, drops: new Float64Array(members.length) }, ...(atlasGold ? { atlasGold: { coin: 0, drops: new Float64Array(members.length) } } : {}) };
        tallies.set(row.encounter, tally);
      }
      const groupCount = row.groups.length / 3;
      const groups: MonsterGroup[] = [];
      let killsHere = 0;
      for (let g = 0; g < groupCount; g++) {
        const entry = groupPool[g] ?? (groupPool[g] = { def: monsterInfo[0], killed: 0, standing: 0 });
        entry.def = monsterInfo[row.groups[g * 3]];
        entry.killed = row.groups[g * 3 + 1];
        entry.standing = row.groups[g * 3 + 2];
        if (!entry.def.passive) killsHere += entry.killed;
        groups.push(entry);
      }
      view.result = RESULT_NAMES[row.result];
      view.won = row.result === RESULT_VICTORY;
      view.realMs = row.realMs;
      view.partyDamage = row.damage;
      view.minHpFrac = row.minHp;
      view.deaths = row.deaths;
      view.pastHorizon = row.pastHorizon;
      view.encounterId = row.encounter === FALLBACK_ENCOUNTER ? null : meta.encounters[row.encounter];
      view.monsters = groups;

      tally.fights++;
      if (row.pastHorizon) tally.pastHorizon++;
      if (row.result === RESULT_VICTORY) {
        tally.wins++;
        if (!row.pastHorizon) tally.winsInHorizon++;
        tally.winMs += row.realMs;
      } else if (row.result === RESULT_DEFEAT) tally.defeats++;
      else if (row.result === RESULT_STALEMATE) tally.stalemates++;
      else if (row.result === RESULT_TIMEOUT) tally.timeouts++;
      tally.ms += row.realMs;
      tally.damage += row.damage;
      tally.minHp += row.minHp;
      tally.deaths += row.deaths;
      tally.kills += killsHere;
      for (let m = 0; m < members.length; m++) tally.xp[m] += pay(members[m], ctx);
      const tallyGold = (into: GoldTally, source: FightGold): void => {
        if (row.result === RESULT_VICTORY) {
          into.coin += source.victoryCoin(row.groups, Math.max(1, ctx.party.shareCount), coinFactor);
          const values = source.dropValues(members.map(m => m.className), ctx.party.hireDetails.map(h => h.className));
          for (let g = 0; g < row.groups.length; g += 3) {
            const present = row.groups[g + 1] + row.groups[g + 2];
            for (let m = 0; m < members.length; m++) into.drops[m] += present * values[m][row.groups[g]];
          }
        }
      };
      tallyGold(tally.gold, gold);
      if (atlasGold) tallyGold(tally.atlasGold!, atlasGold);
      return undefined;
    });
    if (!stopped && current && context) emit(finishCell(current, (context as { members: MemberView[] }).members, tallies));
  };
}
