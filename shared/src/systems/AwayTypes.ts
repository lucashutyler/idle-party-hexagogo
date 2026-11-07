import type { ItemRarity } from './ItemTypes.js';

export type AwayMomentKind =
  | 'level_up'
  | 'first_clear'
  | 'rare_item'
  | 'eject'
  | 'run_ended'
  | 'relocate'
  | 'mastery'
  | 'closest_call';

export interface AwayMoment {
  at: number;
  kind: AwayMomentKind;
  text: string;
  monsterId?: string;
  itemId?: string;
}

export type AwayDungeonOutcome = 'cleared' | 'ejected' | 'left' | 'in_progress';

export interface AwayDungeonEntry {
  dungeonId: string;
  name: string;
  outcome: AwayDungeonOutcome;
}

export interface AwayRetreatEntry {
  at: number;
  kind: 'skip' | 'relocate';
  from: string;
  to?: string;
  winPct: number;
}

export interface AwayNotableItem {
  itemId: string;
  count: number;
  /** Keeps "rarest first" ordering stable across merges. */
  rarity?: ItemRarity;
}

export interface AwayMasteryUp {
  monsterId: string;
  name: string;
  rankFrom: number;
  rankTo: number;
}

export interface AwayCloseCall {
  hpPct: number;
  vs: string;
  where: string;
}

export interface AwayLedger {
  id: string;
  since: number;
  until?: number;
  battles: number;
  wins: number;
  losses: number;
  /** Skips and relocations; `skips` is the skip subset. */
  retreats: number;
  skips: number;
  xp: number;
  gold: number;
  levelFrom: number;
  levelTo: number;
  xpFracFrom: number;
  xpFracTo: number;
  items: Partial<Record<ItemRarity, number>>;
  notableItems: AwayNotableItem[];
  itemsLost: number;
  kills: number;
  masteryUps: AwayMasteryUp[];
  dungeons: AwayDungeonEntry[];
  retreatLog: AwayRetreatEntry[];
  routeStopped?: { at: number; where: string };
  closestCall?: AwayCloseCall;
  moments: AwayMoment[];
}

export interface AwayProgress {
  level: number;
  xpFrac: number;
}

export type AwayRecapStyle = 'toast' | 'modal';

export const AWAY_MIN_MS = 5 * 60_000;
export const AWAY_TOAST_MAX_MS = 30 * 60_000;
export const AWAY_MAX_MOMENTS = 12;
export const AWAY_MAX_NOTABLE_ITEMS = 6;
export const AWAY_MAX_DUNGEONS = 10;
export const AWAY_MAX_RETREATS = 10;
export const AWAY_NOTABLE_MIN_RARITY: ItemRarity = 'rare';

export const AWAY_MOMENT_PRIORITY: Record<AwayMomentKind, number> = {
  level_up: 7,
  first_clear: 6,
  rare_item: 5,
  eject: 4,
  run_ended: 4,
  relocate: 3,
  mastery: 2,
  closest_call: 1,
};

const RARITY_ORDER: readonly ItemRarity[] = ['janky', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'heirloom'];

export function awayRarityRank(rarity: ItemRarity | undefined): number {
  return rarity ? RARITY_ORDER.indexOf(rarity) : -1;
}

export function createAwayLedger(id: string, since: number, progress: AwayProgress): AwayLedger {
  return {
    id,
    since,
    battles: 0,
    wins: 0,
    losses: 0,
    retreats: 0,
    skips: 0,
    xp: 0,
    gold: 0,
    levelFrom: progress.level,
    levelTo: progress.level,
    xpFracFrom: progress.xpFrac,
    xpFracTo: progress.xpFrac,
    items: {},
    notableItems: [],
    itemsLost: 0,
    kills: 0,
    masteryUps: [],
    dungeons: [],
    retreatLog: [],
    moments: [],
  };
}

export function closeAwayLedger(ledger: AwayLedger, until: number, progress: AwayProgress): AwayLedger {
  return { ...ledger, until, levelTo: progress.level, xpFracTo: progress.xpFrac };
}

