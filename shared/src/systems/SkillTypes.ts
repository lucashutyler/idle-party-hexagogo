import type { ClassName } from './CharacterStats.js';

// --- Types ---

export type SkillSlotType = 'passive' | 'active';
/** 'attack' is a class's basic attack: always in use, and it never takes a slot. */
export type SkillType = SkillSlotType | 'attack';
export type SkillId = string;

export interface SkillSlot {
  type: SkillSlotType;
  unlocksAtLevel: number;
}

export type PassiveEffectKind =
  | 'physical_reduction'        // Knight Guard: physical armor rating per level
  | 'party_damage_mult'         // Bard Rally: +% damage per party member (all types)
  | 'magical_reduction_party'   // Priest Bless: party-wide magical/holy rating per level (strongest owner)
  | 'crit_chance'               // Archer Pierce: % chance to crit (2x damage)
  | 'bonus_damage'              // Mage Burn: flat damage per level
  | 'max_hp_percent'            // Knight Fortify: +% max HP per level
  | 'stun_on_phys_hit'          // Knight Shield Bash: % chance to stun attacker on physical hit
  | 'stun_immune'               // Knight Iron Will: immune to stun effects
  | 'healing_received_bonus'    // Knight Tenacity: +% healing received
  | 'conditional_ally_damage'   // Knight War Cry: allies of specific class gain damage when condition met
  | 'conditional_damage_bonus'  // Archer Marksman/Brave/Exploit Weakness: +% damage under conditions
  | 'crit_damage_bonus'         // Archer Precision: +% crit damage
  | 'stacking_same_target'      // Archer Focus: +% per consecutive hit on same target
  | 'heal_power'                // Priest Devotion: +% healing done per level
  | 'holy_damage_party'         // Priest Blessed Arms: +holy damage per priest level to all party
  | 'consecrate'                // Priest Consecrate: undead stay dead (stub until undead system)
  | 'martyr'                    // Priest Martyr: Knight taking damage boosts next heal
  | 'resurrection'              // Priest Resurrection: once per battle ally revive
  | 'intensify'                 // Mage Intensify: -auto damage, +active damage
  | 'dot_on_auto'               // Mage Ignite: % of auto damage as DoT
  | 'arcane_surge'              // Mage Arcane Surge: every 2nd active does 2x
  | 'overflow'                  // Mage Overflow: overkill splashes (single-target only)
  | 'scorch'                    // Mage Scorch: damaged enemies take +% magic damage
  | 'cooldown_reduction'        // Bard Tempo/Encore: reduce active cooldowns by N seconds
  | 'dodge_party'               // Bard Nimble: +% dodge per party member, party-wide
  | 'xp_bonus'                  // Bard Inspiration: +% XP for party
  | 'enemy_damage_reduction_party' // Bard Unnerve: -% enemy damage per party member
  | 'same_class_damage';        // +% own damage per other living human of the same class

export interface PassiveEffect {
  kind: PassiveEffectKind;
  /** Per-level scaling value (e.g., +2 reduction per level). */
  valuePerLevel?: number;
  /** Flat value (e.g., 0.20 = 20% crit chance). */
  flatValue?: number;
  /** If true, effect scales per party member (Bard Rally, Nimble, Unnerve). */
  perPartyMember?: boolean;
  /** Condition for conditional_damage_bonus: 'target_above_75_hp' | 'front_column' | 'target_bleeding_or_stunned'. */
  condition?: string;
  /** Target class for conditional_ally_damage (e.g., 'Archer' for War Cry). */
  targetClass?: ClassName;
  /** HP threshold for conditional_ally_damage (e.g., 0.50 = below 50% HP). */
  hpThreshold?: number;
  /** DoT percent of damage dealt (for dot_on_auto). */
  dotPercent?: number;
  /** DoT tick count (for dot_on_auto). */
  dotTicks?: number;
  /** For cooldown_reduction: if true, the reduction applies to the whole party. Defaults to self-only. */
  partyWide?: boolean;
  /** Effects in one group don't simply add across the party: strongest first, each further copy counts `stackFactor` of the one before (0: strongest only). */
  stackGroup?: string;
  stackFactor?: number;
  /** With perPartyMember: scale by the distinct classes in the fight, hires included, not by head count. */
  perDistinctClass?: boolean;
}

export type ActiveEffectKind =
  | 'stun_single'         // Knight Bash: chance to stun single target
  | 'stun_aoe'            // Bard Drumroll: chance to stun each enemy
  | 'heal_lowest'         // Priest Minor Heal: heal lowest % HP ally
  | 'multi_hit'           // Mage Magic Missile: multiple hits at % damage
  | 'target_lowest_hp'    // Archer Cut Down: target lowest HP enemy
  | 'redirect_hit'        // Knight Intercept: take a single-target hit aimed at an ally
  | 'brace_reflect'       // Knight Shield Slam: reflect % of physical damage taken
  | 'stacking_mark'       // Knight Sunder: mark target for +% incoming damage, stacks
  | 'remove_buffs'        // Knight Dispel: remove all buffs from target
  | 'multi_hit_random'    // Archer Triple Shot: hit N random enemies at % damage
  | 'ignore_dr_single'    // Archer Snipe: high damage ignoring DR
  | 'dot_attack'          // Archer Bleed: normal damage + DoT
  | 'debuff_attack'       // Archer Crippling Shot: normal damage + damage debuff
  | 'smite'               // Priest Smite: normal phys + bonus holy vs undead
  | 'cure_debuffs'        // Priest Cure: remove debuffs from lowest HP ally
  | 'hot_lowest'          // Priest Mending: HoT on lowest HP ally
  | 'shield_non_knight'   // Priest Sanctuary: shield lowest non-Knight ally
  | 'damage_percent'      // Mage Zap: deal % damage to single target
  | 'damage_aoe_all'      // Mage Blizzard/Chain Lightning, Bard Dissonance: deal damage to all enemies
  | 'high_damage_single'  // Mage Arcane Blast: high % damage single target
  | 'party_buff_permanent' // Bard War Song: +% party damage rest of combat, stacking
  | 'enemy_debuff_aoe'    // Bard Lullaby: -% enemy damage for N seconds
  | 'chaos';              // Bard Chaos: enemies attack random enemies

