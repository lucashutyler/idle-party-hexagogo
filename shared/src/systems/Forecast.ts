import type { PartyCombatantInit, PartyCombatState } from './CombatEngine.js';
import { cloneCombatState, createPartyCombatState, processCombatStep } from './CombatEngine.js';
import { createRng } from './combat/CombatRng.js';
import { AUTHORED_PACE, paceRealMs } from './CombatPace.js';
import type { CombatPace } from './CombatPace.js';
import { COMBAT_STEP_MS } from './CombatTiming.js';
import { isBossTier, resolveEnrage } from './CombatScaling.js';
import type { EncounterDefinition } from './EncounterTypes.js';
import { createEncounter } from './EncounterTypes.js';
import type { EncounterTableEntry } from './ZoneTypes.js';
import type { MonsterDefinition, MonsterLevelSource, MonsterSkillEntry, MonsterTier } from './MonsterTypes.js';
import { effectiveMonsterLevel, effectiveMonsterTier } from './MonsterLevels.js';
import { MONSTER_SKILL_CATALOG, getMonsterSkillCastTimeMs } from './MonsterSkills.js';
import type { DungeonDefinition } from './DungeonTypes.js';
import type { SkillDefinition } from './SkillTypes.js';
import { getSkillTrigger } from './SkillTypes.js';
import { packRawXp } from './XpRules.js';
import type {
  ForecastFloor,
  ForecastReason,
  ForecastResult,
  ForecastStats,
  ForecastStratum,
} from './ForecastTypes.js';

export const FORECAST_MIN_SIMS = 30;
/** A room forecast never converges before every table entry has this many sims. */
export const FORECAST_MIN_SIMS_PER_STRATUM = 3;
/** Early stop once the Wilson 95 % half-width is at most this many percentage points. */
export const FORECAST_TARGET_HALF_WIDTH_PCT = 5;
export const FORECAST_SIM_BUDGET: Record<MonsterTier, number> = { trash: 200, elite: 200, boss: 40, raid: 20 };
export const FORECAST_HORIZON_AFTER_ENRAGE_MS = 10 * 60 * 1000;
export const FORECAST_HORIZON_WITHOUT_ENRAGE_MS = 20 * 60 * 1000;
export const FORECAST_MAX_REASONS = 3;
/** Strata below this share (percent) never count as the worst encounter. */
export const FORECAST_WORST_MIN_SHARE_PCT = 10;
export const FORECAST_STALEMATE_REASON_FRACTION = 0.2;
export const FORECAST_NO_HEALER_MEDIAN_MS = 60000;
export const FORECAST_LEVEL_GAP_REASON = 3;
export const FORECAST_OUTLEVEL_REASON = 5;
export const FORECAST_NEEDS_GROUP_HUMANS = 3;
export const FORECAST_NEEDS_GROUP_WIN_PCT = 40;
/** Level/interrupt/cleanse hints stay quiet once a party wins at least this often. */
export const FORECAST_QUIET_WIN_PCT = 90;

const WILSON_Z = 1.96;
const TIER_RANK: Record<MonsterTier, number> = { trash: 0, elite: 1, boss: 2, raid: 3 };

/** How one simulated fight ended; `stalemate` = the no-progress rule (players still up), `timeout` = the horizon. */
export type SimResult = 'victory' | 'defeat' | 'stalemate' | 'timeout';

export interface SimOutcome {
  result: SimResult;
  /** Battle time at the end, including any clone point. */
  elapsedMs: number;
  /** Share of the bosses' HP at the start of the sim that was dealt; absent without bosses. */
  bossDamageFrac?: number;
}

export interface RoomForecastInput {
  kind: 'room';
  players: PartyCombatantInit[];
  /** The room's resolved encounter table (room override, else zone); empty → the goblin fallback. */
  table: EncounterTableEntry[];
  monsters: Record<string, MonsterDefinition>;
  encounters: Record<string, EncounterDefinition>;
  pace?: CombatPace;
}

export interface DungeonForecastInput {
  kind: 'dungeon';
  players: PartyCombatantInit[];
  dungeon: DungeonDefinition;
  monsters: Record<string, MonsterDefinition>;
  encounters: Record<string, EncounterDefinition>;
  /** Used by floors with an empty table, as `createEncounter` does with the zone's table. */
  fallbackTable?: EncounterTableEntry[];
  /** 0-based floor a party already inside the run stands on. Default 0. */
  startFloorIndex?: number;
  pace?: CombatPace;
}

export interface BattleForecastInput {
  kind: 'battle';
  /** A fight in progress; the job clones it up front and never mutates it. */
  state: PartyCombatState;
  /** False for a fight inside a dungeon. */
  henchmenAllowed?: boolean;
}

export type ForecastInput = RoomForecastInput | DungeonForecastInput | BattleForecastInput;

export interface ForecastJobOptions {
  key: string;
  /** Defaults to `partyKey(players)` (for a battle, of the fight's combatants). */
  partyKey?: string;
  /** Defaults to `seedFromKey(key)`. */
  seed?: number;
  /** Defaults to FORECAST_SIM_BUDGET for the strongest tier involved. */
  maxSims?: number;
  minSims?: number;
  halfWidthPct?: number;
  /** Absolute battle-time limit per fight; defaults to `defaultHorizonMs`. */
  horizonMs?: number;
}

