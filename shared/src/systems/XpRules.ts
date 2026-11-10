import { isValidFloorFactor } from './DungeonTypes.js';
import type { MonsterInstance } from './MonsterTypes.js';
import type { SkillDefinition } from './SkillTypes.js';

/** What each member keeps of a fight's XP, indexed by bodies in the fight. A fighting hire is a full body. */
export const PARTY_XP_SHARE: readonly number[] = [1, 1, 0.91, 0.82, 0.76, 0.72];
/** In a starter zone a player with no party and no hire keeps this; everyone else keeps it all. */
export const STARTER_ZONE_LONE_XP_SHARE = 0.8;

export const XP_LEVEL_GAP = {
  /** A monster this many levels below the member still pays in full. */
  evenBand: 2,
  /** Past the even band: e^(-decay × levels). */
  decay: 0.4,
  floor: 0.2,
  /** Added per level a monster is over the highest human in the fight. */
  challengePerLevel: 0.12,
  challengeLevels: 5,
  /** Factor per level past challengeLevels; a harmless monster gets it from its first level over. */
  pastChallengeFactor: 0.93,
} as const;

// A share times a whole pot can land a hair over a whole number, and rounding up would then pay 1 XP too many.
const ROUNDING_GUARD = 1e-9;

export type XpMonster = Pick<MonsterInstance, 'xp' | 'level' | 'levelSource' | 'maxHp' | 'damage' | 'passive' | 'skills'>;

export interface FightXpInput {
  monsters: readonly XpMonster[];
  memberLevel: number;
  /** The highest human in the fight, the member included. */
  topHumanLevel: number;
  /** Humans plus fighting hires. */
  bodies: number;
  /** True for a room of a starter zone; never for a dungeon floor, wherever its entrance stands. */
  starterZone?: boolean;
  /** The floor's `xpFactor`, on a dungeon floor. */
  floorXpFactor?: number;
  /** 1 + the party's `xp_bonus`. */
  xpBonus?: number;
  rewardMultiplier: number;
}

/** Walls, 1 HP fodder and monsters that can't hurt anyone are no challenge at any level. */
export function isHarmlessMonster(monster: Pick<XpMonster, 'maxHp' | 'damage' | 'passive' | 'skills'>): boolean {
  return !!monster.passive || monster.maxHp <= 1 || (monster.damage <= 1 && !monster.skills?.length);
}

/**
 * XP factor of an authored-level monster: decays on the member's own level going back, and rises on the
 * highest human's going up, so a carried friend is paid as the carrier is.
 */
export function levelGapXpFactor(monsterLevel: number, memberLevel: number, topHumanLevel: number, harmless = false): number {
  const { evenBand, decay, floor, challengePerLevel, challengeLevels, pastChallengeFactor } = XP_LEVEL_GAP;
  const below = memberLevel - monsterLevel - evenBand;
  let factor = below > 0 ? Math.max(floor, Math.exp(-decay * below)) : 1;
  const over = monsterLevel - topHumanLevel;
  if (over > 0) {
    const bonusLevels = harmless ? 0 : challengeLevels;
    factor *= 1 + challengePerLevel * Math.min(over, bonusLevels);
    if (over > bonusLevels) factor *= pastChallengeFactor ** (over - bonusLevels);
  }
  return factor;
}

/** A floor's XP or coin factor as the rules read it: absent or invalid pays in full. */
export function floorPayFactor(factor: unknown): number {
  return isValidFloorFactor(factor) ? factor : 1;
}

/** A monster's XP on a floor with this factor, before the level gap. */
export function floorMonsterXp(xp: number, factor: number): number {
  if (!(xp > 0)) return 0;
  return factor >= 1 ? xp : Math.max(1, Math.round(xp * factor));
}

export function partyXpShare(bodies: number, starterZone = false): number {
  if (starterZone) return bodies <= 1 ? STARTER_ZONE_LONE_XP_SHARE : 1;
  return PARTY_XP_SHARE[Math.min(PARTY_XP_SHARE.length - 1, bodies)];
}

/** 1 + every equipped `xp_bonus` passive across the bodies in a fight, hires included. */
export function partyXpBonus(players: readonly { equippedSkills: readonly (SkillDefinition | null)[] }[]): number {
  let bonus = 1;
  for (const player of players) {
    for (const skill of player.equippedSkills) {
      for (const effect of skill?.passiveEffects ?? []) {
        if (effect.kind === 'xp_bonus') bonus += effect.flatValue ?? 0;
      }
    }
  }
  return bonus;
}

/** A pack's monster XP before the level gap, share and multipliers. */
export function packRawXp(monsters: readonly Pick<XpMonster, 'xp'>[]): number {
  let xp = 0;
  for (const monster of monsters) {
    if (Number.isFinite(monster.xp) && monster.xp > 0) xp += monster.xp;
  }
  return xp;
}

/** XP one member earns from a won fight. See docs/architecture/combat.md → XP pay. */
export function fightXp(input: FightXpInput): number {
  const floorFactor = floorPayFactor(input.floorXpFactor);
  let pot = 0;
  for (const monster of input.monsters) {
    if (!Number.isFinite(monster.xp)) continue;
    const xp = floorMonsterXp(monster.xp, floorFactor);
    const authored = monster.levelSource === 'authored' && typeof monster.level === 'number' && Number.isFinite(monster.level);
    pot += authored
      ? xp * levelGapXpFactor(monster.level as number, input.memberLevel, input.topHumanLevel, isHarmlessMonster(monster))
      : xp;
  }
  const earned = pot * (input.xpBonus ?? 1) * input.rewardMultiplier * partyXpShare(input.bodies, input.starterZone);
  return Math.max(0, Math.ceil(earned - ROUNDING_GUARD));
}
