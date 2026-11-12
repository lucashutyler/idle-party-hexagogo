import { meanQuantity } from './materials.js';
import type { CellGold, XpSnapshot } from './types.js';

/** Past this many possible totals the round-up reads its mean instead of walking every total. */
const COIN_SUPPORT_LIMIT = 200_000;
const MEAN_ROUND_UP = 0.5;

export interface GoldRoll {
  min: number;
  max: number;
  /** Monsters present with this roll. */
  count: number;
}

/** Mean of payVictory's `ceil(total x multiplier x coinFactor / shares)`, where each monster present rolls a whole number from min to max. */
export function expectedSplitCoin(rolls: readonly GoldRoll[], rewardMultiplier: number, shares: number, coinFactor = 1): number {
  let lowest = 0;
  let spread = 0;
  let meanTotal = 0;
  for (const roll of rolls) {
    lowest += roll.count * roll.min;
    spread += roll.count * Math.max(0, roll.max - roll.min);
    meanTotal += (roll.count * (roll.min + roll.max)) / 2;
  }
  if (spread + 1 > COIN_SUPPORT_LIMIT) return (meanTotal * rewardMultiplier * coinFactor) / shares + MEAN_ROUND_UP;
  let totals = new Float64Array(spread + 1);
  totals[0] = 1;
  let reached = 0;
  for (const roll of rolls) {
    const width = roll.max - roll.min + 1;
    if (width <= 1) continue;
    for (let copy = 0; copy < roll.count; copy++) {
      const next = new Float64Array(spread + 1);
      let window = 0;
      for (let t = 0; t <= reached + width - 1; t++) {
        if (t <= reached) window += totals[t];
        if (t - width >= 0) window -= totals[t - width];
        next[t] = window / width;
      }
      totals = next;
      reached += width - 1;
    }
  }
  let coin = 0;
  for (let t = 0; t <= spread; t++) {
    if (totals[t] > 0) coin += totals[t] * Math.ceil(((lowest + t) * rewardMultiplier * coinFactor) / shares);
  }
  return coin;
}

/** What a shop pays for one: `value`, or 1 where it has none. An item the content doesn't hold is never granted. */
export function itemSaleValue(items: XpSnapshot['items'] | undefined, itemId: string): number {
  const item = items?.[itemId];
  return item ? item.value ?? 1 : 0;
}

interface FloorReward {
  itemId: string;
  chance: number;
  minQty?: number;
  maxQty?: number;
  classRestriction?: readonly string[];
}

export function floorRewardApplies(reward: Pick<FloorReward, 'classRestriction'>, className: string): boolean {
  return !reward.classRestriction?.length || reward.classRestriction.includes(className);
}

/** Mean sale value one member of this class rolls on one clear of this floor: grantDungeonRewards rolls once per member, not split. */
export function floorRewardValue(floor: { rewards?: readonly FloorReward[] } | undefined, className: string, items: XpSnapshot['items'] | undefined): number {
  let value = 0;
  for (const reward of floor?.rewards ?? []) {
    if (!floorRewardApplies(reward, className)) continue;
    value += Math.min(1, Math.max(0, reward.chance)) * meanQuantity(reward) * itemSaleValue(items, reward.itemId);
  }
  return value;
}

/** Mean share of a dropped item reaching this member: payVictory gives it to one share, among those of its class if any are present, and a hire's item is lost. */
export function dropShare(restriction: readonly string[] | undefined, memberClass: string, shareClasses: readonly string[]): number {
  const matching = restriction?.length ? shareClasses.filter(c => restriction.includes(c)).length : 0;
  if (matching === 0) return 1 / shareClasses.length;
  return restriction!.includes(memberClass) ? 1 / matching : 0;
}

/** Mean sale value reaching this member from one monster present on a won fight. */
export function monsterDropValue(drops: readonly { itemId: string; chance: number }[] | undefined, pacedChance: (chance: number) => number, items: XpSnapshot['items'] | undefined, memberClass: string, shareClasses: readonly string[]): number {
  let value = 0;
  for (const drop of drops ?? []) {
    const sale = itemSaleValue(items, drop.itemId);
    if (sale > 0) value += pacedChance(drop.chance) * sale * dropShare(items?.[drop.itemId]?.classRestriction, memberClass, shareClasses);
  }
  return value;
}

export interface FloorGoldRead {
  /** % of fights on this floor that end in a win. */
  winPct: number;
  coinPerFight: number;
  dropsPerFight: number;
  /** Sale value of the floor's rewards per win. */
  rewardPerWin: number;
}

export interface RunGold {
  coin: number;
  /** Sale value of floor rewards. */
  rewards: number;
  /** Sale value of monster drops. */
  drops: number;
}

/** One member's gold per attempt at a dungeon: floors in order, a loss ending the run, as the XP loop reads them. */
export function loopRunGold(floors: readonly FloorGoldRead[]): RunGold {
  let reach = 1;
  const run: RunGold = { coin: 0, rewards: 0, drops: 0 };
  for (const floor of floors) {
    const win = floor.winPct / 100;
    run.coin += reach * floor.coinPerFight;
    run.drops += reach * floor.dropsPerFight;
    run.rewards += reach * win * floor.rewardPerWin;
    reach *= win;
  }
  return run;
}

