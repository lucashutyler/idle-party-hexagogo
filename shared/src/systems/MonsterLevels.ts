import type { MonsterDefinition, MonsterLevelSource, MonsterTier } from './MonsterTypes.js';
import { MONSTER_SKILL_CATALOG, getMonsterSkillCastTimeMs } from './MonsterSkills.js';
import { MIN_MONSTER_ACTION_INTERVAL_MS } from './CombatTiming.js';
import { levelForTemplateDps, trashTemplateHp } from './MonsterTemplates.js';

export type LevelCon = 'trivial' | 'easy' | 'even' | 'hard' | 'deadly';

export interface EffectiveMonsterLevel {
  level: number;
  source: MonsterLevelSource;
}

export interface LevelConInfo {
  label: string;
  glyph: string;
}

const MIN_MONSTER_LEVEL = 1;
const MAX_MONSTER_LEVEL = 200;

/** An AoE hit counts as this many single-target hits when estimating a monster's damage output. */
export const AOE_DPS_WEIGHT = 3;

/** HP ÷ trash-template HP at the monster's level at which a tier is suggested. */
export const TIER_HP_RATIOS: Record<Exclude<MonsterTier, 'trash'>, number> = {
  elite: 6,
  boss: 180,
  raid: 3000,
};

export const LEVEL_CONS: readonly LevelCon[] = ['trivial', 'easy', 'even', 'hard', 'deadly'];

export const LEVEL_CON_INFO: Record<LevelCon, LevelConInfo> = {
  trivial: { label: 'Trivial', glyph: '·' },
  easy: { label: 'Easy', glyph: '▾' },
  even: { label: 'Even', glyph: '●' },
  hard: { label: 'Hard', glyph: '▴' },
  deadly: { label: 'Deadly', glyph: '☠' },
};

/** XP multiplier by con for monsters with an authored level; derived levels always get 1. */
export const XP_CON_FACTOR: Record<LevelCon, number> = {
  trivial: 0.25,
  easy: 0.75,
  even: 1,
  hard: 1,
  deadly: 1,
};

const SUGGESTED_TIERS: readonly Exclude<MonsterTier, 'trash'>[] = ['raid', 'boss', 'elite'];
const MONSTER_TIER_SET: ReadonlySet<string> = new Set<MonsterTier>(['trash', 'elite', 'boss', 'raid']);
const derivedCache = new WeakMap<MonsterDefinition, { signature: string; level: number }>();

export function clampMonsterLevel(level: number): number {
  return Math.min(MAX_MONSTER_LEVEL, Math.max(MIN_MONSTER_LEVEL, Math.round(level)));
}

/** Autos plus skill damage per (cooldown + cast + interval), DoTs at their full duration. Heals and stuns count 0. */
export function monsterDamagePerSecond(def: MonsterDefinition): number {
  if (def.passive) return 0;
  const intervalMs = Math.max(MIN_MONSTER_ACTION_INTERVAL_MS, (def.attackInterval ?? 1) * 1000);
  const intervalSec = Number.isFinite(intervalMs) ? intervalMs / 1000 : 1;
  let dps = Math.max(0, def.damage || 0) / intervalSec;
  for (const entry of def.skills ?? []) {
    const skill = MONSTER_SKILL_CATALOG[entry.skillId];
    if (!skill || (skill.effect !== 'damage' && skill.effect !== 'dot')) continue;
    const value = Math.max(0, entry.value || 0);
    const perUse = skill.effect === 'dot' ? value * Math.max(1, skill.dotDuration ?? 1) : value;
    const weight = skill.targeting === 'aoe_all' ? AOE_DPS_WEIGHT : 1;
    const period = Math.max(0, entry.cooldown || 0) + getMonsterSkillCastTimeMs(entry, skill) / 1000 + intervalSec;
    dps += perUse * weight / period;
  }
  return dps;
}

/** Level whose template (of the monster's tier) deals the same damage per second. Ignores HP; passive or harmless → 1. */
export function deriveMonsterLevel(def: MonsterDefinition): number {
  const signature = derivationSignature(def);
  const cached = derivedCache.get(def);
  if (cached && cached.signature === signature) return cached.level;
  const dps = monsterDamagePerSecond(def);
  const level = dps > 0 ? clampMonsterLevel(levelForTemplateDps(dps, effectiveMonsterTier(def))) : MIN_MONSTER_LEVEL;
  derivedCache.set(def, { signature, level });
  return level;
}

export function isAuthoredMonsterLevel(level: unknown): level is number {
  return typeof level === 'number' && Number.isFinite(level) && level >= MIN_MONSTER_LEVEL;
}

export function effectiveMonsterLevel(def: MonsterDefinition): EffectiveMonsterLevel {
  if (isAuthoredMonsterLevel(def.level)) return { level: clampMonsterLevel(def.level), source: 'authored' };
  return { level: deriveMonsterLevel(def), source: 'derived' };
}

export function effectiveMonsterTier(def: Pick<MonsterDefinition, 'tier'>): MonsterTier {
  return def.tier && MONSTER_TIER_SET.has(def.tier) ? def.tier : 'trash';
}

/**
 * Admin/MCP hint only — never applied to content. HP ÷ trash HP at the monster's level, where an unauthored
 * level is re-derived with each candidate tier's damage curve.
 */
export function suggestTierFromHp(def: MonsterDefinition): MonsterTier {
  if (def.passive || !(def.hp > 0)) return 'trash';
  const authored = isAuthoredMonsterLevel(def.level) ? clampMonsterLevel(def.level) : undefined;
  const dps = monsterDamagePerSecond(def);
  for (const tier of SUGGESTED_TIERS) {
    const level = authored ?? (dps > 0 ? clampMonsterLevel(levelForTemplateDps(dps, tier)) : MIN_MONSTER_LEVEL);
    if (def.hp / trashTemplateHp(level) >= TIER_HP_RATIOS[tier]) return tier;
  }
  return 'trash';
}

export function levelCon(target: number, viewer: number): LevelCon {
  const delta = target - viewer;
  if (viewer < 10) {
    if (delta >= 3) return 'deadly';
    if (delta >= 2) return 'hard';
  } else {
    if (delta >= 5) return 'deadly';
    if (delta >= 3) return 'hard';
  }
  if (delta >= -2) return 'even';
  if (delta >= -(5 + Math.floor(viewer / 10))) return 'easy';
  return 'trivial';
}

/** Derived levels are estimates, so they always read as even. */
export function monsterLevelCon(level: number, source: MonsterLevelSource, viewer: number): LevelCon {
  return source === 'derived' ? 'even' : levelCon(level, viewer);
}

export function xpConFactor(level: number, source: MonsterLevelSource, viewer: number): number {
  return source === 'derived' ? 1 : XP_CON_FACTOR[levelCon(level, viewer)];
}

export function formatMonsterLevel(level: number, source: MonsterLevelSource): string {
  return `${source === 'derived' ? '~' : ''}L${level}`;
}

function derivationSignature(def: MonsterDefinition): string {
  let signature = `${def.damage}|${def.attackInterval}|${def.passive ? 1 : 0}|${effectiveMonsterTier(def)}`;
  for (const s of def.skills ?? []) signature += `|${s.skillId}:${s.value}:${s.cooldown}:${s.castTime}`;
  return signature;
}