/** Worth delivering: away long enough and something happened. */
export function isAwayLedgerWorthRecap(ledger: AwayLedger, now: number): boolean {
  return now - ledger.since >= AWAY_MIN_MS && ledger.battles + ledger.retreats > 0;
}

export function awayRecapStyle(ledger: AwayLedger, now: number): AwayRecapStyle {
  const awayMs = (ledger.until ?? now) - ledger.since;
  const notable = ledger.moments.some(m => AWAY_MOMENT_PRIORITY[m.kind] >= AWAY_MOMENT_PRIORITY.eject);
  return awayMs < AWAY_TOAST_MAX_MS && !notable ? 'toast' : 'modal';
}

export function recordAwayBattle(
  ledger: AwayLedger,
  battle: { won: boolean; xp?: number; gold?: number; kills?: number },
): AwayLedger {
  return {
    ...ledger,
    battles: ledger.battles + 1,
    wins: ledger.wins + (battle.won ? 1 : 0),
    losses: ledger.losses + (battle.won ? 0 : 1),
    xp: ledger.xp + Math.max(0, battle.xp ?? 0),
    gold: ledger.gold + Math.max(0, battle.gold ?? 0),
    kills: ledger.kills + Math.max(0, battle.kills ?? 0),
  };
}

export function recordAwayItem(ledger: AwayLedger, itemId: string, rarity: ItemRarity, count = 1): AwayLedger {
  if (count <= 0) return ledger;
  const items = { ...ledger.items, [rarity]: (ledger.items[rarity] ?? 0) + count };
  if (awayRarityRank(rarity) < awayRarityRank(AWAY_NOTABLE_MIN_RARITY)) return { ...ledger, items };
  return { ...ledger, items, notableItems: addNotable(ledger.notableItems, { itemId, count, rarity }) };
}

export function recordAwayItemsLost(ledger: AwayLedger, count: number): AwayLedger {
  return count > 0 ? { ...ledger, itemsLost: ledger.itemsLost + count } : ledger;
}

export function recordAwayRetreat(ledger: AwayLedger, entry: AwayRetreatEntry): AwayLedger {
  return {
    ...ledger,
    retreats: ledger.retreats + 1,
    skips: ledger.skips + (entry.kind === 'skip' ? 1 : 0),
    retreatLog: [...ledger.retreatLog, { ...entry }].slice(-AWAY_MAX_RETREATS),
  };
}

/** Updates the latest in-progress entry for the same dungeon instead of adding a new one. */
export function recordAwayDungeon(ledger: AwayLedger, entry: AwayDungeonEntry): AwayLedger {
  const dungeons = [...ledger.dungeons];
  const last = dungeons.length - 1;
  if (last >= 0 && dungeons[last].dungeonId === entry.dungeonId && dungeons[last].outcome === 'in_progress') {
    dungeons[last] = { ...entry };
  } else {
    dungeons.push({ ...entry });
  }
  return { ...ledger, dungeons: dungeons.slice(-AWAY_MAX_DUNGEONS) };
}

export function recordAwayMastery(ledger: AwayLedger, up: AwayMasteryUp): AwayLedger {
  return { ...ledger, masteryUps: addMasteryUp(ledger.masteryUps, up) };
}

export function recordAwayCloseCall(ledger: AwayLedger, call: AwayCloseCall): AwayLedger {
  if (ledger.closestCall && ledger.closestCall.hpPct <= call.hpPct) return ledger;
  return { ...ledger, closestCall: { ...call } };
}

export function recordAwayRouteStopped(ledger: AwayLedger, at: number, where: string): AwayLedger {
  return { ...ledger, routeStopped: { at, where } };
}

/** Keeps at most AWAY_MAX_MOMENTS, evicting the lowest priority (oldest first among equals). */
export function addAwayMoment(ledger: AwayLedger, moment: AwayMoment): AwayLedger {
  return { ...ledger, moments: capMoments([...ledger.moments, { ...moment }]) };
}