export interface ActiveEffect {
  kind: ActiveEffectKind;
  /** Chance to stun (0-1). */
  stunChance?: number;
  /** Heal = level * healMultiplier. */
  healMultiplier?: number;
  /** Number of hits for multi_hit / multi_hit_random. */
  hitCount?: number;
  /** Damage percentage per hit (0.30 = 30%). Used by multi_hit, damage_percent, damage_aoe_all, high_damage_single. */
  damagePercent?: number;
  /** Flat damage per level (for Dissonance). */
  damagePerLevel?: number;
  /** With damagePerLevel: +this share per other living human of the owner's class. */
  sameClassBonus?: number;
  /** Mark damage multiplier per stack (e.g., 0.25 = +25% per stack). */
  markMultiplier?: number;
  /** Reflect percent (for brace_reflect, e.g., 0.10 = 10%). */
  reflectPercent?: number;
  /** DoT percent of damage dealt (for dot_attack). */
  dotPercent?: number;
  /** DoT/HoT pulse count, one per second (for dot_attack, hot_lowest). */
  dotTicks?: number;
  /** Debuff percent (for debuff_attack, enemy_debuff_aoe, e.g., 0.30 = -30%). */
  debuffPercent?: number;
  /** Debuff duration in seconds. */
  debuffDuration?: number;
  /** Shield amount multiplier (level * shieldMultiplier). */
  shieldMultiplier?: number;
  /** Bonus holy damage multiplier vs undead (level * holyMultiplier). */
  holyMultiplier?: number;
  /** Buff percent per stack (for party_buff_permanent, e.g., 0.10 = +10%). */
  buffPercent?: number;
  /** Whether this is an AoE skill (for Overflow check). */
  isAoe?: boolean;
}

/**
 * A skill as editable content. Skills are composed of one or more effect
 * "options": `passiveEffects` are allowed on both passive and active skills,
 * `activeEffects` only on active skills (enforced by `validateSkillDefinition`).
 */
export interface SkillDefinition {
  id: SkillId;
  name: string;
  description: string;
  /** Home class tree this skill belongs to. */
  className: ClassName;
  /** Decides which slot type the skill equips into. */
  type: SkillType;
  /** Level the class learns it; null = grant-only (item/set), never level-learned. */
  unlockLevel: number | null;
  /** Display order within the class tree. */
  sortOrder: number;
  /** Passive effect options — allowed on BOTH passive and active skills. */
  passiveEffects?: PassiveEffect[];
  /** Active effect options — allowed ONLY on active skills. */
  activeEffects?: ActiveEffect[];
  /** Active only — seconds after use before it is ready again. Ignored once `charge` or `recovery` is set. */
  cooldown?: number;
  /** Attack and active — real seconds, after its recovery, until this skill is ready again. */
  charge?: number;
  /** Attack and active — real seconds after use during which its owner can use no action skill. A skill with a trigger has none. */
  recovery?: number;
  /** Active only — seconds of telegraphed wind-up; default 0. */
  castTime?: number;
  /** Attack and active — seconds before first use in a battle (real seconds on a skill with `charge` or `recovery`); default derived from its timing. */
  warmup?: number;
  /** Active only — makes the skill an off-action reaction. */
  trigger?: SkillTrigger;
}

export type SkillTrigger = 'ally_targeted' | 'self_hit' | 'enemy_cast' | 'ally_afflicted' | 'ally_low_hp';

export const SKILL_TRIGGER_VALUES: readonly SkillTrigger[] = [
  'ally_targeted', 'self_hit', 'enemy_cast', 'ally_afflicted', 'ally_low_hp',
];

export const SKILL_TRIGGER_INFO: Record<SkillTrigger, { label: string; description: string }> = {
  ally_targeted: {
    label: 'Ally targeted',
    description: 'Fires when an enemy aims a single-target attack or spell at another ally.',
  },
  self_hit: {
    label: 'Hit by an enemy',
    description: 'Fires when an enemy attack or spell damages you.',
  },
  enemy_cast: {
    label: 'Enemy casts',
    description: 'Fires when an enemy begins casting a spell, countering it a moment later.',
  },
  ally_afflicted: {
    label: 'Ally afflicted',
    description: 'Fires while an ally is stunned or suffering a damage-over-time or weakening effect.',
  },
  ally_low_hp: {
    label: 'Ally below half health',
    description: 'Fires while an ally is below half health.',
  },
};

export type SkillCardType = 'basic' | 'action' | 'instant' | 'passive';

export const SKILL_CARD_TYPE_INFO: Record<SkillCardType, { label: string; icon: string; blurb: string }> = {
  basic: { label: 'Basic attack', icon: '🗡️', blurb: 'Always in use, whenever nothing above it is ready' },
  action: { label: 'Action', icon: '⚔️', blurb: 'Uses your turn when ready, once it would do something' },
  instant: { label: 'Instant', icon: '⚡', blurb: 'Fires on its own when something happens' },
  passive: { label: 'Passive', icon: '◆', blurb: 'Always on' },
};

const INSTANT_PASSIVE_KINDS: ReadonlySet<PassiveEffectKind> = new Set<PassiveEffectKind>([
  'stun_on_phys_hit', 'martyr', 'resurrection', 'dot_on_auto', 'overflow', 'scorch',
  'stacking_same_target', 'arcane_surge',
]);

/**
 * The skill's reaction trigger: the explicit `trigger`, else inferred from its options.
 * Inference is load-bearing — live content holds redirect/brace skills authored without a trigger.
 */
export function getSkillTrigger(skill: SkillDefinition): SkillTrigger | undefined {
  if (skill.type !== 'active') return undefined;
  if (skill.trigger) return skill.trigger;
  const effects = skill.activeEffects ?? [];
  if (effects.some(e => e.kind === 'redirect_hit')) return 'ally_targeted';
  if (effects.some(e => e.kind === 'brace_reflect')) return 'self_hit';
  return undefined;
}

/** Plays on `charge` and `recovery`, in real seconds, rather than on `cooldown`. A missing field reads as 0 when the other is set. */
export function isTimedSkill(skill: SkillDefinition): boolean {
  return typeof skill.charge === 'number' || typeof skill.recovery === 'number';
}

/** The class's basic attack in this content, if it has one. */
export function findAttackSkill(className: string, skills: Record<SkillId, SkillDefinition>): SkillDefinition | undefined {
  let found: SkillDefinition | undefined;
  for (const skill of Object.values(skills)) {
    if (skill.type !== 'attack' || skill.className !== className) continue;
    if (!found || skill.sortOrder < found.sortOrder || (skill.sortOrder === found.sortOrder && skill.id < found.id)) found = skill;
  }
  return found;
}

