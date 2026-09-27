import type { DamageType } from '../CharacterStats.js';
import type { EquipmentBonuses } from '../ItemTypes.js';
import type { Resistance } from '../MonsterTypes.js';
import type { ActiveEffect, PassiveEffect, PassiveEffectKind, SkillDefinition } from '../SkillTypes.js';
import { getSkillTrigger } from '../SkillTypes.js';
import type { CombatMonster, PartyCombatant, PartyCombatState } from '../CombatEngine.js';
import { COMBAT_STEP_MS, MIN_COOLDOWN_MS } from '../CombatTiming.js';
import {
  MAX_ENEMY_DAMAGE_REDUCTION,
  SKILL_RATING_SCALE,
  percentResistFactor,
  ratingMitigation,
  scaleDamage,
} from '../CombatScaling.js';

const MAX_CAST_TIME_MS = 10000;
const MAX_WARMUP_MS = 60000;

// --- Passive lookups ---

/** Every passive option of the given kind across a player's equipped skills (slot order, then option order). */
export function getPassiveEffects(player: PartyCombatant, kind: PassiveEffectKind): PassiveEffect[] {
  const effects: PassiveEffect[] = [];
  for (const skill of player.equippedSkills) {
    if (!skill?.passiveEffects) continue;
    for (const effect of skill.passiveEffects) {
      if (effect.kind === kind) effects.push(effect);
    }
  }
  return effects;
}

/** The first equipped skill carrying a passive option of the given kind (for name-bearing log lines). */
export function getSkillWithPassive(player: PartyCombatant, kind: PassiveEffectKind): SkillDefinition | null {
  for (const skill of player.equippedSkills) {
    if (skill?.passiveEffects?.some(e => e.kind === kind)) return skill;
  }
  return null;
}

export function hasPassive(player: PartyCombatant, kind: PassiveEffectKind): boolean {
  return getSkillWithPassive(player, kind) !== null;
}

/** First-match: the first skill in slot order, first option in list, supplies the value. */
export function getPassiveValue(player: PartyCombatant, kind: PassiveEffectKind): number {
  for (const skill of player.equippedSkills) {
    if (!skill?.passiveEffects) continue;
    for (const effect of skill.passiveEffects) {
      if (effect.kind === kind) return effect.flatValue ?? 0;
    }
  }
  return 0;
}

/** Guard: self-only physical rating. */
export function getGuardRating(target: PartyCombatant): number {
  if (target.currentHp <= 0) return 0;
  return SKILL_RATING_SCALE * perLevelSum(target, 'physical_reduction');
}

/** Bless: party-wide magical/holy rating from the strongest living owner (owners don't stack). */
export function getBlessRating(allPlayers: PartyCombatant[]): number {
  let best = 0;
  for (const p of allPlayers) {
    if (p.currentHp <= 0) continue;
    best = Math.max(best, SKILL_RATING_SCALE * perLevelSum(p, 'magical_reduction_party'));
  }
  return best;
}

function perLevelSum(player: PartyCombatant, kind: PassiveEffectKind): number {
  let total = 0;
  for (const effect of getPassiveEffects(player, kind)) {
    total += (effect.valuePerLevel ?? 0) * player.level;
  }
  return total;
}

export function getCritChance(player: PartyCombatant): number {
  let chance = 0;
  for (const effect of getPassiveEffects(player, 'crit_chance')) {
    chance += effect.flatValue ?? 0;
  }
  return chance;
}

/** Base 2×, plus every crit_damage_bonus option. */
export function getCritMultiplier(player: PartyCombatant): number {
  let mult = 2;
  for (const effect of getPassiveEffects(player, 'crit_damage_bonus')) {
    mult += effect.flatValue ?? 0;
  }
  return mult;
}

