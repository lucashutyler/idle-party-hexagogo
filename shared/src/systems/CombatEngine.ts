import type { ClassName, DamageType } from './CharacterStats.js';
import type { MonsterInstance } from './MonsterTypes.js';
import type { EquipmentBonuses } from './ItemTypes.js';
import type { PartyGridPosition } from './SocialTypes.js';
import type { SkillDefinition } from './SkillTypes.js';

// --- Types ---

export interface TickResult {
  /** Log lines generated this tick (damage dealt, kills, etc.). */
  logEntries: string[];
  /** Whether combat ended this tick. */
  finished: boolean;
  /** Final result if combat ended, null otherwise. */
  result: 'victory' | 'defeat' | null;
}

// --- Party Combat Types ---

export interface PartyCombatant {
  username: string;
  maxHp: number;
  currentHp: number;
  baseDamage: number;
  playerDamageType: DamageType;
  equipBonuses?: EquipmentBonuses;
  gridPosition: PartyGridPosition;
  className: ClassName;
  level: number;
  /** Resolved equipped skill definitions (indexed by slot). */
  equippedSkills: (SkillDefinition | null)[];
  /** Number of attacks this combatant has made (for cooldown tracking). */
  attackCount: number;
  /** Remaining stun turns (0 = not stunned). */
  stunTurns: number;
}

export interface CombatAction {
  /** 'player' or 'monster' */
  attackerSide: 'player' | 'monster';
  /** Grid position of the attacker */
  attackerPos: PartyGridPosition;
  /** Grid position of the target (if any) */
  targetPos: PartyGridPosition | null;
  /** 'player' or 'monster' */
  targetSide: 'player' | 'monster' | null;
  /** Whether the target dodged */
  dodged: boolean;
  /** Name of the skill used (if any) */
  skillName?: string;
  /** Whether a stun was applied */
  stunApplied?: boolean;
  /** Amount healed (if any) */
  healAmount?: number;
  /** Username of the heal target */
  healTarget?: string;
}

export interface PartyCombatState {
  players: PartyCombatant[];
  monsters: MonsterInstance[];
  tickCount: number;
  finished: boolean;
  result: 'victory' | 'defeat' | null;
  /** Index into the turn order for the next combatant to act. */
  turnIndex: number;
  /** Total number of combatants in turn order (players + monsters). */
  turnOrderSize: number;
  /** The action that occurred on the most recent tick (null before first tick). */
  lastAction: CombatAction | null;
  /** Bard Rally damage multiplier (precomputed at combat start). */
  rallyMultiplier: number;
}

// --- Grid Targeting ---

function getRow(pos: PartyGridPosition): number {
  return Math.floor(pos / 3);
}