/** An active its owner uses as an action, which a priority list can place: never an instant. */
export function isActionSkill(skill: SkillDefinition | null | undefined): skill is SkillDefinition {
  if (!skill || skill.type !== 'active' || (skill.activeEffects?.length ?? 0) === 0) return false;
  return !getSkillTrigger(skill);
}

/** Attack skills a reset to `seed` must remove: a class holds one attack, and the seed's replaces any under another id. */
export function attackSkillsReplacedBySeed(skills: Iterable<SkillDefinition>, seed: Record<SkillId, SkillDefinition>): SkillId[] {
  const seededClasses = new Set(Object.values(seed).filter(s => s.type === 'attack').map(s => s.className));
  const replaced: SkillId[] = [];
  for (const skill of skills) {
    if (skill.type === 'attack' && seededClasses.has(skill.className) && seed[skill.id]?.type !== 'attack') replaced.push(skill.id);
  }
  return replaced;
}

/**
 * The order a player's action choice walks. Stale ids are ignored, and equipped skills the list leaves out follow
 * in slot order, above Attack unless Attack is listed. With no attack skill there is no Attack to place: autos stay the fallback.
 */
export function resolveActionOrder(
  equippedSkills: readonly (SkillDefinition | null)[],
  attack: SkillDefinition | undefined,
  actionOrder: readonly SkillId[] | undefined,
): SkillDefinition[] {
  const inSlotOrder = equippedSkills.filter(isActionSkill);
  if (!actionOrder?.length) return attack ? [...inSlotOrder, attack] : inSlotOrder;

  const unplaced = new Map(inSlotOrder.map(skill => [skill.id, skill]));
  const ordered: SkillDefinition[] = [];
  let attackPlaced = false;
  for (const id of actionOrder) {
    if (attack && id === attack.id && !attackPlaced) {
      ordered.push(attack);
      attackPlaced = true;
      continue;
    }
    const skill = unplaced.get(id);
    if (!skill) continue;
    ordered.push(skill);
    unplaced.delete(id);
  }
  ordered.push(...unplaced.values());
  if (attack && !attackPlaced) ordered.push(attack);
  return ordered;
}

export function getSkillCardType(skill: SkillDefinition): SkillCardType {
  if (skill.type === 'attack') return 'basic';
  if (skill.type === 'passive') {
    return (skill.passiveEffects ?? []).some(e => INSTANT_PASSIVE_KINDS.has(e.kind)) ? 'instant' : 'passive';
  }
  return getSkillTrigger(skill) ? 'instant' : 'action';
}

export interface SkillLoadout {
  /** Skill IDs the player has unlocked (in tree order). */
  unlockedSkills: SkillId[];
  /** Equipped skill per slot. null = empty. */
  equippedSkills: (SkillId | null)[];
  /** The player's priority list; absent = slot order, then Attack. See `resolveActionOrder`. */
  actionOrder?: SkillId[];
}

export const MAX_ACTION_ORDER_LENGTH = 32;

/**
 * Runtime skill content threaded through the pure helpers below
 * (parameterized shared functions convention). The server passes
 * ContentStore data; tests and seeds pass the SEED_* tables.
 */
export interface SkillContent {
  skills: Record<SkillId, SkillDefinition>;
  slotSchedules: Record<string, SkillSlot[]>;
}

// --- Legacy seed source (private) ---

/**
 * Pre-content skill shape: singular effect fields plus a `treeOrder` that
 * implied the unlock level. Only used by the private seed table below and by
 * `migrateLegacySkill` when loading old data.
 */
interface LegacySkillDefinition {
  id: SkillId;
  name: string;
  description: string;
  className: ClassName;
  type: SkillSlotType;
  /** Sequential position in the legacy skill tree (0, 1, 2...). */
  treeOrder: number;
  passiveEffect?: PassiveEffect;
  activeEffect?: ActiveEffect;
  charge?: number;
  recovery?: number;
  castTime?: number;
  warmup?: number;
  trigger?: SkillTrigger;
}

/** Legacy unlock cadence: treeOrder 0 → level 1, otherwise treeOrder × 5. */
const LEGACY_LEVELS_PER_SKILL = 5;

/** The historical 5-slot schedule, copied per class into SEED_SKILL_SLOT_SCHEDULES. */
const LEGACY_SLOT_SCHEDULE: SkillSlot[] = [
  { type: 'passive', unlocksAtLevel: 1 },
  { type: 'active', unlocksAtLevel: 5 },
  { type: 'passive', unlocksAtLevel: 10 },
  { type: 'passive', unlocksAtLevel: 30 },
  { type: 'passive', unlocksAtLevel: 50 },
];

/**
 * PRIVATE legacy-shaped source table — used ONLY to build SEED_SKILLS.
 * Skill ids are load-bearing (they live in player saves); never change them.
 */
