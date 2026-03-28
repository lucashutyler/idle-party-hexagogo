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

// --- Buff/Debuff/DoT Tracking ---

export interface DotEffect {
  sourceUsername: string;
  damagePerTick: number;
  ticksRemaining: number;
  damageType: DamageType;
}

export interface HotEffect {
  sourceUsername: string;
  healPerTick: number;
  ticksRemaining: number;
}

export interface CombatBuff {
  type: string;
  value: number;
  /** -1 = permanent (rest of combat). */
  duration: number;
}

export interface CombatDebuff {
  type: string;
  value: number;
  duration: number;
}

export interface SunderMark {
  stacks: number;
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
  // --- Extended combat state ---
  dots: DotEffect[];
  hots: HotEffect[];
  damageShield: number;
  debuffs: CombatDebuff[];
  /** Track consecutive hits on same target for Focus. */
  consecutiveHits: number;
  lastTargetId: string;
  /** Whether Resurrection has triggered this battle. */
  hasResurrected: boolean;
  /** Martyr heal bonus stacks (reset after heal). */
  martyrBonus: number;
  /** Whether this player is bracing (Shield Slam) this tick. */
  braceActive: boolean;
  /** Accumulated damage taken while bracing for reflect. */
  braceDamageTaken: number;
  /** Whether Intercept redirect is active this tick. */
  interceptActive: boolean;
  /** Number of active skills used this combat (for Arcane Surge). */
  activeSkillCount: number;
}

