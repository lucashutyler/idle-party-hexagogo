import type { MonsterTier } from './MonsterTypes.js';

export type MonsterRole = 'bruiser' | 'caster' | 'skirmisher';

export interface SuggestedMonsterStats {
  hp: number;
  damage: number;
  attackInterval: number;
  xp: number;
  goldMin: number;
  goldMax: number;
}

export interface MonsterRoleModifier {
  hp: number;
  dps: number;
  attackInterval: number;
}

export const XP_INCOME_SOLO_L1_PER_DAY = 57_600;
export const XP_INCOME_PARTY_L10_PER_DAY = 557_000;
export const XP_INCOME_DOUBLING_LEVELS = 10;

/** Daily XP income a character is expected to earn at `level` (solo at L1, in a party from L10). */
export const XP_INCOME_MODEL = (level: number): number => {
  const l = Math.max(1, level);
  if (l < 10) {
    const t = (l - 1) / 9;
    return XP_INCOME_SOLO_L1_PER_DAY + t * (XP_INCOME_PARTY_L10_PER_DAY - XP_INCOME_SOLO_L1_PER_DAY);
  }
  return XP_INCOME_PARTY_L10_PER_DAY * Math.pow(2, (l - 10) / XP_INCOME_DOUBLING_LEVELS);
};

// Frozen class averages (Knight/Archer/Priest/Mage/Bard); a class rebalance must not re-level monsters.
export const CLASS_AVERAGE_HP_BASE = 19.2;
export const CLASS_AVERAGE_HP_PER_LEVEL = 2;
export const CLASS_AVERAGE_DAMAGE_BASE = 7;
export const CLASS_AVERAGE_DAMAGE_PER_LEVEL = 1.4;

/** Trash HP tracks class damage and trash DPS tracks class HP, so fight length stays level-independent. */
export const TRASH_HP_PER_CLASS_DAMAGE = 5.8;
export const TRASH_DPS_PER_CLASS_HP = 0.04;

export const ELITE_HP_MULTIPLIER = 8;
export const ELITE_DPS_MULTIPLIER = 3;

export const ROLE_MODIFIERS: Record<MonsterRole, MonsterRoleModifier> = {
  bruiser: { hp: 1.2, dps: 0.8, attackInterval: 2.2 },
  caster: { hp: 0.9, dps: 1.1, attackInterval: 1.8 },
  skirmisher: { hp: 0.9, dps: 1.05, attackInterval: 1 },
};

export const TIER_DEFAULT_ATTACK_INTERVAL: Record<MonsterTier, number> = {
  trash: 1.5,
  elite: 2,
  boss: 2,
  raid: 2,
};

/** The party boss and raid HP are sized against: one of each class, default loadouts, starter gear. */
export const REFERENCE_PARTY = {
  name: 'Reference party',
  classes: ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'],
  loadout: 'default',
  gear: 'starter',
} as const;
export const REFERENCE_PARTY_SIZE = REFERENCE_PARTY.classes.length;

/** [level, damage per second] of REFERENCE_PARTY against a same-level target, measured 30–330 s into the fight. */
export const REFERENCE_PARTY_STEADY_DPS: readonly (readonly [number, number])[] = [
  [1, 148],
  [5, 220],
  [10, 310],
  [20, 492],
  [25, 583],
  [30, 1113],
  [40, 1428],
  [50, 1903],
  [60, 2244],
  [80, 2927],
  [100, 3609],
];

/** A clean REFERENCE_PARTY kill takes this long; a Knight+Priest+Mage trio takes ~2.4–3.7× longer. */
export const BOSS_TARGET_SECONDS = 80;
export const RAID_TARGET_SECONDS = 2700;

/** Boss/raid DPS as a multiple of trash DPS: base + perLevel × level. */
export const BOSS_DPS_BASE = 29;
export const BOSS_DPS_PER_LEVEL = 1.1;
export const RAID_DPS_BASE = 25;
export const RAID_DPS_PER_LEVEL = 1.1;

export const REFERENCE_PACK_SIZE = 2;
export const REFERENCE_FIGHT_SECONDS = 10;
export const FIGHT_OVERHEAD_SECONDS = 1.8;

export const TIER_XP_BONUS: Record<MonsterTier, number> = {
  trash: 1,
  elite: 1.25,
  boss: 1.5,
  raid: 1.5,
};

export const GOLD_PER_XP = 0.4;
const GOLD_SPREAD = 0.3;
const TEMPLATE_MIN_LEVEL = 1;
const TEMPLATE_MAX_LEVEL = 200;
const SECONDS_PER_DAY = 86_400;

export function classAverageHp(level: number): number {
  return CLASS_AVERAGE_HP_BASE + CLASS_AVERAGE_HP_PER_LEVEL * (level - 1);
}

