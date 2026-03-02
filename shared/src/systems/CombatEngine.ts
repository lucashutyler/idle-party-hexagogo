import type { StatBlock } from './CharacterStats.js';
import type { MonsterInstance } from './MonsterTypes.js';
import type { EquipmentBonuses } from './ItemTypes.js';

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

// --- Functions ---

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