const LEGACY_SKILL_TREES: Record<string, LegacySkillDefinition[]> = {
  // ===== KNIGHT (Tank) =====
  // Role: Absorb damage, draw aggro, protect the party.
  // Passives at treeOrder 0,2,4,6,8,10 — Actives at treeOrder 1,3,5,7,9
  Knight: [
    // --- Passive 1 (Lv1) ---
    {
      id: 'knight_guard',
      name: 'Guard',
      description: 'Armor that grows with your level: blocks about 50% of physical damage from enemies your level (less from stronger ones).',
      className: 'Knight',
      type: 'passive',
      treeOrder: 0,
      passiveEffect: { kind: 'physical_reduction', valuePerLevel: 2 },
    },
    // --- Active 1 (Lv5) ---
    {
      id: 'knight_bash',
      name: 'Bash',
      description: 'Strike your target with a 100% chance to stun it for 1.8 seconds. Prefers an enemy that is casting — a landed stun interrupts the spell.',
      className: 'Knight',
      type: 'active',
      treeOrder: 1,
      activeEffect: { kind: 'stun_single', stunChance: 0.50 },
      charge: 6.3,
      recovery: 0.9,
    },
    // --- Passive 2 (Lv10) ---
    {
      id: 'knight_fortify',
      name: 'Fortify',
      description: '+2% max HP per level.',
      className: 'Knight',
      type: 'passive',
      treeOrder: 2,
      passiveEffect: { kind: 'max_hp_percent', valuePerLevel: 2 },
    },
    // --- Active 2 (Lv15) ---
    {
      id: 'knight_intercept',
      name: 'Intercept',
      description: 'When an enemy aims a single-target attack at a frailer ally, jump in and take the hit instead. Saves itself for a telegraphed spell aimed at an ally.',
      className: 'Knight',
      type: 'active',
      treeOrder: 3,
      activeEffect: { kind: 'redirect_hit' },
      charge: 1.8,
      trigger: 'ally_targeted',
    },
    // --- Passive 3 (Lv20) ---
    {
      id: 'knight_shield_bash',
      name: 'Shield Bash',
      description: 'When hit by a physical attack, 10% chance to stun the attacker for 1.8 seconds.',
      className: 'Knight',
      type: 'passive',
      treeOrder: 4,
      passiveEffect: { kind: 'stun_on_phys_hit', flatValue: 0.10 },
    },
    // --- Active 3 (Lv25) ---
    {
      id: 'knight_shield_slam',
      name: 'Shield Slam',
      description: 'When a physical hit lands on you, reflect 10% of the damage taken to every enemy.',
      className: 'Knight',
      type: 'active',
      treeOrder: 5,
      activeEffect: { kind: 'brace_reflect', reflectPercent: 0.10 },
      charge: 1.8,
      trigger: 'self_hit',
    },
    // --- Passive 4 (Lv30) ---
    {
      id: 'knight_iron_will',
      name: 'Iron Will',
      description: 'Immune to stun effects — stuns are resisted as they land.',
      className: 'Knight',
      type: 'passive',
      treeOrder: 6,
      passiveEffect: { kind: 'stun_immune' },
    },
    // --- Active 4 (Lv35) ---
    {
      id: 'knight_sunder',
      name: 'Sunder',
      description: 'Deal normal damage and mark the target — marked enemies take 50% increased damage from attacks (up to 75%, on a second use).',
      className: 'Knight',
      type: 'active',
      treeOrder: 7,
      activeEffect: { kind: 'stacking_mark', markMultiplier: 0.25 },
      charge: 9,
      recovery: 0.9,
      warmup: 1.8,
    },
    // --- Passive 5 (Lv40) ---
    {
      id: 'knight_tenacity',
      name: 'Tenacity',
      description: 'All healing received increased by 30%.',
      className: 'Knight',
      type: 'passive',
      treeOrder: 8,
      passiveEffect: { kind: 'healing_received_bonus', flatValue: 0.30 },
    },
    // --- Active 5 (Lv45) ---
    {
      id: 'knight_dispel',
      name: 'Dispel',
      description: 'When an enemy begins casting, strike the caster, strip its buffs and counter the spell.',
      className: 'Knight',
      type: 'active',
      treeOrder: 9,
      activeEffect: { kind: 'remove_buffs' },
      charge: 9.9,
      trigger: 'enemy_cast',
    },
    // --- Passive 6 (Lv50) ---
    {
      id: 'knight_war_cry',
      name: 'War Cry',
      description: 'While below 50% HP, all Archers in the party deal 25% more damage.',
      className: 'Knight',
      type: 'passive',
      treeOrder: 10,
      passiveEffect: { kind: 'conditional_ally_damage', targetClass: 'Archer', flatValue: 0.25, hpThreshold: 0.50 },
    },
  ],

  // ===== ARCHER (Physical DPS) =====
  // Role: High physical damage, target priority, crit-based burst. Glass cannon.
  Archer: [
    // --- Passive 1 (Lv1) ---
    {
      id: 'archer_pierce',
      name: 'Pierce',
      description: '20% chance to deal a critical hit (2x damage).',
      className: 'Archer',
      type: 'passive',
      treeOrder: 0,
      passiveEffect: { kind: 'crit_chance', flatValue: 0.20 },
    },
    // --- Active 1 (Lv5) ---
    {
      id: 'archer_cut_down',
      name: 'Cut Down',
      description: 'Strike the enemy with the lowest HP.',
      className: 'Archer',
      type: 'active',
      treeOrder: 1,
      activeEffect: { kind: 'target_lowest_hp' },
      charge: 4.4,
      recovery: 1.6,
    },
    // --- Passive 2 (Lv10) ---
    {
      id: 'archer_marksman',
      name: 'Marksman',
      description: '+15% damage against targets above 75% HP.',
      className: 'Archer',
      type: 'passive',
      treeOrder: 2,
      passiveEffect: { kind: 'conditional_damage_bonus', flatValue: 0.15, condition: 'target_above_75_hp' },
    },
    // --- Active 2 (Lv15) ---
    {
      id: 'archer_triple_shot',
      name: 'Triple Shot',
      description: 'Fire at 3 random enemies for 50% damage each.',
      className: 'Archer',
      type: 'active',
      treeOrder: 3,
      activeEffect: { kind: 'multi_hit_random', hitCount: 3, damagePercent: 0.50, isAoe: true },
      charge: 6.4,
      recovery: 1.6,
    },
    // --- Passive 3 (Lv20) ---
    {
      id: 'archer_brave',
      name: 'Brave',
      description: '+25% damage when positioned in the front column.',
      className: 'Archer',
      type: 'passive',
      treeOrder: 4,
      passiveEffect: { kind: 'conditional_damage_bonus', flatValue: 0.25, condition: 'front_column' },
    },
    // --- Active 3 (Lv25) ---
    {
      id: 'archer_snipe',
      name: 'Snipe',
      description: 'Take aim for 2 seconds, then deal 200% damage to a single target, ignoring damage reduction.',
      className: 'Archer',
      type: 'active',
      treeOrder: 5,
      activeEffect: { kind: 'ignore_dr_single', damagePercent: 2.00 },
      charge: 8,
      recovery: 2,
      castTime: 1.0,
    },
    // --- Passive 4 (Lv30) ---
    {
      id: 'archer_exploit_weakness',
      name: 'Exploit Weakness',
      description: '+30% damage against bleeding or stunned targets.',
      className: 'Archer',
      type: 'passive',
      treeOrder: 6,
      passiveEffect: { kind: 'conditional_damage_bonus', flatValue: 0.30, condition: 'target_bleeding_or_stunned' },
    },
    // --- Active 4 (Lv35) ---
    {
      id: 'archer_bleed',
      name: 'Bleed',
      description: 'Deal normal damage and apply a bleed — 20% of the damage dealt over 5.4 seconds (stacks).',
      className: 'Archer',
      type: 'active',
      treeOrder: 7,
      activeEffect: { kind: 'dot_attack', dotPercent: 0.20, dotTicks: 3 },
      charge: 4.4,
      recovery: 1.6,
    },
    // --- Passive 5 (Lv40) ---
    {
      id: 'archer_precision',
      name: 'Precision',
      description: '+100% critical damage.',
      className: 'Archer',
      type: 'passive',
      treeOrder: 8,
      passiveEffect: { kind: 'crit_damage_bonus', flatValue: 1.00 },
    },
    // --- Active 5 (Lv45) ---
    {
      id: 'archer_crippling_shot',
      name: 'Crippling Shot',
      description: 'Deal normal damage and reduce the target\'s damage by 30% for 6 seconds.',
      className: 'Archer',
      type: 'active',
      treeOrder: 9,
      activeEffect: { kind: 'debuff_attack', debuffPercent: 0.30, debuffDuration: 3 },
      charge: 4.4,
      recovery: 1.6,
    },
    // --- Passive 6 (Lv50) ---
    {
      id: 'archer_focus',
      name: 'Focus',
      description: '+10% damage per consecutive attack on the same target (resets on switch).',
      className: 'Archer',
      type: 'passive',
      treeOrder: 10,
      passiveEffect: { kind: 'stacking_same_target', flatValue: 0.10 },
    },
  ],

  // ===== PRIEST (Healer / Holy Protector) =====
  // Role: Keep the party alive, reduce magic damage, deal holy damage.
  Priest: [
    // --- Passive 1 (Lv1) ---
    {
      id: 'priest_bless',
      name: 'Bless',
      description: 'Wards the whole party: blocks about 50% of magical and holy damage from enemies your level. Only the strongest Bless in the party counts.',
      className: 'Priest',
      type: 'passive',
      treeOrder: 0,
      passiveEffect: { kind: 'magical_reduction_party', valuePerLevel: 2 },
    },
    // --- Active 1 (Lv5) ---
    {
      id: 'priest_minor_heal',
      name: 'Minor Heal',
      description: 'Heal the most wounded ally for level × 4 HP. Held until an ally needs it.',
      className: 'Priest',
      type: 'active',
      treeOrder: 1,
      activeEffect: { kind: 'heal_lowest', healMultiplier: 4 },
      charge: 0.9,
      recovery: 0.9,
    },
    // --- Passive 2 (Lv10) ---
    {
      id: 'priest_devotion',
      name: 'Devotion',
      description: '+3% healing power per level.',
      className: 'Priest',
      type: 'passive',
      treeOrder: 2,
      passiveEffect: { kind: 'heal_power', valuePerLevel: 3 },
    },
    // --- Active 2 (Lv15) ---
    {
      id: 'priest_smite',
      name: 'Smite',
      description: 'Deal normal damage plus level × 3 bonus holy damage to undead.',
      className: 'Priest',
      type: 'active',
      treeOrder: 3,
      activeEffect: { kind: 'smite', holyMultiplier: 3 },
      charge: 2.7,
      recovery: 0.9,
    },
    // --- Passive 3 (Lv20) ---
    {
      id: 'priest_blessed_arms',
      name: 'Blessed Arms',
      description: 'All party members\' attacks deal +1 to +2 holy damage per Priest level, by class.',
      className: 'Priest',
      type: 'passive',
      treeOrder: 4,
      passiveEffect: { kind: 'holy_damage_party', valuePerLevel: 1 },
    },
    // --- Active 3 (Lv25) ---
    {
      id: 'priest_cure',
      name: 'Cure',
      description: 'When an ally is stunned or afflicted, remove their stuns, damage-over-time and debuffs.',
      className: 'Priest',
      type: 'active',
      treeOrder: 5,
      activeEffect: { kind: 'cure_debuffs' },
      charge: 5.4,
      trigger: 'ally_afflicted',
    },
    // --- Passive 4 (Lv30) ---
    {
      id: 'priest_consecrate',
      name: 'Consecrate',
      description: 'Undead killed by any party member stay dead.',
      className: 'Priest',
      type: 'passive',
      treeOrder: 6,
      passiveEffect: { kind: 'consecrate' },
    },
    // --- Active 4 (Lv35) ---
    {
      id: 'priest_mending',
      name: 'Mending',
      description: 'When an ally drops below half health, heal them for level × 2 HP every 1.8 seconds for 5.4 seconds.',
      className: 'Priest',
      type: 'active',
      treeOrder: 7,
      activeEffect: { kind: 'hot_lowest', healMultiplier: 2, dotTicks: 3 },
      charge: 7.2,
      trigger: 'ally_low_hp',
    },
    // --- Passive 5 (Lv40) ---
    {
      id: 'priest_martyr',
      name: 'Martyr',
      description: 'When the Knight takes damage, the Priest\'s next heal is 25% stronger.',
      className: 'Priest',
      type: 'passive',
      treeOrder: 8,
      passiveEffect: { kind: 'martyr', flatValue: 0.25 },
    },
    // --- Active 5 (Lv45) ---
    {
      id: 'priest_sanctuary',
      name: 'Sanctuary',
      description: 'Shield the most wounded unshielded non-Knight ally, absorbing up to level × 4 incoming damage.',
      className: 'Priest',
      type: 'active',
      treeOrder: 9,
      activeEffect: { kind: 'shield_non_knight', shieldMultiplier: 4 },
      charge: 0.9,
      recovery: 0.9,
    },
    // --- Passive 6 (Lv50) ---
    {
      id: 'priest_resurrection',
      name: 'Resurrection',
      description: 'Once per battle, when an ally would die, they revive at 20% HP.',
      className: 'Priest',
      type: 'passive',
      treeOrder: 10,
      passiveEffect: { kind: 'resurrection', flatValue: 0.20 },
    },
  ],

  // ===== MAGE (Magical DPS) =====
  // Role: High magical damage, AoE potential. Glass cannon.
  Mage: [
    // --- Passive 1 (Lv1) ---
    {
      id: 'mage_burn',
      name: 'Burn',
      description: '+2.8 magical damage per level.',
      className: 'Mage',
      type: 'passive',
      treeOrder: 0,
      passiveEffect: { kind: 'bonus_damage', valuePerLevel: 2 },
    },
    // --- Active 1 (Lv5) ---
    {
      id: 'mage_magic_missile',
      name: 'Magic Missile',
      description: '4 hits at 30% damage each.',
      className: 'Mage',
      type: 'active',
      treeOrder: 1,
      activeEffect: { kind: 'multi_hit', hitCount: 4, damagePercent: 0.30 },
      charge: 7,
      recovery: 0.5,
    },
    // --- Passive 2 (Lv10) ---
    {
      id: 'mage_intensify',
      name: 'Intensify',
      description: 'Auto-attack damage reduced by 50%, but active skill damage increased by 50%.',
      className: 'Mage',
      type: 'passive',
      treeOrder: 2,
      passiveEffect: { kind: 'intensify', flatValue: 0.50 },
    },
    // --- Active 2 (Lv15) ---
    {
      id: 'mage_zap',
      name: 'Zap',
      description: 'Deal 75% damage to a single target.',
      className: 'Mage',
      type: 'active',
      treeOrder: 3,
      activeEffect: { kind: 'damage_percent', damagePercent: 0.75 },
      charge: 2,
      recovery: 0.5,
    },
    // --- Passive 3 (Lv20) ---
    {
      id: 'mage_ignite',
      name: 'Ignite',
      description: 'Normal attacks add a permanent burn stack equal to 25% of pre-resistance damage. Stacks up to 6 times for the rest of combat.',
      className: 'Mage',
      type: 'passive',
      treeOrder: 4,
      passiveEffect: { kind: 'dot_on_auto', dotPercent: 0.25 },
    },
    // --- Active 3 (Lv25) ---
    {
      id: 'mage_blizzard',
      name: 'Blizzard',
      description: 'Channel for 3.8 seconds, then deal 100% damage to all enemies.',
      className: 'Mage',
      type: 'active',
      treeOrder: 5,
      activeEffect: { kind: 'damage_aoe_all', damagePercent: 1.00, isAoe: true },
      charge: 14,
      recovery: 1,
      castTime: 1.5,
    },
    // --- Passive 4 (Lv30) ---
    {
      id: 'mage_arcane_surge',
      name: 'Arcane Surge',
      description: 'Every second active skill cast deals double damage.',
      className: 'Mage',
      type: 'passive',
      treeOrder: 6,
      passiveEffect: { kind: 'arcane_surge' },
    },
    // --- Active 4 (Lv35) ---
    {
      id: 'mage_chain_lightning',
      name: 'Chain Lightning',
      description: 'Deal 10% damage to all enemies.',
      className: 'Mage',
      type: 'active',
      treeOrder: 7,
      activeEffect: { kind: 'damage_aoe_all', damagePercent: 0.10, isAoe: true },
      charge: 2,
      recovery: 0.5,
    },
    // --- Passive 5 (Lv40) ---
    {
      id: 'mage_overflow',
      name: 'Overflow',
      description: 'Overkill damage on single-target hits splashes to a random enemy.',
      className: 'Mage',
      type: 'passive',
      treeOrder: 8,
      passiveEffect: { kind: 'overflow' },
    },
    // --- Active 5 (Lv45) ---
    {
      id: 'mage_arcane_blast',
      name: 'Arcane Blast',
      description: 'Channel for 2.5 seconds, then deal 250% damage to a single target.',
      className: 'Mage',
      type: 'active',
      treeOrder: 9,
      activeEffect: { kind: 'high_damage_single', damagePercent: 2.50 },
      charge: 11.5,
      recovery: 1,
      castTime: 1.0,
    },
    // --- Passive 6 (Lv50) ---
    {
      id: 'mage_scorch',
      name: 'Scorch',
      description: 'Enemies damaged by the Mage take +10% magical damage from all sources for 5 s.',
      className: 'Mage',
      type: 'passive',
      treeOrder: 10,
      passiveEffect: { kind: 'scorch', flatValue: 0.10 },
    },
  ],

  // ===== BARD (Support) =====
  // Role: Buff the party, disrupt enemies, make everyone better.
  Bard: [
    // --- Passive 1 (Lv1) ---
    {
      id: 'bard_rally',
      name: 'Rally',
      description: '+20% damage to the whole party for each player in the party.',
      className: 'Bard',
      type: 'passive',
      treeOrder: 0,
      passiveEffect: { kind: 'party_damage_mult', flatValue: 0.20, perPartyMember: true },
    },
    // --- Active 1 (Lv5) ---
    {
      id: 'bard_dissonance',
      name: 'Dissonance',
      description: 'Deal 0.28 damage per level, rounded down (at least 1), to all enemies.',
      className: 'Bard',
      type: 'active',
      treeOrder: 1,
      activeEffect: { kind: 'damage_aoe_all', damagePerLevel: 0.2, isAoe: true },
      charge: 6.8,
      recovery: 0.7,
    },
    // --- Passive 2 (Lv10) ---
    {
      id: 'bard_tempo',
      name: 'Tempo',
      description: 'Your skills charge 1.8 s faster (at least a 1.8 s cycle). Attack, recovery and skills that counter enemy spells are unaffected.',
      className: 'Bard',
      type: 'passive',
      treeOrder: 2,
      passiveEffect: { kind: 'cooldown_reduction', flatValue: 1 },
    },
    // --- Active 2 (Lv15) ---
    {
      id: 'bard_drumroll',
      name: 'Drumroll',
      description: 'When an enemy begins casting, counter the spell and roll a 25% chance to stun each enemy for 1.8 seconds.',
      className: 'Bard',
      type: 'active',
      treeOrder: 3,
      activeEffect: { kind: 'stun_aoe', stunChance: 0.25 },
      charge: 7.2,
      trigger: 'enemy_cast',
    },
    // --- Passive 3 (Lv20) ---
    {
      id: 'bard_nimble',
      name: 'Nimble',
      description: '+3% dodge chance for each party member (party-wide).',
      className: 'Bard',
      type: 'passive',
      treeOrder: 4,
      passiveEffect: { kind: 'dodge_party', flatValue: 0.03, perPartyMember: true },
    },
    // --- Active 3 (Lv25) ---
    {
      id: 'bard_war_song',
      name: 'War Song',
      description: 'Increase party damage by 14% for the rest of combat (stacks up to 50%). Ready as a fight begins.',
      className: 'Bard',
      type: 'active',
      treeOrder: 5,
      activeEffect: { kind: 'party_buff_permanent', buffPercent: 0.10 },
      charge: 9.3,
      recovery: 0.7,
      warmup: 0,
    },
    // --- Passive 4 (Lv30) ---
    {
      id: 'bard_inspiration',
      name: 'Inspiration',
      description: '+20% XP rate for the whole party.',
      className: 'Bard',
      type: 'passive',
      treeOrder: 6,
      passiveEffect: { kind: 'xp_bonus', flatValue: 0.20 },
    },
    // --- Active 4 (Lv35) ---
    {
      id: 'bard_lullaby',
      name: 'Lullaby',
      description: 'All enemies deal 20% less damage for 7.6 seconds.',
      className: 'Bard',
      type: 'active',
      treeOrder: 7,
      activeEffect: { kind: 'enemy_debuff_aoe', debuffPercent: 0.20, debuffDuration: 3 },
      charge: 11.8,
      recovery: 0.7,
    },
    // --- Passive 5 (Lv40) ---
    {
      id: 'bard_unnerve',
      name: 'Unnerve',
      description: 'Reduce enemy damage by 5% per party member.',
      className: 'Bard',
      type: 'passive',
      treeOrder: 8,
      passiveEffect: { kind: 'enemy_damage_reduction_party', flatValue: 0.05, perPartyMember: true },
    },
    // --- Active 5 (Lv45) ---
    {
      id: 'bard_chaos',
      name: 'Chaos',
      description: 'Each enemy\'s next action hits a random enemy (possibly itself) instead of the party.',
      className: 'Bard',
      type: 'active',
      treeOrder: 9,
      activeEffect: { kind: 'chaos' },
      charge: 14.3,
      recovery: 0.7,
    },
    // --- Passive 6 (Lv50) ---
    {
      id: 'bard_encore',
      name: 'Encore',
      description: 'Every party member\'s skills charge 1.8 s faster (stacks with Tempo for the Bard, at least a 1.8 s cycle). Attack, recovery and skills that counter enemy spells are unaffected.',
      className: 'Bard',
      type: 'passive',
      treeOrder: 10,
      passiveEffect: { kind: 'cooldown_reduction', flatValue: 1, partyWide: true },
    },
  ],
};

