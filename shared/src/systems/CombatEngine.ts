import type { ClassName, DamageType } from './CharacterStats.js';
import type { EquipmentBonuses } from './ItemTypes.js';
import type { MonsterInstance, MonsterSkillEntry, Resistance } from './MonsterTypes.js';
import { MONSTER_SKILL_CATALOG, getMonsterSkillCastTimeMs } from './MonsterSkills.js';
import type { MonsterSkillDefinition } from './MonsterSkills.js';
import type { SetBonuses } from './SetTypes.js';
import type { PartyGridPosition } from './SocialTypes.js';
import type { ActiveEffect, SkillDefinition, SkillTrigger } from './SkillTypes.js';
import { getSkillCardType, getSkillTrigger, isTimedSkill, resolveActionOrder } from './SkillTypes.js';
import type { CombatEvent, CombatEventKind, CombatRef, CombatResult } from './CombatEvents.js';
import { AUTHORED_PACE, paceKit, paceRealMs } from './CombatPace.js';
import type { CombatPace } from './CombatPace.js';
import {
  BASE_ACTION_INTERVAL_MS,
  BOSS_STALEMATE_WINDOW_MS,
  COMBAT_STEP_MS,
  FIRST_ACTION_MONSTER_MS,
  FIRST_ACTION_PLAYER_MS,
  INTERRUPT_DELAY_MS,
  MIN_MONSTER_ACTION_INTERVAL_MS,
  SCORCH_MS,
  STALEMATE_WINDOW_MS,
  STATUS_PULSE_MS,
  STUN_MS,
} from './CombatTiming.js';
import {
  FOCUS_MAX_STACKS,
  IGNITE_MAX_STACKS,
  MAX_DODGE,
  SUNDER_MAX_STACKS,
  WAR_SONG_MAX_STACKS,
  enrageStacksAt,
  isBossTier,
  masteryFactor,
  pairScaling,
  percentResistFactor,
  ratingMitigation,
  resolveEnrage,
  sanitizeLevel,
  scaleDamage,
} from './CombatScaling.js';
import type { CombatLevel } from './CombatScaling.js';
import {
  aliveOrUndefined,
  assassinateTarget,
  cureTarget,
  findLiveMonsterAt,
  findLivePlayerAt,
  findTarget,
  getCol,
  getRow,
  gridEnemyTarget,
  healTarget,
  isAlive,
  lowHpAlly,
  lowestHpEnemyTarget,
  monsterGridTarget,
  monsterHealTarget,
  monsterRef,
  playerRef,
  shieldTarget,
  stunSingleTarget,
} from './combat/CombatTargeting.js';
import {
  computeAttackBonus,
  computeBlessedArmsDamage,
  computeNimbleDodge,
  computeRallyMultiplier,
  computeUnnerveReduction,
  enrageMultiplier,
  getCritChance,
  getCritMultiplier,
  getHealPowerMultiplier,
  getIntensifyMod,
  getMonsterDamage,
  getPassiveEffects,
  getPassiveValue,
  getSkillWithPassive,
  hasArcaneSurge,
  hasPassive,
  healOptionAmount,
  incomingRating,
  initialWarmupMs,
  baseCycleMs,
  isUsableActive,
  monsterResistFactor,
  playerCastMs,
  skillRecoveryMs,
  useCooldownMs,
} from './combat/CombatPassives.js';
import {
  monsterSkillWouldHaveEffect,
  nextActionWaitMs,
  partyBuffStacks,
  redirectAllowed,
  wouldHaveEffect,
} from './combat/CombatNeeds.js';

export { findTarget } from './combat/CombatTargeting.js';
export { applyMonsterResistance, effectiveCooldownMs } from './combat/CombatPassives.js';
export { wouldHaveEffect } from './combat/CombatNeeds.js';
export { buildClientCombatSnapshot } from './combat/CombatSnapshot.js';
export { createRng } from './combat/CombatRng.js';

// --- Types ---

export interface TickResult {
  logEntries: string[];
  events: CombatEvent[];
  finished: boolean;
  result: CombatResult | null;
}

export interface DotEffect {
  sourceUsername: string;
  /** Grouping key for pulses and log lines (lowercased skill name). */
  name: string;
  /** Display name. */
  label?: string;
  source?: CombatRef;
  damagePerTick: number;
  /** Pulses left. */
  ticksRemaining: number;
  damageType: DamageType;
  /** Never expires for the rest of combat. */
  permanent?: boolean;
}

export interface HotEffect {
  sourceUsername: string;
  name: string;
  label?: string;
  source?: CombatRef;
  healPerTick: number;
  /** Pulses left. */
  ticksRemaining: number;
}

export interface CombatBuff {
  type: string;
  value: number;
  /** -1 = permanent (rest of combat). */
  remainingMs: number;
  name?: string;
}

export interface CombatDebuff {
  type: string;
  value: number;
  remainingMs: number;
  name?: string;
}

export interface SunderMark {
  /** Number of mark applications (display/log only — the damage bonus lives in totalBonus). */
  stacks: number;
  /** Accumulated incoming-damage bonus; each application adds its own skill's multiplier. */
  totalBonus?: number;
  name?: string;
}

export interface CombatCast {
  skillId: string;
  skillName: string;
  totalMs: number;
  remainingMs: number;
  target?: CombatRef;
  counter?: { reactorUsername: string; skillId: string; atMs: number };
}

/** An interrupt committed at a monster's cast start, resolving `INTERRUPT_DELAY_MS` later. */
export interface PendingCounter {
  reactorUsername: string;
  skillId: string;
  casterIndex: number;
  monsterSkillId: string;
  atMs: number;
}

/** Display bookkeeping for party-wide permanent buffs (War Song); the damage lives in `warSongBonus`. */
export interface PartyBuff {
  name: string;
  stacks: number;
}

export interface PartyCombatant {
  username: string;
  maxHp: number;
  currentHp: number;
  baseDamage: number;
  playerDamageType: DamageType;
  equipBonuses?: EquipmentBonuses;
  /**
   * Aggregated set bonuses for the highest unlocked breakpoint of every active set, filtered by class.
   * Flat components are pre-merged into `equipBonuses`; this carries the multiplicative pieces.
   */
  setBonuses?: SetBonuses;
  gridPosition: PartyGridPosition;
  className: ClassName;
  level: number;
  /** Set for hired henchmen — the only thing distinguishing one from a player. Their level counts as derived. */
  isHenchman?: boolean;
  /** Kill-mastery rank per monster definition id. */
  mastery?: Record<string, number>;
  /** Resolved equipped skill definitions (indexed by slot). */
  equippedSkills: (SkillDefinition | null)[];
  /** The class's basic attack. Absent keeps the old opener and interval, with an auto always ready at each action. */
  attack?: SkillDefinition;
  /** The player's priority list. See `resolveActionOrder`. */
  actionOrder?: string[];
  /** Actions taken this combat. */
  attackCount: number;
  hasResolvedCast: boolean;
  dots: DotEffect[];
  hots: HotEffect[];
  damageShield: number;
  debuffs: CombatDebuff[];
  /** Consecutive hits on the same target name (Focus). */
  consecutiveHits: number;
  lastTargetId: string;
  hasResurrected: boolean;
  /** Martyr heal bonus waiting for the next heal. */
  martyrBonus: number;
  /** Active skills resolved this combat (Arcane Surge cadence). */
  activeSkillCount: number;
  /** See paceKit. Scales this unit's actions, never its reactions. */
  kit: number;
  actionIntervalMs: number;
  actionRemainingMs: number;
  /** Length of the current wait. With an Attack skill, the wait from the last action to the next, for the client's ring. */
  actionTotalMs: number;
  /** Never outlasts `actionRemainingMs`, which is what holds back the owner's turn. */
  recoveryRemainingMs: number;
  recoveryTotalMs: number;
  pulseRemainingMs: number;
  stunRemainingMs: number;
  stunTotalMs: number;
  stunSource?: CombatRef;
  cast: CombatCast | null;
  /** Cooldown ms remaining per equipped active skill id. */
  skillCooldowns: Record<string, number>;
  /** Length of each skill's current/last cooldown (warm-up included). */
  skillCooldownTotals: Record<string, number>;
}

type EngineTimerField =
  | 'kit' | 'actionIntervalMs' | 'actionRemainingMs' | 'actionTotalMs' | 'recoveryRemainingMs' | 'recoveryTotalMs' | 'pulseRemainingMs'
  | 'stunRemainingMs' | 'stunTotalMs' | 'stunSource' | 'cast' | 'skillCooldowns' | 'skillCooldownTotals';

type EngineResetField =
  | 'currentHp' | 'attackCount' | 'hasResolvedCast' | 'dots' | 'hots' | 'damageShield' | 'debuffs' | 'consecutiveHits'
  | 'lastTargetId' | 'hasResurrected' | 'martyrBonus' | 'activeSkillCount';

/** What callers hand `createPartyCombatState`; the engine owns (and resets) every per-battle field. */
export type PartyCombatantInit = Omit<PartyCombatant, EngineTimerField | EngineResetField>
  & Partial<Pick<PartyCombatant, EngineResetField>>;

export interface CombatMonster extends MonsterInstance {
  dots: DotEffect[];
  sunderMark: SunderMark | null;
  debuffs: CombatDebuff[];
  buffs: CombatBuff[];
  /** The next action hits a random monster instead of the party. */
  chaosActive: boolean;
  chaosName?: string;
  resistances: Resistance[];
  skills: MonsterSkillEntry[];
  /** Cooldown ms remaining per skill id. */
  skillCooldowns: Record<string, number>;
  attackCount: number;
  actionIntervalMs: number;
  actionRemainingMs: number;
  actionTotalMs: number;
  stunRemainingMs: number;
  stunTotalMs: number;
  pulseRemainingMs: number;
  cast: CombatCast | null;
  enrageState: CombatEnrage | null;
}

/** A monster's enrage clock in battle time (see `enrageStacksAt`). */
export interface CombatEnrage {
  atMs: number;
  stepMs: number;
  stepPercent: number;
  maxStacks: number;
  stacks: number;
}

export interface CombatBossPhases {
  /** Indices into `state.monsters`. */
  bossIndices: number[];
  /** Descending boss-HP fractions in (0, 1). */
  thresholds: number[];
  /** Thresholds crossed so far (resumed fights start at `resumedFromPhase`). */
  phase: number;
  resumedFromPhase?: number;
}

export interface CombatSetup {
  bossPhases?: {
    /** Indices into the `monsters` argument; default = every boss/raid-tier monster. */
    bossIndices?: number[];
    thresholds: number[];
    /** Start at checkpoint k: bosses at `thresholds[k − 1]` of max HP. */
    resumePhase?: number;
    /** Enrage clock offset on resume; default `(1 − thresholds[k − 1]) × afterSeconds`. */
    resumeElapsedMs?: number;
  };
  /** Default AUTHORED_PACE. Real fights pass COMBAT_PACE. */
  pace?: CombatPace;
}

export interface PartyCombatState {
  /** Fixed for the whole fight: engine time stays in authored units, and clients get it through paceRealMs. */
  pace: CombatPace;
  players: PartyCombatant[];
  monsters: CombatMonster[];
  /** Steps processed. */
  tickCount: number;
  elapsedMs: number;
  nextEventId: number;
  finished: boolean;
  /** 'retreat' is only ever set by the server timer. */
  result: CombatResult | null;
  /** Stalemate tracking: when the living monsters' HP sum last reached a new low. */
  lastProgressMs: number;
  lowestMonsterHp: number;
  pendingCounters: PendingCounter[];
  partyBuffs: PartyBuff[];
  rallyMultiplier: number;
  warSongBonus: number;
  nimbleDodge: number;
  unnerveReduction: number;
  blessedArmsDamage: number;
  bossPhases: CombatBossPhases | null;
  /** Lowest Σ player HP / Σ max HP seen at a step boundary. */
  minPartyHpFrac: number;
}

/** A monster's single-target attack between target selection and damage; Intercept rewrites `target`. */
export interface InFlightAttack {
  attacker: CombatMonster;
  target: PartyCombatant;
  /** The resolution of a telegraphed cast locked onto its target. */
  lockedCast: boolean;
  redirected: boolean;
  skillName?: string;
}