/** Folds `later` into `earlier`: counts add up, the range spans both, and the capped lists re-apply their caps. */
export function mergeAwayLedgers(earlier: AwayLedger, later: AwayLedger): AwayLedger {
  const items: Partial<Record<ItemRarity, number>> = { ...earlier.items };
  for (const [rarity, count] of Object.entries(later.items) as [ItemRarity, number][]) {
    items[rarity] = (items[rarity] ?? 0) + count;
  }
  let notableItems = earlier.notableItems.map(n => ({ ...n }));
  for (const n of later.notableItems) notableItems = addNotable(notableItems, n);
  let masteryUps = earlier.masteryUps.map(m => ({ ...m }));
  for (const m of later.masteryUps) masteryUps = addMasteryUp(masteryUps, m);

  const merged: AwayLedger = {
    id: earlier.id,
    since: Math.min(earlier.since, later.since),
    battles: earlier.battles + later.battles,
    wins: earlier.wins + later.wins,
    losses: earlier.losses + later.losses,
    retreats: earlier.retreats + later.retreats,
    skips: earlier.skips + later.skips,
    xp: earlier.xp + later.xp,
    gold: earlier.gold + later.gold,
    levelFrom: earlier.levelFrom,
    levelTo: later.levelTo,
    xpFracFrom: earlier.xpFracFrom,
    xpFracTo: later.xpFracTo,
    items,
    notableItems,
    itemsLost: earlier.itemsLost + later.itemsLost,
    kills: earlier.kills + later.kills,
    masteryUps,
    dungeons: [...earlier.dungeons, ...later.dungeons].map(d => ({ ...d })).slice(-AWAY_MAX_DUNGEONS),
    retreatLog: [...earlier.retreatLog, ...later.retreatLog].map(r => ({ ...r })).slice(-AWAY_MAX_RETREATS),
    moments: capMoments([...earlier.moments, ...later.moments].map(m => ({ ...m }))),
  };
  const until = later.until ?? earlier.until;
  if (until !== undefined) merged.until = until;
  const routeStopped = later.routeStopped ?? earlier.routeStopped;
  if (routeStopped) merged.routeStopped = { ...routeStopped };
  const closest = [earlier.closestCall, later.closestCall]
    .filter((c): c is AwayCloseCall => !!c)
    .sort((a, b) => a.hpPct - b.hpPct)[0];
  if (closest) merged.closestCall = { ...closest };
  return merged;
}

/** Highest priority first, newest first among equals. */
export function topAwayMoments(ledger: AwayLedger, count: number): AwayMoment[] {
  return [...ledger.moments]
    .sort((a, b) => AWAY_MOMENT_PRIORITY[b.kind] - AWAY_MOMENT_PRIORITY[a.kind] || b.at - a.at)
    .slice(0, Math.max(0, count));
}

function capMoments(moments: AwayMoment[]): AwayMoment[] {
  const sorted = moments.sort((a, b) => a.at - b.at);
  while (sorted.length > AWAY_MAX_MOMENTS) {
    let evict = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (AWAY_MOMENT_PRIORITY[sorted[i].kind] < AWAY_MOMENT_PRIORITY[sorted[evict].kind]) evict = i;
    }
    sorted.splice(evict, 1);
  }
  return sorted;
}

function addNotable(list: AwayNotableItem[], item: AwayNotableItem): AwayNotableItem[] {
  const next = list.map(n => ({ ...n }));
  const existing = next.find(n => n.itemId === item.itemId);
  if (existing) {
    existing.count += item.count;
    if (awayRarityRank(item.rarity) > awayRarityRank(existing.rarity)) existing.rarity = item.rarity;
  } else {
    next.push({ ...item });
  }
  return next
    .sort((a, b) => awayRarityRank(b.rarity) - awayRarityRank(a.rarity))
    .slice(0, AWAY_MAX_NOTABLE_ITEMS);
}

function addMasteryUp(list: AwayMasteryUp[], up: AwayMasteryUp): AwayMasteryUp[] {
  const existing = list.find(m => m.monsterId === up.monsterId);
  if (!existing) return [...list, { ...up }];
  return list.map(m => (m === existing
    ? { ...m, name: up.name, rankFrom: Math.min(m.rankFrom, up.rankFrom), rankTo: Math.max(m.rankTo, up.rankTo) }
    : m));
}