// --- Seed content ---

const SEED_ATTACK_SORT_ORDER = -1;

const SEED_ATTACKS: Record<ClassName, Pick<SkillDefinition, 'description' | 'charge' | 'recovery'>> = {
  Knight: { description: 'Your basic attack: strike your target. You can use another skill straight after it.', charge: 3.6, recovery: 0 },
  Archer: { description: 'Your basic attack: loose an arrow at your target. Quick to draw, slow to recover from.', charge: 0.4, recovery: 1.6 },
  Priest: { description: 'Your basic attack: strike your target.', charge: 1.4, recovery: 0.4 },
  Mage: { description: 'Your basic attack: hurl a bolt of magic at your target. Slow to gather, quick to recover from.', charge: 2, recovery: 0.5 },
  Bard: { description: 'Your basic attack: strike your target.', charge: 1.8, recovery: 0.7 },
};

function buildSeedSkills(): Record<SkillId, SkillDefinition> {
  const skills: Record<SkillId, SkillDefinition> = {};
  for (const [className, attack] of Object.entries(SEED_ATTACKS) as [ClassName, typeof SEED_ATTACKS[ClassName]][]) {
    const id = `${className.toLowerCase()}_attack`;
    skills[id] = { id, name: 'Attack', className, type: 'attack', unlockLevel: 1, sortOrder: SEED_ATTACK_SORT_ORDER, ...attack };
  }
  for (const tree of Object.values(LEGACY_SKILL_TREES)) {
    for (const legacy of tree) {
      skills[legacy.id] = migrateLegacySkill(legacy);
    }
  }
  return skills;
}