/** Where an active skill is being resolved from: action (empty), cast resolution, reaction or counter. */
export interface EffectContext {
  trigger?: SkillTrigger;
  ally?: PartyCombatant;
  enemy?: CombatMonster;
  attack?: InFlightAttack;
  hit?: { amount: number; damageType: DamageType; attacker: CombatMonster };
  /** A stun landing on this monster leaves its cast for the pending counter to cancel. */
  suppressInterruptFor?: CombatMonster;
}

interface Step {
  state: PartyCombatState;
  log: string[];
  events: CombatEvent[];
  /** Cooldowns started this step — not decremented until the next one. */
  fresh: Set<string>;
  rng: () => number;
  /** Set while a player's action resolves, so reactions raised outside one stay at 1. */
  kit: number;
}

type EventFields = Omit<CombatEvent, 'id' | 't' | 'kind'>;

const FIRST_ACTION_STAGGER_MS = 100;
const PLAYER_STAGGER_CAP = 5;
const MONSTER_STAGGER_CAP = 8;
const STALEMATE_ATTACK_CHANCES = 2;

// --- Public API ---

/** Build a fresh combat. Players sort front-to-back/top-to-bottom; monsters front (col 0) first. */
export function createPartyCombatState(
  players: PartyCombatantInit[],
  monsters: MonsterInstance[],
  setup: CombatSetup = {},
): PartyCombatState {
  const pace = setup.pace ?? AUTHORED_PACE;
  const sortedPlayers: PartyCombatant[] = players.map(p => ({
    ...p,
    attack: p.attack?.type === 'attack' && isTimedSkill(p.attack) ? p.attack : undefined,
    equippedSkills: [...p.equippedSkills],
    currentHp: p.maxHp,
    attackCount: 0,
    hasResolvedCast: false,
    dots: [],
    hots: [],
    damageShield: 0,
    debuffs: [],
    consecutiveHits: 0,
    lastTargetId: '',
    hasResurrected: false,
    martyrBonus: 0,
    activeSkillCount: 0,
    kit: paceKit(pace, p.className),
    actionIntervalMs: Math.round(BASE_ACTION_INTERVAL_MS * paceKit(pace, p.className)),
    actionRemainingMs: 0,
    actionTotalMs: 0,
    recoveryRemainingMs: 0,
    recoveryTotalMs: 0,
    pulseRemainingMs: 0,
    stunRemainingMs: 0,
    stunTotalMs: 0,
    stunSource: undefined,
    cast: null,
    skillCooldowns: {},
    skillCooldownTotals: {},
  })).sort((a, b) => {
    const colDiff = getCol(b.gridPosition) - getCol(a.gridPosition);
    if (colDiff !== 0) return colDiff;
    return getRow(a.gridPosition) - getRow(b.gridPosition);
  });

  for (const p of sortedPlayers) {
    for (const effect of getPassiveEffects(p, 'bonus_damage')) {
      p.baseDamage += (effect.valuePerLevel ?? 0) * p.level;
    }
    for (const effect of getPassiveEffects(p, 'max_hp_percent')) {
      p.maxHp += Math.floor(p.maxHp * (effect.valuePerLevel ?? 0) * p.level / 100);
      p.currentHp = p.maxHp;
    }
  }

  sortedPlayers.forEach((p, i) => {
    const stagger = FIRST_ACTION_STAGGER_MS * Math.min(i, PLAYER_STAGGER_CAP);
    const offset = FIRST_ACTION_PLAYER_MS + stagger;
    p.pulseRemainingMs = offset;
    if (p.attack) {
      const opener = initialWarmupMs(pace, p, p.attack, sortedPlayers) + stagger;
      p.skillCooldowns[p.attack.id] = opener;
      p.skillCooldownTotals[p.attack.id] = opener;
    } else {
      p.actionRemainingMs = offset;
      p.actionTotalMs = offset;
    }
    for (const skill of p.equippedSkills) {
      if (!isUsableActive(skill)) continue;
      const warmup = initialWarmupMs(pace, p, skill, sortedPlayers);
      p.skillCooldowns[skill.id] = warmup;
      p.skillCooldownTotals[skill.id] = warmup;
    }
  });

  const builtMonsters: CombatMonster[] = monsters.map(m => ({
    ...m,
    dots: [],
    sunderMark: null,
    debuffs: [],
    buffs: [],
    chaosActive: false,
    resistances: (m.resistances ?? []).map(r => ({ ...r })),
    skills: (m.skills ?? []).map(s => ({ ...s })),
    skillCooldowns: Object.fromEntries((m.skills ?? []).map(s => [s.skillId, 0])),
    attackCount: 0,
    actionIntervalMs: 0,
    actionRemainingMs: 0,
    actionTotalMs: 0,
    stunRemainingMs: 0,
    stunTotalMs: 0,
    pulseRemainingMs: 0,
    cast: null,
    enrageState: m.passive ? null : initialEnrage(m),
  }));
  const sortedMonsters = [...builtMonsters].sort((a, b) => {
    const colDiff = getCol(a.gridPosition) - getCol(b.gridPosition);
    if (colDiff !== 0) return colDiff;
    return getRow(a.gridPosition) - getRow(b.gridPosition);
  });
  const bossPhases = setupBossPhases(builtMonsters, sortedMonsters, setup.bossPhases);

  sortedMonsters.forEach((m, i) => {
    const offset = FIRST_ACTION_MONSTER_MS + FIRST_ACTION_STAGGER_MS * Math.min(i, MONSTER_STAGGER_CAP);
    m.pulseRemainingMs = offset;
    if (m.passive) return;
    m.actionIntervalMs = monsterActionIntervalMs(m.attackInterval);
    m.actionRemainingMs = offset;
    m.actionTotalMs = offset;
  });

  const state: PartyCombatState = {
    pace,
    players: sortedPlayers,
    monsters: sortedMonsters,
    tickCount: 0,
    elapsedMs: 0,
    nextEventId: 1,
    finished: false,
    result: null,
    lastProgressMs: 0,
    lowestMonsterHp: livingMonsterHp(sortedMonsters),
    pendingCounters: [],
    partyBuffs: [],
    rallyMultiplier: computeRallyMultiplier(sortedPlayers),
    warSongBonus: 0,
    nimbleDodge: Math.min(MAX_DODGE, computeNimbleDodge(sortedPlayers)),
    unnerveReduction: computeUnnerveReduction(sortedPlayers),
    blessedArmsDamage: computeBlessedArmsDamage(sortedPlayers),
    bossPhases,
    minPartyHpFrac: partyHpFraction(sortedPlayers),
  };
  for (const p of sortedPlayers) {
    if (p.attack) p.actionTotalMs = nextActionWaitMs(state, p);
  }
  return state;
}

/**
 * Advance combat by one step (`dtMs` clamped to (0, COMBAT_STEP_MS]). Mutates `state`.
 * `rng` is read per call so `vi.spyOn(Math, 'random')` keeps working.
 */
export function processCombatStep(
  state: PartyCombatState,
  dtMs: number = COMBAT_STEP_MS,
  rng: () => number = Math.random,
): TickResult {
  if (state.finished) {
    return { logEntries: [], events: [], finished: true, result: state.result };
  }
  const dt = Number.isFinite(dtMs) ? Math.min(COMBAT_STEP_MS, Math.max(1, dtMs)) : COMBAT_STEP_MS;
  state.elapsedMs += dt;
  state.tickCount++;
  const step: Step = { state, log: [], events: [], fresh: new Set(), rng, kit: 1 };
  if (state.tickCount === 1) emit(step, 'battle_start');
  runStep(step, dt);
  state.minPartyHpFrac = Math.min(state.minPartyHpFrac, partyHpFraction(state.players));
  return { logEntries: step.log, events: step.events, finished: state.finished, result: state.result };
}

/** Real time between steps. A step is always COMBAT_STEP_MS of authored time, so a pace only spaces them out. */
export function combatRealStepMs(state: PartyCombatState): number {
  return paceRealMs(state.pace, COMBAT_STEP_MS);
}

export function combatRealElapsedMs(state: PartyCombatState): number {
  return paceRealMs(state.pace, state.elapsedMs);
}

/** Run `ceil(ms / COMBAT_STEP_MS)` full steps, stopping early when the fight ends. */
export function advanceCombat(state: PartyCombatState, ms: number, rng: () => number = Math.random): TickResult {
  const logEntries: string[] = [];
  const events: CombatEvent[] = [];
  const steps = Math.ceil(ms / COMBAT_STEP_MS);
  for (let i = 0; i < steps && !state.finished; i++) {
    const result = processCombatStep(state, COMBAT_STEP_MS, rng);
    logEntries.push(...result.logEntries);
    events.push(...result.events);
  }
  return { logEntries, events, finished: state.finished, result: state.result };
}

/** Deep-copies every per-battle mutable field; content (skills, gear, resistances, monster skills) stays shared. */
export function cloneCombatState(state: PartyCombatState): PartyCombatState {
  return {
    ...state,
    players: state.players.map(clonePlayer),
    monsters: state.monsters.map(cloneMonster),
    pendingCounters: state.pendingCounters.map(c => ({ ...c })),
    partyBuffs: state.partyBuffs.map(b => ({ ...b })),
    bossPhases: state.bossPhases
      ? { ...state.bossPhases, bossIndices: [...state.bossPhases.bossIndices], thresholds: [...state.bossPhases.thresholds] }
      : null,
  };
}

// --- Setup ---

function initialEnrage(monster: MonsterInstance): CombatEnrage | null {
  const resolved = resolveEnrage(monster.tier, monster.enrage);
  if (!resolved) return null;
  const { afterMs, stepMs, stepPercent, maxStacks } = resolved;
  return { atMs: afterMs, stepMs, stepPercent, maxStacks, stacks: 0 };
}

function setupBossPhases(
  built: CombatMonster[],
  sorted: CombatMonster[],
  opts: CombatSetup['bossPhases'],
): CombatBossPhases | null {
  const bosses = opts?.bossIndices
    ? [...new Set(opts.bossIndices)].filter(i => Number.isInteger(i) && i >= 0 && i < built.length).map(i => built[i])
    : built.filter(m => !m.passive && isBossTier(m.tier));
  if (bosses.length === 0) return null;
  const thresholds = [...new Set((opts?.thresholds ?? []).filter(isPhaseThreshold))].sort((a, b) => b - a);
  const phases: CombatBossPhases = {
    bossIndices: bosses.map(b => sorted.indexOf(b)).sort((a, b) => a - b),
    thresholds,
    phase: 0,
  };
  const k = opts?.resumePhase;
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > thresholds.length) return phases;

  const fraction = thresholds[k - 1];
  for (const boss of bosses) {
    if (Number.isFinite(boss.maxHp) && boss.maxHp > 0) boss.currentHp = Math.max(1, Math.ceil(boss.maxHp * fraction));
  }
  const offsetMs = opts?.resumeElapsedMs;
  for (const monster of built) {
    const enrage = monster.enrageState;
    if (!enrage) continue;
    enrage.atMs = typeof offsetMs === 'number' && Number.isFinite(offsetMs) && offsetMs >= 0
      ? Math.max(0, enrage.atMs - offsetMs)
      : Math.round(enrage.atMs / 1000 * fraction) * 1000;
  }
  phases.phase = k;
  phases.resumedFromPhase = k;
  return phases;
}

function isPhaseThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
}

function partyHpFraction(players: PartyCombatant[]): number {
  let hp = 0;
  let max = 0;
  for (const p of players) {
    hp += Math.max(0, finiteOr0(p.currentHp));
    max += Math.max(0, finiteOr0(p.maxHp));
  }
  return max > 0 ? hp / max : 0;
}

function clonePlayer(p: PartyCombatant): PartyCombatant {
  return {
    ...p,
    equippedSkills: [...p.equippedSkills],
    dots: p.dots.map(d => ({ ...d })),
    hots: p.hots.map(h => ({ ...h })),
    debuffs: p.debuffs.map(d => ({ ...d })),
    cast: p.cast ? cloneCast(p.cast) : null,
    skillCooldowns: { ...p.skillCooldowns },
    skillCooldownTotals: { ...p.skillCooldownTotals },
  };
}