export interface CombatMonster extends MonsterInstance {
  stunTurns: number;
  dots: DotEffect[];
  /** Sunder marks on this monster. */
  sunderMark: SunderMark | null;
  /** Debuffs on this monster (e.g., Crippling Shot, Scorch). */
  debuffs: CombatDebuff[];
  /** Buffs on this monster (for Dispel to remove). */
  buffs: CombatBuff[];
  /** Whether this monster is affected by Chaos this tick. */
  chaosActive: boolean;
  /** Whether Lullaby damage reduction is active. */
  lullabyReduction: number;
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
  monsters: CombatMonster[];
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
  /** War Song permanent stacking damage bonus. */
  warSongBonus: number;
  /** Bard Nimble party-wide dodge bonus. */
  nimbleDodge: number;
  /** Bard Unnerve enemy damage reduction (flat %). */
  unnerveReduction: number;
  /** Priest Blessed Arms bonus holy damage per hit. */
  blessedArmsDamage: number;
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

/** Find the lowest HP non-Knight ally (for Sanctuary). */
function findLowestHpNonKnight(players: PartyCombatant[]): PartyCombatant | null {
  const alive = players.filter(p => p.currentHp > 0 && p.className !== 'Knight');
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
  if (target.currentHp <= 0) return 0;
  let reduction = 0;
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

/** Get crit damage multiplier (base 2x, Precision adds +1x). */
function getCritMultiplier(player: PartyCombatant): number {
  let mult = 2;
  for (const skill of player.equippedSkills) {
    if (skill && skill.passiveEffect?.kind === 'crit_damage_bonus') {
      mult += skill.passiveEffect.flatValue ?? 0;
    }
  }
  return mult;
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

/** Compute Bard Nimble party-wide dodge bonus. */
function computeNimbleDodge(players: PartyCombatant[]): number {
  const partySize = players.length;
  let totalDodge = 0;
  for (const p of players) {
    for (const skill of p.equippedSkills) {
      if (skill && skill.passiveEffect?.kind === 'dodge_party' && skill.passiveEffect.perPartyMember) {
        totalDodge += (skill.passiveEffect.flatValue ?? 0) * partySize;
      }
    }
  }
  return totalDodge;
}

/** Compute Bard Unnerve enemy damage reduction. */
function computeUnnerveReduction(players: PartyCombatant[]): number {
  const partySize = players.length;
  let totalReduction = 0;
  for (const p of players) {
    for (const skill of p.equippedSkills) {
      if (skill && skill.passiveEffect?.kind === 'enemy_damage_reduction_party' && skill.passiveEffect.perPartyMember) {
        totalReduction += (skill.passiveEffect.flatValue ?? 0) * partySize;
      }
    }
  }
  return totalReduction;
}

/** Compute Priest Blessed Arms bonus holy damage. */
function computeBlessedArmsDamage(players: PartyCombatant[]): number {
  let totalDamage = 0;
  for (const p of players) {
    if (p.currentHp <= 0) continue;
    for (const skill of p.equippedSkills) {
      if (skill && skill.passiveEffect?.kind === 'holy_damage_party') {
        totalDamage += (skill.passiveEffect.valuePerLevel ?? 0) * p.level;
      }
    }
  }
  return totalDamage;
}

/** Check if a player has a specific passive equipped. */
function hasPassive(player: PartyCombatant, kind: string): boolean {
  return player.equippedSkills.some(s => s && s.passiveEffect?.kind === kind);
}

/** Get a passive's flat value for a player. */
function getPassiveValue(player: PartyCombatant, kind: string): number {
  for (const skill of player.equippedSkills) {
    if (skill && skill.passiveEffect?.kind === kind) {
      return skill.passiveEffect.flatValue ?? 0;
    }
  }
  return 0;
}

/** Get healing power multiplier from Devotion. */
function getHealPowerMultiplier(player: PartyCombatant): number {
  let bonus = 0;
  for (const skill of player.equippedSkills) {
    if (skill && skill.passiveEffect?.kind === 'heal_power') {
      bonus += (skill.passiveEffect.valuePerLevel ?? 0) * player.level;
    }
  }
  return 1 + bonus / 100;
}

/** Get the effective cooldown for a player's active skill (with Tempo/Encore reductions). */
function getEffectiveCooldown(player: PartyCombatant, skill: SkillDefinition): number {
  let cdReduction = 0;
  for (const s of player.equippedSkills) {
    if (s && s.passiveEffect?.kind === 'cooldown_reduction') {
      cdReduction += s.passiveEffect.flatValue ?? 0;
    }
  }
  return Math.max(1, (skill.cooldown ?? 1) - cdReduction);
}

/** Check if Intensify is equipped and return the modifier value. */
function getIntensifyMod(player: PartyCombatant): number {
  return getPassiveValue(player, 'intensify');
}

/** Check if Arcane Surge is equipped. */
function hasArcaneSurge(player: PartyCombatant): boolean {
  return hasPassive(player, 'arcane_surge');
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

/** Compute damage for a player's normal attack or active skill (base + equipment + variance + rally + crit + conditionals). */
function computePlayerDamage(
  player: PartyCombatant,
  state: PartyCombatState,
  target?: CombatMonster,
  options?: { isActive?: boolean; skipCrit?: boolean },
): number {
  const variance = Math.floor(Math.random() * 5) - 2;
  const attackBonus = computeAttackBonus(player.equipBonuses);
  let damage = Math.max(1, player.baseDamage + variance + attackBonus);

  // Intensify: -50% auto, +50% active
  const intensifyMod = getIntensifyMod(player);
  if (intensifyMod > 0) {
    if (options?.isActive) {
      damage = Math.max(1, Math.floor(damage * (1 + intensifyMod)));
    } else {
      damage = Math.max(1, Math.floor(damage * (1 - intensifyMod)));
    }
  }

  // Apply rally multiplier
  if (state.rallyMultiplier > 0) {
    damage = Math.max(1, Math.floor(damage * (1 + state.rallyMultiplier)));
  }

  // Apply War Song permanent bonus
  if (state.warSongBonus > 0) {
    damage = Math.max(1, Math.floor(damage * (1 + state.warSongBonus)));
  }

  // Conditional damage bonuses
  if (target) {
    for (const skill of player.equippedSkills) {
      if (skill && skill.passiveEffect?.kind === 'conditional_damage_bonus') {
        const bonus = skill.passiveEffect.flatValue ?? 0;
        const cond = skill.passiveEffect.condition;
        if (cond === 'target_above_75_hp' && target.currentHp / target.maxHp > 0.75) {
          damage = Math.floor(damage * (1 + bonus));
        } else if (cond === 'front_column' && getCol(player.gridPosition) === 2) {
          damage = Math.floor(damage * (1 + bonus));
        } else if (cond === 'target_bleeding_or_stunned') {
          const isBleeding = target.dots.length > 0;
          const isStunned = target.stunTurns > 0;
          if (isBleeding || isStunned) {
            damage = Math.floor(damage * (1 + bonus));
          }
        }
      }
    }

    // Knight War Cry: Archers get +25% when any Knight is below 50% HP
    if (player.className === 'Archer') {
      for (const p of state.players) {
        if (p.currentHp <= 0) continue;
        for (const skill of p.equippedSkills) {
          if (skill && skill.passiveEffect?.kind === 'conditional_ally_damage'
              && skill.passiveEffect.targetClass === 'Archer'
              && p.currentHp / p.maxHp < (skill.passiveEffect.hpThreshold ?? 0.50)) {
            damage = Math.floor(damage * (1 + (skill.passiveEffect.flatValue ?? 0)));
          }
        }
      }
    }

    // Focus: +10% per consecutive hit on same target
    if (hasPassive(player, 'stacking_same_target')) {
      const bonus = getPassiveValue(player, 'stacking_same_target');
      if (player.lastTargetId === target.name && player.consecutiveHits > 0) {
        damage = Math.floor(damage * (1 + bonus * player.consecutiveHits));
      }
    }

    // Sunder marks on target
    if (target.sunderMark && target.sunderMark.stacks > 0) {
      const sunderBonus = 0.25 * target.sunderMark.stacks;
      damage = Math.floor(damage * (1 + sunderBonus));
    }

    // Scorch debuff on target
    if (player.playerDamageType === 'magical' || player.playerDamageType === 'holy') {
      for (const debuff of target.debuffs) {
        if (debuff.type === 'scorch') {
          damage = Math.floor(damage * (1 + debuff.value));
        }
      }
    }
  }

  // Apply crit
  if (!options?.skipCrit) {
    const critChance = getCritChance(player);
    if (critChance > 0 && Math.random() < critChance) {
      damage = Math.floor(damage * getCritMultiplier(player));
    }
  }

  return damage;
}

/** Apply damage to a monster, including Blessed Arms holy bonus and Overflow splash. */
function applyDamageToMonster(
  damage: number,
  target: CombatMonster,
  player: PartyCombatant,
  state: PartyCombatState,
  logEntries: string[],
  isAoe: boolean,
): void {
  // Add Blessed Arms holy damage
  const totalDamage = damage + state.blessedArmsDamage;
  const prevHp = target.currentHp;
  target.currentHp = Math.max(0, target.currentHp - totalDamage);

  if (state.blessedArmsDamage > 0 && damage > 0) {
    logEntries.push(`${player.username} hits ${target.name} for ${damage} ${player.playerDamageType} + ${state.blessedArmsDamage} holy damage`);
  } else {
    logEntries.push(`${player.username} hits ${target.name} for ${totalDamage} ${player.playerDamageType} damage`);
  }

  // Apply Scorch debuff if Mage has it equipped
  if (hasPassive(player, 'scorch')) {
    const scorchValue = getPassiveValue(player, 'scorch');
    const existing = target.debuffs.find(d => d.type === 'scorch');
    if (existing) {
      existing.duration = 2;
    } else {
      target.debuffs.push({ type: 'scorch', value: scorchValue, duration: 2 });
    }
  }

  // Apply Ignite DoT on auto-attacks
  if (!isAoe) {
    for (const skill of player.equippedSkills) {
      if (skill && skill.passiveEffect?.kind === 'dot_on_auto') {
        const dotTotal = Math.floor(damage * (skill.passiveEffect.dotPercent ?? 0));
        const ticks = skill.passiveEffect.dotTicks ?? 3;
        if (dotTotal > 0 && target.currentHp > 0) {
          target.dots.push({
            sourceUsername: player.username,
            damagePerTick: Math.max(1, Math.floor(dotTotal / ticks)),
            ticksRemaining: ticks,
            damageType: 'magical',
          });
        }
      }
    }
  }

  // Track Focus consecutive hits
  if (hasPassive(player, 'stacking_same_target')) {
    if (player.lastTargetId === target.name) {
      player.consecutiveHits++;
    } else {
      player.consecutiveHits = 1;
      player.lastTargetId = target.name;
    }
  }

  if (target.currentHp <= 0) {
    logEntries.push(`${target.name} defeated!`);

    // Overflow: overkill splashes to random enemy (single-target only, not AoE)
    if (!isAoe && hasPassive(player, 'overflow')) {
      const actualOverkill = totalDamage - prevHp;
      if (actualOverkill > 0) {
        const others = state.monsters.filter(m => m.currentHp > 0 && m !== target);
        if (others.length > 0) {
          const splashTarget = others[Math.floor(Math.random() * others.length)];
          splashTarget.currentHp = Math.max(0, splashTarget.currentHp - actualOverkill);
          logEntries.push(`Overflow! ${actualOverkill} damage splashes to ${splashTarget.name}`);
          if (splashTarget.currentHp <= 0) {
            logEntries.push(`${splashTarget.name} defeated!`);
          }
        }
      }
    }
  }
}

/** Apply healing to a player, factoring in Devotion, Martyr, and Tenacity. */
function applyHeal(
  healer: PartyCombatant,
  target: PartyCombatant,
  baseAmount: number,
  logEntries: string[],
  skillName: string,
): number {
  let amount = baseAmount;

  // Devotion: +heal power %
  amount = Math.floor(amount * getHealPowerMultiplier(healer));

  // Martyr bonus (reset after use)
  if (healer.martyrBonus > 0) {
    amount = Math.floor(amount * (1 + healer.martyrBonus));
    healer.martyrBonus = 0;
  }

  // Tenacity: target receives +30% healing
  if (hasPassive(target, 'healing_received_bonus')) {
    const bonus = getPassiveValue(target, 'healing_received_bonus');
    amount = Math.floor(amount * (1 + bonus));
  }

  // Cap at missing HP
  amount = Math.min(amount, target.maxHp - target.currentHp);
  target.currentHp += amount;

  if (amount > 0) {
    logEntries.push(`${healer.username} uses ${skillName} on ${target.username} for ${amount} HP`);
  }

  return amount;
}

/** Process DoTs and HoTs on a combatant at the start of their turn. */
function processTickEffects(entity: PartyCombatant | CombatMonster, logEntries: string[]): void {
  // Process DoTs
  for (let i = entity.dots.length - 1; i >= 0; i--) {
    const dot = entity.dots[i];
    const name = 'username' in entity ? (entity as PartyCombatant).username : (entity as CombatMonster).name;
    entity.currentHp = Math.max(0, entity.currentHp - dot.damagePerTick);
    logEntries.push(`${name} takes ${dot.damagePerTick} ${dot.damageType} damage (DoT)`);
    dot.ticksRemaining--;
    if (dot.ticksRemaining <= 0) {
      entity.dots.splice(i, 1);
    }
  }

  // Process HoTs (players only)
  if ('hots' in entity && 'maxHp' in entity && 'username' in entity) {
    const player = entity as PartyCombatant;
    for (let i = player.hots.length - 1; i >= 0; i--) {
      const hot = player.hots[i];
      const healAmount = Math.min(hot.healPerTick, player.maxHp - player.currentHp);
      player.currentHp += healAmount;
      if (healAmount > 0) {
        logEntries.push(`${player.username} heals for ${healAmount} HP (HoT)`);
      }
      hot.ticksRemaining--;
      if (hot.ticksRemaining <= 0) {
        player.hots.splice(i, 1);
      }
    }
  }

  // Tick down debuff durations
  if ('debuffs' in entity) {
    for (let i = entity.debuffs.length - 1; i >= 0; i--) {
      entity.debuffs[i].duration--;
      if (entity.debuffs[i].duration <= 0) {
        entity.debuffs.splice(i, 1);
      }
    }
  }

  // Tick down buff durations (monsters only)
  if ('buffs' in entity) {
    const monster = entity as CombatMonster;
    for (let i = monster.buffs.length - 1; i >= 0; i--) {
      if (monster.buffs[i].duration > 0) {
        monster.buffs[i].duration--;
        if (monster.buffs[i].duration <= 0) {
          monster.buffs.splice(i, 1);
        }
      }
    }
  }
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
    dots: [] as DotEffect[],
    hots: [] as HotEffect[],
    damageShield: 0,
    debuffs: [] as CombatDebuff[],
    consecutiveHits: 0,
    lastTargetId: '',
    hasResurrected: false,
    martyrBonus: 0,
    braceActive: false,
    braceDamageTaken: 0,
    interceptActive: false,
    activeSkillCount: 0,
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

  // Apply Knight Fortify max HP bonus at combat start
  for (const p of sortedPlayers) {
    for (const skill of p.equippedSkills) {
      if (skill && skill.passiveEffect?.kind === 'max_hp_percent') {
        const bonus = Math.floor(p.maxHp * (skill.passiveEffect.valuePerLevel ?? 0) * p.level / 100);
        p.maxHp += bonus;
        p.currentHp = p.maxHp;
      }
    }
  }

  // Compute party-wide bonuses
  const rallyMultiplier = computeRallyMultiplier(sortedPlayers);
  const nimbleDodge = computeNimbleDodge(sortedPlayers);
  const unnerveReduction = computeUnnerveReduction(sortedPlayers);
  const blessedArmsDamage = computeBlessedArmsDamage(sortedPlayers);

  // Sort monsters: front-to-back (low col first), then top-to-bottom (low row first)
  const sortedMonsters: CombatMonster[] = monsters.map(m => ({
    ...m,
    stunTurns: m.stunTurns ?? 0,
    dots: [],
    sunderMark: null,
    debuffs: [],
    buffs: [],
    chaosActive: false,
    lullabyReduction: 0,
  })).sort((a, b) => {
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
    warSongBonus: 0,
    nimbleDodge,
    unnerveReduction,
    blessedArmsDamage,
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

  // Track active skill count for Arcane Surge
  player.activeSkillCount++;

  // Arcane Surge: every 2nd active does 2x damage
  const arcaneSurgeActive = hasArcaneSurge(player) && player.activeSkillCount % 2 === 0;
  const arcaneMult = arcaneSurgeActive ? 2 : 1;

  const noAction = (): CombatAction => ({
    attackerSide: 'player', attackerPos: player.gridPosition,
    targetPos: null, targetSide: null, dodged: false, skillName: skill.name,
  });

  switch (effect.kind) {
    case 'stun_single': {
      // Knight Bash: normal damage + chance to stun target
      const target = findTarget(player.gridPosition, state.monsters, false);
      if (!target) return { logEntries, action: noAction() };

      const damage = computePlayerDamage(player, state, target, { isActive: true }) * arcaneMult;
      applyDamageToMonster(damage, target, player, state, logEntries, false);

      let stunApplied = false;
      if (target.currentHp > 0 && Math.random() < (effect.stunChance ?? 0)) {
        target.stunTurns = 1;
        stunApplied = true;
        logEntries.push(`${target.name} is stunned!`);
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
        action: { ...noAction(), stunApplied: anyStunned },
      };
    }

    case 'heal_lowest': {
      // Priest Minor Heal: heal lowest % HP ally
      const healTarget = findLowestPercentHpAlly(state.players);
      if (!healTarget) return { logEntries, action: noAction() };

      const baseHeal = player.level * (effect.healMultiplier ?? 4);
      const healAmount = applyHeal(player, healTarget, baseHeal, logEntries, skill.name);

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: healTarget.gridPosition, targetSide: 'player', dodged: false, skillName: skill.name, healAmount, healTarget: healTarget.username },
      };
    }

    case 'multi_hit': {
      // Mage Magic Missile: multiple hits at % damage
      const hitCount = effect.hitCount ?? 4;
      const pct = effect.damagePercent ?? 0.30;
      const rawDamage = computePlayerDamage(player, state, undefined, { isActive: true }) * arcaneMult;
      const perHitDamage = Math.max(1, Math.floor(rawDamage * pct));

      let lastTarget: CombatMonster | null = null;
      for (let i = 0; i < hitCount; i++) {
        const target = findTarget(player.gridPosition, state.monsters, false);
        if (!target) break;
        lastTarget = target;
        applyDamageToMonster(perHitDamage, target, player, state, logEntries, false);
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: lastTarget?.gridPosition ?? null, targetSide: lastTarget ? 'monster' : null, dodged: false, skillName: skill.name },
      };
    }

    case 'target_lowest_hp': {
      // Archer Cut Down: normal damage but targets lowest HP enemy
      const target = findLowestHpTarget(state.monsters);
      if (!target) return { logEntries, action: noAction() };

      const damage = computePlayerDamage(player, state, target as CombatMonster, { isActive: true }) * arcaneMult;
      applyDamageToMonster(damage, target as CombatMonster, player, state, logEntries, false);

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name },
      };
    }

    case 'redirect_hit': {
      // Knight Intercept: instead of attacking, redirect next hit on ally to self
      player.interceptActive = true;
      logEntries.push(`${player.username} braces to intercept the next attack on an ally`);
      return { logEntries, action: noAction() };
    }

    case 'brace_reflect': {
      // Knight Shield Slam: brace, reflect % of damage taken this round
      player.braceActive = true;
      player.braceDamageTaken = 0;
      logEntries.push(`${player.username} braces behind their shield`);
      return { logEntries, action: noAction() };
    }

    case 'stacking_mark': {
      // Knight Sunder: normal damage + stacking damage mark
      const target = findTarget(player.gridPosition, state.monsters, false);
      if (!target) return { logEntries, action: noAction() };

      const damage = computePlayerDamage(player, state, target, { isActive: true }) * arcaneMult;
      applyDamageToMonster(damage, target, player, state, logEntries, false);

      if (target.currentHp > 0) {
        if (!target.sunderMark) {
          target.sunderMark = { stacks: 1 };
        } else {
          target.sunderMark.stacks++;
        }
        logEntries.push(`${target.name} is sundered! (+${Math.round((target.sunderMark?.stacks ?? 0) * 25)}% incoming damage)`);
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name },
      };
    }

    case 'remove_buffs': {
      // Knight Dispel: normal damage + remove all buffs from target
      const target = findTarget(player.gridPosition, state.monsters, false);
      if (!target) return { logEntries, action: noAction() };

      const damage = computePlayerDamage(player, state, target, { isActive: true }) * arcaneMult;
      applyDamageToMonster(damage, target, player, state, logEntries, false);

      if (target.currentHp > 0 && target.buffs.length > 0) {
        target.buffs = [];
        logEntries.push(`${player.username} dispels all buffs from ${target.name}!`);
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name },
      };
    }