/** Seed skill catalog — the historical 55-skill table converted to the content shape, plus one Attack per class. Ids preserved verbatim (saves depend on them). */
export const SEED_SKILLS: Record<SkillId, SkillDefinition> = buildSeedSkills();

/** Seed per-class slot schedules — today's 5-slot schedule copied per class. */
export const SEED_SKILL_SLOT_SCHEDULES: Record<ClassName, SkillSlot[]> = {
  Knight: LEGACY_SLOT_SCHEDULE.map(s => ({ ...s })),
  Archer: LEGACY_SLOT_SCHEDULE.map(s => ({ ...s })),
  Priest: LEGACY_SLOT_SCHEDULE.map(s => ({ ...s })),
  Mage: LEGACY_SLOT_SCHEDULE.map(s => ({ ...s })),
  Bard: LEGACY_SLOT_SCHEDULE.map(s => ({ ...s })),
};

// --- Pure functions ---

/**
 * Migrate a legacy skill shape (`treeOrder` + singular `passiveEffect`/`activeEffect`)
 * to the content shape (`unlockLevel`/`sortOrder` + effect arrays). Already-migrated
 * skills pass through as a normalized copy. Legacy unlock levels follow the historical
 * formula: treeOrder 0 → level 1, otherwise treeOrder × 5.
 */
