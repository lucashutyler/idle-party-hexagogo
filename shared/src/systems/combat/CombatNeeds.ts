import { resolveActionOrder } from '../SkillTypes.js';
import type { ActiveEffect, SkillDefinition } from '../SkillTypes.js';
import { MONSTER_SKILL_CATALOG } from '../MonsterSkills.js';
import type { MonsterSkillDefinition } from '../MonsterSkills.js';
import type { EffectContext, InFlightAttack, PartyCombatant, PartyCombatState } from '../CombatEngine.js';
import { WAR_SONG_MAX_STACKS } from '../CombatScaling.js';
import { COMBAT_STEP_MS } from '../CombatTiming.js';
import {
  cureTarget,
  healTarget,
  isAlive,
  monsterHealTarget,
  shieldTarget,
} from './CombatTargeting.js';

/**
 * Engine ms until a player with an Attack skill next acts, as things stand: the action choice's walk, timed instead of
 * taken. A skill that isn't needed yet doesn't count, so a need that appears can bring the action forward.
 * One step at least: a player acts at most once a step, so what is ready now goes on the next.
 */
export function nextActionWaitMs(state: PartyCombatState, player: PartyCombatant): number {
  let soonestMs = Infinity;
  for (const skill of resolveActionOrder(player.equippedSkills, player.attack, player.actionOrder)) {
    const chargeMs = player.skillCooldowns[skill.id] ?? 0;
    if (chargeMs >= soonestMs) continue;
    if (skill.type === 'attack' || wouldHaveEffect(player, skill, state)) soonestMs = chargeMs;
  }
  return Math.max(player.actionRemainingMs, player.cast?.remainingMs ?? 0, soonestMs, COMBAT_STEP_MS);
}

/**
 * Whether using the skill now would do anything (the "needed" check). Uses the same target helpers
 * as the executor; `ctx` carries a reaction's trigger context. A skill that fails it is held.
 */
export function wouldHaveEffect(
  player: PartyCombatant,
  skill: SkillDefinition,
  state: PartyCombatState,
  ctx: EffectContext = {},
): boolean {
  return (skill.activeEffects ?? []).some(effect => optionWouldHaveEffect(player, skill, effect, state, ctx));
}

export function optionWouldHaveEffect(
  player: PartyCombatant,
  skill: SkillDefinition,
  effect: ActiveEffect,
  state: PartyCombatState,
  ctx: EffectContext,
): boolean {
  switch (effect.kind) {
    case 'heal_lowest':
    case 'hot_lowest':
      return healTarget(state.players, ctx.ally) !== null;
    case 'cure_debuffs':
      return cureTarget(state.players, ctx.ally) !== null;
    case 'shield_non_knight':
      return shieldTarget(state.players, ctx.ally) !== null;
    case 'redirect_hit':
      return ctx.trigger === 'ally_targeted' && !!ctx.attack && redirectAllowed(player, ctx.attack, state);
    case 'brace_reflect':
      return ctx.trigger === 'self_hit' && ctx.hit?.damageType === 'physical' && state.monsters.some(isAlive);
    case 'stun_aoe':
      return state.monsters.some(m => isAlive(m) && !m.passive);
    case 'party_buff_permanent':
      return partyBuffStacks(state, skill.name) < WAR_SONG_MAX_STACKS && state.monsters.some(isAlive);
    default:
      return state.monsters.some(isAlive);
  }
}

export function partyBuffStacks(state: PartyCombatState, name: string): number {
  return state.partyBuffs.find(b => b.name === name)?.stacks ?? 0;
}

/**
 * Intercept only protects frailer allies, never re-redirects, and while an enemy spell is locked
 * onto someone else it saves itself for that spell's resolution.
 */
export function redirectAllowed(reactor: PartyCombatant, attack: InFlightAttack, state: PartyCombatState): boolean {
  if (attack.redirected || attack.target === reactor) return false;
  if (attack.target.maxHp >= reactor.maxHp) return false;
  if (attack.lockedCast) return true;
  return !state.monsters.some(m => isAlive(m) && m.cast?.target?.side === 'player'
    && m.cast.target.pos !== reactor.gridPosition
    && MONSTER_SKILL_CATALOG[m.cast.skillId]?.effect === 'damage');
}

/** Monster skill "needed" check at the monster's action — a skill with nothing to do keeps its cooldown. */
export function monsterSkillWouldHaveEffect(
  def: MonsterSkillDefinition,
  state: PartyCombatState,
): boolean {
  const anyPlayer = state.players.some(isAlive);
  switch (def.effect) {
    case 'damage':
      return anyPlayer && (def.targeting === 'aoe_all' || def.targeting === 'lowest_hp_enemy');
    case 'dot':
      return anyPlayer && (def.targeting === 'standard' || def.targeting === 'lowest_hp_enemy');
    case 'stun':
      return def.targeting === 'all_class' && !!def.targetClasses
        && state.players.some(p => isAlive(p) && def.targetClasses!.includes(p.className));
    case 'heal':
      return def.targeting === 'lowest_hp_ally' && monsterHealTarget(state.monsters) !== null;
    default:
      return false;
  }
}