function cloneMonster(m: CombatMonster): CombatMonster {
  return {
    ...m,
    dots: m.dots.map(d => ({ ...d })),
    sunderMark: m.sunderMark ? { ...m.sunderMark } : null,
    debuffs: m.debuffs.map(d => ({ ...d })),
    buffs: m.buffs.map(b => ({ ...b })),
    cast: m.cast ? cloneCast(m.cast) : null,
    skillCooldowns: { ...m.skillCooldowns },
    enrageState: m.enrageState ? { ...m.enrageState } : null,
  };
}

function cloneCast(cast: CombatCast): CombatCast {
  const copy: CombatCast = { ...cast };
  if (cast.counter) copy.counter = { ...cast.counter };
  return copy;
}

// --- Step ---

function runStep(step: Step, dt: number): void {
  const { state } = step;
  enragePass(step);
  statusPass(step, dt);
  if (checkEnd(step)) return;

  resolveDueCounters(step);
  if (checkEnd(step)) return;

  for (const player of state.players) {
    actPlayerSlot(step, player, dt);
    if (checkEnd(step)) return;
  }
  for (const monster of state.monsters) {
    actMonsterSlot(step, monster, dt);
    if (checkEnd(step)) return;
  }

  evaluateLevelTriggers(step);
  if (checkEnd(step)) return;

  checkStalemate(step);
}

function emit(step: Step, kind: CombatEventKind, fields: EventFields = {}): CombatEvent {
  const { pace, elapsedMs } = step.state;
  const event: CombatEvent = { id: step.state.nextEventId++, t: paceRealMs(pace, elapsedMs), kind, ...fields };
  if (event.durationMs !== undefined) event.durationMs = paceRealMs(pace, event.durationMs);
  if (event.recoveryMs !== undefined) event.recoveryMs = paceRealMs(pace, event.recoveryMs);
  step.events.push(event);
  return event;
}

function finish(step: Step, result: 'victory' | 'defeat'): void {
  const { state } = step;
  if (state.finished) return;
  state.finished = true;
  state.result = result;
  emit(step, 'battle_end', { result });
}

/** Walls don't count toward victory, but a wall-only fight still gives the party its opening round. A timed cast chained after that round doesn't extend it. */
function isVictory(state: PartyCombatState): boolean {
  if (state.monsters.every(m => !isAlive(m))) return true;
  if (state.monsters.some(m => !m.passive)) return state.monsters.every(m => m.passive || !isAlive(m));
  return state.players.every(p => !isAlive(p) || (p.attackCount > 0 && (!p.cast || p.hasResolvedCast)));
}

// Victory is tested first, so a mutual wipe is a victory.
function checkEnd(step: Step): boolean {
  const { state } = step;
  if (state.finished) return true;
  if (isVictory(state)) {
    finish(step, 'victory');
    return true;
  }
  updateBossPhase(step);
  if (state.players.every(p => !isAlive(p))) {
    finish(step, 'defeat');
    return true;
  }
  return false;
}

function livingMonsterHp(monsters: CombatMonster[]): number {
  let total = 0;
  for (const m of monsters) {
    if (isAlive(m)) total += m.currentHp;
  }
  return total;
}

function checkStalemate(step: Step): void {
  const { state } = step;
  const hp = livingMonsterHp(state.monsters);
  if (hp < state.lowestMonsterHp) {
    state.lowestMonsterHp = hp;
    state.lastProgressMs = state.elapsedMs;
    return;
  }
  const bossAlive = state.monsters.some(m => isAlive(m) && !m.passive && isBossTier(m.tier));
  const stalledMs = state.elapsedMs - state.lastProgressMs;
  if (stalledMs >= (bossAlive ? BOSS_STALEMATE_WINDOW_MS : STALEMATE_WINDOW_MS) && stalledMs >= slowAttackGraceMs(state)) {
    step.log.push('The fight drags on — the party withdraws.');
    finish(step, 'defeat');
  }
}

/** A stall isn't proven until a living player's slowest Attack has had two chances to land. */
function slowAttackGraceMs(state: PartyCombatState): number {
  let slowest = 0;
  for (const p of state.players) {
    if (!p.attack || !isAlive(p)) continue;
    slowest = Math.max(slowest, initialWarmupMs(state.pace, p, p.attack, state.players), baseCycleMs(state.pace, p, p.attack));
  }
  return slowest * STALEMATE_ATTACK_CHANCES;
}

function updateBossPhase(step: Step): void {
  const { state } = step;
  const phases = state.bossPhases;
  if (!phases || phases.phase >= phases.thresholds.length) return;
  let hp = 0;
  let max = 0;
  for (const i of phases.bossIndices) {
    const boss = state.monsters[i];
    if (!boss) continue;
    hp += Math.max(0, boss.currentHp);
    max += boss.maxHp;
  }
  if (!(max > 0)) return;
  const fraction = hp / max;
  let advanced = false;
  while (phases.phase < phases.thresholds.length && fraction <= phases.thresholds[phases.phase]) {
    phases.phase++;
    advanced = true;
    emit(step, 'phase', { amount: phases.phase });
    step.log.push(`Checkpoint ${phases.phase} reached!`);
  }
  if (advanced) {
    state.lowestMonsterHp = livingMonsterHp(state.monsters);
    state.lastProgressMs = state.elapsedMs;
  }
}

function enragePass(step: Step): void {
  for (const monster of step.state.monsters) {
    const enrage = monster.enrageState;
    if (!enrage || !isAlive(monster)) continue;
    const stacks = enrageStacksAt(enrage, step.state.elapsedMs);
    if (stacks <= enrage.stacks) continue;
    enrage.stacks = stacks;
    emit(step, 'enrage', { src: monsterRef(monster), amount: stacks });
    step.log.push(`${monster.name} is enraged! (×${formatMultiplier(enrageMultiplier(monster))})`);
  }
}

function formatMultiplier(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// --- Level-relative scaling ---

function playerLevel(player: PartyCombatant): CombatLevel {
  return { level: sanitizeLevel(player.level), derived: !!player.isHenchman };
}

function monsterLevel(monster: CombatMonster): CombatLevel {
  const derived = monster.levelSource ? monster.levelSource !== 'authored' : monster.level === undefined;
  return { level: sanitizeLevel(monster.level), derived, estimated: derived };
}

/** A monster's damage to a player: gap × mastery × rating mitigation × set resist %, floor 1. */
function mitigateHitOnPlayer(
  state: PartyCombatState,
  target: PartyCombatant,
  raw: number,
  damageType: DamageType,
  attacker: CombatMonster | undefined,
): number {
  const defender = playerLevel(target);
  const { gap, mitigationLevel } = pairScaling(attacker ? monsterLevel(attacker) : { ...defender, derived: true }, defender);
  const mastery = attacker ? masteryFactor(target.mastery?.[attacker.id], 'taken') : 1;
  const mitigation = ratingMitigation(incomingRating(target, damageType, state.players), mitigationLevel);
  return scaleDamage(raw, gap * mastery * (1 - mitigation) * percentResistFactor(target.setBonuses?.damageResistancePercent));
}

/** A player's damage to a monster: gap × mastery × the monster's resistance, floor 1. */
function mitigateHitOnMonster(
  target: CombatMonster,
  raw: number,
  damageType: DamageType,
  attacker: PartyCombatant | undefined,
): number {
  const defender = monsterLevel(target);
  const { gap, mitigationLevel } = pairScaling(attacker ? playerLevel(attacker) : { ...defender, derived: true }, defender);
  const mastery = attacker ? masteryFactor(attacker.mastery?.[target.id], 'dealt') : 1;
  return scaleDamage(raw, gap * mastery * monsterResistFactor(target.resistances, damageType, mitigationLevel));
}

function playerFromRef(state: PartyCombatState, ref: CombatRef | undefined): PartyCombatant | undefined {
  return ref?.side === 'player' ? state.players.find(p => p.gridPosition === ref.pos) : undefined;
}

function monsterFromRef(state: PartyCombatState, ref: CombatRef | undefined): CombatMonster | undefined {
  return ref?.side === 'monster' ? state.monsters.find(m => m.gridPosition === ref.pos) : undefined;
}

function monsterActionIntervalMs(attackInterval: number | undefined): number {
  const seconds = attackInterval !== undefined && Number.isFinite(attackInterval) ? attackInterval : 1;
  return Math.max(MIN_MONSTER_ACTION_INTERVAL_MS, Math.round(seconds * 1000));
}

function unitKey(state: PartyCombatState, unit: PartyCombatant | CombatMonster): string {
  return 'username' in unit ? `p:${unit.username}` : `m:${state.monsters.indexOf(unit)}`;
}

function tickCooldowns(step: Step, cooldowns: Record<string, number>, key: string, dt: number): void {
  for (const id of Object.keys(cooldowns)) {
    if (cooldowns[id] <= 0 || step.fresh.has(`${key}:${id}`)) continue;
    cooldowns[id] = Math.max(0, cooldowns[id] - dt);
  }
}

function scheduleNextAction(unit: PartyCombatant | CombatMonster, castMs: number, castsAddTime = false): void {
  const castWait = castsAddTime ? unit.actionIntervalMs + castMs : Math.max(unit.actionIntervalMs, castMs);
  const wait = castMs > 0 ? castWait : unit.actionIntervalMs;
  unit.actionRemainingMs = Math.max(1, unit.actionRemainingMs + wait);
  unit.actionTotalMs = wait;
}

function tickStun(unit: PartyCombatant | CombatMonster, dt: number): void {
  unit.stunRemainingMs = Math.max(0, unit.stunRemainingMs - dt);
  if (unit.stunRemainingMs === 0) unit.stunTotalMs = 0;
}

// --- Status pass (debuff expiry + DoT/HoT pulses) ---

function statusPass(step: Step, dt: number): void {
  const { state } = step;
  for (const player of state.players) {
    if (!isAlive(player)) continue;
    tickTimedList(player.debuffs, dt);
    player.pulseRemainingMs -= dt;
    if (player.pulseRemainingMs <= 0) {
      player.pulseRemainingMs += STATUS_PULSE_MS;
      pulsePlayer(step, player);
    }
  }
  for (const monster of state.monsters) {
    if (!isAlive(monster)) continue;
    tickTimedList(monster.debuffs, dt);
    tickTimedList(monster.buffs, dt);
    monster.pulseRemainingMs -= dt;
    if (monster.pulseRemainingMs <= 0) {
      monster.pulseRemainingMs += STATUS_PULSE_MS;
      pulseMonster(step, monster);
    }
  }
}

function tickTimedList(list: { remainingMs: number }[], dt: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].remainingMs < 0) continue;
    list[i].remainingMs -= dt;
    if (list[i].remainingMs <= 0) list.splice(i, 1);
  }
}

interface DotGroup {
  name: string;
  label: string;
  total: number;
  count: number;
  damageType: DamageType;
  source?: CombatRef;
}

function pulseDotGroups(dots: DotEffect[]): DotGroup[] {
  const grouped = new Map<string, DotGroup>();
  for (let i = dots.length - 1; i >= 0; i--) {
    const dot = dots[i];
    const key = `${dot.name}|${dot.source ? `${dot.source.side}:${dot.source.pos}` : ''}`;
    const group = grouped.get(key);
    if (group) {
      group.total += dot.damagePerTick;
      group.count++;
    } else {
      grouped.set(key, {
        name: dot.name,
        label: dot.label ?? dot.name,
        total: dot.damagePerTick,
        count: 1,
        damageType: dot.damageType,
        source: dot.source,
      });
    }
    if (!dot.permanent) {
      dot.ticksRemaining--;
      if (dot.ticksRemaining <= 0) dots.splice(i, 1);
    }
  }
  return [...grouped.values()];
}

function realSeconds(state: PartyCombatState, engineMs: number): number {
  return state.pace.clock === 1 ? engineMs / 1000 : Math.round(paceRealMs(state.pace, engineMs) / 100) / 10;
}

function pulseText(state: PartyCombatState, pulses: number): string {
  const { clock } = state.pace;
  const every = clock === 1 ? 'per second' : `every ${clock} seconds`;
  return `${every} for ${realSeconds(state, pulses * STATUS_PULSE_MS)} seconds`;
}

