import type { ActiveEffect, SkillDefinition } from '../SkillTypes.js';
import { MONSTER_SKILL_CATALOG, getMonsterSkillCastTimeMs } from '../MonsterSkills.js';
import type { MonsterSkillDefinition } from '../MonsterSkills.js';
import type { EffectContext, InFlightAttack, PartyCombatant, PartyCombatState } from '../CombatEngine.js';
import { healOptionAmount } from './CombatPassives.js';
import {
  cureTarget,
  healTarget,
  isAlive,
  monsterHealTarget,
  shieldTarget,
} from './CombatTargeting.js';

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
  return (skill.activeEffects ?? []).some(effect => optionWouldHaveEffect(player, effect, state, ctx));
}

export function optionWouldHaveEffect(
  player: PartyCombatant,
  effect: ActiveEffect,
  state: PartyCombatState,
  ctx: EffectContext,
): boolean {
  switch (effect.kind) {
    case 'heal_lowest':
      return healTarget(state.players, healOptionAmount(player, effect, 4), ctx.ally) !== null;
    case 'hot_lowest':
      return healTarget(state.players, healOptionAmount(player, effect, 2), ctx.ally) !== null;
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
    default:
      return state.monsters.some(isAlive);
  }
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

function monsterSkillCanApplyThisFight(def: MonsterSkillDefinition, state: PartyCombatState): boolean {
  switch (def.effect) {
    case 'stun':
      return !!def.targetClasses && state.players.some(p => isAlive(p) && def.targetClasses!.includes(p.className));
    default:
      return true;
  }
}

/**
 * Interrupt "flash mode": no living enemy can ever cast in this fight, so enemy_cast skills
 * act as ordinary action skills instead of waiting for a cast that will never come.
 */
export function isInterruptFlashMode(state: PartyCombatState): boolean {
  return !state.monsters.some(m => isAlive(m) && !m.passive && m.skills.some(entry => {
    const def = MONSTER_SKILL_CATALOG[entry.skillId];
    if (!def || getMonsterSkillCastTimeMs(entry, def) <= 0) return false;
    return monsterSkillCanApplyThisFight(def, state);
  }));
}