/** Monte Carlo forecast that the caller drives in slices; results are deterministic for a given key/seed. */
export interface ForecastJob {
  readonly done: boolean;
  readonly sims: number;
  readonly maxSims: number;
  /** Completes up to `n` more sims (finishing one in progress first). Returns how many completed. */
  runSims(n: number): number;
  /** Advances by up to `maxSteps` combat steps; a long sim spans several calls. Returns the steps used. */
  advance(maxSteps: number): number;
  /** The estimate so far (valid at any point, final once `done`). */
  result(): ForecastResult;
}

export interface ForecastReasonInput {
  /** Times here are engine time; this only turns them into real time for the text. */
  clock?: number;
  winPct: number;
  sims: number;
  stalemates: number;
  medianMs: number | null;
  killEtaMs: number | null;
  /** Earliest enemy enrage, battle time. */
  enrageAtMs?: number | null;
  worst?: { label: string; winPct: number; sharePct: number };
  partyLevel: number;
  humanPlayers: number;
  /** Level of the strongest common enemy with an authored level. */
  enemyLevel?: number;
  bossFight?: boolean;
  casterEnemies?: boolean;
  afflictingEnemies?: boolean;
  hasInterrupt?: boolean;
  hasCleanse?: boolean;
  hasHealer?: boolean;
  /** False for dungeons, which henchmen cannot enter. */
  henchmenAllowed?: boolean;
}

interface Budget {
  left: number;
}

type SimGenerator = Generator<void, void, void>;

interface EnemyProfile {
  level: number;
  derived: boolean;
  tier: MonsterTier;
  passive: boolean;
  caster: boolean;
  afflicting: boolean;
  enrageAtMs: number | null;
}

interface PartyProfile {
  partyLevel: number;
  humanPlayers: number;
  hasInterrupt: boolean;
  hasCleanse: boolean;
  hasHealer: boolean;
}

interface EnemySummary {
  enemyLevels?: [number, number];
  someUnrated?: boolean;
  /** Strongest common enemy with an authored level; derived levels never drive level reasons. */
  enemyLevel?: number;
  bossFight: boolean;
  casterEnemies: boolean;
  afflictingEnemies: boolean;
  enrageAtMs: number | null;
  topTier: MonsterTier;
}

interface Sampler {
  readonly topTier: MonsterTier;
  readonly pace: CombatPace;
  sim(budget: Budget): SimGenerator;
  converged(minSims: number, halfWidthPct: number): boolean;
  result(): Omit<ForecastResult, 'key' | 'partyKey'>;
}

// --- Single fight ---

/** Latest battle time a forecast fight runs to: enrage + 10 min (20 min without), and ≥ 10 min past the clone point. */
export function defaultHorizonMs(state: PartyCombatState): number {
  let enrageAt = Infinity;
  for (const m of state.monsters) {
    if (!m.passive && m.currentHp > 0 && m.enrageState) enrageAt = Math.min(enrageAt, m.enrageState.atMs);
  }
  const base = Number.isFinite(enrageAt)
    ? enrageAt + FORECAST_HORIZON_AFTER_ENRAGE_MS
    : FORECAST_HORIZON_WITHOUT_ENRAGE_MS;
  return Math.max(base, state.elapsedMs + FORECAST_HORIZON_AFTER_ENRAGE_MS);
}

/** Runs `state` (mutated in place — pass a fresh or cloned fight) until it ends or reaches `horizonMs` battle time. */
export function simulateToEnd(state: PartyCombatState, rng: () => number, horizonMs: number): SimOutcome {
  const run = fightSteps(state, rng, horizonMs, { left: Infinity });
  let step = run.next();
  while (!step.done) step = run.next();
  return step.value;
}

function* fightSteps(state: PartyCombatState, rng: () => number, horizonMs: number, budget: Budget): Generator<void, SimOutcome, void> {
  const bossStart = bossHp(state);
  while (!state.finished && state.elapsedMs < horizonMs) {
    while (budget.left <= 0) yield;
    processCombatStep(state, COMBAT_STEP_MS, rng);
    budget.left--;
  }
  return outcomeOf(state, bossStart);
}

function bossHp(state: PartyCombatState): number | null {
  const bosses = state.monsters.filter(m => !m.passive && isBossTier(m.tier));
  if (bosses.length === 0) return null;
  let hp = 0;
  for (const boss of bosses) {
    if (Number.isFinite(boss.currentHp)) hp += Math.max(0, boss.currentHp);
  }
  return hp;
}

function outcomeOf(state: PartyCombatState, bossStart: number | null): SimOutcome {
  let result: SimResult;
  if (!state.finished) result = 'timeout';
  else if (state.result === 'victory') result = 'victory';
  else if (state.players.some(p => p.currentHp > 0)) result = 'stalemate';
  else result = 'defeat';
  const outcome: SimOutcome = { result, elapsedMs: state.elapsedMs };
  if (bossStart !== null && bossStart > 0) {
    const dealt = (bossStart - (bossHp(state) ?? 0)) / bossStart;
    outcome.bossDamageFrac = Math.min(1, Math.max(0, dealt));
  }
  return outcome;
}

// --- Statistics ---

