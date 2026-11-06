import { getSkillCardType, getSkillTrigger, isTimedSkill } from '../SkillTypes.js';
import type { SkillDefinition } from '../SkillTypes.js';
import type {
  ClientCombatBossPhases,
  ClientCombatCast,
  ClientCombatSkill,
  ClientCombatSnapshot,
  ClientCombatStatus,
  ClientCombatUnit,
} from '../CombatEvents.js';
import type {
  CombatCast,
  CombatDebuff,
  CombatMonster,
  DotEffect,
  HotEffect,
  PartyCombatant,
  PartyCombatState,
} from '../CombatEngine.js';
import { paceRealMs } from '../CombatPace.js';
import { MIN_COOLDOWN_MS, STATUS_PULSE_MS } from '../CombatTiming.js';
import {
  actionTimeMs,
  baseCooldownMs,
  baseCycleMs,
  isUsableActive,
  playerCastMs,
  skillChargeMs,
  skillRecoveryMs,
  useCooldownMs,
} from './CombatPassives.js';
import { nextActionWaitMs, wouldHaveEffect } from './CombatNeeds.js';

type RealMs = (engineMs: number) => number;

/** Client view of a combat, in real milliseconds. `full` adds the static fields (names, ids, skill metadata). */
export function buildClientCombatSnapshot(state: PartyCombatState, battleId: number, full: boolean): ClientCombatSnapshot {
  const real: RealMs = ms => paceRealMs(state.pace, ms);
  const units: ClientCombatUnit[] = [
    ...state.players.map(p => playerUnit(state, p, full, real)),
    ...state.monsters.map(m => monsterUnit(m, full, real)),
  ];
  const snapshot: ClientCombatSnapshot = {
    battleId,
    elapsedMs: real(state.elapsedMs),
    full,
    finished: state.finished,
    result: state.result,
    units,
  };
  if (state.bossPhases) snapshot.bossPhases = bossPhasesView(state, full);
  return snapshot;
}

function bossPhasesView(state: PartyCombatState, full: boolean): ClientCombatBossPhases {
  const phases = state.bossPhases!;
  const view: ClientCombatBossPhases = {
    bossPos: phases.bossIndices.map(i => state.monsters[i]?.gridPosition).filter(pos => pos !== undefined),
    phase: phases.phase,
  };
  if (full) view.thresholds = [...phases.thresholds];
  if (phases.resumedFromPhase !== undefined) view.resumedFromPhase = phases.resumedFromPhase;
  return view;
}

function playerUnit(
  state: PartyCombatState,
  player: PartyCombatant,
  full: boolean,
  real: RealMs,
): ClientCombatUnit {
  const stunned = player.currentHp > 0 && player.stunRemainingMs > 0;
  const actionMs = player.attack ? nextActionWaitMs(state, player) : Math.max(0, player.actionRemainingMs);
  // Display-only, and kept: the ring must run down from a raised total, not restart at every snapshot.
  if (player.attack) player.actionTotalMs = Math.max(player.actionTotalMs, actionMs);
  const unit: ClientCombatUnit = {
    side: 'player',
    pos: player.gridPosition,
    hp: player.currentHp,
    maxHp: player.maxHp,
    actionMs: real(actionMs),
    actionTotalMs: real(player.actionTotalMs),
  };
  if (player.damageShield > 0) unit.shield = player.damageShield;
  if (stunned) {
    unit.stunMs = real(player.stunRemainingMs);
    unit.stunTotalMs = real(player.stunTotalMs);
  }
  if (player.recoveryRemainingMs > 0) {
    unit.recoveryMs = real(player.recoveryRemainingMs);
    unit.recoveryTotalMs = real(player.recoveryTotalMs);
  }
  if (player.cast) unit.cast = castView(player.cast, stunned, real);
  const statuses = player.currentHp > 0 ? playerStatuses(state, player, real) : [];
  if (statuses.length > 0) unit.statuses = statuses;
  if (!player.isHenchman) unit.skills = skillViews(state, player, full, real);

  if (full) {
    unit.name = player.username;
    unit.level = player.level;
    unit.actionIntervalMs = real(player.actionIntervalMs);
    if (player.isHenchman) {
      unit.henchman = true;
    } else {
      unit.className = player.className;
      unit.passives = player.equippedSkills
        .filter((s): s is SkillDefinition => !!s && s.type === 'passive')
        .map(s => s.id);
    }
  }
  return unit;
}