function stackSuffix(count: number): string {
  return count > 1 ? ` (x${count})` : '';
}

function pulsePlayer(step: Step, player: PartyCombatant): void {
  const { state } = step;
  if (player.dots.length > 0) {
    for (const group of pulseDotGroups(player.dots)) {
      const damage = mitigateHitOnPlayer(state, player, group.total, group.damageType, monsterFromRef(state, group.source));
      player.currentHp = Math.max(0, player.currentHp - damage);
      emit(step, 'damage', {
        src: group.source, dst: playerRef(player), amount: damage, dmgType: group.damageType, overTime: true, skill: group.label,
      });
      step.log.push(`${player.username} receives ${damage} ${group.damageType} damage from ${group.name}${stackSuffix(group.count)}!`);
      if (player.className === 'Knight' && damage > 0) triggerMartyr(state, player);
      if (!isAlive(player)) {
        handlePlayerDown(step, player, group.source);
        if (!isAlive(player)) return;
      }
    }
  }

  if (player.hots.length > 0) {
    const grouped = new Map<string, { total: number; count: number; label: string; source?: CombatRef }>();
    for (let i = player.hots.length - 1; i >= 0; i--) {
      const hot = player.hots[i];
      const amount = Math.min(hot.healPerTick, player.maxHp - player.currentHp);
      player.currentHp += amount;
      if (amount > 0) {
        const group = grouped.get(hot.name);
        if (group) {
          group.total += amount;
          group.count++;
        } else {
          grouped.set(hot.name, { total: amount, count: 1, label: hot.label ?? hot.name, source: hot.source });
        }
      }
      hot.ticksRemaining--;
      if (hot.ticksRemaining <= 0) player.hots.splice(i, 1);
    }
    for (const [name, group] of grouped) {
      emit(step, 'heal', { src: group.source, dst: playerRef(player), amount: group.total, overTime: true, skill: group.label });
      step.log.push(`${player.username} heals for ${group.total} HP from ${name}${stackSuffix(group.count)}`);
    }
  }
}

function pulseMonster(step: Step, monster: CombatMonster): void {
  if (monster.dots.length === 0) return;
  for (const group of pulseDotGroups(monster.dots)) {
    const damage = mitigateHitOnMonster(monster, group.total, group.damageType, playerFromRef(step.state, group.source));
    monster.currentHp = Math.max(0, monster.currentHp - damage);
    emit(step, 'damage', {
      src: group.source, dst: monsterRef(monster), amount: damage, dmgType: group.damageType, overTime: true, skill: group.label,
    });
    step.log.push(`${monster.name} receives ${damage} ${group.damageType} damage from ${group.name}${stackSuffix(group.count)}!`);
    if (!isAlive(monster)) {
      step.log.push(`${monster.name} defeated! (DoT)`);
      markMonsterDead(step, monster, group.source);
      return;
    }
  }
}

// --- Actor pass ---

function actPlayerSlot(step: Step, player: PartyCombatant, dt: number): void {
  if (!isAlive(player)) return;
  if (player.stunRemainingMs > 0) {
    tickStun(player, dt);
    return;
  }
  tickCooldowns(step, player.skillCooldowns, unitKey(step.state, player), dt);
  player.recoveryRemainingMs = Math.max(0, player.recoveryRemainingMs - dt);
  if (player.cast) {
    player.cast.remainingMs -= dt;
    if (player.cast.remainingMs <= 0) resolvePlayerCast(step, player);
  }
  if (!isAlive(player) || player.stunRemainingMs > 0) return;
  player.actionRemainingMs -= dt;
  if (player.actionRemainingMs > 0 || player.cast) return;
  playerAct(step, player);
}

function actMonsterSlot(step: Step, monster: CombatMonster, dt: number): void {
  if (!isAlive(monster) || monster.passive) return;
  if (monster.stunRemainingMs > 0) {
    tickStun(monster, dt);
    return;
  }
  tickCooldowns(step, monster.skillCooldowns, unitKey(step.state, monster), dt);
  if (monster.cast) {
    monster.cast.remainingMs -= dt;
    if (monster.cast.remainingMs <= 0) resolveMonsterCast(step, monster);
  }
  if (!isAlive(monster) || monster.stunRemainingMs > 0) return;
  monster.actionRemainingMs -= dt;
  if (monster.actionRemainingMs > 0 || monster.cast) return;
  scheduleNextAction(monster, monsterAct(step, monster));
}

function playerAct(step: Step, player: PartyCombatant): void {
  if (player.attack) player.actionRemainingMs = 0;
  const choice = chooseAction(step.state, player);
  if (!choice && player.attack) return;

  player.attackCount++;
  if (!choice) {
    playerAutoAttack(step, player);
    scheduleNextAction(player, 0);
  } else if (choice.type === 'attack') {
    useAttack(step, player, choice);
  } else {
    useActiveAsAction(step, player, choice);
  }
}

function chooseAction(state: PartyCombatState, player: PartyCombatant): SkillDefinition | null {
  for (const skill of resolveActionOrder(player.equippedSkills, player.attack, player.actionOrder)) {
    if ((player.skillCooldowns[skill.id] ?? 0) > 0) continue;
    if (skill.type === 'attack') return skill;
    if (wouldHaveEffect(player, skill, state)) return skill;
  }
  return null;
}

function useActiveAsAction(step: Step, player: PartyCombatant, skill: SkillDefinition): void {
  const { state } = step;
  const timed = isTimedSkill(skill);
  startPlayerCooldown(step, player, skill);
  const castMs = playerCastMs(player, skill);
  if (castMs > 0) {
    if (timed) {
      const wait = castMs + skillRecoveryMs(state.pace, skill);
      player.actionRemainingMs = wait;
      player.actionTotalMs = wait;
    } else {
      scheduleNextAction(player, castMs, state.pace.castsAddTime);
    }
    startPlayerCast(step, player, skill, castMs);
    return;
  }

  if (timed) startActionRecovery(step, player, skill);
  else scheduleNextAction(player, 0);
  const use = emit(step, 'attack', {
    src: playerRef(player), dst: primaryTargetRef(player, skill, state, {}), skill: skill.name, skillId: skill.id,
    ...recoveryField(step, skill),
  });
  const effective = executeAction(step, player, skill, {});
  stampNextAction(step, player, use);
  if (!effective) emitPlayerFizzle(step, player, skill);
  if (timed || effective) return;
  if (!player.attack) playerAutoAttack(step, player);
  else if ((player.skillCooldowns[player.attack.id] ?? 0) <= 0) useAttack(step, player, player.attack);
}

function useAttack(step: Step, player: PartyCombatant, attack: SkillDefinition): void {
  startPlayerCooldown(step, player, attack);
  startRecovery(player, skillRecoveryMs(step.state.pace, attack));
  playerAutoAttack(step, player, attack);
}

/** Without an attack skill the next action is an auto, always ready, so this action's wait must end on a whole step to keep its interval on the grid. */
function startActionRecovery(step: Step, player: PartyCombatant, skill: SkillDefinition): void {
  startRecovery(player, skillRecoveryMs(step.state.pace, skill));
  if (!player.attack) player.actionRemainingMs = Math.max(COMBAT_STEP_MS, player.actionRemainingMs);
}

function startRecovery(player: PartyCombatant, ms: number): void {
  if (ms > player.recoveryRemainingMs) {
    player.recoveryRemainingMs = ms;
    player.recoveryTotalMs = ms;
  }
  if (ms > player.actionRemainingMs) {
    player.actionRemainingMs = ms;
    player.actionTotalMs = ms;
  }
}

function recoveryField(step: Step, skill: SkillDefinition): Pick<EventFields, 'recoveryMs'> {
  return isTimedSkill(skill) ? { recoveryMs: skillRecoveryMs(step.state.pace, skill) } : {};
}

/** Call once this action's timers are set and its effects have landed, which can end the need for the next skill. */
function stampNextAction(step: Step, player: PartyCombatant, event: CombatEvent): void {
  if (!player.attack) return;
  player.actionTotalMs = nextActionWaitMs(step.state, player);
  event.nextActionMs = paceRealMs(step.state.pace, player.actionTotalMs);
}

function playerAutoAttack(step: Step, player: PartyCombatant, attack?: SkillDefinition): void {
  const target = findTarget(player.gridPosition, step.state.monsters, false);
  if (!target) return;
  step.kit = player.kit;
  const { amount, crit } = rollDamage(step, player, target);
  const use = emit(step, 'attack', {
    src: playerRef(player), dst: monsterRef(target),
    ...(attack ? { skillId: attack.id, ...recoveryField(step, attack) } : {}),
  });
  applyDamageToMonster(step, amount, crit, target, player, false);
  step.kit = 1;
  stampNextAction(step, player, use);
}

function executeAction(step: Step, player: PartyCombatant, skill: SkillDefinition, ctx: EffectContext): boolean {
  step.kit = player.kit;
  const effective = executeSkill(step, player, skill, ctx);
  step.kit = 1;
  return effective;
}

function rollDamage(step: Step, player: PartyCombatant, target?: CombatMonster, opts?: { isActive?: boolean }): { amount: number; crit: boolean } {
  const roll = computePlayerDamage(player, step.state, step.rng, target, opts);
  return step.kit === 1 ? roll : { ...roll, amount: Math.max(1, Math.round(roll.amount * step.kit)) };
}

/** How much of a stack-capped ramp one action adds: slower actions add more at once, never past the cap. */
function rampStacks(step: Step, current: number, max: number): number {
  return Math.min(step.kit, max - current);
}

function kitAmount(step: Step, amount: number): number {
  return step.kit === 1 ? amount : Math.round(amount * step.kit);
}

function startPlayerCooldown(step: Step, player: PartyCombatant, skill: SkillDefinition): void {
  const ms = useCooldownMs(step.state.pace, player, skill, step.state.players);
  player.skillCooldowns[skill.id] = ms;
  player.skillCooldownTotals[skill.id] = ms;
  step.fresh.add(`${unitKey(step.state, player)}:${skill.id}`);
}

function startPlayerCast(step: Step, player: PartyCombatant, skill: SkillDefinition, castMs: number): void {
  const target = primaryTargetRef(player, skill, step.state, {});
  player.cast = { skillId: skill.id, skillName: skill.name, totalMs: castMs, remainingMs: castMs, target };
  const { pace } = step.state;
  const nextActionMs = isTimedSkill(skill)
    ? paceRealMs(pace, castMs + skillRecoveryMs(pace, skill))
    : pace.castsAddTime ? paceRealMs(pace, player.actionIntervalMs + castMs) : undefined;
  const start = emit(step, 'cast_start', {
    src: playerRef(player), dst: target, skill: skill.name, skillId: skill.id, durationMs: castMs,
    ...(nextActionMs !== undefined ? { nextActionMs } : {}),
  });
  stampNextAction(step, player, start);
  step.log.push(`${player.username} begins casting ${skill.name}!`);
}

function resolvePlayerCast(step: Step, player: PartyCombatant): void {
  const cast = player.cast;
  if (!cast) return;
  player.cast = null;
  const skill = player.equippedSkills.find(s => s?.id === cast.skillId);
  if (skill && isTimedSkill(skill)) {
    player.hasResolvedCast = true;
    startRecovery(player, skillRecoveryMs(step.state.pace, skill));
  }
  emit(step, 'cast_end', {
    src: playerRef(player), skill: cast.skillName, skillId: cast.skillId, ...(skill ? recoveryField(step, skill) : {}),
  });
  if (!skill) return;
  const ctx: EffectContext = {
    enemy: cast.target?.side === 'monster' ? findLiveMonsterAt(step.state, cast.target.pos) : undefined,
  };
  // No skillId: the client restarts cooldown sweeps on attack events that carry one.
  emit(step, 'attack', { src: playerRef(player), dst: primaryTargetRef(player, skill, step.state, ctx), skill: skill.name });
  if (!executeAction(step, player, skill, ctx)) emitPlayerFizzle(step, player, skill);
}