export function classAverageDamage(level: number): number {
  return CLASS_AVERAGE_DAMAGE_BASE + CLASS_AVERAGE_DAMAGE_PER_LEVEL * (level - 1);
}

export function trashTemplateHp(level: number): number {
  return TRASH_HP_PER_CLASS_DAMAGE * classAverageDamage(level);
}

export function trashTemplateDps(level: number): number {
  return TRASH_DPS_PER_CLASS_HP * classAverageHp(level);
}

export function referencePartyDps(level: number): number {
  const table = REFERENCE_PARTY_STEADY_DPS;
  let i = 1;
  while (i < table.length - 1 && level > table[i][0]) i++;
  const [l0, d0] = table[i - 1];
  const [l1, d1] = table[i];
  return Math.max(1, d0 + (d1 - d0) * (level - l0) / (l1 - l0));
}

export function bossDpsMultiplier(level: number): number {
  return BOSS_DPS_BASE + BOSS_DPS_PER_LEVEL * level;
}

export function raidDpsMultiplier(level: number): number {
  return RAID_DPS_BASE + RAID_DPS_PER_LEVEL * level;
}

export function templateHp(level: number, tier: MonsterTier): number {
  switch (tier) {
    case 'trash': return trashTemplateHp(level);
    case 'elite': return trashTemplateHp(level) * ELITE_HP_MULTIPLIER;
    case 'boss': return referencePartyDps(level) * BOSS_TARGET_SECONDS;
    case 'raid': return referencePartyDps(level) * RAID_TARGET_SECONDS;
  }
}

export function templateDps(level: number, tier: MonsterTier): number {
  switch (tier) {
    case 'trash': return trashTemplateDps(level);
    case 'elite': return trashTemplateDps(level) * ELITE_DPS_MULTIPLIER;
    case 'boss': return trashTemplateDps(level) * bossDpsMultiplier(level);
    case 'raid': return trashTemplateDps(level) * raidDpsMultiplier(level);
  }
}

/** Continuous inverse of templateDps over [1, 200]. */
export function levelForTemplateDps(dps: number, tier: MonsterTier = 'trash'): number {
  if (!(dps > templateDps(TEMPLATE_MIN_LEVEL, tier))) return TEMPLATE_MIN_LEVEL;
  if (dps >= templateDps(TEMPLATE_MAX_LEVEL, tier)) return TEMPLATE_MAX_LEVEL;
  let lo = TEMPLATE_MIN_LEVEL;
  let hi = TEMPLATE_MAX_LEVEL;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (templateDps(mid, tier) < dps) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Member-seconds of fighting one kill of this tier stands for in the income model. */
export function tierMemberSeconds(tier: MonsterTier): number {
  const trash = (REFERENCE_FIGHT_SECONDS + FIGHT_OVERHEAD_SECONDS) / REFERENCE_PACK_SIZE;
  switch (tier) {
    case 'trash': return trash;
    case 'elite': return trash * ELITE_HP_MULTIPLIER;
    case 'boss': return BOSS_TARGET_SECONDS * REFERENCE_PARTY_SIZE;
    case 'raid': return RAID_TARGET_SECONDS * REFERENCE_PARTY_SIZE;
  }
}

/** Starting-point stats for an on-level monster. See docs/architecture/combat.md (templates). */
export function suggestMonsterStats(level: number, tier: MonsterTier = 'trash', role?: MonsterRole): SuggestedMonsterStats {
  const l = Math.min(TEMPLATE_MAX_LEVEL, Math.max(TEMPLATE_MIN_LEVEL, Math.round(Number.isFinite(level) ? level : 1)));
  const mod = role ? ROLE_MODIFIERS[role] : undefined;
  const attackInterval = mod?.attackInterval ?? TIER_DEFAULT_ATTACK_INTERVAL[tier];

  let hp = templateHp(l, tier);
  let dps = templateDps(l, tier);
  if (mod) {
    hp *= mod.hp;
    dps *= mod.dps;
  }

  const xp = Math.max(1, Math.round(XP_INCOME_MODEL(l) / SECONDS_PER_DAY * tierMemberSeconds(tier) * TIER_XP_BONUS[tier]));
  const avgGold = xp * GOLD_PER_XP;
  const goldMin = Math.max(1, Math.round(avgGold * (1 - GOLD_SPREAD)));
  const goldMax = Math.max(goldMin, Math.round(avgGold * (1 + GOLD_SPREAD)));

  return {
    hp: Math.max(1, Math.round(hp)),
    damage: Math.max(1, Math.round(dps * attackInterval)),
    attackInterval,
    xp,
    goldMin,
    goldMax,
  };
}
