import type { ClassName } from './CharacterStats.js';

// --- Types ---

export type SkillSlotType = 'passive' | 'active';
export type SkillId = string;

export interface SkillSlot {
  type: SkillSlotType;
  unlocksAtLevel: number;
}

export type PassiveEffectKind =
  | 'physical_reduction'     // Knight Guard: flat physical DR per level
  | 'party_damage_mult'      // Bard Rally: +% damage per party member (all types)
  | 'magical_reduction_party' // Priest Bless: flat magical/holy DR party-wide per level
  | 'crit_chance'            // Archer Pierce: % chance to crit (2x damage)
  | 'bonus_damage';          // Mage Burn: flat damage per level

export interface PassiveEffect {
  kind: PassiveEffectKind;
  /** Per-level scaling value (e.g., +2 reduction per level). */
  valuePerLevel?: number;
  /** Flat value (e.g., 0.20 = 20% crit chance). */
  flatValue?: number;
  /** If true, effect scales per party member (Bard Rally). */
  perPartyMember?: boolean;
}

export type ActiveEffectKind =
  | 'stun_single'    // Knight Bash: chance to stun single target
  | 'stun_aoe'       // Bard Drumroll: chance to stun each enemy
  | 'heal_lowest'    // Priest Minor Heal: heal lowest % HP ally
  | 'multi_hit'      // Mage Magic Missile: multiple hits at % damage
  | 'target_lowest_hp'; // Archer Cut Down: target lowest HP enemy

export interface ActiveEffect {
  kind: ActiveEffectKind;
  /** Chance to stun (0-1). */
  stunChance?: number;
  /** Heal = level * healMultiplier. */
  healMultiplier?: number;
  /** Number of hits for multi_hit. */
  hitCount?: number;
  /** Damage percentage per hit for multi_hit (0.30 = 30%). */
  damagePercent?: number;
}

export interface SkillDefinition {
  id: SkillId;
  name: string;
  description: string;
  className: ClassName;
  type: SkillSlotType;
  /** Sequential position in the skill tree (0, 1, 2...). */
  treeOrder: number;
  passiveEffect?: PassiveEffect;
  activeEffect?: ActiveEffect;
  /** Cooldown for actives: triggers every Nth attack. */
  cooldown?: number;
}

export interface SkillLoadout {
  /** Skill IDs the player has unlocked (in tree order). */
  unlockedSkills: SkillId[];
  /** Equipped skill per slot (indexed by slot: 0=passive1, 1=active, 2=passive2). null = empty. */
  equippedSkills: (SkillId | null)[];
}

// --- Constants ---

export const SKILL_SLOTS: SkillSlot[] = [
  { type: 'passive', unlocksAtLevel: 1 },
  { type: 'active', unlocksAtLevel: 5 },
  { type: 'passive', unlocksAtLevel: 10 },
];

/** Skill points are earned every N levels. */
export const LEVELS_PER_SKILL_POINT = 5;

export const SKILL_TREES: Record<string, SkillDefinition[]> = {
  Knight: [
    {
      id: 'knight_guard',
      name: 'Guard',
      description: 'Gains 2 physical damage reduction per level.',
      className: 'Knight',
      type: 'passive',
      treeOrder: 0,
      passiveEffect: { kind: 'physical_reduction', valuePerLevel: 2 },
    },
    {
      id: 'knight_bash',
      name: 'Bash',
      description: '50% chance to stun target for one round.',
      className: 'Knight',
      type: 'active',
      treeOrder: 1,
      activeEffect: { kind: 'stun_single', stunChance: 0.50 },
      cooldown: 2,
    },
  ],
  Archer: [
    {
      id: 'archer_pierce',
      name: 'Pierce',
      description: '20% chance to deal a critical hit (100% increased damage).',
      className: 'Archer',
      type: 'passive',
      treeOrder: 0,
      passiveEffect: { kind: 'crit_chance', flatValue: 0.20 },
    },
    {
      id: 'archer_cut_down',
      name: 'Cut Down',
      description: 'Targets the lowest HP enemy.',
      className: 'Archer',
      type: 'active',
      treeOrder: 1,
      activeEffect: { kind: 'target_lowest_hp' },
      cooldown: 3,
    },
  ],
  Priest: [
    {
      id: 'priest_bless',
      name: 'Bless',
      description: 'Gains 2 magical damage reduction for the whole party per level.',
      className: 'Priest',
      type: 'passive',
      treeOrder: 0,
      passiveEffect: { kind: 'magical_reduction_party', valuePerLevel: 2 },
    },
    {
      id: 'priest_minor_heal',
      name: 'Minor Heal',
      description: 'Heals the lowest percent health ally for level × 4 HP.',
      className: 'Priest',
      type: 'active',
      treeOrder: 1,
      activeEffect: { kind: 'heal_lowest', healMultiplier: 4 },
      cooldown: 1,
    },
  ],
  Mage: [
    {
      id: 'mage_burn',
      name: 'Burn',
      description: 'Increases damage by 2 per level.',
      className: 'Mage',
      type: 'passive',
      treeOrder: 0,
      passiveEffect: { kind: 'bonus_damage', valuePerLevel: 2 },
    },
    {
      id: 'mage_magic_missile',
      name: 'Magic Missile',
      description: 'Deals 30% damage, 4 times.',
      className: 'Mage',
      type: 'active',
      treeOrder: 1,
      activeEffect: { kind: 'multi_hit', hitCount: 4, damagePercent: 0.30 },
      cooldown: 3,
    },
  ],
  Bard: [
    {
      id: 'bard_rally',
      name: 'Rally',
      description: '+20% damage to the whole party for each player in the party.',
      className: 'Bard',
      type: 'passive',
      treeOrder: 0,
      passiveEffect: { kind: 'party_damage_mult', flatValue: 0.20, perPartyMember: true },
    },
    {
      id: 'bard_drumroll',
      name: 'Drumroll',
      description: '10% chance per enemy to stun for one round.',
      className: 'Bard',
      type: 'active',
      treeOrder: 1,
      activeEffect: { kind: 'stun_aoe', stunChance: 0.10 },
      cooldown: 3,
    },
  ],
};