/** Wilson score interval (as fractions) for a success rate `p` observed over `n` trials. */
export function wilsonInterval(p: number, n: number, z = WILSON_Z): [number, number] {
  if (!(n > 0)) return [0, 1];
  const rate = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (rate + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt(rate * (1 - rate) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Nearest-rank quantile of an ascending list. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

/** Estimated battle time at which the bosses die: the clone point plus sim time scaled by the share dealt. */
export function killEtaFor(outcome: SimOutcome, atMs = 0): number | null {
  const frac = outcome.bossDamageFrac;
  if (frac === undefined) return null;
  if (!(frac > 0)) return Infinity;
  return atMs + Math.max(0, outcome.elapsedMs - atMs) / frac;
}

export interface SummarizeOptions {
  /** Clone point (battle time) the sims started from. */
  atMs?: number;
  /** Overrides the pooled win rate (stratified or per-floor product estimates). */
  winRate?: number;
  /** Overrides the kill ETAs derived from the outcomes. */
  killEtas?: number[];
}

export function summarize(outcomes: readonly SimOutcome[], opts: SummarizeOptions = {}): ForecastStats {
  const atMs = opts.atMs ?? 0;
  const sims = outcomes.length;
  let wins = 0;
  let losses = 0;
  let stalemates = 0;
  const winTimes: number[] = [];
  for (const o of outcomes) {
    if (o.result === 'victory') {
      wins++;
      winTimes.push(o.elapsedMs);
    } else if (o.result === 'defeat') {
      losses++;
    } else {
      stalemates++;
    }
  }
  winTimes.sort((a, b) => a - b);
  const rate = opts.winRate ?? (sims > 0 ? wins / sims : 0);
  const [lo, hi] = wilsonInterval(rate, sims);
  const etas = (opts.killEtas ?? outcomes.map(o => killEtaFor(o, atMs)).filter((v): v is number => v !== null))
    .slice()
    .sort((a, b) => a - b);
  const eta = etas.length > 0 ? quantile(etas, 0.5) : NaN;
  return {
    sims,
    wins,
    losses,
    stalemates,
    winPct: round1(rate * 100),
    ci: [round1(lo * 100), round1(hi * 100)],
    medianMs: wins >= 3 ? Math.round(quantile(winTimes, 0.5)) : null,
    p90Ms: wins >= 3 ? Math.round(quantile(winTimes, 0.9)) : null,
    atMs,
    killEtaMs: Number.isFinite(eta) ? Math.round(eta) : null,
  };
}

function converged(rate: number, n: number, allAgree: boolean, minSims: number, halfWidthPct: number): boolean {
  if (n < minSims) return false;
  if (allAgree) return true;
  const [lo, hi] = wilsonInterval(rate, n);
  return ((hi - lo) / 2) * 100 <= halfWidthPct;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// --- Keys & seeds ---

/** 53-bit string hash (cyrb53) as 14 hex digits. */
export function hashString(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, '0');
}

export function seedFromKey(key: string): number {
  return parseInt(hashString(key).slice(-8), 16) >>> 0;
}

const skillFingerprints = new WeakMap<SkillDefinition, string>();

function skillFingerprint(skill: SkillDefinition | null): string {
  if (!skill) return '-';
  let fp = skillFingerprints.get(skill);
  if (fp === undefined) {
    fp = `${skill.id}~${hashString(stableStringify(skill))}`;
    skillFingerprints.set(skill, fp);
  }
  return fp;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' && !Number.isFinite(value) ? `"${String(value)}"` : JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(k => record[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/**
 * Digest of a party's forecast inputs (never usernames). Kill mastery is left out on purpose, so
 * rank-ups don't invalidate cached forecasts. See docs/architecture/combat.md (forecasting).
 */
export function partyKey(players: readonly PartyCombatantInit[]): string {
  const parts = players.map(p => stableStringify([
    p.gridPosition,
    p.className,
    p.level,
    p.maxHp,
    p.baseDamage,
    p.playerDamageType,
    p.isHenchman ? 1 : 0,
    p.equipBonuses ?? null,
    p.setBonuses ?? null,
    p.equippedSkills.map(skillFingerprint),
    ...(p.attack ? [skillFingerprint(p.attack)] : []),
    ...(p.actionOrder?.length ? [p.actionOrder] : []),
  ])).sort();
  return `pk${hashString(parts.join('|'))}`;
}

// --- Reasons ---

/** Clock text for battle time: m:ss, or h:mm:ss from one hour. */
export function formatForecastClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const SHARE_FRACTIONS: readonly (readonly [number, number])[] = [
  [1, 2], [1, 3], [2, 3], [1, 4], [3, 4], [1, 5], [2, 5], [3, 5], [4, 5], [1, 10], [3, 10], [7, 10], [9, 10],
];

/** The simple fraction `[numerator, denominator]` nearest to a share in percent (the simpler one on a tie). */
export function nearestShareFraction(sharePct: number): [number, number] {
  const share = Number.isFinite(sharePct) ? sharePct / 100 : 0;
  let best = SHARE_FRACTIONS[0];
  for (const f of SHARE_FRACTIONS) {
    if (Math.abs(f[0] / f[1] - share) < Math.abs(best[0] / best[1] - share) - 1e-9) best = f;
  }
  return [best[0], best[1]];
}

/** "2 in 5 fights" for a 40 % share. */
export function fightsShareText(sharePct: number): string {
  const [n, d] = nearestShareFraction(sharePct);
  return `${n} in ${d} fights`;
}

/** At most FORECAST_MAX_REASONS explanations, most important first. */
export function forecastReasons(input: ForecastReasonInput): ForecastReason[] {
  const reasons: ForecastReason[] = [];
  const add = (code: string, tone: ForecastReason['tone'], text: string): void => {
    reasons.push({ code, tone, text });
  };
  const quiet = input.winPct >= FORECAST_QUIET_WIN_PCT;
  const gap = input.enemyLevel !== undefined ? Math.round(input.enemyLevel - input.partyLevel) : 0;

  if (input.bossFight && input.humanPlayers < FORECAST_NEEDS_GROUP_HUMANS && input.winPct < FORECAST_NEEDS_GROUP_WIN_PCT) {
    add('needs_group', 'bad', input.henchmenAllowed === false
      ? 'Bosses are built for groups. Invite friends.'
      : 'Bosses are built for groups. Invite friends or hire a henchman.');
  }
  if (input.killEtaMs !== null && typeof input.enrageAtMs === 'number' && input.killEtaMs > input.enrageAtMs) {
    add('enrage', 'bad',
      `They enrage at ${formatForecastClock(input.enrageAtMs * (input.clock ?? 1))} — your party needs about ${formatForecastClock(input.killEtaMs * (input.clock ?? 1))}`);
  }
  if (input.sims > 0 && input.stalemates / input.sims >= FORECAST_STALEMATE_REASON_FRACTION) {
    add('stalemate', 'bad', 'Your party can barely hurt them. Fights may stall out.');
  }
  const worst = input.worst;
  if (worst && worst.sharePct < 100 && worst.winPct < input.winPct - 10 && worst.winPct < 70) {
    add('worst_encounter', 'bad', `${fightsShareText(worst.sharePct)} here are ${worst.label}: wins ${Math.round(worst.winPct)}%`);
  }
  if (!quiet && gap >= FORECAST_LEVEL_GAP_REASON) {
    add('level_gap', 'bad', `Enemies here are ${gap} levels above your party.`);
  }
  if (!input.hasHealer && input.medianMs !== null && input.medianMs > FORECAST_NO_HEALER_MEDIAN_MS) {
    add('no_healer', 'info', 'Fights here run over a minute and nobody in your party can heal.');
  }
  if (!quiet && input.casterEnemies && !input.hasInterrupt) {
    add('no_interrupt', 'info', 'Enemies here cast spells and nobody in your party can interrupt them.');
  }
  if (!quiet && input.afflictingEnemies && !input.hasCleanse) {
    add('no_cleanse', 'info', 'Enemies here stun or poison and nobody in your party can cleanse it.');
  }
  if (quiet && -gap >= FORECAST_OUTLEVEL_REASON) {
    add('outlevel', 'good', `Your party outlevels the enemies here by ${-gap}.`);
  }
  return reasons.slice(0, FORECAST_MAX_REASONS);
}

function partyProfile(players: readonly Pick<PartyCombatantInit, 'level' | 'isHenchman' | 'equippedSkills'>[]): PartyProfile {
  const humans = players.filter(p => !p.isHenchman);
  const levelSource = humans.length > 0 ? humans : players;
  const partyLevel = levelSource.length > 0
    ? levelSource.reduce((sum, p) => sum + (Number.isFinite(p.level) ? p.level : 1), 0) / levelSource.length
    : 1;
  let hasInterrupt = false;
  let hasCleanse = false;
  let hasHealer = false;
  for (const p of players) {
    for (const skill of p.equippedSkills) {
      if (!skill || skill.type !== 'active') continue;
      if (getSkillTrigger(skill) === 'enemy_cast') hasInterrupt = true;
      for (const effect of skill.activeEffects ?? []) {
        if (effect.kind === 'cure_debuffs') hasCleanse = true;
        if (effect.kind === 'heal_lowest' || effect.kind === 'hot_lowest') hasHealer = true;
      }
    }
  }
  return { partyLevel, humanPlayers: humans.length, hasInterrupt, hasCleanse, hasHealer };
}

function skillTraits(skills: readonly MonsterSkillEntry[] | undefined): { caster: boolean; afflicting: boolean } {
  let caster = false;
  let afflicting = false;
  for (const entry of skills ?? []) {
    const def = MONSTER_SKILL_CATALOG[entry.skillId];
    if (!def) continue;
    if (getMonsterSkillCastTimeMs(entry, def) > 0) caster = true;
    if (def.effect === 'dot' || def.effect === 'stun') afflicting = true;
  }
  return { caster, afflicting };
}

function defProfile(def: MonsterDefinition): EnemyProfile {
  const { level, source } = effectiveMonsterLevel(def);
  const tier = effectiveMonsterTier(def);
  return {
    level,
    derived: source === 'derived',
    tier,
    passive: !!def.passive,
    ...skillTraits(def.skills),
    enrageAtMs: def.passive ? null : resolveEnrage(tier, def.enrage)?.afterMs ?? null,
  };
}

function isDerivedSource(source: MonsterLevelSource | undefined, level: number | undefined): boolean {
  return source ? source !== 'authored' : level === undefined;
}

function stateProfiles(state: PartyCombatState): EnemyProfile[] {
  return state.monsters.filter(m => m.currentHp > 0).map(m => ({
    level: typeof m.level === 'number' && Number.isFinite(m.level) ? m.level : 1,
    derived: isDerivedSource(m.levelSource, m.level),
    tier: m.tier && m.tier in TIER_RANK ? m.tier : 'trash',
    passive: !!m.passive,
    ...skillTraits(m.skills),
    enrageAtMs: m.enrageState ? m.enrageState.atMs : null,
  }));
}

/** `common` = enemies from strata with a share ≥ FORECAST_WORST_MIN_SHARE_PCT (falls back to all). */
function summarizeEnemies(all: readonly EnemyProfile[], common: readonly EnemyProfile[]): EnemySummary {
  const fighters = all.filter(e => !e.passive);
  const summary: EnemySummary = {
    bossFight: fighters.some(e => isBossTier(e.tier)),
    casterEnemies: fighters.some(e => e.caster),
    afflictingEnemies: fighters.some(e => e.afflicting),
    enrageAtMs: null,
    topTier: 'trash',
  };
  for (const e of fighters) {
    if (TIER_RANK[e.tier] > TIER_RANK[summary.topTier]) summary.topTier = e.tier;
    if (e.enrageAtMs !== null) summary.enrageAtMs = Math.min(summary.enrageAtMs ?? Infinity, e.enrageAtMs);
  }
  if (fighters.length === 0) return summary;
  const rated = fighters.filter(e => !e.derived);
  if (rated.length > 0) {
    const levels = rated.map(e => e.level);
    summary.enemyLevels = [Math.min(...levels), Math.max(...levels)];
    if (rated.length < fighters.length) summary.someUnrated = true;
  }
  const pool = common.filter(e => !e.passive);
  for (const e of (pool.length > 0 ? pool : fighters).filter(f => !f.derived)) {
    if (summary.enemyLevel === undefined || e.level > summary.enemyLevel) summary.enemyLevel = e.level;
  }
  return summary;
}

function reasonsFor(stats: ForecastStats, party: PartyProfile, enemies: EnemySummary, clock: number, extra: Partial<ForecastReasonInput> = {}): ForecastReason[] {
  if (stats.sims === 0) return [];
  return forecastReasons({
    clock,
    winPct: stats.winPct,
    sims: stats.sims,
    stalemates: stats.stalemates,
    medianMs: stats.medianMs,
    killEtaMs: stats.killEtaMs,
    enrageAtMs: enemies.enrageAtMs,
    partyLevel: party.partyLevel,
    humanPlayers: party.humanPlayers,
    enemyLevel: enemies.enemyLevel,
    bossFight: enemies.bossFight,
    casterEnemies: enemies.casterEnemies,
    afflictingEnemies: enemies.afflictingEnemies,
    hasInterrupt: party.hasInterrupt,
    hasCleanse: party.hasCleanse,
    hasHealer: party.hasHealer,
    ...extra,
  });
}

function applyEnemyLevels(target: Pick<ForecastResult, 'enemyLevels' | 'someUnrated'>, enemies: EnemySummary): void {
  if (!enemies.enemyLevels) return;
  target.enemyLevels = enemies.enemyLevels;
  if (enemies.someUnrated) target.someUnrated = true;
}

// --- Encounter tables ---

interface TableStratum extends TableShare {
  label: string;
  enemies: EnemyProfile[];
}

function fallbackMonster(monsters: Record<string, MonsterDefinition>): MonsterDefinition | undefined {
  return monsters['goblin'] ?? Object.values(monsters)[0];
}

function encounterMonsterDefs(
  encounterId: string,
  monsters: Record<string, MonsterDefinition>,
  encounters: Record<string, EncounterDefinition>,
): MonsterDefinition[] {
  const encounter = encounters[encounterId];
  const ids = encounter?.type === 'explicit'
    ? (encounter.placements ?? []).map(p => p.monsterId)
    : (encounter?.monsterPool ?? []).filter(p => p.max > 0).map(p => p.monsterId);
  const defs = [...new Set(ids)].map(id => monsters[id]).filter((d): d is MonsterDefinition => !!d);
  if (defs.length > 0) return defs;
  const fallback = fallbackMonster(monsters);
  return fallback ? [fallback] : [];
}

export interface TableShare {
  entryId: string;
  share: number;
  /** One-entry table that forces `createEncounter` onto this entry (empty = the fallback). */
  table: EncounterTableEntry[];
}

/** A weighted table's entries and shares (duplicate ids merged), mirroring `pickWeightedEncounter`. */
export function tableShares(table: readonly EncounterTableEntry[]): TableShare[] {
  const weights = new Map<string, number>();
  for (const entry of table) {
    const w = typeof entry.weight === 'number' && Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0;
    if (w > 0) weights.set(entry.encounterId, (weights.get(entry.encounterId) ?? 0) + w);
  }
  if (weights.size === 0 && table.length > 0) weights.set(table[0].encounterId, 1);
  if (weights.size === 0) return [{ entryId: '', share: 1, table: [] }];
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  return [...weights].map(([entryId, weight]) => ({
    entryId,
    share: weight / total,
    table: [{ encounterId: entryId, weight: 1 }],
  }));
}

function tableStrata(
  table: readonly EncounterTableEntry[],
  monsters: Record<string, MonsterDefinition>,
  encounters: Record<string, EncounterDefinition>,
): TableStratum[] {
  return tableShares(table).map(({ entryId, share, table: one }) => {
    if (one.length === 0) {
      const fallback = fallbackMonster(monsters);
      return { entryId, label: fallback?.name ?? 'Nothing', share, table: one, enemies: fallback ? [defProfile(fallback)] : [] };
    }
    return {
      entryId,
      label: encounters[entryId]?.name ?? entryId,
      share,
      table: one,
      enemies: encounterMonsterDefs(entryId, monsters, encounters).map(defProfile),
    };
  });
}

function commonEnemies(strata: readonly TableStratum[]): EnemyProfile[] {
  return strata.filter(s => s.share * 100 >= FORECAST_WORST_MIN_SHARE_PCT).flatMap(s => s.enemies);
}

// --- Room sampler (stratified by table entry) ---

interface StratumTally {
  n: number;
  wins: number;
  ms: number;
  packXp: number;
  winPackXp: number;
}

class RoomSampler implements Sampler {
  readonly topTier: MonsterTier;
  readonly pace: CombatPace;
  private readonly strata: TableStratum[];
  private readonly tallies: StratumTally[];
  private readonly outcomes: SimOutcome[] = [];
  private readonly party: PartyProfile;
  private readonly enemies: EnemySummary;

  constructor(private readonly input: RoomForecastInput, private readonly rng: () => number, private readonly horizonMs: number | undefined) {
    this.pace = input.pace ?? AUTHORED_PACE;
    this.strata = tableStrata(input.table ?? [], input.monsters, input.encounters);
    this.tallies = this.strata.map(() => ({ n: 0, wins: 0, ms: 0, packXp: 0, winPackXp: 0 }));
    this.party = partyProfile(input.players);
    this.enemies = summarizeEnemies(this.strata.flatMap(s => s.enemies), commonEnemies(this.strata));
    this.topTier = this.enemies.topTier;
  }

  *sim(budget: Budget): SimGenerator {
    const index = this.nextStratum();
    const stratum = this.strata[index];
    const monsters = createEncounter(undefined, this.input.monsters, {}, this.input.encounters, stratum.table, this.rng);
    const state = createPartyCombatState(this.input.players, monsters, { pace: this.pace });
    const outcome = yield* fightSteps(state, this.rng, this.horizonMs ?? defaultHorizonMs(state), budget);
    const tally = this.tallies[index];
    const packXp = packRawXp(monsters);
    tally.n++;
    tally.ms += outcome.elapsedMs;
    tally.packXp += packXp;
    if (outcome.result === 'victory') {
      tally.wins++;
      tally.winPackXp += packXp;
    }
    this.outcomes.push(outcome);
  }

  converged(minSims: number, halfWidthPct: number): boolean {
    if (this.tallies.some(t => t.n < FORECAST_MIN_SIMS_PER_STRATUM)) return false;
    return converged(this.winRate(), this.outcomes.length, allAgree(this.outcomes), minSims, halfWidthPct);
  }

  result(): Omit<ForecastResult, 'key' | 'partyKey'> {
    const stats = summarize(this.outcomes, { winRate: this.winRate() });
    const unsampled = this.strata.reduce((sum, s, i) => sum + (this.tallies[i].n === 0 ? s.share : 0), 0);
    if (unsampled > 0 && stats.sims > 0) {
      stats.ci = [round1(stats.ci[0] * (1 - unsampled)), round1(stats.ci[1] * (1 - unsampled) + unsampled * 100)];
    }
    const strata: ForecastStratum[] = [];
    this.strata.forEach((s, i) => {
      const t = this.tallies[i];
      if (t.n === 0) return;
      const packFactor = t.wins > 0 && t.packXp > 0 ? (t.winPackXp / t.wins) / (t.packXp / t.n) : 1;
      strata.push({ label: s.label, entryId: s.entryId, winPct: round1((100 * t.wins) / t.n), sharePct: round1(s.share * 100), meanMs: t.ms / t.n, packFactor });
    });
    let worst: ForecastResult['worst'];
    if (strata.length >= 2) {
      for (const s of strata) {
        if (s.sharePct < FORECAST_WORST_MIN_SHARE_PCT) continue;
        if (!worst || s.winPct < worst.winPct) worst = { label: s.label, winPct: s.winPct, sharePct: s.sharePct };
      }
    }
    const out: Omit<ForecastResult, 'key' | 'partyKey'> = {
      ...stats,
      strata,
      reasons: reasonsFor(stats, this.party, this.enemies, this.pace.clock, { worst }),
    };
    if (worst) out.worst = worst;
    applyEnemyLevels(out, this.enemies);
    return out;
  }

  private nextStratum(): number {
    let under = -1;
    this.strata.forEach((s, i) => {
      const n = this.tallies[i].n;
      if (n >= FORECAST_MIN_SIMS_PER_STRATUM) return;
      if (under < 0 || n < this.tallies[under].n || (n === this.tallies[under].n && s.share > this.strata[under].share)) under = i;
    });
    if (under >= 0) return under;
    const total = this.outcomes.length + 1;
    let best = 0;
    let bestDeficit = -Infinity;
    this.strata.forEach((s, i) => {
      const deficit = s.share * total - this.tallies[i].n;
      if (deficit > bestDeficit + 1e-12) {
        best = i;
        bestDeficit = deficit;
      }
    });
    return best;
  }

  private winRate(): number {
    let weighted = 0;
    let share = 0;
    this.strata.forEach((s, i) => {
      const t = this.tallies[i];
      if (t.n === 0) return;
      weighted += s.share * (t.wins / t.n);
      share += s.share;
    });
    return share > 0 ? weighted / share : 0;
  }
}

function allAgree(outcomes: readonly SimOutcome[]): boolean {
  if (outcomes.length === 0) return false;
  const first = outcomes[0].result === 'victory';
  return outcomes.every(o => (o.result === 'victory') === first);
}

// --- Live battle sampler ---

class BattleSampler implements Sampler {
  readonly topTier: MonsterTier;
  readonly pace: CombatPace;
  private readonly base: PartyCombatState;
  private readonly outcomes: SimOutcome[] = [];
  private readonly party: PartyProfile;
  private readonly enemies: EnemySummary;
  private readonly horizonMs: number;

  constructor(
    state: PartyCombatState,
    private readonly rng: () => number,
    horizonMs: number | undefined,
    private readonly henchmenAllowed: boolean | undefined,
  ) {
    this.base = cloneCombatState(state);
    this.pace = state.pace;
    this.party = partyProfile(this.base.players);
    const profiles = stateProfiles(this.base);
    this.enemies = summarizeEnemies(profiles, profiles);
    this.topTier = this.enemies.topTier;
    this.horizonMs = horizonMs ?? defaultHorizonMs(this.base);
  }

  *sim(budget: Budget): SimGenerator {
    const state = cloneCombatState(this.base);
    this.outcomes.push(yield* fightSteps(state, this.rng, this.horizonMs, budget));
  }

  converged(minSims: number, halfWidthPct: number): boolean {
    const n = this.outcomes.length;
    const rate = n > 0 ? this.outcomes.filter(o => o.result === 'victory').length / n : 0;
    return converged(rate, n, allAgree(this.outcomes), minSims, halfWidthPct);
  }

  result(): Omit<ForecastResult, 'key' | 'partyKey'> {
    const stats = summarize(this.outcomes, { atMs: this.base.elapsedMs });
    const reasons = reasonsFor(stats, this.party, this.enemies, this.pace.clock, { henchmenAllowed: this.henchmenAllowed });
    const out: Omit<ForecastResult, 'key' | 'partyKey'> = { ...stats, reasons };
    applyEnemyLevels(out, this.enemies);
    return out;
  }
}

// --- Dungeon sampler (per-floor product) ---

interface FloorPlan {
  number: number;
  strata: TableStratum[];
  table: EncounterTableEntry[];
  boss: boolean;
}

interface FloorTally {
  n: number;
  wins: number;
  winMs: number[];
}

class DungeonSampler implements Sampler {
  readonly topTier: MonsterTier;
  readonly pace: CombatPace;
  private readonly plans: FloorPlan[];
  private readonly tallies: FloorTally[];
  private readonly runs: SimOutcome[] = [];
  private readonly killEtas: number[] = [];
  private enrageAtMs: number | null = null;
  private readonly party: PartyProfile;
  private readonly enemies: EnemySummary;

  constructor(private readonly input: DungeonForecastInput, private readonly rng: () => number, private readonly horizonMs: number | undefined) {
    this.pace = input.pace ?? AUTHORED_PACE;
    const floors = input.dungeon.floors ?? [];
    const startIndex = Math.min(Math.max(0, Math.floor(input.startFloorIndex ?? 0) || 0), Math.max(0, floors.length - 1));
    this.plans = floors.slice(startIndex).map((floor, i) => {
      const table = floor.encounterTable?.length ? floor.encounterTable : input.fallbackTable ?? [];
      const strata = tableStrata(table, input.monsters, input.encounters);
      return {
        number: startIndex + i + 1,
        strata,
        table,
        boss: !!floor.isBoss || strata.some(s => s.enemies.some(e => !e.passive && isBossTier(e.tier))),
      };
    });
    this.tallies = this.plans.map(() => ({ n: 0, wins: 0, winMs: [] }));
    this.party = partyProfile(input.players);
    const allStrata = this.plans.flatMap(p => p.strata);
    this.enemies = summarizeEnemies(allStrata.flatMap(s => s.enemies), commonEnemies(allStrata));
    this.topTier = this.enemies.topTier;
  }

  *sim(budget: Budget): SimGenerator {
    let cleared = true;
    let failure: SimResult = 'defeat';
    let totalMs = 0;
    let etaTaken = false;
    for (let f = 0; f < this.plans.length; f++) {
      const plan = this.plans[f];
      const tally = this.tallies[f];
      const monsters = createEncounter(undefined, this.input.monsters, {}, this.input.encounters, plan.table, this.rng);
      const state = createPartyCombatState(this.input.players, monsters, { pace: this.pace });
      const enrageAt = earliestEnrage(state);
      const last = yield* fightSteps(state, this.rng, this.horizonMs ?? defaultHorizonMs(state), budget);
      totalMs += last.elapsedMs;
      if (!etaTaken && last.bossDamageFrac !== undefined) {
        etaTaken = true;
        const eta = killEtaFor(last);
        if (eta !== null) this.killEtas.push(eta);
        if (enrageAt !== null) this.enrageAtMs = Math.min(this.enrageAtMs ?? Infinity, enrageAt);
      }
      tally.n++;
      if (last.result === 'victory') {
        tally.wins++;
        tally.winMs.push(last.elapsedMs);
      } else if (cleared) {
        cleared = false;
        failure = last.result;
      }
    }
    this.runs.push({ result: cleared ? 'victory' : failure, elapsedMs: totalMs });
  }

  converged(minSims: number, halfWidthPct: number): boolean {
    return converged(this.winRate(), this.runs.length, allAgree(this.runs), minSims, halfWidthPct);
  }

  result(): Omit<ForecastResult, 'key' | 'partyKey'> {
    const stats = summarize(this.runs, { winRate: this.winRate(), killEtas: this.killEtas });
    const floors: ForecastFloor[] = this.plans.map((plan, i) => {
      const t = this.tallies[i];
      const floor: ForecastFloor = { floor: plan.number, winPct: t.n > 0 ? round1((100 * t.wins) / t.n) : 0 };
      if (plan.boss) floor.boss = true;
      return floor;
    });
    const out: Omit<ForecastResult, 'key' | 'partyKey'> = {
      ...stats,
      floors,
      reasons: reasonsFor(stats, this.party, this.enemies, this.pace.clock, {
        enrageAtMs: this.enrageAtMs ?? this.enemies.enrageAtMs,
        medianMs: this.longestFloorMedianMs(),
        henchmenAllowed: false,
      }),
    };
    applyEnemyLevels(out, this.enemies);
    return out;
  }

  /** Median winning fight on the slowest floor; null until some floor has 3 wins. */
  private longestFloorMedianMs(): number | null {
    let longest: number | null = null;
    for (const t of this.tallies) {
      if (t.winMs.length < 3) continue;
      const median = quantile([...t.winMs].sort((a, b) => a - b), 0.5);
      longest = Math.max(longest ?? 0, Math.round(median));
    }
    return longest;
  }

  private winRate(): number {
    if (this.plans.length === 0 || this.runs.length === 0) return 0;
    return this.tallies.reduce((acc, t) => acc * (t.n > 0 ? t.wins / t.n : 0), 1);
  }
}

function earliestEnrage(state: PartyCombatState): number | null {
  let at: number | null = null;
  for (const m of state.monsters) {
    if (!m.passive && m.enrageState) at = Math.min(at ?? Infinity, m.enrageState.atMs);
  }
  return at;
}

// --- Job ---

class Job implements ForecastJob {
  readonly maxSims: number;
  private readonly budget: Budget = { left: 0 };
  private current: SimGenerator | null = null;
  private completed = 0;
  private stopped = false;
  private readonly minSims: number;
  private readonly halfWidthPct: number;

  constructor(private readonly sampler: Sampler, private readonly key: string, private readonly partyKeyValue: string, opts: ForecastJobOptions) {
    this.maxSims = Math.max(0, Math.floor(opts.maxSims ?? FORECAST_SIM_BUDGET[sampler.topTier]));
    this.minSims = Math.max(1, Math.floor(opts.minSims ?? FORECAST_MIN_SIMS));
    this.halfWidthPct = opts.halfWidthPct ?? FORECAST_TARGET_HALF_WIDTH_PCT;
  }

  get done(): boolean {
    return this.stopped || this.completed >= this.maxSims;
  }

  get sims(): number {
    return this.completed;
  }

  runSims(n: number): number {
    this.budget.left = Infinity;
    return this.drive(Math.max(0, Math.floor(n)));
  }

  advance(maxSteps: number): number {
    const steps = Math.max(0, Math.floor(maxSteps));
    if (steps === 0) return 0;
    this.budget.left = steps;
    this.drive(Infinity);
    const used = steps - Math.max(0, this.budget.left);
    this.budget.left = 0;
    return used;
  }

  result(): ForecastResult {
    const result = this.sampler.result();
    const real = (ms: number): number => paceRealMs(this.sampler.pace, ms);
    return {
      key: this.key,
      partyKey: this.partyKeyValue,
      ...result,
      medianMs: result.medianMs === null ? null : real(result.medianMs),
      p90Ms: result.p90Ms === null ? null : real(result.p90Ms),
      atMs: real(result.atMs),
      killEtaMs: result.killEtaMs === null ? null : real(result.killEtaMs),
      ...(result.strata ? { strata: result.strata.map(s => (s.meanMs === undefined ? s : { ...s, meanMs: real(s.meanMs) })) } : {}),
    };
  }

  private drive(maxSims: number): number {
    let finished = 0;
    while (!this.done && finished < maxSims) {
      this.current ??= this.sampler.sim(this.budget);
      if (!this.current.next().done) break;
      this.current = null;
      this.completed++;
      finished++;
      if (this.sampler.converged(this.minSims, this.halfWidthPct)) this.stopped = true;
    }
    return finished;
  }
}

/** A step-able forecast for a room table, a dungeon run or a live fight. See docs/architecture/combat.md. */
export function createForecastJob(input: ForecastInput, opts: ForecastJobOptions): ForecastJob {
  const rng = createRng(opts.seed ?? seedFromKey(opts.key));
  let sampler: Sampler;
  let key: string;
  switch (input.kind) {
    case 'room':
      sampler = new RoomSampler(input, rng, opts.horizonMs);
      key = opts.partyKey ?? partyKey(input.players);
      break;
    case 'dungeon':
      sampler = new DungeonSampler(input, rng, opts.horizonMs);
      key = opts.partyKey ?? partyKey(input.players);
      if (!input.dungeon.floors?.length) return new Job(sampler, opts.key, key, { ...opts, maxSims: 0 });
      break;
    case 'battle':
      sampler = new BattleSampler(input.state, rng, opts.horizonMs, input.henchmenAllowed);
      key = opts.partyKey ?? partyKey(input.state.players);
      break;
  }
  return new Job(sampler, opts.key, key, opts);
}

/** Runs a whole forecast synchronously (tests, tools); servers should slice with `advance`. */
export function runForecast(input: ForecastInput, opts: ForecastJobOptions): ForecastResult {
  const job = createForecastJob(input, opts);
  while (!job.done) job.runSims(job.maxSims);
  return job.result();
}
