import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { FightXpInput, MonsterSkillEntry, XpMonster } from '../../../shared/src/index.js';
import type { ClassName } from '../types.js';
import type { CellRate, CompFamily, MemberRole, ResultName, XpCell, XpComp, XpSnapshot, XpTable } from './types.js';

/** A monster as `createMonsterInstance` makes it, so it is also the `XpMonster` the rules read. */
export interface MonsterInfo {
  id: string;
  /** After the plan's retuneContent, if any. */
  xp: number;
  hp: number;
  maxHp: number;
  damage: number;
  level: number;
  levelSource: 'authored' | 'derived';
  /** False: the engine derived the level, so the level gap never applies. */
  authored: boolean;
  tier: string;
  passive: boolean;
  skills?: MonsterSkillEntry[];
}

export interface MonsterGroup {
  def: MonsterInfo;
  killed: number;
  standing: number;
}

/** One simulated fight. The evaluator reuses this object between calls: never keep a reference. */
export interface FightView {
  result: ResultName;
  won: boolean;
  /** Engine time at pace, without the pause between fights. */
  realMs: number;
  partyDamage: number;
  minHpFrac: number;
  deaths: number;
  /** Still going at defaultHorizonMs. The game fights on, and `won` and `realMs` say how it ended; the real forecast scores it as not won. */
  pastHorizon: boolean;
  encounterId: string | null;
  monsters: readonly MonsterGroup[];
}

export interface MemberView {
  index: number;
  className: ClassName;
  level: number;
  role: MemberRole;
}

export interface HireView {
  id: string;
  className: ClassName;
  level: number;
}

export interface PartyView {
  compId: string;
  family: CompFamily;
  members: readonly MemberView[];
  hires: readonly string[];
  /** The hires in `hires`, in that order, as the snapshot defines them. */
  hireDetails: readonly HireView[];
  /** Humans + fighting hires: payVictory's bodies. */
  shareCount: number;
  /** 1 + every xp_bonus passive equipped in the party, hires included. */
  xpMultiplier: number;
}

export interface PayoutContext {
  party: PartyView;
  table: XpTable;
  rewardMultiplier: number;
  /** Real ms between one fight's last blow and the next fight. */
  pauseMs: number;
  params: Readonly<Record<string, number>>;
  /** What the plan's `prepare` returned, after a JSON round trip. */
  state?: unknown;
  rules: XpRules;
}

/** The game's XP rules, from the same shared module the atlas fought with. See shared/src/systems/XpRules.ts. */
export interface XpRules {
  fightXp(input: FightXpInput): number;
  levelGapXpFactor(monsterLevel: number, memberLevel: number, topHumanLevel: number, harmless?: boolean): number;
  isHarmlessMonster(monster: Pick<XpMonster, 'maxHp' | 'damage' | 'passive' | 'skills'>): boolean;
  partyXpShare(bodies: number, starterZone?: boolean): number;
  floorPayFactor(factor: unknown): number;
  floorMonsterXp(xp: number, factor: number): number;
}

export function xpRulesOf(mod: any): XpRules {
  const { fightXp, levelGapXpFactor, isHarmlessMonster, partyXpShare, floorPayFactor, floorMonsterXp } = mod;
  return { fightXp, levelGapXpFactor, isHarmlessMonster, partyXpShare, floorPayFactor, floorMonsterXp };
}

/** An engine rule for one dungeon: a weekly lump, and a rate for every clear after it. */
export interface DungeonWeeklyRule {
  /** Clears each week that pay in full. */
  fullClearsPerWeek: number;
  /** XP factor on every other clear. */
  repeatFactor: number;
  /** Coin factor on every other run, on runs stopping early as well as clears. Absent: full coin, however low repeatFactor is. */
  repeatCoinFactor?: number;
  /** Factor on floor reward chances on every other run, stopping early or not, so it cuts dungeon materials as well as sale value. Absent: full rewards, however low repeatFactor is. */
  repeatRewardFactor?: number;
}

/** A weekly rule may pay a few clears a week in full and no more. */
export const MAX_WEEKLY_FULL_CLEARS = 3;

export interface BossPolicy {
  /** Real ms before a boss room offers its fight again. */
  respawnMs?: number;
  /** XP factor for the nth boss kill (0-based) in a day. */
  bounty?(killsToday: number): number;
  /** Dungeon clears a day that pay at all, above 0. A run stopping early counts as one. */
  dungeonClearsPerDay?: number;
  /** One rule for every dungeon, or a rule per dungeon; undefined leaves that dungeon as it is. `oneCanEnter`: a lone player passes its door at some level. */
  dungeonWeekly?: DungeonWeeklyRule | ((dungeonId: string, oneCanEnter: boolean) => DungeonWeeklyRule | undefined);
}

