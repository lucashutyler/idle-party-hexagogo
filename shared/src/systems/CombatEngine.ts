import { ALL_STATS, CLASS_DEFINITIONS, calculateMaxHp } from './CharacterStats.js';
import type { StatBlock, ClassName } from './CharacterStats.js';
import type { MonsterInstance } from './MonsterTypes.js';
import type { EquipmentBonuses } from './ItemTypes.js';
import type { PartyGridPosition } from './SocialTypes.js';

// --- Types ---

export interface CombatantState {
  name: string;
  level: number;
  maxHp: number;
  currentHp: number;
}

export interface CombatState {
  player: CombatantState;
  monsters: MonsterInstance[];
  stats: StatBlock;
  equipBonuses?: EquipmentBonuses;
  tickCount: number;
  finished: boolean;
  result: 'victory' | 'defeat' | null;
}

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
  stats: StatBlock;
  equipBonuses?: EquipmentBonuses;
  gridPosition: PartyGridPosition;
  className: ClassName;
  level: number;
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

// --- Single-player combat (legacy, kept for compatibility) ---

/** Create initial combat state for a battle. */
export function createCombatState(
  playerName: string,
  level: number,
  stats: StatBlock,
  maxHp: number,
  monsters: MonsterInstance[],
  equipBonuses?: EquipmentBonuses,
): CombatState {
  return {
    player: {
      name: playerName,
      level,
      maxHp,
      currentHp: maxHp,
    },
    monsters,
    stats,
    equipBonuses,
    tickCount: 0,
    finished: false,
    result: null,
  };
}

/**
 * Process one combat tick (1 second of combat).
 * Mutates `state` in place.
 *
 * Order: player attacks first alive monster, then all alive monsters attack player.
 */
export function processTick(state: CombatState): TickResult {
  if (state.finished) {
    return { logEntries: [], finished: true, result: state.result };
  }

  state.tickCount++;
  const logEntries: string[] = [];

  // --- Player attacks ---
  const target = state.monsters.find(m => m.currentHp > 0);
  if (target) {
    const baseDamage = state.stats.STR;
    const variance = Math.floor(Math.random() * 5) - 2; // -2 to +2
    let attackBonus = 0;
    if (state.equipBonuses && state.equipBonuses.bonusAttackMax > 0) {
      const { bonusAttackMin, bonusAttackMax } = state.equipBonuses;
      attackBonus = bonusAttackMin + Math.floor(Math.random() * (bonusAttackMax - bonusAttackMin + 1));
    }
    const damage = Math.max(1, baseDamage + variance + attackBonus);
    target.currentHp = Math.max(0, target.currentHp - damage);
    logEntries.push(`${state.player.name} hits ${target.name} for ${damage} damage`);

    if (target.currentHp <= 0) {
      logEntries.push(`${target.name} defeated!`);
    }
  }

  // Check for victory
  if (state.monsters.every(m => m.currentHp <= 0)) {
    state.finished = true;
    state.result = 'victory';
    return { logEntries, finished: true, result: 'victory' };
  }

  // --- Monsters attack ---
  for (const monster of state.monsters) {
    if (monster.currentHp <= 0) continue;
    // Dodge check
    if (state.equipBonuses && state.equipBonuses.dodgeChance > 0 && Math.random() < state.equipBonuses.dodgeChance) {
      logEntries.push(`${state.player.name} dodges ${monster.name}'s attack!`);
      continue;
    }
    let reduction = 0;
    if (state.equipBonuses && state.equipBonuses.damageReductionMax > 0) {
      const { damageReductionMin, damageReductionMax } = state.equipBonuses;
      reduction = damageReductionMin + Math.floor(Math.random() * (damageReductionMax - damageReductionMin + 1));
    }
    const damage = Math.max(0, monster.damage - reduction);
    state.player.currentHp = Math.max(0, state.player.currentHp - damage);
    logEntries.push(`${monster.name} hits ${state.player.name} for ${damage} damage`);
  }

  // Check for defeat
  if (state.player.currentHp <= 0) {
    state.finished = true;
    state.result = 'defeat';
    return { logEntries, finished: true, result: 'defeat' };
  }

  return { logEntries, finished: false, result: null };
}

// --- Party Combat ---

/**
 * Create initial party combat state.
 * Players and monsters are sorted into turn order: front-to-back, top-to-bottom.
 * - Players: high column first (front line), then low row first (top)
 * - Monsters: low column first (front line), then low row first (top)
 */