function monsterUnit(monster: CombatMonster, full: boolean, real: RealMs): ClientCombatUnit {
  const unit: ClientCombatUnit = {
    side: 'monster',
    pos: monster.gridPosition,
    hp: monster.currentHp,
    maxHp: monster.maxHp,
    actionMs: real(Math.max(0, monster.actionRemainingMs)),
    actionTotalMs: real(monster.actionTotalMs),
  };
  if (monster.currentHp > 0 && monster.stunRemainingMs > 0) {
    unit.stunMs = real(monster.stunRemainingMs);
    unit.stunTotalMs = real(monster.stunTotalMs);
  }
  if (monster.cast) unit.cast = castView(monster.cast, false, real);
  const statuses = monster.currentHp > 0 ? monsterStatuses(monster, real) : [];
  if (statuses.length > 0) unit.statuses = statuses;
  if (monster.enrageState) {
    const { atMs, stacks, stepMs, stepPercent, maxStacks } = monster.enrageState;
    unit.enrage = { atMs: real(atMs), stacks, stepMs: real(stepMs), stepPercent, maxStacks };
  }

  if (full) {
    unit.name = monster.name;
    unit.id = monster.id;
    unit.level = monster.level ?? 1;
    unit.levelSource = monster.levelSource ?? (monster.level === undefined ? 'derived' : 'authored');
    unit.tier = monster.tier ?? 'trash';
    if (!monster.passive) unit.actionIntervalMs = real(monster.actionIntervalMs);
    if (monster.passive) unit.passive = true;
    if (monster.description) unit.description = monster.description;
  }
  return unit;
}

function castView(cast: CombatCast, paused: boolean, real: RealMs): ClientCombatCast {
  const view: ClientCombatCast = {
    skill: cast.skillName,
    skillId: cast.skillId,
    totalMs: real(cast.totalMs),
    remainingMs: real(Math.max(0, cast.remainingMs)),
  };
  if (cast.target) view.target = cast.target;
  if (paused) view.paused = true;
  return view;
}

function skillViews(
  state: PartyCombatState,
  player: PartyCombatant,
  full: boolean,
  real: RealMs,
): ClientCombatSkill[] {
  const views: ClientCombatSkill[] = [];
  for (const skill of player.equippedSkills) {
    if (!isUsableActive(skill)) continue;
    const remainingMs = player.skillCooldowns[skill.id] ?? 0;
    const trigger = getSkillTrigger(skill);
    let skillState: ClientCombatSkill['state'];
    if (player.cast?.skillId === skill.id) skillState = 'casting';
    else if (remainingMs > 0) skillState = 'cooldown';
    else if (trigger) skillState = 'armed';
    else if (!wouldHaveEffect(player, skill, state)) skillState = 'held';
    else skillState = 'ready';

    const view: ClientCombatSkill = {
      id: skill.id,
      remainingMs: real(remainingMs),
      cooldownMs: real(player.skillCooldownTotals[skill.id] ?? 0),
      state: skillState,
    };
    if (full) {
      view.name = skill.name;
      view.cardType = getSkillCardType(skill);
      if (trigger) view.trigger = trigger;
      view.castTimeMs = real(playerCastMs(player, skill));
      view.baseCooldownMs = real(isTimedSkill(skill)
        ? baseCycleMs(state.pace, player, skill)
        : actionTimeMs(player, skill, Math.max(MIN_COOLDOWN_MS, baseCooldownMs(skill))));
      view.useCooldownMs = real(useCooldownMs(state.pace, player, skill, state.players));
      addTimedFields(state, skill, view, real);
    }
    views.push(view);
  }
  if (player.attack) views.push(attackView(state, player, player.attack, full, real));
  return views;
}

function attackView(
  state: PartyCombatState,
  player: PartyCombatant,
  attack: SkillDefinition,
  full: boolean,
  real: RealMs,
): ClientCombatSkill {
  const remainingMs = player.skillCooldowns[attack.id] ?? 0;
  const view: ClientCombatSkill = {
    id: attack.id,
    remainingMs: real(remainingMs),
    cooldownMs: real(player.skillCooldownTotals[attack.id] ?? 0),
    state: remainingMs > 0 ? 'cooldown' : 'ready',
  };
  if (full) {
    view.name = attack.name;
    view.cardType = getSkillCardType(attack);
    view.castTimeMs = 0;
    view.baseCooldownMs = real(baseCycleMs(state.pace, player, attack));
    view.useCooldownMs = real(useCooldownMs(state.pace, player, attack, state.players));
    addTimedFields(state, attack, view, real);
  }
  return view;
}