export interface AtlasSummary {
  tables: readonly XpTable[];
  comps: readonly XpComp[];
  cells: readonly XpCell[];
  /** Win rate, fight time and kills per cell, from the baseline-independent stats pass; XP fields are the current content's. */
  rates: readonly CellRate[];
}

/** A pure XP rule. Add one as a new file, under plans/ or outside the repository if it names live content, and pass its path to `run-plan`; the harness needs no change. */
export interface XpPlan {
  id: string;
  describe: string;
  params?: Record<string, number>;
  /** Rewards only: monster xp, goldMin and goldMax; quest xp rewards; dungeon first-clear xp; floor reward chance, minQty and maxQty; item value, never raised over its lowest shop price. Fights don't read these, so the atlas stands. Anything else is refused. */
  retuneContent?(snapshot: XpSnapshot, atlasSummary: AtlasSummary): XpSnapshot;
  /**
   * Runs once on the main thread, after retuneContent. Its JSON result reaches payout as `ctx.state`, and nothing else does:
   * payout runs on worker threads with a fresh copy of this module, so a module variable set here or in retuneContent is empty there.
   */
  prepare?(snapshot: XpSnapshot, atlasSummary: AtlasSummary): unknown;
  /** XP this member gets for this fight: a finite number, zero or more, from this call's arguments alone. Anything else stops the run. */
  payout(fight: FightView, member: MemberView, ctx: PayoutContext): number;
  /** Write it as a function of params if it reads one: a plain object is built when the module loads, before `--param` runs. */
  bossPolicy?: BossPolicy | ((params: Readonly<Record<string, number>>) => BossPolicy);
}

export function planBossPolicy(plan: XpPlan | undefined): BossPolicy | undefined {
  const policy = plan?.bossPolicy;
  return typeof policy === 'function' ? policy(plan!.params ?? {}) : policy;
}

/** A weekly rule's bounds: repeat clears stay above zero XP, and a rule can't declare a cap so high it changes nothing. Gold may be cut to nothing; I15 fails a dungeon-only material cut that far. */
export function assertWeeklyRule(rule: DungeonWeeklyRule, where: string): void {
  const { fullClearsPerWeek: full, repeatFactor: factor, repeatCoinFactor: coin, repeatRewardFactor: rewards } = rule;
  if (!Number.isFinite(factor) || factor <= 0 || factor > 1) throw new Error(`dungeonWeekly for ${where}: repeatFactor ${String(factor)} must be above 0 and at most 1, since monster XP in a detuned dungeon must stay above zero`);
  if (!Number.isFinite(full) || full < 0 || full > MAX_WEEKLY_FULL_CLEARS) throw new Error(`dungeonWeekly for ${where}: fullClearsPerWeek ${String(full)} must be 0 to ${MAX_WEEKLY_FULL_CLEARS}`);
  for (const [name, value] of [['repeatCoinFactor', coin], ['repeatRewardFactor', rewards]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`dungeonWeekly for ${where}: ${name} ${String(value)} must be 0 to 1`);
  }
}

/** Throws on a policy out of bounds, for any dungeon, whether or not one player can enter it. A cap of 0 is a clear that never pays, and monster XP in a detuned dungeon must stay above zero. */
export function assertBossPolicy(policy: BossPolicy | undefined, dungeonIds: readonly string[]): void {
  const cap = policy?.dungeonClearsPerDay;
  if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0)) throw new Error(`dungeonClearsPerDay ${String(cap)} must be a finite number above 0`);
  const respawn = policy?.respawnMs;
  if (respawn !== undefined && (!Number.isFinite(respawn) || respawn < 0)) throw new Error(`respawnMs ${String(respawn)} must be a finite number, zero or more`);
  const rule = policy?.dungeonWeekly;
  if (!rule) return;
  if (typeof rule !== 'function') {
    assertWeeklyRule(rule, 'every dungeon');
    return;
  }
  for (const id of dungeonIds) {
    for (const oneCanEnter of [true, false]) {
      const found = rule(id, oneCanEnter);
      if (found) assertWeeklyRule(found, id);
    }
  }
}

const PROBE_DUNGEON = 'param-probe';