export function migrateLegacySkill(
  skill: SkillDefinition | (Omit<SkillDefinition, 'unlockLevel' | 'sortOrder'> & {
    treeOrder?: number;
    unlockLevel?: number | null;
    sortOrder?: number;
    passiveEffect?: PassiveEffect;
    activeEffect?: ActiveEffect;
  }),
): SkillDefinition {
  const raw = skill as {
    id: SkillId; name: string; description: string; className: ClassName; type: SkillType;
    treeOrder?: number; unlockLevel?: number | null; sortOrder?: number;
    passiveEffect?: PassiveEffect; activeEffect?: ActiveEffect;
    passiveEffects?: PassiveEffect[]; activeEffects?: ActiveEffect[];
    cooldown?: number; charge?: number; recovery?: number; castTime?: number; warmup?: number; trigger?: SkillTrigger;
  };

  const unlockLevel = raw.unlockLevel !== undefined
    ? raw.unlockLevel
    : raw.treeOrder === undefined
      ? 1
      : raw.treeOrder === 0 ? 1 : raw.treeOrder * LEGACY_LEVELS_PER_SKILL;
  const sortOrder = raw.sortOrder ?? raw.treeOrder ?? 0;

  const passiveEffects = raw.passiveEffects
    ? raw.passiveEffects.map(e => ({ ...e }))
    : raw.passiveEffect ? [{ ...raw.passiveEffect }] : undefined;
  const activeEffects = raw.activeEffects
    ? raw.activeEffects.map(e => ({ ...e }))
    : raw.activeEffect ? [{ ...raw.activeEffect }] : undefined;

  const migrated: SkillDefinition = {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    className: raw.className,
    type: raw.type,
    unlockLevel,
    sortOrder,
  };
  if (passiveEffects && passiveEffects.length > 0) migrated.passiveEffects = passiveEffects;
  if (activeEffects && activeEffects.length > 0) migrated.activeEffects = activeEffects;
  if (raw.cooldown !== undefined) migrated.cooldown = raw.cooldown;
  if (raw.charge !== undefined) migrated.charge = raw.charge;
  if (raw.recovery !== undefined) migrated.recovery = raw.recovery;
  if (raw.castTime !== undefined) migrated.castTime = raw.castTime;
  if (raw.warmup !== undefined) migrated.warmup = raw.warmup;
  if (raw.trigger !== undefined) migrated.trigger = raw.trigger;
  return migrated;
}