function emitPlayerFizzle(step: Step, player: PartyCombatant, skill: SkillDefinition): void {
  emit(step, 'fizzle', { src: playerRef(player), skill: skill.name, skillId: skill.id });
  step.log.push(`${player.username}'s ${skill.name} fizzles!`);
}

function primaryTargetRef(
  player: PartyCombatant,
  skill: SkillDefinition,
  state: PartyCombatState,
  ctx: EffectContext,
): CombatRef | undefined {
  for (const effect of skill.activeEffects ?? []) {
    const ref = optionTargetRef(player, effect, state, ctx);
    if (ref) return ref;
  }
  return undefined;
}

function optionTargetRef(
  player: PartyCombatant,
  effect: ActiveEffect,
  state: PartyCombatState,
  ctx: EffectContext,
): CombatRef | undefined {
  let monster: CombatMonster | null = null;
  let ally: PartyCombatant | null = null;
  switch (effect.kind) {
    case 'stun_single':
      monster = stunSingleTarget(player, state.monsters, ctx.enemy);
      break;
    case 'target_lowest_hp':
      monster = lowestHpEnemyTarget(state.monsters, ctx.enemy);
      break;
    case 'multi_hit':
    case 'stacking_mark':
    case 'remove_buffs':
    case 'ignore_dr_single':
    case 'dot_attack':
    case 'debuff_attack':
    case 'smite':
    case 'damage_percent':
    case 'high_damage_single':
      monster = gridEnemyTarget(player, state.monsters, ctx.enemy);
      break;
    case 'heal_lowest':
    case 'hot_lowest':
      ally = healTarget(state.players, ctx.ally);
      break;
    case 'cure_debuffs':
      ally = cureTarget(state.players, ctx.ally);
      break;
    case 'shield_non_knight':
      ally = shieldTarget(state.players, ctx.ally);
      break;
    default:
      return undefined;
  }
  if (monster) return monsterRef(monster);
  if (ally) return playerRef(ally);
  return undefined;
}

// --- Player damage ---

function computePlayerDamage(
  player: PartyCombatant,
  state: PartyCombatState,
  rng: () => number,
  target?: CombatMonster,
  options?: { isActive?: boolean },
): { amount: number; crit: boolean } {
  const variance = Math.floor(rng() * 5) - 2;
  const attackBonus = computeAttackBonus(player.equipBonuses, rng);
  let damage = Math.max(1, player.baseDamage + variance + attackBonus);

  const intensifyMod = getIntensifyMod(player);
  if (intensifyMod > 0) {
    const factor = options?.isActive ? 1 + intensifyMod : 1 - intensifyMod;
    damage = Math.max(1, Math.floor(damage * factor));
  }
  if (state.rallyMultiplier > 0) {
    damage = Math.max(1, Math.floor(damage * (1 + state.rallyMultiplier)));
  }
  if (state.warSongBonus > 0) {
    damage = Math.max(1, Math.floor(damage * (1 + state.warSongBonus)));
  }
  const setDmgPct = player.setBonuses?.damagePercent ?? 0;
  if (setDmgPct > 0) {
    damage = Math.max(1, Math.floor(damage * (1 + setDmgPct / 100)));
  }

  if (target) {
    for (const effect of getPassiveEffects(player, 'conditional_damage_bonus')) {
      const bonus = effect.flatValue ?? 0;
      const cond = effect.condition;
      if (cond === 'target_above_75_hp' && target.currentHp / target.maxHp > 0.75) {
        damage = Math.floor(damage * (1 + bonus));
      } else if (cond === 'front_column' && getCol(player.gridPosition) === 2) {
        damage = Math.floor(damage * (1 + bonus));
      } else if (cond === 'target_bleeding_or_stunned' && (target.dots.length > 0 || target.stunRemainingMs > 0)) {
        damage = Math.floor(damage * (1 + bonus));
      }
    }

    for (const p of state.players) {
      if (!isAlive(p)) continue;
      for (const effect of getPassiveEffects(p, 'conditional_ally_damage')) {
        if (player.className === effect.targetClass && p.currentHp / p.maxHp < (effect.hpThreshold ?? 0.50)) {
          damage = Math.floor(damage * (1 + (effect.flatValue ?? 0)));
        }
      }
    }

    if (hasPassive(player, 'stacking_same_target')) {
      const bonus = getPassiveValue(player, 'stacking_same_target');
      if (player.lastTargetId === target.name && player.consecutiveHits > 0) {
        damage = Math.floor(damage * (1 + bonus * player.consecutiveHits));
      }
    }

    if (target.sunderMark && target.sunderMark.stacks > 0) {
      const sunderBonus = target.sunderMark.totalBonus ?? target.sunderMark.stacks * 0.25;
      damage = Math.floor(damage * (1 + sunderBonus));
    }

    if (player.playerDamageType === 'magical' || player.playerDamageType === 'holy') {
      for (const debuff of target.debuffs) {
        if (debuff.type === 'scorch') damage = Math.floor(damage * (1 + debuff.value));
      }
    }
  }

  let crit = false;
  const critChance = Math.min(1, getCritChance(player));
  if (critChance > 0 && rng() < critChance) {
    damage = Math.floor(damage * getCritMultiplier(player));
    crit = true;
  }
  return { amount: damage, crit };
}

function applyDamageToMonster(
  step: Step,
  damage: number,
  crit: boolean,
  target: CombatMonster,
  player: PartyCombatant,
  isAoe: boolean,
  skill?: SkillDefinition,
): void {
  const { state } = step;
  // DoT riders use pre-scaling damage; gap, mastery and resistance apply again at pulse time.
  const preMrDamage = damage;

  damage = mitigateHitOnMonster(target, damage, player.playerDamageType, player);
  const holyDamage = mitigateHitOnMonster(target, kitAmount(step, state.blessedArmsDamage), 'holy', player);
  const totalDamage = damage + holyDamage;
  const prevHp = target.currentHp;
  target.currentHp = Math.max(0, target.currentHp - totalDamage);

  const src = playerRef(player);
  const dst = monsterRef(target);
  emit(step, 'damage', {
    src, dst, amount: damage, dmgType: player.playerDamageType, crit: crit || undefined, skill: skill?.name,
  });
  if (holyDamage > 0) {
    emit(step, 'damage', { src, dst, amount: holyDamage, dmgType: 'holy', skill: skill?.name });
  }

  const verb = skill ? `uses ${skill.name} on` : 'hits';
  if (holyDamage > 0) {
    step.log.push(`${player.username} ${verb} ${target.name} for ${damage} ${player.playerDamageType} + ${holyDamage} holy damage`);
  } else {
    step.log.push(`${player.username} ${verb} ${target.name} for ${damage} ${player.playerDamageType} damage`);
  }

  const scorchSkill = getSkillWithPassive(player, 'scorch');
  if (scorchSkill) {
    const existing = target.debuffs.find(d => d.type === 'scorch');
    const scorchMs = Math.round(SCORCH_MS * step.kit);
    if (existing) {
      existing.remainingMs = Math.max(existing.remainingMs, scorchMs);
    } else {
      target.debuffs.push({ type: 'scorch', value: getPassiveValue(player, 'scorch'), remainingMs: scorchMs, name: scorchSkill.name });
      emit(step, 'status', { src, dst, name: scorchSkill.name });
    }
  }

  if (!isAoe) {
    for (const passiveSkill of player.equippedSkills) {
      if (!passiveSkill?.passiveEffects) continue;
      for (const effect of passiveSkill.passiveEffects) {
        if (effect.kind !== 'dot_on_auto') continue;
        const perTick = Math.floor(preMrDamage * (effect.dotPercent ?? 0));
        if (perTick <= 0 || !isAlive(target)) continue;
        const added = addCappedPermanentDot(player, target, {
          sourceUsername: player.username,
          name: passiveSkill.name.toLowerCase(),
          label: passiveSkill.name,
          source: src,
          damagePerTick: Math.max(1, perTick),
          ticksRemaining: 1,
          damageType: 'magical',
          permanent: true,
        });
        if (added) emit(step, 'status', { src, dst, name: passiveSkill.name });
      }
    }
  }

  if (hasPassive(player, 'stacking_same_target')) {
    if (player.lastTargetId === target.name) {
      player.consecutiveHits = Math.min(FOCUS_MAX_STACKS, player.consecutiveHits + 1);
    } else {
      player.consecutiveHits = 1;
      player.lastTargetId = target.name;
    }
  }

  if (!isAlive(target) && prevHp > 0) {
    step.log.push(`${target.name} defeated!`);
    markMonsterDead(step, target, src);
    if (!isAoe && hasPassive(player, 'overflow')) {
      overflowSplash(step, player, target, totalDamage - prevHp);
    }
  }
}

/** Ignite-style stacks per (source, target) are capped; at the cap a stronger stack replaces the weakest. */
function addCappedPermanentDot(owner: PartyCombatant, target: CombatMonster, dot: DotEffect): boolean {
  let count = 0;
  let weakest: DotEffect | null = null;
  for (const d of target.dots) {
    if (!d.permanent || d.sourceUsername !== dot.sourceUsername || d.name !== dot.name) continue;
    count++;
    if (!weakest || d.damagePerTick < weakest.damagePerTick) weakest = d;
  }
  if (count >= Math.max(1, Math.round(IGNITE_MAX_STACKS / owner.kit))) {
    if (!weakest || weakest.damagePerTick >= dot.damagePerTick) return false;
    target.dots.splice(target.dots.indexOf(weakest), 1);
  }
  target.dots.push(dot);
  return true;
}

function overflowSplash(step: Step, player: PartyCombatant, killed: CombatMonster, overkill: number): void {
  if (overkill <= 0) return;
  const others = step.state.monsters.filter(m => isAlive(m) && m !== killed);
  if (others.length === 0) return;
  const splashTarget = others[Math.floor(step.rng() * others.length)];
  splashTarget.currentHp = Math.max(0, splashTarget.currentHp - overkill);
  const src = playerRef(player);
  emit(step, 'damage', {
    src, dst: monsterRef(splashTarget), amount: overkill, dmgType: player.playerDamageType,
    skill: getSkillWithPassive(player, 'overflow')?.name,
  });
  step.log.push(`Overflow! ${overkill} damage splashes to ${splashTarget.name}`);
  if (!isAlive(splashTarget)) {
    step.log.push(`${splashTarget.name} defeated!`);
    markMonsterDead(step, splashTarget, src);
  }
}

function markMonsterDead(step: Step, monster: CombatMonster, src?: CombatRef): void {
  monster.cast = null;
  emit(step, 'death', { src, dst: monsterRef(monster) });
}

function applyHeal(step: Step, healer: PartyCombatant, target: PartyCombatant, baseAmount: number, skill: SkillDefinition): number {
  let amount = Math.floor(kitAmount(step, baseAmount) * getHealPowerMultiplier(healer));
  if (healer.martyrBonus > 0) {
    amount = Math.floor(amount * (1 + healer.martyrBonus));
    healer.martyrBonus = 0;
  }
  if (hasPassive(target, 'healing_received_bonus')) {
    amount = Math.floor(amount * (1 + getPassiveValue(target, 'healing_received_bonus')));
  }
  amount = Math.min(amount, target.maxHp - target.currentHp);
  target.currentHp += amount;
  if (amount > 0) {
    emit(step, 'heal', { src: playerRef(healer), dst: playerRef(target), amount, skill: skill.name });
    step.log.push(`${healer.username} uses ${skill.name} on ${target.username} for ${amount} HP`);
  }
  return amount;
}

// --- Active skill execution ---

// Arcane Surge is rewound only when every option fizzled.
function executeSkill(step: Step, player: PartyCombatant, skill: SkillDefinition, ctx: EffectContext): boolean {
  player.activeSkillCount++;
  const arcaneMult = hasArcaneSurge(player) && player.activeSkillCount % 2 === 0 ? 2 : 1;
  let effective = false;
  for (const effect of skill.activeEffects ?? []) {
    if (executeEffect(step, player, skill, effect, ctx, arcaneMult)) effective = true;
  }
  if (!effective) player.activeSkillCount--;
  return effective;
}