function getCol(pos: PartyGridPosition): number {
  return pos % 3;
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

  // Try same row first
  const sameRow = alive.filter(t => getRow(t.gridPosition) === attackerRow);
  if (sameRow.length > 0) {
    return pickByCol(sameRow, preferHighCol);
  }

  // Scan up (lower row indices)
  for (let row = attackerRow - 1; row >= 0; row--) {
    const rowTargets = alive.filter(t => getRow(t.gridPosition) === row);
    if (rowTargets.length > 0) {
      return pickByCol(rowTargets, preferHighCol);
    }
  }

  // Scan down (higher row indices)
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

/** Find the target with the lowest current HP (for Cut Down). */
function findLowestHpTarget<T extends { currentHp: number }>(targets: T[]): T | null {
  const alive = targets.filter(t => t.currentHp > 0);
  if (alive.length === 0) return null;
  return alive.reduce((lowest, t) => t.currentHp < lowest.currentHp ? t : lowest);
}

/** Find the ally with the lowest HP percentage (for Minor Heal). */
function findLowestPercentHpAlly(players: PartyCombatant[]): PartyCombatant | null {
  const alive = players.filter(p => p.currentHp > 0);
  if (alive.length === 0) return null;
  return alive.reduce((lowest, p) => {
    const lowestPct = lowest.currentHp / lowest.maxHp;
    const pPct = p.currentHp / p.maxHp;
    return pPct < lowestPct ? p : lowest;
  });
}

// --- Passive Helpers ---

/** Get total physical damage reduction for a target from Knight Guard passives. */
function getPhysicalReduction(target: PartyCombatant, _allPlayers: PartyCombatant[]): number {
  // Knight Guard is self-only physical reduction
  if (target.currentHp <= 0) return 0;
  let reduction = 0;
  // Only the target's own Guard applies (self-only)
  for (const skill of target.equippedSkills) {
    if (skill && skill.passiveEffect?.kind === 'physical_reduction') {
      reduction += (skill.passiveEffect.valuePerLevel ?? 0) * target.level;
    }
  }
  return reduction;
}

/** Get total magical/holy damage reduction from all alive Priests with Bless (party-wide). */
function getMagicalReduction(allPlayers: PartyCombatant[]): number {
  let reduction = 0;
  for (const p of allPlayers) {
    if (p.currentHp <= 0) continue;
    for (const skill of p.equippedSkills) {
      if (skill && skill.passiveEffect?.kind === 'magical_reduction_party') {
        reduction += (skill.passiveEffect.valuePerLevel ?? 0) * p.level;
      }
    }
  }
  return reduction;
}

/** Get crit chance from equipped passives. */
function getCritChance(player: PartyCombatant): number {
  let chance = 0;
  for (const skill of player.equippedSkills) {
    if (skill && skill.passiveEffect?.kind === 'crit_chance') {
      chance += skill.passiveEffect.flatValue ?? 0;
    }
  }
  return chance;
}

/** Compute rally multiplier from all Bards with Rally equipped. */
function computeRallyMultiplier(players: PartyCombatant[]): number {
  const partySize = players.length;
  let totalMult = 0;
  for (const p of players) {
    for (const skill of p.equippedSkills) {
      if (skill && skill.passiveEffect?.kind === 'party_damage_mult' && skill.passiveEffect.perPartyMember) {
        totalMult += (skill.passiveEffect.flatValue ?? 0) * partySize;
      }
    }
  }
  return totalMult;
}

// --- Combat Helpers ---

function computeAttackBonus(equipBonuses?: EquipmentBonuses): number {
  if (!equipBonuses || equipBonuses.bonusAttackMax <= 0) return 0;
  const { bonusAttackMin, bonusAttackMax } = equipBonuses;
  return bonusAttackMin + Math.floor(Math.random() * (bonusAttackMax - bonusAttackMin + 1));
}

function computeEquipReduction(equipBonuses?: EquipmentBonuses): number {
  if (!equipBonuses || equipBonuses.damageReductionMax <= 0) return 0;
  const { damageReductionMin, damageReductionMax } = equipBonuses;
  return damageReductionMin + Math.floor(Math.random() * (damageReductionMax - damageReductionMin + 1));
}

// --- Party Combat ---

/**
 * Create initial party combat state.
 * Players and monsters are sorted into turn order: front-to-back, top-to-bottom.
 */
export function createPartyCombatState(
  players: PartyCombatant[],
  monsters: MonsterInstance[],
): PartyCombatState {
  // Sort players: front-to-back (high col first), then top-to-bottom (low row first)
  const sortedPlayers = players.map(p => ({
    ...p,
    equippedSkills: [...p.equippedSkills],
    currentHp: p.maxHp,
    attackCount: 0,
    stunTurns: 0,
  })).sort((a, b) => {
    const colDiff = getCol(b.gridPosition) - getCol(a.gridPosition);
    if (colDiff !== 0) return colDiff;
    return getRow(a.gridPosition) - getRow(b.gridPosition);
  });

  // Apply Mage Burn bonus damage at combat start
  for (const p of sortedPlayers) {
    for (const skill of p.equippedSkills) {
      if (skill && skill.passiveEffect?.kind === 'bonus_damage') {
        p.baseDamage += (skill.passiveEffect.valuePerLevel ?? 0) * p.level;
      }
    }
  }

  // Compute Bard Rally multiplier
  const rallyMultiplier = computeRallyMultiplier(sortedPlayers);

  // Sort monsters: front-to-back (low col first), then top-to-bottom (low row first)
  const sortedMonsters = monsters.map(m => ({ ...m, stunTurns: m.stunTurns ?? 0 }))
    .sort((a, b) => {
      const colDiff = getCol(a.gridPosition) - getCol(b.gridPosition);
      if (colDiff !== 0) return colDiff;
      return getRow(a.gridPosition) - getRow(b.gridPosition);
    });

  return {
    players: sortedPlayers,
    monsters: sortedMonsters,
    tickCount: 0,
    finished: false,
    result: null,
    turnIndex: 0,
    turnOrderSize: sortedPlayers.length + sortedMonsters.length,
    lastAction: null,
    rallyMultiplier,
  };
}

/**
 * Execute a player's active skill.
 * Returns log entries generated by the skill.
 */
function executeActiveSkill(
  player: PartyCombatant,
  skill: SkillDefinition,
  state: PartyCombatState,
): { logEntries: string[]; action: CombatAction } {
  const logEntries: string[] = [];
  const effect = skill.activeEffect!;

  switch (effect.kind) {
    case 'stun_single': {
      // Knight Bash: normal damage + chance to stun target
      const target = findTarget(player.gridPosition, state.monsters, false);
      if (!target) {
        return {
          logEntries,
          action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: null, targetSide: null, dodged: false, skillName: skill.name },
        };
      }

      const damage = computePlayerDamage(player, state.rallyMultiplier);
      target.currentHp = Math.max(0, target.currentHp - damage);
      logEntries.push(`${player.username} uses ${skill.name} on ${target.name} for ${damage} ${player.playerDamageType} damage`);

      let stunApplied = false;
      if (target.currentHp > 0 && Math.random() < (effect.stunChance ?? 0)) {
        target.stunTurns = 1;
        stunApplied = true;
        logEntries.push(`${target.name} is stunned!`);
      }

      if (target.currentHp <= 0) {
        logEntries.push(`${target.name} defeated!`);
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name, stunApplied },
      };
    }

    case 'stun_aoe': {
      // Bard Drumroll: chance to stun each alive enemy, no damage
      let anyStunned = false;
      for (const monster of state.monsters) {
        if (monster.currentHp <= 0) continue;
        if (Math.random() < (effect.stunChance ?? 0)) {
          monster.stunTurns = 1;
          anyStunned = true;
          logEntries.push(`${player.username}'s ${skill.name} stuns ${monster.name}!`);
        }
      }
      if (!anyStunned) {
        logEntries.push(`${player.username} uses ${skill.name} but no enemies are stunned`);
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: null, targetSide: null, dodged: false, skillName: skill.name, stunApplied: anyStunned },
      };
    }

    case 'heal_lowest': {
      // Priest Minor Heal: heal lowest % HP ally
      const healTarget = findLowestPercentHpAlly(state.players);
      if (!healTarget) {
        return {
          logEntries,
          action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: null, targetSide: null, dodged: false, skillName: skill.name },
        };
      }

      const healAmount = Math.min(
        player.level * (effect.healMultiplier ?? 4),
        healTarget.maxHp - healTarget.currentHp,
      );
      healTarget.currentHp += healAmount;
      logEntries.push(`${player.username} uses ${skill.name} on ${healTarget.username} for ${healAmount} HP`);

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: healTarget.gridPosition, targetSide: 'player', dodged: false, skillName: skill.name, healAmount, healTarget: healTarget.username },
      };
    }

    case 'multi_hit': {
      // Mage Magic Missile: multiple hits at % damage
      const hitCount = effect.hitCount ?? 4;
      const pct = effect.damagePercent ?? 0.30;
      const rawDamage = computePlayerDamage(player, state.rallyMultiplier);
      const perHitDamage = Math.max(1, Math.floor(rawDamage * pct));

      let lastTarget: MonsterInstance | null = null;
      for (let i = 0; i < hitCount; i++) {
        const target = findTarget(player.gridPosition, state.monsters, false);
        if (!target) break;
        lastTarget = target;
        target.currentHp = Math.max(0, target.currentHp - perHitDamage);
        logEntries.push(`${player.username}'s ${skill.name} hits ${target.name} for ${perHitDamage} ${player.playerDamageType} damage`);
        if (target.currentHp <= 0) {
          logEntries.push(`${target.name} defeated!`);
        }
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: lastTarget?.gridPosition ?? null, targetSide: lastTarget ? 'monster' : null, dodged: false, skillName: skill.name },
      };
    }

    case 'target_lowest_hp': {
      // Archer Cut Down: normal damage but targets lowest HP enemy
      const target = findLowestHpTarget(state.monsters);
      if (!target) {
        return {
          logEntries,
          action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: null, targetSide: null, dodged: false, skillName: skill.name },
        };
      }

      const damage = computePlayerDamage(player, state.rallyMultiplier);
      target.currentHp = Math.max(0, target.currentHp - damage);
      logEntries.push(`${player.username} uses ${skill.name} on ${target.name} for ${damage} ${player.playerDamageType} damage`);

      if (target.currentHp <= 0) {
        logEntries.push(`${target.name} defeated!`);
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name },
      };
    }
  }
}