    case 'multi_hit_random': {
      // Archer Triple Shot: hit N random enemies at % damage
      const hitCount = effect.hitCount ?? 3;
      const pct = effect.damagePercent ?? 0.50;
      const rawDamage = computePlayerDamage(player, state, undefined, { isActive: true }) * arcaneMult;
      const perHitDamage = Math.max(1, Math.floor(rawDamage * pct));

      let lastTarget: CombatMonster | null = null;
      for (let i = 0; i < hitCount; i++) {
        const alive = state.monsters.filter(m => m.currentHp > 0);
        if (alive.length === 0) break;
        const target = alive[Math.floor(Math.random() * alive.length)];
        lastTarget = target;
        applyDamageToMonster(perHitDamage, target, player, state, logEntries, true);
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: lastTarget?.gridPosition ?? null, targetSide: lastTarget ? 'monster' : null, dodged: false, skillName: skill.name },
      };
    }

    case 'ignore_dr_single': {
      // Archer Snipe: high damage ignoring DR
      const target = findTarget(player.gridPosition, state.monsters, false);
      if (!target) return { logEntries, action: noAction() };

      const rawDamage = computePlayerDamage(player, state, target, { isActive: true }) * arcaneMult;
      const damage = Math.max(1, Math.floor(rawDamage * (effect.damagePercent ?? 2.0)));
      // Direct damage, bypass normal damage reduction
      const prevHp = target.currentHp;
      target.currentHp = Math.max(0, target.currentHp - damage);
      logEntries.push(`${player.username} snipes ${target.name} for ${damage} damage (ignores DR)`);

      if (target.currentHp <= 0) {
        logEntries.push(`${target.name} defeated!`);
        // Overflow check
        if (hasPassive(player, 'overflow')) {
          const overkill = damage - prevHp;
          if (overkill > 0) {
            const others = state.monsters.filter(m => m.currentHp > 0 && m !== target);
            if (others.length > 0) {
              const splashTarget = others[Math.floor(Math.random() * others.length)];
              splashTarget.currentHp = Math.max(0, splashTarget.currentHp - overkill);
              logEntries.push(`Overflow! ${overkill} damage splashes to ${splashTarget.name}`);
              if (splashTarget.currentHp <= 0) {
                logEntries.push(`${splashTarget.name} defeated!`);
              }
            }
          }
        }
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name },
      };
    }

    case 'dot_attack': {
      // Archer Bleed: normal damage + DoT
      const target = findTarget(player.gridPosition, state.monsters, false);
      if (!target) return { logEntries, action: noAction() };

      const damage = computePlayerDamage(player, state, target, { isActive: true }) * arcaneMult;
      applyDamageToMonster(damage, target, player, state, logEntries, false);

      if (target.currentHp > 0) {
        const dotTotal = Math.floor(damage * (effect.dotPercent ?? 0.20));
        const ticks = effect.dotTicks ?? 3;
        target.dots.push({
          sourceUsername: player.username,
          damagePerTick: Math.max(1, Math.floor(dotTotal / ticks)),
          ticksRemaining: ticks,
          damageType: player.playerDamageType,
        });
        logEntries.push(`${target.name} is bleeding!`);
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name },
      };
    }

    case 'debuff_attack': {
      // Archer Crippling Shot: normal damage + damage debuff on target
      const target = findTarget(player.gridPosition, state.monsters, false);
      if (!target) return { logEntries, action: noAction() };

      const damage = computePlayerDamage(player, state, target, { isActive: true }) * arcaneMult;
      applyDamageToMonster(damage, target, player, state, logEntries, false);

      if (target.currentHp > 0) {
        target.debuffs.push({
          type: 'crippling_shot',
          value: effect.debuffPercent ?? 0.30,
          duration: effect.debuffDuration ?? 3,
        });
        logEntries.push(`${target.name}'s damage is reduced by ${Math.round((effect.debuffPercent ?? 0.30) * 100)}%!`);
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name },
      };
    }

    case 'smite': {
      // Priest Smite: normal physical damage (+ bonus holy vs undead, stubbed for now)
      const target = findTarget(player.gridPosition, state.monsters, false);
      if (!target) return { logEntries, action: noAction() };

      const damage = computePlayerDamage(player, state, target, { isActive: true }) * arcaneMult;
      applyDamageToMonster(damage, target, player, state, logEntries, false);
      // TODO: Add bonus holy damage vs undead when undead system is implemented

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name },
      };
    }

    case 'cure_debuffs': {
      // Priest Cure: remove all debuffs from lowest HP ally
      const target = findLowestPercentHpAlly(state.players);
      if (!target) return { logEntries, action: noAction() };

      const hadDebuffs = target.debuffs.length > 0 || target.stunTurns > 0 || target.dots.length > 0;
      target.debuffs = [];
      target.dots = [];
      if (target.stunTurns > 0) target.stunTurns = 0;

      if (hadDebuffs) {
        logEntries.push(`${player.username} cures ${target.username}'s afflictions!`);
      } else {
        logEntries.push(`${player.username} uses ${skill.name} on ${target.username} but there's nothing to cure`);
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'player', dodged: false, skillName: skill.name },
      };
    }

    case 'hot_lowest': {
      // Priest Mending: HoT on lowest HP ally
      const target = findLowestPercentHpAlly(state.players);
      if (!target) return { logEntries, action: noAction() };

      const healPerTick = Math.floor(player.level * (effect.healMultiplier ?? 2) * getHealPowerMultiplier(player));
      const ticks = effect.dotTicks ?? 3;

      // Apply Tenacity to HoT
      let adjustedHeal = healPerTick;
      if (hasPassive(target, 'healing_received_bonus')) {
        const bonus = getPassiveValue(target, 'healing_received_bonus');
        adjustedHeal = Math.floor(adjustedHeal * (1 + bonus));
      }

      target.hots.push({
        sourceUsername: player.username,
        healPerTick: adjustedHeal,
        ticksRemaining: ticks,
      });
      logEntries.push(`${player.username} applies ${skill.name} to ${target.username} (${adjustedHeal} HP/tick for ${ticks} ticks)`);

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'player', dodged: false, skillName: skill.name, healTarget: target.username },
      };
    }

    case 'shield_non_knight': {
      // Priest Sanctuary: shield lowest HP non-Knight ally
      const target = findLowestHpNonKnight(state.players);
      if (!target) {
        logEntries.push(`${player.username} uses ${skill.name} but no non-Knight allies need protection`);
        return { logEntries, action: noAction() };
      }

      const shieldAmount = player.level * (effect.shieldMultiplier ?? 4);
      target.damageShield = shieldAmount;
      logEntries.push(`${player.username} shields ${target.username} for ${shieldAmount} damage`);

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'player', dodged: false, skillName: skill.name },
      };
    }

    case 'damage_percent': {
      // Mage Zap: deal % damage to single target
      const target = findTarget(player.gridPosition, state.monsters, false);
      if (!target) return { logEntries, action: noAction() };

      const rawDamage = computePlayerDamage(player, state, target, { isActive: true }) * arcaneMult;
      const damage = Math.max(1, Math.floor(rawDamage * (effect.damagePercent ?? 0.75)));
      applyDamageToMonster(damage, target, player, state, logEntries, false);

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name },
      };
    }

    case 'damage_aoe_all': {
      // Mage Blizzard/Chain Lightning, Bard Dissonance: deal damage to all enemies
      let lastTarget: CombatMonster | null = null;

      if (effect.damagePerLevel) {
        // Bard Dissonance: flat damage per level
        const damage = Math.max(1, Math.floor(effect.damagePerLevel * player.level)) * arcaneMult;
        for (const monster of state.monsters) {
          if (monster.currentHp <= 0) continue;
          lastTarget = monster;
          monster.currentHp = Math.max(0, monster.currentHp - damage);
          logEntries.push(`${player.username}'s ${skill.name} hits ${monster.name} for ${damage} damage`);
          if (monster.currentHp <= 0) {
            logEntries.push(`${monster.name} defeated!`);
          }
        }
      } else {
        // Mage Blizzard/Chain Lightning: % of normal damage
        const rawDamage = computePlayerDamage(player, state, undefined, { isActive: true }) * arcaneMult;
        const damage = Math.max(1, Math.floor(rawDamage * (effect.damagePercent ?? 1.0)));
        for (const monster of state.monsters) {
          if (monster.currentHp <= 0) continue;
          lastTarget = monster;
          applyDamageToMonster(damage, monster, player, state, logEntries, true);
        }
      }

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: lastTarget?.gridPosition ?? null, targetSide: lastTarget ? 'monster' : null, dodged: false, skillName: skill.name },
      };
    }

    case 'high_damage_single': {
      // Mage Arcane Blast: high % damage to single target
      const target = findTarget(player.gridPosition, state.monsters, false);
      if (!target) return { logEntries, action: noAction() };

      const rawDamage = computePlayerDamage(player, state, target, { isActive: true }) * arcaneMult;
      const damage = Math.max(1, Math.floor(rawDamage * (effect.damagePercent ?? 2.50)));
      applyDamageToMonster(damage, target, player, state, logEntries, false);

      return {
        logEntries,
        action: { attackerSide: 'player', attackerPos: player.gridPosition, targetPos: target.gridPosition, targetSide: 'monster', dodged: false, skillName: skill.name },
      };
    }

    case 'party_buff_permanent': {
      // Bard War Song: +% party damage, permanent, stacking
      const buffAmount = effect.buffPercent ?? 0.10;
      state.warSongBonus += buffAmount;
      logEntries.push(`${player.username}'s ${skill.name} increases party damage by ${Math.round(buffAmount * 100)}%! (Total: +${Math.round(state.warSongBonus * 100)}%)`);

      return { logEntries, action: noAction() };
    }

    case 'enemy_debuff_aoe': {
      // Bard Lullaby: reduce enemy damage for N turns
      const debuffAmount = effect.debuffPercent ?? 0.20;
      const duration = effect.debuffDuration ?? 3;
      for (const monster of state.monsters) {
        if (monster.currentHp <= 0) continue;
        // Don't stack Lullaby with itself — refresh duration
        const existing = monster.debuffs.find(d => d.type === 'lullaby');
        if (existing) {
          existing.duration = duration;
        } else {
          monster.debuffs.push({ type: 'lullaby', value: debuffAmount, duration });
        }
      }
      logEntries.push(`${player.username}'s ${skill.name} reduces enemy damage by ${Math.round(debuffAmount * 100)}% for ${duration} turns`);

      return { logEntries, action: noAction() };
    }

    case 'chaos': {
      // Bard Chaos: all enemies attack a random enemy (including themselves) this round
      for (const monster of state.monsters) {
        if (monster.currentHp <= 0) continue;
        monster.chaosActive = true;
      }
      logEntries.push(`${player.username}'s ${skill.name} causes chaos! Enemies turn on each other!`);

      return { logEntries, action: noAction() };
    }
  }

  // Should never reach here — all cases handled
  return { logEntries, action: noAction() };
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

      // Process tick effects (DoTs, HoTs, debuff expiry)
      processTickEffects(player, logEntries);
      if (player.currentHp <= 0) {
        // Check Resurrection
        if (checkResurrection(player, state, logEntries)) {
          // Player revived, continue turn
        } else {
          state.turnIndex = (idx + 1) % totalCombatants;
          acted = true;
          break;
        }
      }

      // Reset per-tick states
      player.braceActive = false;
      player.braceDamageTaken = 0;
      player.interceptActive = false;

      // Check stun
      if (player.stunTurns > 0) {
        // Iron Will: immune to stun
        if (hasPassive(player, 'stun_immune')) {
          player.stunTurns = 0;
          logEntries.push(`${player.username}'s Iron Will resists the stun!`);
        } else {
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
      }

      player.attackCount++;

      // Check if an active skill should trigger (every Nth attack, with CD reduction)
      let usedSkill = false;
      for (const skill of player.equippedSkills) {
        if (skill && skill.type === 'active' && skill.cooldown && skill.activeEffect) {
          const effectiveCD = getEffectiveCooldown(player, skill);
          if (player.attackCount % effectiveCD === 0) {
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
          const damage = computePlayerDamage(player, state, target);
          applyDamageToMonster(damage, target, player, state, logEntries, false);

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

      // Process tick effects (DoTs, debuff expiry)
      processTickEffects(monster, logEntries);
      if (monster.currentHp <= 0) {
        logEntries.push(`${monster.name} defeated! (DoT)`);
        state.turnIndex = (idx + 1) % totalCombatants;
        acted = true;
        break;
      }

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

      // Chaos: monster attacks a random enemy instead
      if (monster.chaosActive) {
        monster.chaosActive = false;
        const aliveMonsters = state.monsters.filter(m => m.currentHp > 0);
        if (aliveMonsters.length > 0) {
          const chaosTarget = aliveMonsters[Math.floor(Math.random() * aliveMonsters.length)];
          const monsterDmg = getMonsterDamage(monster, state);
          chaosTarget.currentHp = Math.max(0, chaosTarget.currentHp - monsterDmg);
          logEntries.push(`${monster.name} attacks ${chaosTarget.name} in confusion for ${monsterDmg} damage!`);
          if (chaosTarget.currentHp <= 0) {
            logEntries.push(`${chaosTarget.name} defeated!`);
          }
        }
        state.lastAction = {
          attackerSide: 'monster',
          attackerPos: monster.gridPosition,
          targetPos: null,
          targetSide: 'monster',
          dodged: false,
        };
        state.turnIndex = (idx + 1) % totalCombatants;
        acted = true;
        break;
      }

      // Normal monster attack on player
      let target = findTarget(monster.gridPosition, state.players, true);

      // Intercept check: if any player has interceptActive, redirect to them
      if (target) {
        const interceptor = state.players.find(p => p.currentHp > 0 && p.interceptActive && p !== target);
        if (interceptor) {
          logEntries.push(`${interceptor.username} intercepts the attack on ${target.username}!`);
          target = interceptor;
        }
      }

      if (target) {
        // Dodge check: equipment dodge + Nimble party dodge
        const equipDodge = target.equipBonuses?.dodgeChance ?? 0;
        const totalDodge = equipDodge + state.nimbleDodge;
        const dodged = totalDodge > 0 && Math.random() < totalDodge;

        if (dodged) {
          logEntries.push(`${target.username} dodges ${monster.name}'s attack!`);
        } else {
          const rawMonsterDmg = getMonsterDamage(monster, state);

          let reduction = 0;
          if (monster.damageType === 'physical') {
            reduction += computeEquipReduction(target.equipBonuses);
            reduction += getPhysicalReduction(target, state.players);
          } else {
            reduction += getMagicalReduction(state.players);
          }

          let damage = Math.max(0, rawMonsterDmg - reduction);

          // Damage shield (Sanctuary)
          if (target.damageShield > 0) {
            const absorbed = Math.min(damage, target.damageShield);
            target.damageShield -= absorbed;
            damage -= absorbed;
            if (absorbed > 0) {
              logEntries.push(`${target.username}'s shield absorbs ${absorbed} damage`);
            }
          }

          target.currentHp = Math.max(0, target.currentHp - damage);
          logEntries.push(`${monster.name} hits ${target.username} for ${damage} ${monster.damageType} damage`);

          // Shield Slam brace: accumulate damage taken
          if (target.braceActive) {
            target.braceDamageTaken += damage;
          }

          // Shield Bash passive: 10% chance to stun attacker on physical hit
          if (monster.damageType === 'physical' && hasPassive(target, 'stun_on_phys_hit')) {
            const stunChance = getPassiveValue(target, 'stun_on_phys_hit');
            if (Math.random() < stunChance) {
              monster.stunTurns = 1;
              logEntries.push(`${target.username}'s Shield Bash stuns ${monster.name}!`);
            }
          }

          // Martyr: when a Knight takes damage, Priests with Martyr get heal bonus
          if (target.className === 'Knight' && damage > 0) {
            for (const p of state.players) {
              if (p.currentHp <= 0 || p === target) continue;
              if (hasPassive(p, 'martyr')) {
                p.martyrBonus += getPassiveValue(p, 'martyr');
              }
            }
          }

          // Check for player death
          if (target.currentHp <= 0) {
            if (!checkResurrection(target, state, logEntries)) {
              logEntries.push(`${target.username} has fallen!`);
            }
          }
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

  // Process Shield Slam reflect at end of monster attacks
  for (const player of state.players) {
    if (player.braceActive && player.braceDamageTaken > 0) {
      // Check equipped active skill for reflectPercent
      for (const skill of player.equippedSkills) {
        if (skill && skill.activeEffect?.kind === 'brace_reflect') {
          const pct = skill.activeEffect.reflectPercent ?? 0.10;
          const reflectDamage = Math.max(1, Math.floor(player.braceDamageTaken * pct));
          // Reflect to all monsters that are alive (simplified: split among attackers)
          for (const m of state.monsters) {
            if (m.currentHp <= 0) continue;
            m.currentHp = Math.max(0, m.currentHp - reflectDamage);
            logEntries.push(`${player.username}'s Shield Slam reflects ${reflectDamage} damage to ${m.name}`);
            if (m.currentHp <= 0) {
              logEntries.push(`${m.name} defeated!`);
            }
          }
          break;
        }
      }
      player.braceActive = false;
      player.braceDamageTaken = 0;
    }
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

/** Get monster damage with all reductions (Unnerve, Lullaby, Crippling Shot). */
function getMonsterDamage(monster: CombatMonster, state: PartyCombatState): number {
  let damage = monster.damage;

  // Unnerve: passive % reduction from Bard
  if (state.unnerveReduction > 0) {
    damage = Math.floor(damage * (1 - state.unnerveReduction));
  }

  // Lullaby debuff
  for (const debuff of monster.debuffs) {
    if (debuff.type === 'lullaby') {
      damage = Math.floor(damage * (1 - debuff.value));
    }
  }

  // Crippling Shot debuff
  for (const debuff of monster.debuffs) {
    if (debuff.type === 'crippling_shot') {
      damage = Math.floor(damage * (1 - debuff.value));
    }
  }

  return Math.max(0, damage);
}

/** Check if Resurrection triggers for a dying player. */
function checkResurrection(
  player: PartyCombatant,
  state: PartyCombatState,
  logEntries: string[],
): boolean {
  if (player.currentHp > 0) return false;

  // Check if any alive Priest has Resurrection equipped and it hasn't been used
  for (const p of state.players) {
    if (p.currentHp <= 0) continue;
    if (hasPassive(p, 'resurrection') && !p.hasResurrected) {
      const revivePercent = getPassiveValue(p, 'resurrection') || 0.20;
      player.currentHp = Math.max(1, Math.floor(player.maxHp * revivePercent));
      p.hasResurrected = true;
      logEntries.push(`${p.username}'s Resurrection revives ${player.username} at ${Math.round(revivePercent * 100)}% HP!`);
      return true;
    }
  }
  return false;
}