function strikeMonster(
  step: Step,
  player: PartyCombatant,
  skill: SkillDefinition,
  target: CombatMonster,
  arcaneMult: number,
  percent?: number,
): number {
  const { amount, crit } = rollDamage(step, player, target, { isActive: true });
  const raw = amount * arcaneMult;
  const damage = percent === undefined ? raw : Math.max(1, Math.floor(raw * percent));
  applyDamageToMonster(step, damage, crit, target, player, false, skill);
  return damage;
}

function executeEffect(
  step: Step,
  player: PartyCombatant,
  skill: SkillDefinition,
  effect: ActiveEffect,
  ctx: EffectContext,
  arcaneMult: number,
): boolean {
  const { state } = step;
  const sn = skill.name;
  const src = playerRef(player);

  switch (effect.kind) {
    case 'stun_single': {
      const target = stunSingleTarget(player, state.monsters, ctx.enemy);
      if (!target) return false;
      strikeMonster(step, player, skill, target, arcaneMult);
      const stunMs = isAlive(target) ? rollActionStunMs(step, effect.stunChance ?? 0) : 0;
      if (stunMs > 0) applyStunToMonster(step, target, src, ctx.suppressInterruptFor, stunMs);
      return true;
    }

    case 'stun_aoe': {
      let anyStunned = false;
      for (const monster of state.monsters) {
        if (!isAlive(monster) || monster.passive) continue;
        const stunMs = rollActionStunMs(step, effect.stunChance ?? 0);
        if (stunMs > 0) {
          step.log.push(`${player.username}'s ${sn} stuns ${monster.name}!`);
          applyStunToMonster(step, monster, src, ctx.suppressInterruptFor, stunMs);
          anyStunned = true;
        }
      }
      return anyStunned;
    }

    case 'heal_lowest': {
      const target = healTarget(state.players, ctx.ally);
      if (!target) return false;
      return applyHeal(step, player, target, player.level * (effect.healMultiplier ?? 4), skill) > 0;
    }

    case 'multi_hit': {
      const hitCount = effect.hitCount ?? 4;
      const { amount, crit } = rollDamage(step, player, undefined, { isActive: true });
      const perHit = Math.max(1, Math.floor(amount * arcaneMult * (effect.damagePercent ?? 0.30)));
      let hit = false;
      for (let i = 0; i < hitCount; i++) {
        const target = gridEnemyTarget(player, state.monsters, ctx.enemy);
        if (!target) break;
        applyDamageToMonster(step, perHit, crit, target, player, false, skill);
        hit = true;
      }
      return hit;
    }

    case 'target_lowest_hp': {
      const target = lowestHpEnemyTarget(state.monsters, ctx.enemy);
      if (!target) return false;
      strikeMonster(step, player, skill, target, arcaneMult);
      return true;
    }

    case 'redirect_hit': {
      const attack = ctx.attack;
      if (ctx.trigger !== 'ally_targeted' || !attack || !redirectAllowed(player, attack, state)) return false;
      const original = attack.target;
      step.log.push(attack.skillName
        ? `${player.username} intercepts ${attack.attacker.name}'s ${attack.skillName} aimed at ${original.username}!`
        : `${player.username} intercepts the attack on ${original.username}!`);
      attack.target = player;
      attack.redirected = true;
      emit(step, 'redirect', { src, dst: playerRef(original), skill: sn, skillId: skill.id });
      return true;
    }

    case 'brace_reflect': {
      const hit = ctx.hit;
      if (ctx.trigger !== 'self_hit' || !hit || hit.damageType !== 'physical') return false;
      const reflect = Math.max(1, Math.floor(hit.amount * (effect.reflectPercent ?? 0.10))) * arcaneMult;
      let any = false;
      for (const monster of state.monsters) {
        if (!isAlive(monster)) continue;
        any = true;
        monster.currentHp = Math.max(0, monster.currentHp - reflect);
        emit(step, 'damage', { src, dst: monsterRef(monster), amount: reflect, dmgType: 'physical', skill: sn });
        step.log.push(`${player.username}'s ${sn} reflects ${reflect} damage to ${monster.name}`);
        if (!isAlive(monster)) {
          step.log.push(`${monster.name} defeated!`);
          markMonsterDead(step, monster, src);
        }
      }
      return any;
    }

    case 'stacking_mark': {
      const target = gridEnemyTarget(player, state.monsters, ctx.enemy);
      if (!target) return false;
      strikeMonster(step, player, skill, target, arcaneMult);
      if (isAlive(target)) {
        const markMultiplier = effect.markMultiplier ?? 0.25;
        if (!target.sunderMark) {
          const stacks = rampStacks(step, 0, SUNDER_MAX_STACKS);
          target.sunderMark = { stacks, totalBonus: markMultiplier * stacks, name: sn };
        } else if (target.sunderMark.stacks < SUNDER_MAX_STACKS) {
          const priorBonus = target.sunderMark.totalBonus ?? target.sunderMark.stacks * 0.25;
          const added = rampStacks(step, target.sunderMark.stacks, SUNDER_MAX_STACKS);
          target.sunderMark.stacks += added;
          target.sunderMark.totalBonus = priorBonus + markMultiplier * added;
          target.sunderMark.name = sn;
        }
        step.log.push(`${target.name} is sundered! (+${Math.round((target.sunderMark.totalBonus ?? 0) * 100)}% incoming damage)`);
        emit(step, 'status', { src, dst: monsterRef(target), name: sn });
      }
      return true;
    }

    case 'remove_buffs': {
      const target = gridEnemyTarget(player, state.monsters, ctx.enemy);
      if (!target) return false;
      strikeMonster(step, player, skill, target, arcaneMult);
      if (isAlive(target) && target.buffs.length > 0) {
        target.buffs = [];
        step.log.push(`${player.username} dispels all buffs from ${target.name}!`);
        emit(step, 'cleanse', { src, dst: monsterRef(target), skill: sn });
      }
      return true;
    }

    case 'multi_hit_random': {
      const hitCount = effect.hitCount ?? 3;
      const { amount, crit } = rollDamage(step, player, undefined, { isActive: true });
      const perHit = Math.max(1, Math.floor(amount * arcaneMult * (effect.damagePercent ?? 0.50)));
      let hit = false;
      for (let i = 0; i < hitCount; i++) {
        const alive = state.monsters.filter(isAlive);
        if (alive.length === 0) break;
        const target = alive[Math.floor(step.rng() * alive.length)];
        applyDamageToMonster(step, perHit, crit, target, player, true, skill);
        hit = true;
      }
      return hit;
    }

    case 'ignore_dr_single': {
      const target = gridEnemyTarget(player, state.monsters, ctx.enemy);
      if (!target) return false;
      const { amount, crit } = rollDamage(step, player, target, { isActive: true });
      const damage = Math.max(1, Math.floor(amount * arcaneMult * (effect.damagePercent ?? 2.0)));
      const prevHp = target.currentHp;
      target.currentHp = Math.max(0, target.currentHp - damage);
      emit(step, 'damage', {
        src, dst: monsterRef(target), amount: damage, dmgType: player.playerDamageType, crit: crit || undefined, skill: sn,
      });
      step.log.push(`${player.username} snipes ${target.name} for ${damage} damage (ignores DR)`);
      if (!isAlive(target)) {
        step.log.push(`${target.name} defeated!`);
        markMonsterDead(step, target, src);
        if (hasPassive(player, 'overflow')) overflowSplash(step, player, target, damage - prevHp);
      }
      return true;
    }

    case 'dot_attack': {
      const target = gridEnemyTarget(player, state.monsters, ctx.enemy);
      if (!target) return false;
      const dealt = strikeMonster(step, player, skill, target, arcaneMult);
      if (isAlive(target)) {
        const dotTotal = Math.floor(dealt * (effect.dotPercent ?? 0.20));
        const pulses = effect.dotTicks ?? 3;
        target.dots.push({
          sourceUsername: player.username,
          name: sn.toLowerCase(),
          label: sn,
          source: src,
          damagePerTick: Math.max(1, Math.floor(dotTotal / pulses)),
          ticksRemaining: pulses,
          damageType: player.playerDamageType,
        });
        step.log.push(`${target.name} is bleeding!`);
        emit(step, 'status', { src, dst: monsterRef(target), name: sn });
      }
      return true;
    }

    case 'debuff_attack': {
      const target = gridEnemyTarget(player, state.monsters, ctx.enemy);
      if (!target) return false;
      strikeMonster(step, player, skill, target, arcaneMult);
      if (isAlive(target)) {
        const percent = effect.debuffPercent ?? 0.30;
        target.debuffs.push({
          type: 'crippling_shot', value: percent, remainingMs: Math.round((effect.debuffDuration ?? 3) * 1000 * step.kit), name: sn,
        });
        step.log.push(`${target.name}'s damage is reduced by ${Math.round(percent * 100)}%!`);
        emit(step, 'status', { src, dst: monsterRef(target), name: sn });
      }
      return true;
    }

    case 'smite': {
      const target = gridEnemyTarget(player, state.monsters, ctx.enemy);
      if (!target) return false;
      // TODO: add bonus holy damage vs undead (level × holyMultiplier) when the undead system exists.
      strikeMonster(step, player, skill, target, arcaneMult);
      return true;
    }

    case 'cure_debuffs': {
      const target = cureTarget(state.players, ctx.ally);
      if (!target) return false;
      target.debuffs = [];
      target.dots = [];
      target.stunRemainingMs = 0;
      target.stunTotalMs = 0;
      target.stunSource = undefined;
      step.log.push(`${player.username} cures ${target.username}'s afflictions!`);
      emit(step, 'cleanse', { src, dst: playerRef(target), skill: sn });
      return true;
    }

    case 'hot_lowest': {
      const healPerPulse = kitAmount(step, healOptionAmount(player, effect, 2));
      const target = healTarget(state.players, ctx.ally);
      if (!target) return false;
      const pulses = effect.dotTicks ?? 3;
      let adjustedHeal = healPerPulse;
      if (hasPassive(target, 'healing_received_bonus')) {
        adjustedHeal = Math.floor(adjustedHeal * (1 + getPassiveValue(target, 'healing_received_bonus')));
      }
      target.hots.push({
        sourceUsername: player.username,
        name: sn.toLowerCase(),
        label: sn,
        source: src,
        healPerTick: adjustedHeal,
        ticksRemaining: pulses,
      });
      step.log.push(`${player.username} applies ${sn} to ${target.username} (${adjustedHeal} HP ${pulseText(state, pulses)})`);
      emit(step, 'status', { src, dst: playerRef(target), name: sn });
      return true;
    }

    case 'shield_non_knight': {
      const target = shieldTarget(state.players, ctx.ally);
      if (!target) return false;
      const shieldAmount = kitAmount(step, player.level * (effect.shieldMultiplier ?? 4));
      target.damageShield = shieldAmount;
      step.log.push(`${player.username} shields ${target.username} for ${shieldAmount} damage`);
      emit(step, 'shield', { src, dst: playerRef(target), amount: shieldAmount, skill: sn });
      return true;
    }

    case 'damage_percent': {
      const target = gridEnemyTarget(player, state.monsters, ctx.enemy);
      if (!target) return false;
      strikeMonster(step, player, skill, target, arcaneMult, effect.damagePercent ?? 0.75);
      return true;
    }

    case 'damage_aoe_all': {
      let any = false;
      if (effect.damagePerLevel) {
        const damage = Math.max(1, Math.floor(effect.damagePerLevel * player.level * step.kit)) * arcaneMult;
        for (const monster of state.monsters) {
          if (!isAlive(monster)) continue;
          any = true;
          monster.currentHp = Math.max(0, monster.currentHp - damage);
          emit(step, 'damage', { src, dst: monsterRef(monster), amount: damage, dmgType: player.playerDamageType, skill: sn });
          step.log.push(`${player.username}'s ${sn} hits ${monster.name} for ${damage} damage`);
          if (!isAlive(monster)) {
            step.log.push(`${monster.name} defeated!`);
            markMonsterDead(step, monster, src);
          }
        }
      } else {
        const { amount, crit } = rollDamage(step, player, undefined, { isActive: true });
        const damage = Math.max(1, Math.floor(amount * arcaneMult * (effect.damagePercent ?? 1.0)));
        for (const monster of state.monsters) {
          if (!isAlive(monster)) continue;
          any = true;
          applyDamageToMonster(step, damage, crit, monster, player, true, skill);
        }
      }
      return any;
    }

    case 'high_damage_single': {
      const target = gridEnemyTarget(player, state.monsters, ctx.enemy);
      if (!target) return false;
      strikeMonster(step, player, skill, target, arcaneMult, effect.damagePercent ?? 2.50);
      return true;
    }

    case 'party_buff_permanent': {
      if (partyBuffStacks(state, sn) >= WAR_SONG_MAX_STACKS) return false;
      const addedStacks = rampStacks(step, partyBuffStacks(state, sn), WAR_SONG_MAX_STACKS);
      const buffAmount = (effect.buffPercent ?? 0.10) * addedStacks;
      state.warSongBonus += buffAmount;
      const existing = state.partyBuffs.find(b => b.name === sn);
      if (existing) existing.stacks += addedStacks;
      else state.partyBuffs.push({ name: sn, stacks: addedStacks });
      step.log.push(`${player.username}'s ${sn} increases party damage by ${Math.round(buffAmount * 100)}%! (Total: +${Math.round(state.warSongBonus * 100)}%)`);
      emit(step, 'buff', { src, name: sn, amount: Math.round(buffAmount * 100), skill: sn });
      for (const ally of state.players) {
        if (isAlive(ally)) emit(step, 'status', { src, dst: playerRef(ally), name: sn });
      }
      return true;
    }

    case 'enemy_debuff_aoe': {
      const debuffAmount = effect.debuffPercent ?? 0.20;
      const seconds = effect.debuffDuration ?? 3;
      const debuffMs = Math.round(seconds * 1000 * step.kit);
      let any = false;
      for (const monster of state.monsters) {
        if (!isAlive(monster) || monster.passive) continue;
        any = true;
        const existing = monster.debuffs.find(d => d.type === 'lullaby');
        if (existing) {
          existing.remainingMs = debuffMs;
        } else {
          monster.debuffs.push({ type: 'lullaby', value: debuffAmount, remainingMs: debuffMs, name: sn });
        }
        emit(step, 'status', { src, dst: monsterRef(monster), name: sn });
      }
      if (any) {
        step.log.push(`${player.username}'s ${sn} reduces enemy damage by ${Math.round(debuffAmount * 100)}% for ${realSeconds(state, debuffMs)} seconds`);
      }
      return any;
    }

    case 'chaos': {
      let any = false;
      for (const monster of state.monsters) {
        if (!isAlive(monster) || monster.passive) continue;
        any = true;
        monster.chaosActive = true;
        monster.chaosName = sn;
        emit(step, 'status', { src, dst: monsterRef(monster), name: sn });
      }
      if (any) step.log.push(`${player.username}'s ${sn} causes chaos! Enemies turn on each other!`);
      return any;
    }
  }
  return false;
}