function sumPerMemberPassive(players: PartyCombatant[], kind: PassiveEffectKind): number {
  const partySize = players.length;
  let total = 0;
  for (const p of players) {
    for (const effect of getPassiveEffects(p, kind)) {
      if (effect.perPartyMember) total += (effect.flatValue ?? 0) * partySize;
    }
  }
  return total;
}

export function computeRallyMultiplier(players: PartyCombatant[]): number {
  return sumPerMemberPassive(players, 'party_damage_mult');
}

export function computeNimbleDodge(players: PartyCombatant[]): number {
  return sumPerMemberPassive(players, 'dodge_party');
}

export function computeUnnerveReduction(players: PartyCombatant[]): number {
  return sumPerMemberPassive(players, 'enemy_damage_reduction_party');
}

export function computeBlessedArmsDamage(players: PartyCombatant[]): number {
  let totalDamage = 0;
  for (const p of players) {
    if (p.currentHp <= 0) continue;
    for (const effect of getPassiveEffects(p, 'holy_damage_party')) {
      totalDamage += (effect.valuePerLevel ?? 0) * p.level;
    }
  }
  return totalDamage;
}

export function getHealPowerMultiplier(player: PartyCombatant): number {
  let bonus = 0;
  for (const effect of getPassiveEffects(player, 'heal_power')) {
    bonus += (effect.valuePerLevel ?? 0) * player.level;
  }
  return 1 + bonus / 100;
}

export function getIntensifyMod(player: PartyCombatant): number {
  return getPassiveValue(player, 'intensify');
}

export function hasArcaneSurge(player: PartyCombatant): boolean {
  return hasPassive(player, 'arcane_surge');
}

// --- Skill timing ---

/** An equipped active the engine can use: active type with at least one active option. */
export function isUsableActive(skill: SkillDefinition | null | undefined): skill is SkillDefinition {
  return !!skill && skill.type === 'active' && (skill.activeEffects?.length ?? 0) > 0;
}

function secondsToMs(seconds: number | undefined, fallbackMs: number, maxMs: number): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return fallbackMs;
  return Math.min(maxMs, Math.max(0, Math.round(seconds * 1000)));
}

/** Wind-up of an action skill; skills with a trigger never cast. */
export function skillCastTimeMs(skill: SkillDefinition): number {
  if (getSkillTrigger(skill)) return 0;
  return ceilToStep(secondsToMs(skill.castTime, 0, MAX_CAST_TIME_MS));
}

/** Casts only resolve on step boundaries, so their length is rounded up to whole steps. */
function ceilToStep(ms: number): number {
  return Math.ceil(ms / COMBAT_STEP_MS) * COMBAT_STEP_MS;
}

/**
 * Cooldown after use: base seconds minus own CDR (party-wide options included), other living members'
 * party-wide CDR and set CDR, floored at MIN_COOLDOWN_MS. Interrupts (enemy_cast) ignore CDR.
 */
export function effectiveCooldownMs(owner: PartyCombatant, skill: SkillDefinition, allPlayers: PartyCombatant[]): number {
  const base = Number.isFinite(skill.cooldown) ? (skill.cooldown as number) * 1000 : 1000;
  if (getSkillTrigger(skill) === 'enemy_cast') return Math.max(MIN_COOLDOWN_MS, base);

  let cdrSeconds = 0;
  for (const effect of getPassiveEffects(owner, 'cooldown_reduction')) {
    cdrSeconds += effect.flatValue ?? 0;
  }
  for (const p of allPlayers) {
    if (p === owner || p.currentHp <= 0) continue;
    for (const effect of getPassiveEffects(p, 'cooldown_reduction')) {
      if (effect.partyWide) cdrSeconds += effect.flatValue ?? 0;
    }
  }
  cdrSeconds += owner.setBonuses?.cooldownReduction ?? 0;

  return Math.max(MIN_COOLDOWN_MS, Math.round(base - cdrSeconds * 1000));
}