function policyNumbers(policy: BossPolicy): number[] {
  const rule = policy.dungeonWeekly;
  const rules = typeof rule === 'function' ? [rule(PROBE_DUNGEON, true), rule(PROBE_DUNGEON, false)] : [rule];
  return [policy.respawnMs, policy.dungeonClearsPerDay, ...rules.flatMap(r => [r?.fullClearsPerWeek, r?.repeatFactor, r?.repeatCoinFactor, r?.repeatRewardFactor])].filter((x): x is number => x !== undefined);
}

/** A plain bossPolicy that holds a param's old value, and reads the same whatever the params, was built before `--param` set it, so the title would claim a value the run never used. */
export function assertParamsReachPolicy(plan: XpPlan, defaults: Readonly<Record<string, number>>, overrides: ParamOverrides | undefined): void {
  if (!plan.bossPolicy || typeof plan.bossPolicy === 'function') return;
  const held = policyNumbers(plan.bossPolicy);
  const current = { ...plan.params };
  if (plan.params) Object.assign(plan.params, defaults);
  const atDefaults = policyNumbers(plan.bossPolicy);
  if (plan.params) Object.assign(plan.params, current);
  if (held.join() !== atDefaults.join()) return;
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (defaults[key] !== value && held.includes(defaults[key])) throw new Error(`plan ${plan.id}: bossPolicy still holds ${key}'s old value ${defaults[key]}, because it was built when the module loaded, before --param. Write it as a function: bossPolicy: params => ({ ... })`);
  }
}

export type ParamOverrides = Readonly<Record<string, number>>;

/** `key=value` flags as numbers. */
export function parseParamFlags(flags: readonly string[]): Record<string, number> {
  const parsed: Record<string, number> = {};
  for (const flag of flags) {
    const at = flag.indexOf('=');
    const text = flag.slice(at + 1);
    if (at <= 0 || text.trim() === '' || !Number.isFinite(Number(text))) throw new Error(`--param ${flag}: expected key=number`);
    parsed[flag.slice(0, at)] = Number(text);
  }
  return parsed;
}

/** Sets these on the plan's own params object, so a closure over it sees them too. A key the plan doesn't declare is a typo that would silently read the default. */
export function applyParamOverrides(plan: XpPlan, overrides: ParamOverrides | undefined): void {
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!plan.params || !(key in plan.params)) throw new Error(`plan ${plan.id} has no param ${key}; it has: ${Object.keys(plan.params ?? {}).join(', ') || 'none'}`);
    plan.params[key] = value;
  }
}

export function planTitle(planId: string, overrides: ParamOverrides | undefined): string {
  const entries = Object.entries(overrides ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  return entries.length ? `${planId} (${entries.map(([k, v]) => `${k}=${v}`).join(', ')})` : planId;
}

export async function loadPlan(path: string, overrides?: ParamOverrides): Promise<XpPlan> {
  const mod = await import(pathToFileURL(resolve(path)).href);
  const plan = (mod.default ?? mod.plan) as XpPlan | undefined;
  if (!plan || typeof plan.payout !== 'function' || !plan.id) throw new Error(`${path} does not export a plan (default export with id and payout)`);
  const defaults = { ...plan.params };
  applyParamOverrides(plan, overrides);
  assertParamsReachPolicy(plan, defaults, overrides);
  return plan;
}

export function readPlanState(statePath: string | undefined): unknown {
  return statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(k => [k, canonical(record[k])]));
  }
  return value;
}

function assertXpValue(where: string, xp: unknown): void {
  if (xp === undefined) return;
  if (typeof xp !== 'number' || !Number.isFinite(xp) || xp < 0) throw new Error(`retuneContent set ${where} to ${String(xp)}: XP must be a finite number, zero or more`);
}

/** The game rolls and multiplies these as whole numbers. */
function assertWholeValue(where: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`retuneContent set ${where} to ${String(value)}: it must be a whole number, zero or more`);
}

function assertGoldRange(where: string, entry: { goldMin?: unknown; goldMax?: unknown }): void {
  assertWholeValue(`${where} goldMin`, entry.goldMin);
  assertWholeValue(`${where} goldMax`, entry.goldMax);
  if (typeof entry.goldMin === 'number' && typeof entry.goldMax === 'number' && entry.goldMin > entry.goldMax) throw new Error(`retuneContent set ${where} goldMin ${entry.goldMin} above goldMax ${entry.goldMax}`);
}