// --- Stuns ---

function applyStunToPlayer(step: Step, player: PartyCombatant, src: CombatRef | undefined): void {
  if (!isAlive(player)) return;
  const immuneSkill = getSkillWithPassive(player, 'stun_immune');
  if (immuneSkill) {
    emit(step, 'resist', { src, dst: playerRef(player), skill: immuneSkill.name });
    step.log.push(`${player.username}'s ${immuneSkill.name} resists the stun!`);
    return;
  }
  if (STUN_MS > player.stunRemainingMs) {
    player.stunRemainingMs = STUN_MS;
    player.stunTotalMs = STUN_MS;
  }
  if (src?.side === 'monster') player.stunSource = src;
  emit(step, 'stun', { src, dst: playerRef(player), durationMs: STUN_MS });
}

/** One action's stun length, or 0. See docs/architecture/combat.md → Combat pace. */
function rollActionStunMs(step: Step, chance: number): number {
  if (step.kit === 1) return step.rng() < chance ? STUN_MS : 0;
  const scaled = chance * step.kit;
  if (!(step.rng() < Math.min(1, scaled))) return 0;
  return Math.round(STUN_MS * Math.max(1, scaled));
}

// A pending counter owns the cancel of its caster's spell, so its own stun must not interrupt it.
function applyStunToMonster(
  step: Step,
  monster: CombatMonster,
  src: CombatRef | undefined,
  suppressInterruptFor: CombatMonster | undefined,
  stunMs: number = STUN_MS,
): void {
  if (!isAlive(monster) || monster.passive) return;
  if (stunMs > monster.stunRemainingMs) {
    monster.stunRemainingMs = stunMs;
    monster.stunTotalMs = stunMs;
  }
  emit(step, 'stun', { src, dst: monsterRef(monster), durationMs: stunMs });
  step.log.push(`${monster.name} is stunned!`);
  if (monster.cast && suppressInterruptFor !== monster) {
    const cast = monster.cast;
    monster.cast = null;
    emit(step, 'interrupt', { src, dst: monsterRef(monster), skill: cast.skillName, skillId: cast.skillId });
    step.log.push(`${monster.name}'s ${cast.skillName} is interrupted!`);
  }
}

// --- Monster actions ---

function monsterAct(step: Step, monster: CombatMonster): number {
  if (monster.chaosActive) {
    monster.chaosActive = false;
    monster.chaosName = undefined;
    chaosStrike(step, monster);
    return 0;
  }
  monster.attackCount++;

  for (const entry of monster.skills) {
    const def = MONSTER_SKILL_CATALOG[entry.skillId];
    if (!def) continue;
    if ((monster.skillCooldowns[entry.skillId] ?? 0) > 0) continue;
    if (!monsterSkillWouldHaveEffect(def, step.state)) continue;

    startMonsterCooldown(step, monster, entry);
    const castMs = getMonsterSkillCastTimeMs(entry, def);
    if (castMs > 0) {
      startMonsterCast(step, monster, entry, def, castMs);
      return castMs;
    }
    if (!resolveMonsterSkill(step, monster, entry, def, undefined, false)) {
      emitMonsterFizzle(step, monster, entry, def);
    }
    return 0;
  }

  monsterAutoAttack(step, monster);
  return 0;
}

function startMonsterCooldown(step: Step, monster: CombatMonster, entry: MonsterSkillEntry): void {
  const seconds = Number.isFinite(entry.cooldown) ? Math.max(0, entry.cooldown) : 0;
  monster.skillCooldowns[entry.skillId] = Math.round(seconds * 1000);
  step.fresh.add(`${unitKey(step.state, monster)}:${entry.skillId}`);
}

function monsterCastTarget(state: PartyCombatState, monster: CombatMonster, def: MonsterSkillDefinition): CombatRef | undefined {
  if (def.effect === 'heal') {
    const ally = monsterHealTarget(state.monsters);
    return ally ? monsterRef(ally) : undefined;
  }
  let target: PartyCombatant | null = null;
  if ((def.effect === 'damage' || def.effect === 'dot') && def.targeting === 'lowest_hp_enemy') {
    target = assassinateTarget(state.players);
  } else if (def.effect === 'dot' && def.targeting === 'standard') {
    target = monsterGridTarget(monster, state.players);
  }
  return target ? playerRef(target) : undefined;
}

function startMonsterCast(
  step: Step,
  monster: CombatMonster,
  entry: MonsterSkillEntry,
  def: MonsterSkillDefinition,
  castMs: number,
): void {
  const target = monsterCastTarget(step.state, monster, def);
  monster.cast = { skillId: entry.skillId, skillName: def.name, totalMs: castMs, remainingMs: castMs, target };
  emit(step, 'cast_start', {
    src: monsterRef(monster), dst: target, skill: def.name, skillId: entry.skillId, durationMs: castMs,
  });
  step.log.push(`${monster.name} begins casting ${def.name}!`);
  commitInterrupt(step, monster, entry.skillId);
}

function resolveMonsterCast(step: Step, monster: CombatMonster): void {
  const cast = monster.cast;
  if (!cast) return;
  monster.cast = null;
  emit(step, 'cast_end', { src: monsterRef(monster), skill: cast.skillName, skillId: cast.skillId });
  const entry = monster.skills.find(s => s.skillId === cast.skillId);
  const def = MONSTER_SKILL_CATALOG[cast.skillId];
  if (!entry || !def) return;
  const locked = cast.target?.side === 'player' ? findLivePlayerAt(step.state, cast.target.pos) : undefined;
  if (!resolveMonsterSkill(step, monster, entry, def, locked, true)) {
    emitMonsterFizzle(step, monster, entry, def);
  }
}

function emitMonsterFizzle(step: Step, monster: CombatMonster, entry: MonsterSkillEntry, def: MonsterSkillDefinition): void {
  emit(step, 'fizzle', { src: monsterRef(monster), skill: def.name, skillId: entry.skillId });
  step.log.push(`${monster.name}'s ${def.name} fizzles!`);
}

// Monster skill values are flat: Unnerve, Lullaby and Crippling Shot never reduce them.
function resolveMonsterSkill(
  step: Step,
  monster: CombatMonster,
  entry: MonsterSkillEntry,
  def: MonsterSkillDefinition,
  locked: PartyCombatant | undefined,
  fromCast: boolean,
): boolean {
  const { state } = step;
  const src = monsterRef(monster);

  switch (def.effect) {
    case 'damage': {
      const damageType = def.damageType ?? 'physical';
      const value = scaleDamage(Math.max(1, finiteOr0(entry.value)), enrageMultiplier(monster));
      if (def.targeting === 'aoe_all') {
        const targets = state.players.filter(isAlive);
        if (targets.length === 0) return false;
        step.log.push(`${monster.name} casts ${def.name}!`);
        emit(step, 'attack', { src, skill: def.name, skillId: entry.skillId });
        for (const p of targets) {
          if (!isAlive(p)) continue;
          if (rollDodge(state, step.rng)) {
            emit(step, 'dodge', { src, dst: playerRef(p), skill: def.name });
            step.log.push(`${p.username} dodges ${def.name}!`);
            continue;
          }
          applyMonsterDirectDamage(step, p, value, damageType, monster, `${def.name} hits`, def.name);
        }
        return true;
      }
      if (def.targeting === 'lowest_hp_enemy') {
        const target = assassinateTarget(state.players, locked);
        if (!target) return false;
        monsterSingleTargetAttack(step, monster, target, {
          flatDamage: value, damageType, lockedCast: fromCast, skillName: def.name, skillId: entry.skillId,
          label: `${monster.name}'s ${def.name} hits`,
        });
        return true;
      }
      return false;
    }

    case 'stun': {
      if (def.targeting !== 'all_class' || !def.targetClasses) return false;
      const targets = state.players.filter(p => isAlive(p) && def.targetClasses!.includes(p.className));
      if (targets.length === 0) return false;
      const affected = targets.filter(t => !hasPassive(t, 'stun_immune'));
      emit(step, 'attack', { src, skill: def.name, skillId: entry.skillId });
      if (affected.length > 0) {
        step.log.push(`${monster.name} casts ${def.name}! ${affected.map(t => t.username).join(', ')} ${affected.length === 1 ? 'is' : 'are'} stunned!`);
      } else {
        step.log.push(`${monster.name} casts ${def.name} but no targets are affected!`);
      }
      for (const t of targets) applyStunToPlayer(step, t, src);
      return true;
    }

    case 'dot': {
      let target: PartyCombatant | null = null;
      if (def.targeting === 'standard') target = monsterGridTarget(monster, state.players, locked);
      else if (def.targeting === 'lowest_hp_enemy') target = assassinateTarget(state.players, locked);
      if (!target) return false;
      const pulses = def.dotDuration ?? 3;
      const damageType = def.damageType ?? 'magical';
      const perPulse = scaleDamage(Math.max(1, finiteOr0(entry.value)), enrageMultiplier(monster));
      target.dots.push({
        sourceUsername: monster.name,
        name: def.name.toLowerCase(),
        label: def.name,
        source: src,
        damagePerTick: perPulse,
        ticksRemaining: pulses,
        damageType,
      });
      emit(step, 'attack', { src, dst: playerRef(target), skill: def.name, skillId: entry.skillId });
      emit(step, 'status', { src, dst: playerRef(target), name: def.name });
      step.log.push(`${monster.name} casts ${def.name} on ${target.username}! (${perPulse} ${damageType} damage ${pulseText(state, pulses)})`);
      return true;
    }

    case 'heal': {
      if (def.targeting !== 'lowest_hp_ally') return false;
      const target = monsterHealTarget(state.monsters);
      if (!target) return false;
      const amount = Math.max(0, Math.min(finiteOr0(entry.value), target.maxHp - target.currentHp));
      target.currentHp += amount;
      emit(step, 'attack', { src, dst: monsterRef(target), skill: def.name, skillId: entry.skillId });
      emit(step, 'heal', { src, dst: monsterRef(target), amount, skill: def.name });
      step.log.push(`${monster.name} casts ${def.name} on ${target.name} for ${amount} HP!`);
      return true;
    }
  }
  return false;
}

