import type { ClassName, DamageType } from './CharacterStats.js';
import type { EquipmentBonuses } from './ItemTypes.js';
import type { MonsterInstance, MonsterSkillEntry, Resistance } from './MonsterTypes.js';
import { MONSTER_SKILL_CATALOG, getMonsterSkillCastTimeMs } from './MonsterSkills.js';
import type { MonsterSkillDefinition } from './MonsterSkills.js';
import type { SetBonuses } from './SetTypes.js';
import type { PartyGridPosition } from './SocialTypes.js';
import type { ActiveEffect, SkillDefinition, SkillTrigger } from './SkillTypes.js';
import { getSkillCardType, getSkillTrigger } from './SkillTypes.js';
import type { CombatEvent, CombatEventKind, CombatRef } from './CombatEvents.js';
import {
  BASE_ACTION_INTERVAL_MS,
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
  applyMonsterResistance,
  computeAttackBonus,
  computeBlessedArmsDamage,
  computeNimbleDodge,
  computeRallyMultiplier,
  computeUnnerveReduction,
  effectiveCooldownMs,
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
  incomingFlatReduction,
  initialWarmupMs,
  isUsableActive,
  skillCastTimeMs,
} from './combat/CombatPassives.js';
import {
  isInterruptFlashMode,
  monsterSkillWouldHaveEffect,
  redirectAllowed,
  wouldHaveEffect,
} from './combat/CombatNeeds.js';

export { findTarget } from './combat/CombatTargeting.js';
export { applyMonsterResistance, effectiveCooldownMs } from './combat/CombatPassives.js';
export { isInterruptFlashMode, wouldHaveEffect } from './combat/CombatNeeds.js';
export { buildClientCombatSnapshot } from './combat/CombatSnapshot.js';

// --- Types ---

export interface TickResult {
  logEntries: string[];
  events: CombatEvent[];
  finished: boolean;
  result: 'victory' | 'defeat' | null;
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
  /** Set for hired henchmen — the only thing distinguishing one from a player. */
  isHenchman?: boolean;
  /** Resolved equipped skill definitions (indexed by slot). */
  equippedSkills: (SkillDefinition | null)[];
  /** Actions taken this combat. */
  attackCount: number;
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
  actionIntervalMs: number;
  actionRemainingMs: number;
  /** Length of the current wait. */
  actionTotalMs: number;
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
  | 'actionIntervalMs' | 'actionRemainingMs' | 'actionTotalMs' | 'pulseRemainingMs'
  | 'stunRemainingMs' | 'stunTotalMs' | 'stunSource' | 'cast' | 'skillCooldowns' | 'skillCooldownTotals';

type EngineResetField =
  | 'currentHp' | 'attackCount' | 'dots' | 'hots' | 'damageShield' | 'debuffs' | 'consecutiveHits'
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
}

export interface PartyCombatState {
  players: PartyCombatant[];
  monsters: CombatMonster[];
  /** Steps processed. */
  tickCount: number;
  elapsedMs: number;
  nextEventId: number;
  finished: boolean;
  result: 'victory' | 'defeat' | null;
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
}

type EventFields = Omit<CombatEvent, 'id' | 't' | 'kind'>;

const FIRST_ACTION_STAGGER_MS = 100;
const PLAYER_STAGGER_CAP = 5;
const MONSTER_STAGGER_CAP = 8;

// --- Public API ---