/** Cooldown remaining at battle start. */
export function initialWarmupMs(owner: PartyCombatant, skill: SkillDefinition, allPlayers: PartyCombatant[]): number {
  if (skill.warmup !== undefined && Number.isFinite(skill.warmup)) {
    return secondsToMs(skill.warmup, 0, MAX_WARMUP_MS);
  }
  const trigger = getSkillTrigger(skill);
  if (trigger && trigger !== 'enemy_cast') return 0;
  return Math.max(0, effectiveCooldownMs(owner, skill, allPlayers) - 1000);
}

// --- Damage helpers ---

/** Damage factor of a monster's resistance to one damage type: flat is a rating vs `attackerLevel`, percent may be negative. */
export function monsterResistFactor(resistances: Resistance[], damageType: DamageType, attackerLevel: number): number {
  const res = resistances.find(r => r.damageType === damageType);
  if (!res) return 1;
  return (1 - ratingMitigation(res.flatReduction, attackerLevel)) * percentResistFactor(res.percentReduction, -1);
}

/** Resisted damage (floor 1 for damage ≥ 1) from an attacker of the given level. */
export function applyMonsterResistance(
  damage: number,
  damageType: DamageType,
  resistances: Resistance[],
  attackerLevel = 1,
): number {
  return scaleDamage(damage, monsterResistFactor(resistances, damageType, attackerLevel));
}

export function computeAttackBonus(equipBonuses: EquipmentBonuses | undefined, rng: () => number): number {
  if (!equipBonuses || equipBonuses.bonusAttackMax <= 0) return 0;
  const { bonusAttackMin, bonusAttackMax } = equipBonuses;
  return bonusAttackMin + Math.floor(rng() * (bonusAttackMax - bonusAttackMin + 1));
}

/** Gear rating is the average of the min/max roll. */
function gearRating(min: number | undefined, max: number | undefined): number {
  const total = (min ?? 0) + (max ?? 0);
  return Number.isFinite(total) ? total / 2 : 0;
}

/** Rating a player brings against a damage type: gear DR + Guard (physical), gear MR + Bless (magical), Bless (holy). */
export function incomingRating(target: PartyCombatant, damageType: DamageType, allPlayers: PartyCombatant[]): number {
  const gear = target.equipBonuses;
  if (damageType === 'physical') {
    return gearRating(gear?.damageReductionMin, gear?.damageReductionMax) + getGuardRating(target);
  }
  if (damageType === 'magical') {
    return gearRating(gear?.magicReductionMin, gear?.magicReductionMax) + getBlessRating(allPlayers);
  }
  return getBlessRating(allPlayers);
}

export function enrageMultiplier(monster: CombatMonster): number {
  const enrage = monster.enrageState;
  return enrage && enrage.stacks > 0 ? 1 + enrage.stacks * enrage.stepPercent : 1;
}

/** Enemy damage debuffs (Unnerve, Lullaby, Crippling Shot) as one factor; the combined reduction is capped. */
export function enemyDebuffFactor(monster: CombatMonster, state: PartyCombatState): number {
  let factor = 1 - clamp01(state.unnerveReduction);
  for (const debuff of monster.debuffs) {
    if (debuff.type === 'lullaby' || debuff.type === 'crippling_shot') factor *= 1 - clamp01(debuff.value);
  }
  return Math.max(1 - MAX_ENEMY_DAMAGE_REDUCTION, factor);
}

/** Monster auto-attack / chaos damage after enemy debuffs and enrage. Skills ignore the debuffs. */
export function getMonsterDamage(monster: CombatMonster, state: PartyCombatState): number {
  return scaleDamage(monster.damage, enemyDebuffFactor(monster, state) * enrageMultiplier(monster));
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Heal amount of a heal option after heal power (before Martyr/Tenacity). */
export function healOptionAmount(healer: PartyCombatant, effect: ActiveEffect, defaultMultiplier: number): number {
  return Math.floor(healer.level * (effect.healMultiplier ?? defaultMultiplier) * getHealPowerMultiplier(healer));
}