function monsterAutoAttack(step: Step, monster: CombatMonster): void {
  const target = findTarget(monster.gridPosition, step.state.players, true);
  if (!target) return;
  monsterSingleTargetAttack(step, monster, target, {
    damageType: monster.damageType, lockedCast: false, label: `${monster.name} hits`,
  });
}

function rollDodge(state: PartyCombatState, rng: () => number): boolean {
  return state.nimbleDodge > 0 && rng() < Math.min(MAX_DODGE, state.nimbleDodge);
}

// Order: ally_targeted reactions (Intercept) → dodge → damage; a dead attacker's swing is cancelled.
function monsterSingleTargetAttack(
  step: Step,
  monster: CombatMonster,
  target: PartyCombatant,
  opts: {
    damageType: DamageType;
    lockedCast: boolean;
    label: string;
    flatDamage?: number;
    skillName?: string;
    skillId?: string;
  },
): void {
  const { state } = step;
  const attack: InFlightAttack = {
    attacker: monster, target, lockedCast: opts.lockedCast, redirected: false, skillName: opts.skillName,
  };
  tryReaction(step, 'ally_targeted', state.players.filter(p => p !== target), {
    trigger: 'ally_targeted', ally: target, enemy: aliveOrUndefined(monster), attack,
  }, playerRef(target));
  if (!isAlive(monster) || !isAlive(attack.target)) return;
  if (!opts.lockedCast && monster.stunRemainingMs > 0) return;

  const finalTarget = attack.target;
  const src = monsterRef(monster);
  emit(step, 'attack', { src, dst: playerRef(finalTarget), skill: opts.skillName, skillId: opts.skillId });
  if (rollDodge(state, step.rng)) {
    emit(step, 'dodge', { src, dst: playerRef(finalTarget), skill: opts.skillName });
    step.log.push(opts.skillName
      ? `${finalTarget.username} dodges ${monster.name}'s ${opts.skillName}!`
      : `${finalTarget.username} dodges ${monster.name}'s attack!`);
    return;
  }
  const raw = opts.flatDamage ?? getMonsterDamage(monster, state);
  applyMonsterDirectDamage(step, finalTarget, raw, opts.damageType, monster, opts.label, opts.skillName);
}

function chaosStrike(step: Step, monster: CombatMonster): void {
  const { state } = step;
  const alive = state.monsters.filter(isAlive);
  if (alive.length === 0) return;
  const target = alive[Math.floor(step.rng() * alive.length)];
  const damage = getMonsterDamage(monster, state);
  target.currentHp = Math.max(0, target.currentHp - damage);
  const src = monsterRef(monster);
  emit(step, 'attack', { src, dst: monsterRef(target) });
  emit(step, 'damage', { src, dst: monsterRef(target), amount: damage, dmgType: monster.damageType });
  step.log.push(`${monster.name} attacks ${target.name} in confusion for ${damage} damage!`);
  if (!isAlive(target)) {
    step.log.push(`${target.name} defeated!`);
    markMonsterDead(step, target, src);
  }
}

// Order is load-bearing: reductions, shield, HP → Shield Bash → Martyr → death/Resurrection → self_hit.
function applyMonsterDirectDamage(
  step: Step,
  target: PartyCombatant,
  rawDamage: number,
  damageType: DamageType,
  attacker: CombatMonster,
  hitLabel: string,
  skillName?: string,
): number {
  const { state } = step;
  const src = monsterRef(attacker);
  const dst = playerRef(target);

  let damage = mitigateHitOnPlayer(state, target, rawDamage, damageType, attacker);

  if (target.damageShield > 0) {
    const absorbed = Math.min(damage, target.damageShield);
    target.damageShield -= absorbed;
    damage -= absorbed;
    if (absorbed > 0) {
      emit(step, 'absorb', { src, dst, amount: absorbed, skill: skillName });
      step.log.push(`${target.username}'s shield absorbs ${absorbed} damage`);
    }
  }

  target.currentHp = Math.max(0, target.currentHp - damage);
  emit(step, 'damage', { src, dst, amount: damage, dmgType: damageType, skill: skillName });
  step.log.push(`${hitLabel} ${target.username} for ${damage} ${damageType} damage`);

  if (damageType === 'physical' && isAlive(attacker)) {
    const bashSkill = getSkillWithPassive(target, 'stun_on_phys_hit');
    if (bashSkill && step.rng() < getPassiveValue(target, 'stun_on_phys_hit')) {
      step.log.push(`${target.username}'s ${bashSkill.name} stuns ${attacker.name}!`);
      applyStunToMonster(step, attacker, dst, undefined);
    }
  }

  if (target.className === 'Knight' && damage > 0) triggerMartyr(state, target);

  if (!isAlive(target)) handlePlayerDown(step, target, src);

  if (isAlive(target) && damage > 0) {
    tryReaction(step, 'self_hit', [target], {
      trigger: 'self_hit', ally: target, enemy: aliveOrUndefined(attacker), hit: { amount: damage, damageType, attacker },
    }, dst);
  }
  return damage;
}

function triggerMartyr(state: PartyCombatState, victim: PartyCombatant): void {
  for (const p of state.players) {
    if (!isAlive(p) || p === victim) continue;
    if (hasPassive(p, 'martyr')) {
      const value = getPassiveValue(p, 'martyr');
      if (p.martyrBonus < value) p.martyrBonus = value;
    }
  }
}

function handlePlayerDown(step: Step, player: PartyCombatant, src?: CombatRef): void {
  player.cast = null;
  if (checkResurrection(step, player)) return;
  emit(step, 'death', { src, dst: playerRef(player) });
  step.log.push(`${player.username} has fallen!`);
}

function checkResurrection(step: Step, player: PartyCombatant): boolean {
  if (isAlive(player)) return false;
  for (const p of step.state.players) {
    if (!isAlive(p) || p.hasResurrected) continue;
    const resSkill = getSkillWithPassive(p, 'resurrection');
    if (!resSkill) continue;
    const revivePercent = getPassiveValue(p, 'resurrection') || 0.20;
    player.currentHp = Math.max(1, Math.floor(player.maxHp * revivePercent));
    p.hasResurrected = true;
    emit(step, 'revive', { src: playerRef(p), dst: playerRef(player), amount: player.currentHp, skill: resSkill.name });
    step.log.push(`${p.username}'s ${resSkill.name} revives ${player.username} at ${Math.round(revivePercent * 100)}% HP!`);
    return true;
  }
  return false;
}

// --- Reactions ---

// Cooldown starts before the effects resolve, so a reaction can never re-trigger itself.
function tryReaction(
  step: Step,
  trigger: SkillTrigger,
  reactors: PartyCombatant[],
  ctx: EffectContext,
  subject: CombatRef | undefined,
): boolean {
  for (const player of reactors) {
    if (!isAlive(player) || player.stunRemainingMs > 0) continue;
    for (const skill of player.equippedSkills) {
      if (!isUsableActive(skill) || getSkillTrigger(skill) !== trigger) continue;
      if ((player.skillCooldowns[skill.id] ?? 0) > 0) continue;
      if (!wouldHaveEffect(player, skill, step.state, ctx)) continue;
      startPlayerCooldown(step, player, skill);
      emit(step, 'reaction', {
        src: playerRef(player), dst: subject, skill: skill.name, skillId: skill.id, cardType: getSkillCardType(skill),
      });
      if (!executeSkill(step, player, skill, ctx)) emitPlayerFizzle(step, player, skill);
      return true;
    }
  }
  return false;
}

function evaluateLevelTriggers(step: Step): void {
  const { state } = step;
  const afflicted = cureTarget(state.players);
  if (afflicted) {
    tryReaction(step, 'ally_afflicted', state.players, {
      trigger: 'ally_afflicted', ally: afflicted, enemy: afflictionSource(state, afflicted),
    }, playerRef(afflicted));
    if (checkEnd(step)) return;
  }
  const low = lowHpAlly(state.players);
  if (low) {
    tryReaction(step, 'ally_low_hp', state.players, { trigger: 'ally_low_hp', ally: low }, playerRef(low));
  }
}

function afflictionSource(state: PartyCombatState, ally: PartyCombatant): CombatMonster | undefined {
  const ref = ally.stunRemainingMs > 0
    ? ally.stunSource
    : ally.dots.find(d => d.source?.side === 'monster')?.source;
  return ref?.side === 'monster' ? findLiveMonsterAt(state, ref.pos) : undefined;
}

function commitInterrupt(step: Step, caster: CombatMonster, monsterSkillId: string): void {
  const { state } = step;
  const cast = caster.cast;
  if (!cast) return;
  for (const player of state.players) {
    if (!isAlive(player) || player.stunRemainingMs > 0) continue;
    for (const skill of player.equippedSkills) {
      if (!isUsableActive(skill) || getSkillTrigger(skill) !== 'enemy_cast') continue;
      if ((player.skillCooldowns[skill.id] ?? 0) > 0) continue;
      startPlayerCooldown(step, player, skill);
      emit(step, 'reaction', {
        src: playerRef(player), dst: monsterRef(caster), skill: skill.name, skillId: skill.id, cardType: getSkillCardType(skill),
      });
      const immediate = cast.remainingMs < INTERRUPT_DELAY_MS;
      const counter: PendingCounter = {
        reactorUsername: player.username,
        skillId: skill.id,
        casterIndex: state.monsters.indexOf(caster),
        monsterSkillId,
        atMs: state.elapsedMs + (immediate ? 0 : INTERRUPT_DELAY_MS),
      };
      cast.counter = { reactorUsername: counter.reactorUsername, skillId: counter.skillId, atMs: counter.atMs };
      if (immediate) resolveCounter(step, counter);
      else state.pendingCounters.push(counter);
      return;
    }
  }
}

function resolveDueCounters(step: Step): void {
  const { state } = step;
  if (state.pendingCounters.length === 0) return;
  const due = state.pendingCounters.filter(c => c.atMs <= state.elapsedMs);
  if (due.length === 0) return;
  state.pendingCounters = state.pendingCounters.filter(c => c.atMs > state.elapsedMs);
  for (const counter of due) resolveCounter(step, counter);
}

function finiteOr0(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function resolveCounter(step: Step, counter: PendingCounter): void {
  const { state } = step;
  const reactor = state.players.find(p => p.username === counter.reactorUsername);
  const skill = reactor?.equippedSkills.find(s => s?.id === counter.skillId);
  if (!reactor || !skill) return;
  if (!isAlive(reactor) || reactor.stunRemainingMs > 0) {
    emitPlayerFizzle(step, reactor, skill);
    return;
  }
  const caster = state.monsters[counter.casterIndex];

  const effective = executeSkill(step, reactor, skill, {
    trigger: 'enemy_cast', enemy: aliveOrUndefined(caster), suppressInterruptFor: caster,
  });

  const cast = caster?.cast;
  const stillCasting = !!caster && isAlive(caster) && !!cast && cast.skillId === counter.monsterSkillId
    && cast.counter?.reactorUsername === counter.reactorUsername && cast.counter.atMs === counter.atMs;
  if (stillCasting && cast) {
    caster.cast = null;
    emit(step, 'interrupt', {
      src: playerRef(reactor), dst: monsterRef(caster), skill: cast.skillName, skillId: counter.monsterSkillId,
      countered: true,
    });
    step.log.push(`${reactor.username}'s ${skill.name} counters ${caster.name}'s ${cast.skillName}!`);
  } else if (!effective) {
    emitPlayerFizzle(step, reactor, skill);
  }
}