/** Build a fresh combat. Players sort front-to-back/top-to-bottom; monsters front (col 0) first. */
export function createPartyCombatState(
  players: PartyCombatantInit[],
  monsters: MonsterInstance[],
): PartyCombatState {
  const sortedPlayers: PartyCombatant[] = players.map(p => ({
    ...p,
    equippedSkills: [...p.equippedSkills],
    currentHp: p.maxHp,
    attackCount: 0,
    dots: [],
    hots: [],
    damageShield: 0,
    debuffs: [],
    consecutiveHits: 0,
    lastTargetId: '',
    hasResurrected: false,
    martyrBonus: 0,
    activeSkillCount: 0,
    actionIntervalMs: BASE_ACTION_INTERVAL_MS,
    actionRemainingMs: 0,
    actionTotalMs: 0,
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
    const offset = FIRST_ACTION_PLAYER_MS + FIRST_ACTION_STAGGER_MS * Math.min(i, PLAYER_STAGGER_CAP);
    p.actionRemainingMs = offset;
    p.actionTotalMs = offset;
    p.pulseRemainingMs = offset;
    for (const skill of p.equippedSkills) {
      if (!isUsableActive(skill)) continue;
      const warmup = initialWarmupMs(p, skill, sortedPlayers);
      p.skillCooldowns[skill.id] = warmup;
      p.skillCooldownTotals[skill.id] = warmup;
    }
  });

  const sortedMonsters: CombatMonster[] = monsters.map(m => ({
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
  })).sort((a, b) => {
    const colDiff = getCol(a.gridPosition) - getCol(b.gridPosition);
    if (colDiff !== 0) return colDiff;
    return getRow(a.gridPosition) - getRow(b.gridPosition);
  });

  sortedMonsters.forEach((m, i) => {
    const offset = FIRST_ACTION_MONSTER_MS + FIRST_ACTION_STAGGER_MS * Math.min(i, MONSTER_STAGGER_CAP);
    m.pulseRemainingMs = offset;
    if (m.passive) return;
    m.actionIntervalMs = monsterActionIntervalMs(m.attackInterval);
    m.actionRemainingMs = offset;
    m.actionTotalMs = offset;
  });

  return {
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
    nimbleDodge: computeNimbleDodge(sortedPlayers),
    unnerveReduction: computeUnnerveReduction(sortedPlayers),
    blessedArmsDamage: computeBlessedArmsDamage(sortedPlayers),
  };
}

/** Advance combat by one step (`dtMs` clamped to (0, COMBAT_STEP_MS]). Mutates `state`. */
export function processCombatStep(state: PartyCombatState, dtMs: number = COMBAT_STEP_MS): TickResult {
  if (state.finished) {
    return { logEntries: [], events: [], finished: true, result: state.result };
  }
  const dt = Number.isFinite(dtMs) ? Math.min(COMBAT_STEP_MS, Math.max(1, dtMs)) : COMBAT_STEP_MS;
  state.elapsedMs += dt;
  state.tickCount++;
  const step: Step = { state, log: [], events: [], fresh: new Set() };
  if (state.tickCount === 1) emit(step, 'battle_start');
  runStep(step, dt);
  return { logEntries: step.log, events: step.events, finished: state.finished, result: state.result };
}

/** Run `ceil(ms / COMBAT_STEP_MS)` full steps, stopping early when the fight ends. */
export function advanceCombat(state: PartyCombatState, ms: number): TickResult {
  const logEntries: string[] = [];
  const events: CombatEvent[] = [];
  const steps = Math.ceil(ms / COMBAT_STEP_MS);
  for (let i = 0; i < steps && !state.finished; i++) {
    const result = processCombatStep(state, COMBAT_STEP_MS);
    logEntries.push(...result.logEntries);
    events.push(...result.events);
  }
  return { logEntries, events, finished: state.finished, result: state.result };
}

// --- Step ---

function runStep(step: Step, dt: number): void {
  const { state } = step;
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

function emit(step: Step, kind: CombatEventKind, fields: EventFields = {}): void {
  step.events.push({ id: step.state.nextEventId++, t: step.state.elapsedMs, kind, ...fields });
}

function finish(step: Step, result: 'victory' | 'defeat'): void {
  const { state } = step;
  if (state.finished) return;
  state.finished = true;
  state.result = result;
  emit(step, 'battle_end', { result });
}

// Victory is tested first, so a mutual wipe is a victory.
function checkEnd(step: Step): boolean {
  const { state } = step;
  if (state.finished) return true;
  if (state.monsters.every(m => m.passive || !isAlive(m))) {
    finish(step, 'victory');
    return true;
  }
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
  if (state.elapsedMs - state.lastProgressMs >= STALEMATE_WINDOW_MS) {
    step.log.push('The fight drags on — the party withdraws.');
    finish(step, 'defeat');
  }
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

function scheduleNextAction(unit: PartyCombatant | CombatMonster, castMs: number): void {
  const wait = castMs > 0 ? Math.max(unit.actionIntervalMs, castMs) : unit.actionIntervalMs;
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
    const group = grouped.get(dot.name);
    if (group) {
      group.total += dot.damagePerTick;
      group.count++;
    } else {
      grouped.set(dot.name, {
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

function stackSuffix(count: number): string {
  return count > 1 ? ` (x${count})` : '';
}

function pulsePlayer(step: Step, player: PartyCombatant): void {
  const { state } = step;
  if (player.dots.length > 0) {
    for (const group of pulseDotGroups(player.dots)) {
      let damage = group.total;
      const resistPct = player.setBonuses?.damageResistancePercent ?? 0;
      if (resistPct > 0) damage = Math.max(0, Math.floor(damage * (1 - resistPct / 100)));
      damage = Math.max(0, damage - incomingFlatReduction(player, group.damageType, state.players));
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
    const damage = applyMonsterResistance(group.total, group.damageType, monster.resistances);
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
  if (player.cast) {
    player.cast.remainingMs -= dt;
    if (player.cast.remainingMs <= 0) resolvePlayerCast(step, player);
  }
  if (!isAlive(player) || player.stunRemainingMs > 0) return;
  player.actionRemainingMs -= dt;
  if (player.actionRemainingMs > 0 || player.cast) return;
  scheduleNextAction(player, playerAct(step, player));
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

function playerAct(step: Step, player: PartyCombatant): number {
  const { state } = step;
  player.attackCount++;
  let flashMode: boolean | undefined;

  for (const skill of player.equippedSkills) {
    if (!isUsableActive(skill)) continue;
    const trigger = getSkillTrigger(skill);
    if (trigger) {
      if (trigger !== 'enemy_cast') continue;
      flashMode ??= isInterruptFlashMode(state);
      if (!flashMode) continue;
    }
    if ((player.skillCooldowns[skill.id] ?? 0) > 0) continue;
    if (!wouldHaveEffect(player, skill, state)) continue;

    startPlayerCooldown(step, player, skill);
    const castMs = skillCastTimeMs(skill);
    if (castMs > 0) {
      startPlayerCast(step, player, skill, castMs);
      return castMs;
    }
    emit(step, 'attack', {
      src: playerRef(player), dst: primaryTargetRef(player, skill, state, {}), skill: skill.name, skillId: skill.id,
    });
    if (executeSkill(step, player, skill, {})) return 0;
    emitPlayerFizzle(step, player, skill);
    break;
  }

  playerAutoAttack(step, player);
  return 0;
}

function playerAutoAttack(step: Step, player: PartyCombatant): void {
  const target = findTarget(player.gridPosition, step.state.monsters, false);
  if (!target) return;
  const { amount, crit } = computePlayerDamage(player, step.state, target);
  emit(step, 'attack', { src: playerRef(player), dst: monsterRef(target) });
  applyDamageToMonster(step, amount, crit, target, player, false);
}

function startPlayerCooldown(step: Step, player: PartyCombatant, skill: SkillDefinition): void {
  const ms = effectiveCooldownMs(player, skill, step.state.players);
  player.skillCooldowns[skill.id] = ms;
  player.skillCooldownTotals[skill.id] = ms;
  step.fresh.add(`${unitKey(step.state, player)}:${skill.id}`);
}

function startPlayerCast(step: Step, player: PartyCombatant, skill: SkillDefinition, castMs: number): void {
  const target = primaryTargetRef(player, skill, step.state, {});
  player.cast = { skillId: skill.id, skillName: skill.name, totalMs: castMs, remainingMs: castMs, target };
  emit(step, 'cast_start', {
    src: playerRef(player), dst: target, skill: skill.name, skillId: skill.id, durationMs: castMs,
  });
  step.log.push(`${player.username} begins casting ${skill.name}!`);
}

function resolvePlayerCast(step: Step, player: PartyCombatant): void {
  const cast = player.cast;
  if (!cast) return;
  player.cast = null;
  emit(step, 'cast_end', { src: playerRef(player), skill: cast.skillName, skillId: cast.skillId });
  const skill = player.equippedSkills.find(s => s?.id === cast.skillId);
  if (!skill) return;
  const ctx: EffectContext = {
    enemy: cast.target?.side === 'monster' ? findLiveMonsterAt(step.state, cast.target.pos) : undefined,
  };
  // No skillId: the client restarts cooldown sweeps on attack events that carry one.
  emit(step, 'attack', { src: playerRef(player), dst: primaryTargetRef(player, skill, step.state, ctx), skill: skill.name });
  if (!executeSkill(step, player, skill, ctx)) emitPlayerFizzle(step, player, skill);
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
      ally = healTarget(state.players, healOptionAmount(player, effect, 4), ctx.ally);
      break;
    case 'hot_lowest':
      ally = healTarget(state.players, healOptionAmount(player, effect, 2), ctx.ally);
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
  target?: CombatMonster,
  options?: { isActive?: boolean },
): { amount: number; crit: boolean } {
  const variance = Math.floor(Math.random() * 5) - 2;
  const attackBonus = computeAttackBonus(player.equipBonuses);
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
  const critChance = getCritChance(player);
  if (critChance > 0 && Math.random() < critChance) {
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
  // DoT riders use pre-resistance damage; resistance applies again at pulse time.
  const preMrDamage = damage;

  if (target.resistances.length > 0) {
    damage = applyMonsterResistance(damage, player.playerDamageType, target.resistances);
  }
  let holyDamage = state.blessedArmsDamage;
  if (holyDamage > 0 && target.resistances.length > 0) {
    holyDamage = applyMonsterResistance(holyDamage, 'holy', target.resistances);
  }
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
    if (existing) {
      existing.remainingMs = SCORCH_MS;
    } else {
      target.debuffs.push({ type: 'scorch', value: getPassiveValue(player, 'scorch'), remainingMs: SCORCH_MS, name: scorchSkill.name });
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
        target.dots.push({
          sourceUsername: player.username,
          name: passiveSkill.name.toLowerCase(),
          label: passiveSkill.name,
          source: src,
          damagePerTick: Math.max(1, perTick),
          ticksRemaining: 1,
          damageType: 'magical',
          permanent: true,
        });
        emit(step, 'status', { src, dst, name: passiveSkill.name });
      }
    }
  }

  if (hasPassive(player, 'stacking_same_target')) {
    if (player.lastTargetId === target.name) {
      player.consecutiveHits++;
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

function overflowSplash(step: Step, player: PartyCombatant, killed: CombatMonster, overkill: number): void {
  if (overkill <= 0) return;
  const others = step.state.monsters.filter(m => isAlive(m) && m !== killed);
  if (others.length === 0) return;
  const splashTarget = others[Math.floor(Math.random() * others.length)];
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
  let amount = Math.floor(baseAmount * getHealPowerMultiplier(healer));
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
  const { amount, crit } = computePlayerDamage(player, step.state, target, { isActive: true });
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
      if (isAlive(target) && Math.random() < (effect.stunChance ?? 0)) {
        applyStunToMonster(step, target, src, ctx.suppressInterruptFor);
      }
      return true;
    }

    case 'stun_aoe': {
      let anyStunned = false;
      for (const monster of state.monsters) {
        if (!isAlive(monster) || monster.passive) continue;
        if (Math.random() < (effect.stunChance ?? 0)) {
          step.log.push(`${player.username}'s ${sn} stuns ${monster.name}!`);
          applyStunToMonster(step, monster, src, ctx.suppressInterruptFor);
          anyStunned = true;
        }
      }
      return anyStunned;
    }

    case 'heal_lowest': {
      const target = healTarget(state.players, healOptionAmount(player, effect, 4), ctx.ally);
      if (!target) return false;
      return applyHeal(step, player, target, player.level * (effect.healMultiplier ?? 4), skill) > 0;
    }

    case 'multi_hit': {
      const hitCount = effect.hitCount ?? 4;
      const { amount, crit } = computePlayerDamage(player, state, undefined, { isActive: true });
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
          target.sunderMark = { stacks: 1, totalBonus: markMultiplier, name: sn };
        } else {
          const priorBonus = target.sunderMark.totalBonus ?? target.sunderMark.stacks * 0.25;
          target.sunderMark.stacks++;
          target.sunderMark.totalBonus = priorBonus + markMultiplier;
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
      const { amount, crit } = computePlayerDamage(player, state, undefined, { isActive: true });
      const perHit = Math.max(1, Math.floor(amount * arcaneMult * (effect.damagePercent ?? 0.50)));
      let hit = false;
      for (let i = 0; i < hitCount; i++) {
        const alive = state.monsters.filter(isAlive);
        if (alive.length === 0) break;
        const target = alive[Math.floor(Math.random() * alive.length)];
        applyDamageToMonster(step, perHit, crit, target, player, true, skill);
        hit = true;
      }
      return hit;
    }

    case 'ignore_dr_single': {
      const target = gridEnemyTarget(player, state.monsters, ctx.enemy);
      if (!target) return false;
      const { amount, crit } = computePlayerDamage(player, state, target, { isActive: true });
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
          type: 'crippling_shot', value: percent, remainingMs: (effect.debuffDuration ?? 3) * 1000, name: sn,
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
      const healPerPulse = healOptionAmount(player, effect, 2);
      const target = healTarget(state.players, healPerPulse, ctx.ally);
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
      step.log.push(`${player.username} applies ${sn} to ${target.username} (${adjustedHeal} HP per second for ${pulses} seconds)`);
      emit(step, 'status', { src, dst: playerRef(target), name: sn });
      return true;
    }

    case 'shield_non_knight': {
      const target = shieldTarget(state.players, ctx.ally);
      if (!target) return false;
      const shieldAmount = player.level * (effect.shieldMultiplier ?? 4);
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
        const damage = Math.max(1, Math.floor(effect.damagePerLevel * player.level)) * arcaneMult;
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
        const { amount, crit } = computePlayerDamage(player, state, undefined, { isActive: true });
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
      const buffAmount = effect.buffPercent ?? 0.10;
      state.warSongBonus += buffAmount;
      const existing = state.partyBuffs.find(b => b.name === sn);
      if (existing) existing.stacks++;
      else state.partyBuffs.push({ name: sn, stacks: 1 });
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
      let any = false;
      for (const monster of state.monsters) {
        if (!isAlive(monster) || monster.passive) continue;
        any = true;
        const existing = monster.debuffs.find(d => d.type === 'lullaby');
        if (existing) {
          existing.remainingMs = seconds * 1000;
        } else {
          monster.debuffs.push({ type: 'lullaby', value: debuffAmount, remainingMs: seconds * 1000, name: sn });
        }
        emit(step, 'status', { src, dst: monsterRef(monster), name: sn });
      }
      if (any) {
        step.log.push(`${player.username}'s ${sn} reduces enemy damage by ${Math.round(debuffAmount * 100)}% for ${seconds} seconds`);
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

// A pending counter owns the cancel of its caster's spell, so its own stun must not interrupt it.
function applyStunToMonster(
  step: Step,
  monster: CombatMonster,
  src: CombatRef | undefined,
  suppressInterruptFor: CombatMonster | undefined,
): void {
  if (!isAlive(monster) || monster.passive) return;
  if (STUN_MS > monster.stunRemainingMs) {
    monster.stunRemainingMs = STUN_MS;
    monster.stunTotalMs = STUN_MS;
  }
  emit(step, 'stun', { src, dst: monsterRef(monster), durationMs: STUN_MS });
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
      const value = Math.max(1, finiteOr0(entry.value));
      if (def.targeting === 'aoe_all') {
        const targets = state.players.filter(isAlive);
        if (targets.length === 0) return false;
        step.log.push(`${monster.name} casts ${def.name}!`);
        emit(step, 'attack', { src, skill: def.name, skillId: entry.skillId });
        for (const p of targets) {
          if (!isAlive(p)) continue;
          if (rollDodge(state)) {
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
      const perPulse = Math.max(1, finiteOr0(entry.value));
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
      step.log.push(`${monster.name} casts ${def.name} on ${target.username}! (${perPulse} ${damageType} damage per second for ${pulses} seconds)`);
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

function rollDodge(state: PartyCombatState): boolean {
  return state.nimbleDodge > 0 && Math.random() < state.nimbleDodge;
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
  if (rollDodge(state)) {
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
  const target = alive[Math.floor(Math.random() * alive.length)];
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

  const setResistPct = target.setBonuses?.damageResistancePercent ?? 0;
  let scaledRaw = rawDamage;
  if (setResistPct > 0) {
    scaledRaw = Math.max(0, Math.floor(scaledRaw * (1 - setResistPct / 100)));
  }
  let damage = Math.max(0, scaledRaw - incomingFlatReduction(target, damageType, state.players));

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
    if (bashSkill && Math.random() < getPassiveValue(target, 'stun_on_phys_hit')) {
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
        src: playerRef(player), dst: monsterRef(caster), skill: skill.name, skillId: skill.id, cardType: 'interrupt',
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
      cardType: 'interrupt',
    });
    step.log.push(`${reactor.username}'s ${skill.name} counters ${caster.name}'s ${cast.skillName}!`);
  } else if (!effective) {
    emitPlayerFizzle(step, reactor, skill);
  }
}