export function createPartyCombatState(
  players: PartyCombatant[],
  monsters: MonsterInstance[],
): PartyCombatState {
  // Sort players: front-to-back (high col first), then top-to-bottom (low row first)
  const sortedPlayers = players.map(p => ({
    ...p,
    stats: { ...p.stats },
    currentHp: p.maxHp,
  })).sort((a, b) => {
    const colDiff = getCol(b.gridPosition) - getCol(a.gridPosition); // high col first
    if (colDiff !== 0) return colDiff;
    return getRow(a.gridPosition) - getRow(b.gridPosition); // low row first
  });

  // Apply Bard stat buff: +bardStatMultiplierPerMember * partySize to all players
  const partySize = sortedPlayers.length;
  let totalBardMultiplier = 0;
  for (const p of sortedPlayers) {
    const def = CLASS_DEFINITIONS[p.className];
    if (def.bardStatMultiplierPerMember > 0) {
      totalBardMultiplier += def.bardStatMultiplierPerMember * partySize;
    }
  }
  if (totalBardMultiplier > 0) {
    for (const p of sortedPlayers) {
      for (const stat of ALL_STATS) {
        p.stats[stat] = Math.floor(p.stats[stat] * (1 + totalBardMultiplier));
      }
      // Recalculate maxHp with buffed CON
      p.maxHp = calculateMaxHp(p.level, p.stats.CON, p.className);
      p.currentHp = p.maxHp;
    }
  }

  // Sort monsters: front-to-back (low col first), then top-to-bottom (low row first)
  const sortedMonsters = [...monsters]
    .sort((a, b) => {
      const colDiff = getCol(a.gridPosition) - getCol(b.gridPosition); // low col first
      if (colDiff !== 0) return colDiff;
      return getRow(a.gridPosition) - getRow(b.gridPosition); // low row first
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
  };
}

/**
 * Process one party combat tick — one combatant acts per tick.
 * Mutates `state` in place.
 *
 * Turn order: players first (sorted by grid position), then monsters (sorted by grid position).
 * Dead combatants are skipped. After the last combatant, wraps back to the first.
 */
export function processPartyTick(state: PartyCombatState): TickResult {
  if (state.finished) {
    return { logEntries: [], finished: true, result: state.result };
  }

  state.tickCount++;
  const logEntries: string[] = [];

  // Build turn order: players by grid position, then monsters by grid position
  const totalCombatants = state.turnOrderSize;

  // Find the next alive combatant (scan up to a full cycle to skip dead ones)
  let acted = false;
  for (let i = 0; i < totalCombatants; i++) {
    const idx = (state.turnIndex + i) % totalCombatants;

    if (idx < state.players.length) {
      // Player turn
      const player = state.players[idx];
      if (player.currentHp <= 0) continue;

      const target = findTarget(player.gridPosition, state.monsters, false);
      if (target) {
        const classDef = CLASS_DEFINITIONS[player.className];
        const baseDamage = classDef.attackStat ? player.stats[classDef.attackStat] : 0;
        const variance = Math.floor(Math.random() * 5) - 2;
        let attackBonus = 0;
        if (player.equipBonuses && player.equipBonuses.bonusAttackMax > 0) {
          const { bonusAttackMin, bonusAttackMax } = player.equipBonuses;
          attackBonus = bonusAttackMin + Math.floor(Math.random() * (bonusAttackMax - bonusAttackMin + 1));
        }
        const damage = Math.max(1, baseDamage + variance + attackBonus);
        target.currentHp = Math.max(0, target.currentHp - damage);
        logEntries.push(`${player.username} hits ${target.name} for ${damage} damage`);

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

      state.turnIndex = (idx + 1) % totalCombatants;
      acted = true;
      break;
    } else {
      // Monster turn
      const monster = state.monsters[idx - state.players.length];
      if (monster.currentHp <= 0) continue;

      const target = findTarget(monster.gridPosition, state.players, true);
      if (target) {
        // Dodge check
        const dodged = !!(target.equipBonuses && target.equipBonuses.dodgeChance > 0 && Math.random() < target.equipBonuses.dodgeChance);
        if (dodged) {
          logEntries.push(`${target.username} dodges ${monster.name}'s attack!`);
        } else {
          let reduction = 0;

          if (monster.damageType === 'physical') {
            // Equipment reduction applies to physical damage only
            if (target.equipBonuses && target.equipBonuses.damageReductionMax > 0) {
              const { damageReductionMin, damageReductionMax } = target.equipBonuses;
              reduction = damageReductionMin + Math.floor(Math.random() * (damageReductionMax - damageReductionMin + 1));
            }
            // Knight class physical damage reduction (target only)
            const targetDef = CLASS_DEFINITIONS[target.className];
            if (targetDef.physicalReductionBase > 0 || targetDef.physicalReductionPerLevel > 0) {
              reduction += targetDef.physicalReductionBase + targetDef.physicalReductionPerLevel * target.level;
            }
          } else {
            // Magical damage: Priest party-wide magical reduction from all alive Priests
            for (const p of state.players) {
              if (p.currentHp <= 0) continue;
              const pDef = CLASS_DEFINITIONS[p.className];
              if (pDef.partyMagicalReductionBase > 0 || pDef.partyMagicalReductionPerLevel > 0) {
                reduction += pDef.partyMagicalReductionBase + pDef.partyMagicalReductionPerLevel * p.level;
              }
            }
          }

          const damage = Math.max(0, monster.damage - reduction);
          target.currentHp = Math.max(0, target.currentHp - damage);
          logEntries.push(`${monster.name} hits ${target.username} for ${damage} damage`);
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
    // Shouldn't happen — means everyone is dead
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