export interface GoldStop {
  /** Floors tried before walking out; the last stop is the full run. */
  floors: number;
  run: RunGold;
  runMs: number;
  /** Share of attempts winning every one of those floors. */
  reach: number;
}

/** A run walking out after each floor in turn, a loss ending it sooner: floors pay as they are won, so a run needn't clear to earn. `cycleMs`: a floor's fight plus the pause after it. */
export function goldStops(floors: readonly (FloorGoldRead & { cycleMs: number })[], reentryMs: number): GoldStop[] {
  let runMs = reentryMs;
  let reach = 1;
  return floors.map((floor, f) => {
    runMs += reach * floor.cycleMs;
    reach *= floor.winPct / 100;
    return { floors: f + 1, run: loopRunGold(floors.slice(0, f + 1)), runMs, reach };
  });
}

export interface GoldFactors {
  coin: number;
  rewards: number;
}

/** What a weekly rule does to gold. A factor it leaves out stays at 1: XP's factor is set against XP and says nothing about gold. */
export function goldFactors(rule: { repeatCoinFactor?: number; repeatRewardFactor?: number } | undefined): GoldFactors {
  return { coin: rule?.repeatCoinFactor ?? 1, rewards: rule?.repeatRewardFactor ?? 1 };
}

/** Gold a repeat clear pays under these factors, and what a week's full clears add on top. Monster drops aren't touched. */
export function applyGoldFactors(run: RunGold, factors: GoldFactors, fullClearsPerWeek: number): { repeat: RunGold; gold: number; lump: number } {
  const repeat: RunGold = { coin: run.coin * factors.coin, rewards: run.rewards * factors.rewards, drops: run.drops };
  const gold = repeat.coin + repeat.rewards;
  return { repeat, gold, lump: fullClearsPerWeek * (run.coin + run.rewards - gold) };
}

/** Reads coin and monster drops off fight rows. Pure and memoised, so one instance serves a whole worker. */
export class FightGold {
  private readonly rolls: { min: number; max: number }[];
  private readonly coinMemo = new Map<string, number>();
  private readonly dropMemo = new Map<string, Float64Array[]>();

  constructor(private readonly monsterIds: readonly string[], private readonly content: XpSnapshot, private readonly mod: any, private readonly rewardMultiplier: number) {
    this.rolls = monsterIds.map(id => {
      const def = content.monsters[id];
      return { min: def?.goldMin ?? 0, max: def?.goldMax ?? 0 };
    });
  }

  private rollsIn(groups: readonly number[]): GoldRoll[] {
    const rolls: GoldRoll[] = [];
    for (let g = 0; g < groups.length; g += 3) rolls.push({ ...this.rolls[groups[g]], count: groups[g + 1] + groups[g + 2] });
    return rolls;
  }

  /** `groups`: a row's flat triples of monster index, killed, standing. Every monster present pays, standing walls too. `coinFactor`: a floor's, as floorPayFactor reads it. */
  victoryCoin(groups: readonly number[], shares: number, coinFactor = 1): number {
    let key = `${shares}|${coinFactor}`;
    for (let g = 0; g < groups.length; g += 3) key += `,${groups[g]}x${groups[g + 1] + groups[g + 2]}`;
    let coin = this.coinMemo.get(key);
    if (coin === undefined) {
      coin = expectedSplitCoin(this.rollsIn(groups), this.rewardMultiplier, shares, coinFactor);
      this.coinMemo.set(key, coin);
    }
    return coin;
  }

  /** Per member, per monster index: mean sale value reaching that member from one such monster on a won fight. */
  dropValues(memberClasses: readonly string[], hireClasses: readonly string[]): Float64Array[] {
    const shareClasses = [...memberClasses, ...hireClasses];
    const key = `${memberClasses.join()}|${hireClasses.join()}`;
    const held = this.dropMemo.get(key);
    if (held) return held;
    const pace = { rewardMultiplier: this.rewardMultiplier };
    const paced = (chance: number): number => this.mod.paceDropChance(pace, chance);
    const values = memberClasses.map(className => Float64Array.from(this.monsterIds, id => monsterDropValue(this.content.monsters[id]?.drops, paced, this.content.items, className, shareClasses)));
    this.dropMemo.set(key, values);
    return values;
  }
}

/** Figures are rounded as CellRate's are: they sit beside the XP figures. */
export function roundCellGold(gold: CellGold): CellGold {
  const r = (value: number, digits: number): number => {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
  };
  return {
    cf: r(gold.cf, 2),
    ch: r(gold.ch, 1),
    cr: r(gold.cr, 1),
    df: gold.df.map(x => r(x, 2)),
    dh: gold.dh.map(x => r(x, 1)),
    ...(gold.bs ? { bs: { coin: r(gold.bs.coin, 2), rest: r(gold.bs.rest, 2) } } : {}),
    ...(gold.atlas ? { atlas: { ch: r(gold.atlas.ch, 1), df: gold.atlas.df.map(x => r(x, 2)), ...(gold.atlas.bs ? { bs: { coin: r(gold.atlas.bs.coin, 2), rest: r(gold.atlas.bs.rest, 2) } } : {}) } } : {}),
  };
}
