import type { DamageType } from '../CharacterStats.js';
import type { EquipmentBonuses } from '../ItemTypes.js';
import type { Resistance } from '../MonsterTypes.js';
import type { ActiveEffect, PassiveEffect, PassiveEffectKind, SkillDefinition } from '../SkillTypes.js';
import { getSkillTrigger } from '../SkillTypes.js';
import type { CombatMonster, PartyCombatant, PartyCombatState } from '../CombatEngine.js';
import { MIN_COOLDOWN_MS } from '../CombatTiming.js';

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

export function getPhysicalReduction(target: PartyCombatant): number {
  if (target.currentHp <= 0) return 0;
  let reduction = 0;
  for (const effect of getPassiveEffects(target, 'physical_reduction')) {
    reduction += (effect.valuePerLevel ?? 0) * target.level;
  }
  return reduction;
}

/** Party-wide magical/holy reduction from every living owner. */
export function getMagicalReduction(allPlayers: PartyCombatant[]): number {
  let reduction = 0;
  for (const p of allPlayers) {
    if (p.currentHp <= 0) continue;
    for (const effect of getPassiveEffects(p, 'magical_reduction_party')) {
      reduction += (effect.valuePerLevel ?? 0) * p.level;
    }
  }
  return reduction;
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
  return secondsToMs(skill.castTime, 0, MAX_CAST_TIME_MS);
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

/** Apply monster resistance to incoming damage. Percent first, then flat, min 0. */
export function applyMonsterResistance(
  damage: number,
  damageType: DamageType,
  resistances: Resistance[],
): number {
  const res = resistances.find(r => r.damageType === damageType);
  if (!res) return damage;
  damage = damage * (1 - res.percentReduction / 100);
  damage = damage - res.flatReduction;
  return Math.max(0, Math.floor(damage));
}

export function computeAttackBonus(equipBonuses?: EquipmentBonuses): number {
  if (!equipBonuses || equipBonuses.bonusAttackMax <= 0) return 0;
  const { bonusAttackMin, bonusAttackMax } = equipBonuses;
  return bonusAttackMin + Math.floor(Math.random() * (bonusAttackMax - bonusAttackMin + 1));
}

export function computeEquipReduction(equipBonuses?: EquipmentBonuses): number {
  if (!equipBonuses || equipBonuses.damageReductionMax <= 0) return 0;
  const { damageReductionMin, damageReductionMax } = equipBonuses;
  return damageReductionMin + Math.floor(Math.random() * (damageReductionMax - damageReductionMin + 1));
}

export function computeEquipMagicReduction(equipBonuses?: EquipmentBonuses): number {
  if (!equipBonuses || equipBonuses.magicReductionMax <= 0) return 0;
  const { magicReductionMin, magicReductionMax } = equipBonuses;
  return magicReductionMin + Math.floor(Math.random() * (magicReductionMax - magicReductionMin + 1));
}

/** Flat reduction a player applies to incoming damage of a type (equip DR + Guard, equip MR + Bless, Bless only for holy). */
export function incomingFlatReduction(target: PartyCombatant, damageType: DamageType, allPlayers: PartyCombatant[]): number {
  if (damageType === 'physical') {
    return computeEquipReduction(target.equipBonuses) + getPhysicalReduction(target);
  }
  if (damageType === 'magical') {
    return computeEquipMagicReduction(target.equipBonuses) + getMagicalReduction(allPlayers);
  }
  return getMagicalReduction(allPlayers);
}

/** Monster auto-attack / chaos damage after Unnerve, Lullaby and Crippling Shot. Skills stay flat. */
export function getMonsterDamage(monster: CombatMonster, state: PartyCombatState): number {
  let damage = monster.damage;
  if (state.unnerveReduction > 0) {
    damage = Math.floor(damage * (1 - state.unnerveReduction));
  }
  for (const debuff of monster.debuffs) {
    if (debuff.type === 'lullaby') damage = Math.floor(damage * (1 - debuff.value));
  }
  for (const debuff of monster.debuffs) {
    if (debuff.type === 'crippling_shot') damage = Math.floor(damage * (1 - debuff.value));
  }
  return Math.max(0, damage);
}

/** Heal amount of a heal option after heal power (before Martyr/Tenacity). */
export function healOptionAmount(healer: PartyCombatant, effect: ActiveEffect, defaultMultiplier: number): number {
  return Math.floor(healer.level * (effect.healMultiplier ?? defaultMultiplier) * getHealPowerMultiplier(healer));
}
