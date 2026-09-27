import type { PartyGridPosition } from '../SocialTypes.js';
import type { CombatRef } from '../CombatEvents.js';
import type { CombatMonster, PartyCombatant, PartyCombatState } from '../CombatEngine.js';
import { LOW_HP_THRESHOLD } from '../CombatTiming.js';

export function getRow(pos: PartyGridPosition): number {
  return Math.floor(pos / 3);
}

export function getCol(pos: PartyGridPosition): number {
  return pos % 3;
}

export function playerRef(player: PartyCombatant): CombatRef {
  return { side: 'player', pos: player.gridPosition };
}

export function monsterRef(monster: CombatMonster): CombatRef {
  return { side: 'monster', pos: monster.gridPosition };
}

export function isAlive(unit: { currentHp: number }): boolean {
  return unit.currentHp > 0;
}

export function hpFraction(unit: { currentHp: number; maxHp: number }): number {
  return unit.maxHp > 0 ? unit.currentHp / unit.maxHp : 0;
}

/**
 * Find the best target based on grid position.
 *
 * Targeting rules:
 * 1. Same row first
 * 2. Within a row, prefer the "front" target (closest to attacker)
 *    - Players attacking monsters: prefer low column (col 0 is closest)
 *    - Monsters attacking players: prefer high column (col 2 is closest)
 * 3. If no targets in same row, scan UP first (lower row index), then DOWN
 */
export function findTarget<T extends { currentHp: number; gridPosition: PartyGridPosition }>(
  attackerPos: PartyGridPosition,
  targets: T[],
  preferHighCol: boolean,
): T | null {
  const alive = targets.filter(t => t.currentHp > 0);
  if (alive.length === 0) return null;

  const attackerRow = getRow(attackerPos);

  const sameRow = alive.filter(t => getRow(t.gridPosition) === attackerRow);
  if (sameRow.length > 0) {
    return pickByCol(sameRow, preferHighCol);
  }

  for (let row = attackerRow - 1; row >= 0; row--) {
    const rowTargets = alive.filter(t => getRow(t.gridPosition) === row);
    if (rowTargets.length > 0) {
      return pickByCol(rowTargets, preferHighCol);
    }
  }

  for (let row = attackerRow + 1; row <= 2; row++) {
    const rowTargets = alive.filter(t => getRow(t.gridPosition) === row);
    if (rowTargets.length > 0) {
      return pickByCol(rowTargets, preferHighCol);
    }
  }

  return null;
}

function pickByCol<T extends { gridPosition: PartyGridPosition }>(
  targets: T[],
  preferHighCol: boolean,
): T {
  return targets.reduce((best, t) => {
    const bestCol = getCol(best.gridPosition);
    const tCol = getCol(t.gridPosition);
    if (preferHighCol ? tCol > bestCol : tCol < bestCol) return t;
    return best;
  });
}

/** Lowest absolute current HP among the living (first wins ties). */
export function findLowestHp<T extends { currentHp: number }>(targets: T[]): T | null {
  const alive = targets.filter(isAlive);
  if (alive.length === 0) return null;
  return alive.reduce((lowest, t) => t.currentHp < lowest.currentHp ? t : lowest);
}

/** Lowest HP fraction among the given units (first wins ties); callers pre-filter for life. */
export function findLowestFraction<T extends { currentHp: number; maxHp: number }>(units: T[]): T | null {
  if (units.length === 0) return null;
  return units.reduce((lowest, u) => hpFraction(u) < hpFraction(lowest) ? u : lowest);
}

function preferredOrAll<T extends { currentHp: number }>(all: T[], preferred?: T): T[] {
  if (preferred && isAlive(preferred)) return [preferred];
  return all.filter(isAlive);
}

// --- Enemy targets (player → monster) ---

export function aliveOrUndefined<T extends { currentHp: number }>(unit: T | undefined): T | undefined {
  return unit && isAlive(unit) ? unit : undefined;
}

export function firstCastingMonster(monsters: CombatMonster[]): CombatMonster | null {
  return monsters.find(m => isAlive(m) && m.cast !== null) ?? null;
}

export function gridEnemyTarget(player: PartyCombatant, monsters: CombatMonster[], preferred?: CombatMonster): CombatMonster | null {
  return aliveOrUndefined(preferred) ?? findTarget(player.gridPosition, monsters, false);
}

export function stunSingleTarget(player: PartyCombatant, monsters: CombatMonster[], preferred?: CombatMonster): CombatMonster | null {
  return aliveOrUndefined(preferred) ?? firstCastingMonster(monsters) ?? findTarget(player.gridPosition, monsters, false);
}

export function lowestHpEnemyTarget(monsters: CombatMonster[], preferred?: CombatMonster): CombatMonster | null {
  return aliveOrUndefined(preferred) ?? findLowestHp(monsters);
}

export function findLiveMonsterAt(state: PartyCombatState, pos: PartyGridPosition): CombatMonster | undefined {
  return state.monsters.find(m => m.gridPosition === pos && isAlive(m));
}

export function findLivePlayerAt(state: PartyCombatState, pos: PartyGridPosition): PartyCombatant | undefined {
  return state.players.find(p => p.gridPosition === pos && isAlive(p));
}

// --- Ally targets (shared by the "needed" check and the executor) ---

export function needsHeal(player: PartyCombatant, healAmount: number): boolean {
  const missing = player.maxHp - player.currentHp;
  if (missing <= 0) return false;
  return hpFraction(player) < LOW_HP_THRESHOLD || missing >= healAmount * 0.5;
}

export function healTarget(allies: PartyCombatant[], healAmount: number, preferred?: PartyCombatant): PartyCombatant | null {
  return findLowestFraction(preferredOrAll(allies, preferred).filter(p => needsHeal(p, healAmount)));
}

export function isAfflicted(player: PartyCombatant): boolean {
  return player.stunRemainingMs > 0 || player.dots.length > 0 || player.debuffs.length > 0;
}

/** Stunned allies first, then lowest HP fraction. */
export function cureTarget(allies: PartyCombatant[], preferred?: PartyCombatant): PartyCombatant | null {
  const afflicted = preferredOrAll(allies, preferred).filter(isAfflicted);
  const stunned = afflicted.filter(p => p.stunRemainingMs > 0);
  return findLowestFraction(stunned.length > 0 ? stunned : afflicted);
}

export function shieldTarget(allies: PartyCombatant[], preferred?: PartyCombatant): PartyCombatant | null {
  const pool = preferredOrAll(allies, preferred);
  return findLowestFraction(pool.filter(p => p.className !== 'Knight' && p.damageShield <= 0));
}

export function lowHpAlly(allies: PartyCombatant[]): PartyCombatant | null {
  return findLowestFraction(allies.filter(p => isAlive(p) && hpFraction(p) < LOW_HP_THRESHOLD));
}

// --- Monster-side targets (monster → player / monster) ---

export function assassinateTarget(players: PartyCombatant[], preferred?: PartyCombatant): PartyCombatant | null {
  return aliveOrUndefined(preferred) ?? findLowestHp(players);
}

export function monsterGridTarget(monster: CombatMonster, players: PartyCombatant[], preferred?: PartyCombatant): PartyCombatant | null {
  return aliveOrUndefined(preferred) ?? findTarget(monster.gridPosition, players, true);
}

/** Wounded, living, non-passive monsters other than the caster; lowest absolute HP first. */
export function monsterHealTarget(caster: CombatMonster, monsters: CombatMonster[]): CombatMonster | null {
  return findLowestHp(monsters.filter(m => m !== caster && !m.passive && isAlive(m) && m.currentHp < m.maxHp));
}