function assertFloorRewards(where: string, dungeon: any): void {
  (dungeon.floors ?? []).forEach((floor: any, f: number) => {
    for (const reward of floor.rewards ?? []) {
      const at = `${where} floor ${f} reward ${String(reward.itemId)}`;
      if (typeof reward.chance !== 'number' || !Number.isFinite(reward.chance) || reward.chance < 0 || reward.chance > 1) throw new Error(`retuneContent set ${at} chance to ${String(reward.chance)}: it must be 0 to 1`);
      assertWholeValue(`${at} minQty`, reward.minQty);
      assertWholeValue(`${at} maxQty`, reward.maxQty);
    }
  });
}

/** The game adds these without a check, so a roll without one pays NaN. */
function assertCoinKept(where: string, before: any, after: any): void {
  for (const field of ['goldMin', 'goldMax']) {
    if (before[field] !== undefined && after[field] === undefined) throw new Error(`retuneContent removed ${where} ${field}: set it to 0 instead`);
  }
}

/** A shop charges its own price and buys back at value, so a value over the price is gold from nothing. */
function assertNoShopArbitrage(where: string, wasValue: unknown, value: unknown, lowestPrice: number | undefined): void {
  if (typeof value !== 'number' || lowestPrice === undefined || value <= lowestPrice) return;
  if (value > (typeof wasValue === 'number' ? wasValue : 1)) throw new Error(`retuneContent set ${where} value to ${value}, over its lowest shop price ${lowestPrice}: buying it and selling it back would make gold from nothing`);
}

function lowestShopPrices(shops: XpSnapshot['shops'] | undefined): Map<string, number> {
  const prices = new Map<string, number>();
  for (const shop of Object.values(shops ?? {})) {
    for (const entry of (shop as any).inventory ?? []) {
      if (typeof entry.price === 'number' && entry.price < (prices.get(entry.itemId) ?? Infinity)) prices.set(entry.itemId, entry.price);
    }
  }
  return prices;
}

function assertRewardValues(section: string, id: string, before: any, entry: any, prices: ReadonlyMap<string, number>): void {
  const where = `${section}/${id}`;
  if (section === 'monsters') {
    assertXpValue(where, entry.xp);
    assertCoinKept(where, before, entry);
    assertGoldRange(where, entry);
  }
  if (section === 'dungeons') {
    assertXpValue(where, entry.firstClearXp);
    assertFloorRewards(where, entry);
  }
  if (section === 'quests') for (const reward of entry.rewards ?? []) if (reward.kind === 'xp') assertXpValue(where, reward.amount);
  if (section === 'items') {
    assertWholeValue(`${where} value`, entry.value);
    assertNoShopArbitrage(where, before.value, entry.value, prices.get(id));
  }
}

function masked(section: string, entry: any): unknown {
  if (section === 'monsters') {
    const { xp: _xp, goldMin: _min, goldMax: _max, ...rest } = entry;
    return rest;
  }
  if (section === 'quests') {
    return { ...entry, rewards: (entry.rewards ?? []).map((r: any) => (r.kind === 'xp' ? { kind: 'xp' } : r)) };
  }
  if (section === 'dungeons') {
    const { firstClearXp: _xp, ...rest } = entry;
    if (!rest.floors) return rest;
    return { ...rest, floors: rest.floors.map((floor: any) => (floor.rewards ? { ...floor, rewards: floor.rewards.map(({ chance: _chance, minQty: _min, maxQty: _max, ...reward }: any) => reward) } : floor)) };
  }
  if (section === 'items') {
    const { value: _value, ...rest } = entry;
    return rest;
  }
  return entry;
}

const REWARD_SECTIONS = ['monsters', 'quests', 'dungeons', 'items'];

/** Throws unless `after` differs from `before` only in values fights never read, so the atlas still describes it. */
export function assertRewardsOnlyChange(before: XpSnapshot, after: XpSnapshot): void {
  const sections = new Set([...Object.keys(before), ...Object.keys(after)]);
  const prices = lowestShopPrices(before.shops);
  for (const section of sections) {
    const a = (before as any)[section];
    const b = (after as any)[section];
    if (!REWARD_SECTIONS.includes(section)) {
      if (JSON.stringify(canonical(a)) !== JSON.stringify(canonical(b))) throw new Error(`retuneContent changed ${section}: only XP, gold and reward values may change`);
      continue;
    }
    const ids = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    for (const id of ids) {
      if (!a?.[id] || !b?.[id]) throw new Error(`retuneContent added or removed ${section}/${id}`);
      assertRewardValues(section, id, a[id], b[id], prices);
      if (JSON.stringify(canonical(masked(section, a[id]))) !== JSON.stringify(canonical(masked(section, b[id])))) {
        throw new Error(`retuneContent changed ${section}/${id} beyond its XP, gold and reward values`);
      }
    }
  }
}