function addTimedFields(state: PartyCombatState, skill: SkillDefinition, view: ClientCombatSkill, real: RealMs): void {
  if (!isTimedSkill(skill)) return;
  view.chargeMs = real(skillChargeMs(state.pace, skill));
  view.recoveryMs = real(skillRecoveryMs(state.pace, skill));
}

function pulseRemainingMs(ticksRemaining: number, pulseRemaining: number): number {
  return Math.max(0, (ticksRemaining - 1) * STATUS_PULSE_MS + Math.max(0, pulseRemaining));
}

function dotStatuses(dots: DotEffect[], pulseRemaining: number, real: RealMs): ClientCombatStatus[] {
  const grouped = new Map<string, ClientCombatStatus>();
  for (const dot of dots) {
    const remaining = dot.permanent ? undefined : real(pulseRemainingMs(dot.ticksRemaining, pulseRemaining));
    const existing = grouped.get(dot.name);
    if (existing) {
      existing.stacks = (existing.stacks ?? 1) + 1;
      if (remaining !== undefined && (existing.remainingMs === undefined || remaining > existing.remainingMs)) {
        existing.remainingMs = remaining;
      }
    } else {
      const status: ClientCombatStatus = { kind: 'dot', name: dot.label ?? dot.name };
      if (remaining !== undefined) status.remainingMs = remaining;
      grouped.set(dot.name, status);
    }
  }
  return [...grouped.values()];
}

function hotStatuses(hots: HotEffect[], pulseRemaining: number, real: RealMs): ClientCombatStatus[] {
  const grouped = new Map<string, ClientCombatStatus>();
  for (const hot of hots) {
    const remaining = real(pulseRemainingMs(hot.ticksRemaining, pulseRemaining));
    const existing = grouped.get(hot.name);
    if (existing) {
      existing.stacks = (existing.stacks ?? 1) + 1;
      existing.remainingMs = Math.max(existing.remainingMs ?? 0, remaining);
    } else {
      grouped.set(hot.name, { kind: 'hot', name: hot.label ?? hot.name, remainingMs: remaining });
    }
  }
  return [...grouped.values()];
}

function debuffStatuses(debuffs: CombatDebuff[], real: RealMs): ClientCombatStatus[] {
  const grouped = new Map<string, ClientCombatStatus>();
  for (const debuff of debuffs) {
    const key = `${debuff.type}:${debuff.name ?? ''}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.stacks = (existing.stacks ?? 1) + 1;
      existing.remainingMs = Math.max(existing.remainingMs ?? 0, real(debuff.remainingMs));
    } else {
      grouped.set(key, {
        kind: debuff.type === 'scorch' ? 'scorch' : 'debuff',
        name: debuff.name ?? debuff.type,
        remainingMs: real(debuff.remainingMs),
      });
    }
  }
  return [...grouped.values()];
}

function playerStatuses(state: PartyCombatState, player: PartyCombatant, real: RealMs): ClientCombatStatus[] {
  const statuses = [
    ...dotStatuses(player.dots, player.pulseRemainingMs, real),
    ...hotStatuses(player.hots, player.pulseRemainingMs, real),
    ...debuffStatuses(player.debuffs, real),
  ];
  for (const buff of state.partyBuffs) {
    const status: ClientCombatStatus = { kind: 'buff', name: buff.name };
    if (buff.stacks > 1) status.stacks = Math.round(buff.stacks);
    statuses.push(status);
  }
  return statuses;
}

function monsterStatuses(monster: CombatMonster, real: RealMs): ClientCombatStatus[] {
  const statuses = [
    ...dotStatuses(monster.dots, monster.pulseRemainingMs, real),
    ...debuffStatuses(monster.debuffs, real),
  ];
  for (const buff of monster.buffs) {
    const status: ClientCombatStatus = { kind: 'buff', name: buff.name ?? buff.type };
    if (buff.remainingMs >= 0) status.remainingMs = real(buff.remainingMs);
    statuses.push(status);
  }
  if (monster.sunderMark && monster.sunderMark.stacks > 0) {
    const status: ClientCombatStatus = { kind: 'mark', name: monster.sunderMark.name ?? 'Sunder' };
    if (monster.sunderMark.stacks > 1) status.stacks = Math.round(monster.sunderMark.stacks);
    statuses.push(status);
  }
  if (monster.chaosActive) statuses.push({ kind: 'chaos', name: monster.chaosName ?? 'Chaos' });
  if (monster.enrageState && monster.enrageState.stacks > 0) {
    statuses.push({ kind: 'enrage', name: 'Enraged', stacks: monster.enrageState.stacks });
  }
  return statuses;
}