/** Look up a skill definition by ID. */
export function getSkillById(skillId: SkillId, content: SkillContent): SkillDefinition | undefined {
  return content.skills[skillId];
}

/** Get all skills in a class's tree, sorted by sortOrder. */
export function getSkillsForClass(className: ClassName, content: SkillContent): SkillDefinition[] {
  return Object.values(content.skills)
    .filter(s => s.className === className)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/** Get all skill IDs that should be unlocked for a class at a given level (auto-unlock). Grant-only skills (unlockLevel null) are never included. */
export function getUnlockedSkillsForLevel(className: ClassName, level: number, content: SkillContent): SkillId[] {
  return getSkillsForClass(className, content)
    .filter(s => s.unlockLevel !== null && level >= s.unlockLevel)
    .map(s => s.id);
}

/** Get the slot schedule for a class, falling back to the seed schedule when the class has none in content. */
export function getSlotSchedule(className: ClassName, content: SkillContent): SkillSlot[] {
  const schedule = content.slotSchedules[className];
  if (schedule && schedule.length > 0) return schedule;
  return SEED_SKILL_SLOT_SCHEDULES[className] ?? [];
}

/**
 * Check if a skill can be equipped in a given slot.
 * A skill is available when it belongs to the player's class AND is unlocked,
 * OR when it is granted by equipped items/sets (`grantedSkillIds` — may be cross-class).
 */
export function canEquipSkill(
  skillId: SkillId,
  slotIndex: number,
  className: ClassName,
  level: number,
  unlockedSkills: SkillId[],
  grantedSkillIds: SkillId[],
  content: SkillContent,
): boolean {
  const schedule = getSlotSchedule(className, content);
  if (slotIndex < 0 || slotIndex >= schedule.length) return false;

  const slot = schedule[slotIndex];
  if (level < slot.unlocksAtLevel) return false;

  const skill = content.skills[skillId];
  if (!skill) return false;

  const availableFromClass = skill.className === className && unlockedSkills.includes(skillId);
  const availableFromGrant = grantedSkillIds.includes(skillId);
  if (!availableFromClass && !availableFromGrant) return false;

  return skill.type === slot.type;
}

/** Equip a skill in a slot. Returns updated equippedSkills, or null if invalid. */
export function equipSkillInSlot(
  skillId: SkillId,
  slotIndex: number,
  className: ClassName,
  level: number,
  loadout: SkillLoadout,
  grantedSkillIds: SkillId[],
  content: SkillContent,
): (SkillId | null)[] | null {
  if (!canEquipSkill(skillId, slotIndex, className, level, loadout.unlockedSkills, grantedSkillIds, content)) return null;

  const newEquipped = [...loadout.equippedSkills];
  // Unequip from any other slot first
  for (let i = 0; i < newEquipped.length; i++) {
    if (newEquipped[i] === skillId) newEquipped[i] = null;
  }
  newEquipped[slotIndex] = skillId;
  return newEquipped;
}

/** Unequip a skill from a slot. Returns updated equippedSkills. */
export function unequipSkillFromSlot(
  slotIndex: number,
  equippedSkills: (SkillId | null)[],
): (SkillId | null)[] {
  if (slotIndex < 0 || slotIndex >= equippedSkills.length) return equippedSkills;
  const newEquipped = [...equippedSkills];
  newEquipped[slotIndex] = null;
  return newEquipped;
}

/**
 * Create the default skill loadout for a class: its level-1 passive (tie broken
 * by sortOrder, grant-only skills excluded) unlocked and equipped in the first
 * passive slot. If no passive unlocks at level 1, the loadout starts fully empty
 * (matches what `reconcileSkillLoadout` would immediately reduce it to for a
 * level-1 character, since nothing is unlocked yet). Slot count comes from the
 * class schedule.
 */
export function createDefaultSkillLoadout(className: ClassName, content: SkillContent): SkillLoadout {
  const schedule = getSlotSchedule(className, content);
  const emptySlots: (SkillId | null)[] = schedule.map(() => null);

  const starting = getSkillsForClass(className, content)
    .filter(s => s.type === 'passive' && s.unlockLevel !== null && s.unlockLevel <= 1)
    .sort((a, b) => (a.unlockLevel ?? 0) - (b.unlockLevel ?? 0) || a.sortOrder - b.sortOrder)[0];
  if (!starting) {
    return { unlockedSkills: [], equippedSkills: emptySlots };
  }

  const equipped = [...emptySlots];
  const slotIndex = schedule.findIndex(slot => slot.type === 'passive');
  if (slotIndex >= 0) equipped[slotIndex] = starting.id;

  return {
    unlockedSkills: [starting.id],
    equippedSkills: equipped,
  };
}

/**
 * Reconcile a saved loadout against current content: pads or TRUNCATES
 * equippedSkills to the class schedule length, and nulls any entry whose skill
 * is missing from content, type-mismatches its slot, or is no longer available
 * (not unlocked for the class at this level and not granted by equipment).
 * Never throws; unlockedSkills passes through untouched (it is recomputed by
 * the server's autoUnlockSkills).
 */
export function reconcileSkillLoadout(
  loadout: SkillLoadout,
  className: ClassName,
  level: number,
  grantedSkillIds: SkillId[],
  content: SkillContent,
): SkillLoadout {
  const schedule = getSlotSchedule(className, content);
  const prior = loadout.equippedSkills ?? [];
  const unlockedForLevel = new Set(getUnlockedSkillsForLevel(className, level, content));
  const granted = new Set(grantedSkillIds);

  const equipped: (SkillId | null)[] = [];
  for (let i = 0; i < schedule.length; i++) {
    const skillId = prior[i] ?? null;
    if (!skillId) {
      equipped.push(null);
      continue;
    }
    const skill = content.skills[skillId];
    if (!skill || skill.type !== schedule[i].type) {
      equipped.push(null);
      continue;
    }
    if (level < schedule[i].unlocksAtLevel) {
      equipped.push(null);
      continue;
    }
    const available = (skill.className === className && unlockedForLevel.has(skillId)) || granted.has(skillId);
    equipped.push(available ? skillId : null);
  }

  const reconciled: SkillLoadout = {
    unlockedSkills: [...(loadout.unlockedSkills ?? [])],
    equippedSkills: equipped,
  };
  const actionOrder = loadout.actionOrder?.filter(id => content.skills[id]);
  if (actionOrder?.length) reconciled.actionOrder = actionOrder;
  return reconciled;
}