// --- Pure functions ---

/** Get skill points earned by a given level (1 per 5 levels). */
export function getSkillPointsForLevel(level: number): number {
  return Math.floor(level / LEVELS_PER_SKILL_POINT);
}

/** Get available (unspent) skill points. First passive is free, rest cost 1 each. */
export function getAvailableSkillPoints(level: number, unlockedSkills: SkillId[]): number {
  const totalEarned = getSkillPointsForLevel(level);
  // First skill is free, so spent = max(0, unlocked - 1)
  const spent = Math.max(0, unlockedSkills.length - 1);
  return Math.max(0, totalEarned - spent);
}

/** Check if a skill can be unlocked: correct class, sequential order, has points. */
export function canUnlockSkill(
  skillId: SkillId,
  className: ClassName,
  level: number,
  unlockedSkills: SkillId[],
): boolean {
  const tree = SKILL_TREES[className];
  if (!tree) return false;

  const skill = tree.find(s => s.id === skillId);
  if (!skill) return false;

  // Already unlocked
  if (unlockedSkills.includes(skillId)) return false;

  // Must unlock in tree order — all prior skills must be unlocked
  for (const s of tree) {
    if (s.treeOrder < skill.treeOrder && !unlockedSkills.includes(s.id)) {
      return false;
    }
  }

  // Must have available skill points (first skill is free)
  const availablePoints = getAvailableSkillPoints(level, unlockedSkills);
  const cost = skill.treeOrder === 0 ? 0 : 1;
  return availablePoints >= cost;
}

/** Unlock a skill. Returns updated unlockedSkills, or null if invalid. */
export function unlockSkill(
  skillId: SkillId,
  className: ClassName,
  level: number,
  unlockedSkills: SkillId[],
): SkillId[] | null {
  if (!canUnlockSkill(skillId, className, level, unlockedSkills)) return null;
  return [...unlockedSkills, skillId];
}

/** Check if a skill can be equipped in a given slot. */
export function canEquipSkill(
  skillId: SkillId,
  slotIndex: number,
  className: ClassName,
  level: number,
  unlockedSkills: SkillId[],
): boolean {
  if (slotIndex < 0 || slotIndex >= SKILL_SLOTS.length) return false;

  const slot = SKILL_SLOTS[slotIndex];
  if (level < slot.unlocksAtLevel) return false;

  if (!unlockedSkills.includes(skillId)) return false;

  const tree = SKILL_TREES[className];
  if (!tree) return false;

  const skill = tree.find(s => s.id === skillId);
  if (!skill) return false;

  return skill.type === slot.type;
}

/** Equip a skill in a slot. Returns updated equippedSkills, or null if invalid. */
export function equipSkillInSlot(
  skillId: SkillId,
  slotIndex: number,
  className: ClassName,
  level: number,
  loadout: SkillLoadout,
): (SkillId | null)[] | null {
  if (!canEquipSkill(skillId, slotIndex, className, level, loadout.unlockedSkills)) return null;

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

/** Create the default skill loadout for a class (first passive unlocked + equipped). */
export function createDefaultSkillLoadout(className: ClassName): SkillLoadout {
  const tree = SKILL_TREES[className];
  if (!tree || tree.length === 0) {
    return { unlockedSkills: [], equippedSkills: [null, null, null] };
  }

  const firstSkill = tree.find(s => s.treeOrder === 0);
  if (!firstSkill) {
    return { unlockedSkills: [], equippedSkills: [null, null, null] };
  }

  return {
    unlockedSkills: [firstSkill.id],
    equippedSkills: [firstSkill.id, null, null],
  };
}

/** Look up a skill definition by ID. */
export function getSkillById(skillId: SkillId): SkillDefinition | undefined {
  for (const tree of Object.values(SKILL_TREES)) {
    const skill = tree.find(s => s.id === skillId);
    if (skill) return skill;
  }
  return undefined;
}
