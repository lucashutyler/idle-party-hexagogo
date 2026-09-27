import { getSkillCardType, getSkillTrigger } from '../SkillTypes.js';
import type { SkillDefinition } from '../SkillTypes.js';
import type {
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
import { STATUS_PULSE_MS } from '../CombatTiming.js';
import { isUsableActive, skillCastTimeMs } from './CombatPassives.js';
import { isInterruptFlashMode, wouldHaveEffect } from './CombatNeeds.js';

/** Client view of a combat. `full` adds the static fields (names, ids, skill metadata). */
export function buildClientCombatSnapshot(state: PartyCombatState, battleId: number, full: boolean): ClientCombatSnapshot {
  let flashMode: boolean | undefined;
  const isFlash = (): boolean => flashMode ??= isInterruptFlashMode(state);
  const units: ClientCombatUnit[] = [
    ...state.players.map(p => playerUnit(state, p, full, isFlash)),
    ...state.monsters.map(m => monsterUnit(m, full)),
  ];
  return {
    battleId,
    elapsedMs: state.elapsedMs,
    full,
    finished: state.finished,
    result: state.result,
    units,
  };
}

function playerUnit(
  state: PartyCombatState,
  player: PartyCombatant,
  full: boolean,
  isFlash: () => boolean,
): ClientCombatUnit {
  const stunned = player.currentHp > 0 && player.stunRemainingMs > 0;
  const unit: ClientCombatUnit = {
    side: 'player',
    pos: player.gridPosition,
    hp: player.currentHp,
    maxHp: player.maxHp,
    actionMs: Math.max(0, player.actionRemainingMs),
    actionTotalMs: player.actionTotalMs,
  };
  if (player.damageShield > 0) unit.shield = player.damageShield;
  if (stunned) {
    unit.stunMs = player.stunRemainingMs;
    unit.stunTotalMs = player.stunTotalMs;
  }
  if (player.cast) unit.cast = castView(player.cast, stunned);
  const statuses = player.currentHp > 0 ? playerStatuses(state, player) : [];
  if (statuses.length > 0) unit.statuses = statuses;
  if (!player.isHenchman) unit.skills = skillViews(state, player, full, isFlash);

  if (full) {
    unit.name = player.username;
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

function monsterUnit(monster: CombatMonster, full: boolean): ClientCombatUnit {
  const unit: ClientCombatUnit = {
    side: 'monster',
    pos: monster.gridPosition,
    hp: monster.currentHp,
    maxHp: monster.maxHp,
    actionMs: Math.max(0, monster.actionRemainingMs),
    actionTotalMs: monster.actionTotalMs,
  };
  if (monster.currentHp > 0 && monster.stunRemainingMs > 0) {
    unit.stunMs = monster.stunRemainingMs;
    unit.stunTotalMs = monster.stunTotalMs;
  }
  if (monster.cast) unit.cast = castView(monster.cast, false);
  const statuses = monster.currentHp > 0 ? monsterStatuses(monster) : [];
  if (statuses.length > 0) unit.statuses = statuses;

  if (full) {
    unit.name = monster.name;
    unit.id = monster.id;
    if (monster.passive) unit.passive = true;
    if (monster.description) unit.description = monster.description;
  }
  return unit;
}

function castView(cast: CombatCast, paused: boolean): ClientCombatCast {
  const view: ClientCombatCast = {
    skill: cast.skillName,
    skillId: cast.skillId,
    totalMs: cast.totalMs,
    remainingMs: Math.max(0, cast.remainingMs),
  };
  if (cast.target) view.target = cast.target;
  if (paused) view.paused = true;
  return view;
}

function skillViews(
  state: PartyCombatState,
  player: PartyCombatant,
  full: boolean,
  isFlash: () => boolean,
): ClientCombatSkill[] {
  const views: ClientCombatSkill[] = [];
  for (const skill of player.equippedSkills) {
    if (!isUsableActive(skill)) continue;
    const remainingMs = player.skillCooldowns[skill.id] ?? 0;
    const trigger = getSkillTrigger(skill);
    let skillState: ClientCombatSkill['state'];
    if (player.cast?.skillId === skill.id) skillState = 'casting';
    else if (remainingMs > 0) skillState = 'cooldown';
    else if (trigger && !(trigger === 'enemy_cast' && isFlash())) skillState = 'armed';
    else if (!wouldHaveEffect(player, skill, state)) skillState = 'held';
    else skillState = 'ready';

    const view: ClientCombatSkill = {
      id: skill.id,
      remainingMs,
      cooldownMs: player.skillCooldownTotals[skill.id] ?? 0,
      state: skillState,
    };
    if (full) {
      view.name = skill.name;
      view.cardType = getSkillCardType(skill);
      if (trigger) view.trigger = trigger;
      view.castTimeMs = skillCastTimeMs(skill);
    }
    views.push(view);
  }
  return views;
}

function pulseRemainingMs(ticksRemaining: number, pulseRemaining: number): number {
  return Math.max(0, (ticksRemaining - 1) * STATUS_PULSE_MS + Math.max(0, pulseRemaining));
}

function dotStatuses(dots: DotEffect[], pulseRemaining: number): ClientCombatStatus[] {
  const grouped = new Map<string, ClientCombatStatus>();
  for (const dot of dots) {
    const remaining = dot.permanent ? undefined : pulseRemainingMs(dot.ticksRemaining, pulseRemaining);
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

function hotStatuses(hots: HotEffect[], pulseRemaining: number): ClientCombatStatus[] {
  const grouped = new Map<string, ClientCombatStatus>();
  for (const hot of hots) {
    const remaining = pulseRemainingMs(hot.ticksRemaining, pulseRemaining);
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

function debuffStatuses(debuffs: CombatDebuff[]): ClientCombatStatus[] {
  const grouped = new Map<string, ClientCombatStatus>();
  for (const debuff of debuffs) {
    const key = `${debuff.type}:${debuff.name ?? ''}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.stacks = (existing.stacks ?? 1) + 1;
      existing.remainingMs = Math.max(existing.remainingMs ?? 0, debuff.remainingMs);
    } else {
      grouped.set(key, {
        kind: debuff.type === 'scorch' ? 'scorch' : 'debuff',
        name: debuff.name ?? debuff.type,
        remainingMs: debuff.remainingMs,
      });
    }
  }
  return [...grouped.values()];
}

function playerStatuses(state: PartyCombatState, player: PartyCombatant): ClientCombatStatus[] {
  const statuses = [
    ...dotStatuses(player.dots, player.pulseRemainingMs),
    ...hotStatuses(player.hots, player.pulseRemainingMs),
    ...debuffStatuses(player.debuffs),
  ];
  for (const buff of state.partyBuffs) {
    const status: ClientCombatStatus = { kind: 'buff', name: buff.name };
    if (buff.stacks > 1) status.stacks = buff.stacks;
    statuses.push(status);
  }
  return statuses;
}

function monsterStatuses(monster: CombatMonster): ClientCombatStatus[] {
  const statuses = [
    ...dotStatuses(monster.dots, monster.pulseRemainingMs),
    ...debuffStatuses(monster.debuffs),
  ];
  for (const buff of monster.buffs) {
    const status: ClientCombatStatus = { kind: 'buff', name: buff.name ?? buff.type };
    if (buff.remainingMs >= 0) status.remainingMs = buff.remainingMs;
    statuses.push(status);
  }
  if (monster.sunderMark && monster.sunderMark.stacks > 0) {
    const status: ClientCombatStatus = { kind: 'mark', name: monster.sunderMark.name ?? 'Sunder' };
    if (monster.sunderMark.stacks > 1) status.stacks = monster.sunderMark.stacks;
    statuses.push(status);
  }
  if (monster.chaosActive) statuses.push({ kind: 'chaos', name: monster.chaosName ?? 'Chaos' });
  return statuses;
}