/** Compute damage for a player's normal attack (base + equipment + variance + rally + crit). */
function computePlayerDamage(player: PartyCombatant, rallyMultiplier: number): number {
  const variance = Math.floor(Math.random() * 5) - 2;
  const attackBonus = computeAttackBonus(player.equipBonuses);
  let damage = Math.max(1, player.baseDamage + variance + attackBonus);

  // Apply rally multiplier
  if (rallyMultiplier > 0) {
    damage = Math.max(1, Math.floor(damage * (1 + rallyMultiplier)));
  }

  // Apply crit
  const critChance = getCritChance(player);
  if (critChance > 0 && Math.random() < critChance) {
    damage *= 2;
  }

  return damage;
}

/**
 * Process one party combat tick — one combatant acts per tick.
 * Mutates `state` in place.
 */
export function processPartyTick(state: PartyCombatState): TickResult {
  if (state.finished) {
    return { logEntries: [], finished: true, result: state.result };
  }

  state.tickCount++;
  const logEntries: string[] = [];

  const totalCombatants = state.turnOrderSize;

  // Find the next alive combatant (scan up to a full cycle to skip dead ones)
  let acted = false;
  for (let i = 0; i < totalCombatants; i++) {
    const idx = (state.turnIndex + i) % totalCombatants;

    if (idx < state.players.length) {
      // Player turn
      const player = state.players[idx];
      if (player.currentHp <= 0) continue;

      // Check stun
      if (player.stunTurns > 0) {
        player.stunTurns--;
        logEntries.push(`${player.username} is stunned!`);
        state.lastAction = {
          attackerSide: 'player',
          attackerPos: player.gridPosition,
          targetPos: null,
          targetSide: null,
          dodged: false,
        };
        state.turnIndex = (idx + 1) % totalCombatants;
        acted = true;
        break;
      }

      player.attackCount++;

      // Check if an active skill should trigger (every Nth attack)
      let usedSkill = false;
      for (const skill of player.equippedSkills) {
        if (skill && skill.type === 'active' && skill.cooldown && skill.activeEffect) {
          if (player.attackCount % skill.cooldown === 0) {
            const result = executeActiveSkill(player, skill, state);
            logEntries.push(...result.logEntries);
            state.lastAction = result.action;
            usedSkill = true;
            break;
          }
        }
      }

      if (!usedSkill) {
        // Normal attack
        const target = findTarget(player.gridPosition, state.monsters, false);
        if (target) {
          const damage = computePlayerDamage(player, state.rallyMultiplier);
          target.currentHp = Math.max(0, target.currentHp - damage);
          logEntries.push(`${player.username} hits ${target.name} for ${damage} ${player.playerDamageType} damage`);

          if (target.currentHp <= 0) {
            logEntries.push(`${target.name} defeated!`);
          }

          state.lastAction = {
            attackerSide: 'player',
            attackerPos: player.gridPosition,
            targetPos: target.gridPosition,
            targetSide: 'monster',
            dodged: false,
          };
        } else {
          state.lastAction = {
            attackerSide: 'player',
            attackerPos: player.gridPosition,
            targetPos: null,
            targetSide: null,
            dodged: false,
          };
        }
      }

      state.turnIndex = (idx + 1) % totalCombatants;
      acted = true;
      break;
    } else {
      // Monster turn
      const monster = state.monsters[idx - state.players.length];
      if (monster.currentHp <= 0) continue;

      // Check stun
      if (monster.stunTurns > 0) {
        monster.stunTurns--;
        logEntries.push(`${monster.name} is stunned!`);
        state.lastAction = {
          attackerSide: 'monster',
          attackerPos: monster.gridPosition,
          targetPos: null,
          targetSide: null,
          dodged: false,
        };
        state.turnIndex = (idx + 1) % totalCombatants;
        acted = true;
        break;
      }

      const target = findTarget(monster.gridPosition, state.players, true);
      if (target) {
        // Dodge check
        const dodged = !!(target.equipBonuses && target.equipBonuses.dodgeChance > 0 && Math.random() < target.equipBonuses.dodgeChance);
        if (dodged) {
          logEntries.push(`${target.username} dodges ${monster.name}'s attack!`);
        } else {
          let reduction = 0;

          if (monster.damageType === 'physical') {
            // Equipment reduction applies to physical damage
            reduction += computeEquipReduction(target.equipBonuses);
            // Knight Guard physical damage reduction (target only)
            reduction += getPhysicalReduction(target, state.players);
          } else {
            // Magical/holy damage: Priest Bless party-wide magical reduction
            reduction += getMagicalReduction(state.players);
          }

          const damage = Math.max(0, monster.damage - reduction);
          target.currentHp = Math.max(0, target.currentHp - damage);
          logEntries.push(`${monster.name} hits ${target.username} for ${damage} ${monster.damageType} damage`);
        }

        state.lastAction = {
          attackerSide: 'monster',
          attackerPos: monster.gridPosition,
          targetPos: target.gridPosition,
          targetSide: 'player',
          dodged,
        };
      } else {
        state.lastAction = {
          attackerSide: 'monster',
          attackerPos: monster.gridPosition,
          targetPos: null,
          targetSide: null,
          dodged: false,
        };
      }

      state.turnIndex = (idx + 1) % totalCombatants;
      acted = true;
      break;
    }
  }

  if (!acted) {
    state.finished = true;
    state.result = 'defeat';
    return { logEntries, finished: true, result: 'defeat' };
  }

  // Check for victory (all monsters dead)
  if (state.monsters.every(m => m.currentHp <= 0)) {
    state.finished = true;
    state.result = 'victory';
    return { logEntries, finished: true, result: 'victory' };
  }

  // Check for defeat (all players dead)
  if (state.players.every(p => p.currentHp <= 0)) {
    state.finished = true;
    state.result = 'defeat';
    return { logEntries, finished: true, result: 'defeat' };
  }

  return { logEntries, finished: false, result: null };
}
