import { ALL_CLASS_NAMES } from './CharacterStats.js';
import type {
  ActiveEffect,
  ActiveEffectKind,
  PassiveEffect,
  PassiveEffectKind,
  SkillContent,
  SkillDefinition,
  SkillSlotType,
} from './SkillTypes.js';

// --- Types ---

/**
 * Spec for one editable parameter of a skill option. `percent` inputs are
 * STORED as 0-1 fractions; editors display them ×100 (monster drop-chance
 * precedent). `condition` is a select over SKILL_CONDITION_VALUES and `class`
 * a select over ALL_CLASS_NAMES.
 */
export interface SkillOptionParamSpec {
  key: string;
  label: string;
  help?: string;
  input: 'number' | 'percent' | 'boolean' | 'class' | 'condition';
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
}

/** Catalog entry describing one engine-supported effect kind ("option"). */
export interface SkillOptionDefinition {
  kind: PassiveEffectKind | ActiveEffectKind;
  /** Which effect array this kind lives in: passive kinds → passiveEffects, active kinds → activeEffects. */
  slotType: SkillSlotType;
  label: string;
  /** What the engine actually does, including stacking/collision caveats. */
  description: string;
  /** Human targeting string: 'self', 'single enemy', 'all enemies', 'party', 'lowest-HP ally', ... */
  targeting: string;
  params: SkillOptionParamSpec[];
  /** A seed skill using this kind (aids catalog search). */
  seedExample: string;
}

// --- Constants ---

/** The condition strings the engine understands for conditional_damage_bonus. */
export const SKILL_CONDITION_VALUES = ['target_above_75_hp', 'front_column', 'target_bleeding_or_stunned'] as const;

/** Every passive effect kind the engine supports (27). */
export const ALL_PASSIVE_EFFECT_KINDS: PassiveEffectKind[] = [
  'physical_reduction', 'party_damage_mult', 'magical_reduction_party', 'crit_chance',
  'bonus_damage', 'max_hp_percent', 'stun_on_phys_hit', 'stun_immune',
  'healing_received_bonus', 'conditional_ally_damage', 'conditional_damage_bonus',
  'crit_damage_bonus', 'stacking_same_target', 'heal_power', 'holy_damage_party',
  'consecrate', 'martyr', 'resurrection', 'intensify', 'dot_on_auto', 'arcane_surge',
  'overflow', 'scorch', 'cooldown_reduction', 'dodge_party', 'xp_bonus',
  'enemy_damage_reduction_party',
];

/** Every active effect kind the engine supports (23). */
export const ALL_ACTIVE_EFFECT_KINDS: ActiveEffectKind[] = [
  'stun_single', 'stun_aoe', 'heal_lowest', 'multi_hit', 'target_lowest_hp',
  'redirect_hit', 'brace_reflect', 'stacking_mark', 'remove_buffs', 'multi_hit_random',
  'ignore_dr_single', 'dot_attack', 'debuff_attack', 'smite', 'cure_debuffs',
  'hot_lowest', 'shield_non_knight', 'damage_percent', 'damage_aoe_all',
  'high_damage_single', 'party_buff_permanent', 'enemy_debuff_aoe', 'chaos',
];

// Typed against the full kind union so the compiler enforces one entry per kind.
const CATALOG = {
  // ===== PASSIVE OPTIONS =====
  physical_reduction: {
    kind: 'physical_reduction',
    slotType: 'passive',
    label: 'Physical damage reduction',
    description: 'Reduces physical damage the owner takes by (value × owner level). Applies to direct hits and to physical DoT ticks. Contributions from multiple options/skills sum.',
    targeting: 'self',
    params: [
      { key: 'valuePerLevel', label: 'Reduction per level', input: 'number', min: 0, step: 1, required: true },
    ],
    seedExample: 'Knight — Guard',
  },
  party_damage_mult: {
    kind: 'party_damage_mult',
    slotType: 'passive',
    label: 'Party damage per member',
    description: 'At combat start, adds (value × party size) to the party-wide damage multiplier applied to every player attack. Only counted when "scales per party member" is enabled. Contributions from multiple owners sum.',
    targeting: 'party',
    params: [
      { key: 'flatValue', label: 'Damage bonus per member', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
      { key: 'perPartyMember', label: 'Scales per party member', help: 'Must be enabled — the engine only counts per-member scaling for this option.', input: 'boolean', required: true },
    ],
    seedExample: 'Bard — Rally',
  },
  magical_reduction_party: {
    kind: 'magical_reduction_party',
    slotType: 'passive',
    label: 'Party magic/holy reduction',
    description: 'Reduces magical AND holy damage taken by every party member by (value × owner level) while the owner is alive. Applies to direct hits and DoT ticks; this is the only reduction that touches holy damage. Contributions sum across owners.',
    targeting: 'party',
    params: [
      { key: 'valuePerLevel', label: 'Reduction per level', input: 'number', min: 0, step: 1, required: true },
    ],
    seedExample: 'Priest — Bless',
  },
  crit_chance: {
    kind: 'crit_chance',
    slotType: 'passive',
    label: 'Critical hit chance',
    description: 'Chance for the owner\'s attacks to critically hit (base 2× damage, increased by crit damage bonuses). Contributions from multiple options sum.',
    targeting: 'self',
    params: [
      { key: 'flatValue', label: 'Crit chance', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
    ],
    seedExample: 'Archer — Pierce',
  },
  bonus_damage: {
    kind: 'bonus_damage',
    slotType: 'passive',
    label: 'Flat bonus damage',
    description: 'Adds (value × owner level) flat damage to the owner\'s base damage, baked once at combat start. Contributions sum.',
    targeting: 'self',
    params: [
      { key: 'valuePerLevel', label: 'Damage per level', input: 'number', min: 0, step: 1, required: true },
    ],
    seedExample: 'Mage — Burn',
  },
  max_hp_percent: {
    kind: 'max_hp_percent',
    slotType: 'passive',
    label: 'Max HP percent',
    description: 'Increases the owner\'s max HP by (value% × level) at combat start and refills them to full. Multiple options compound sequentially (each applies to the already-increased max HP).',
    targeting: 'self',
    params: [
      { key: 'valuePerLevel', label: 'HP % per level', help: 'Whole percent per level — 2 means +2% max HP per level.', input: 'number', min: 0, step: 1, required: true },
    ],
    seedExample: 'Knight — Fortify',
  },
  stun_on_phys_hit: {
    kind: 'stun_on_phys_hit',
    slotType: 'passive',
    label: 'Stun attacker on physical hit',
    description: 'When the owner is hit by a physical attack, chance to stun the attacker for 1 turn. Never triggers from magical or holy hits. First-match: only the first equipped skill with this option counts — duplicates do not stack. The combat log uses the skill\'s name.',
    targeting: 'self',
    params: [
      { key: 'flatValue', label: 'Stun chance', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
    ],
    seedExample: 'Knight — Shield Bash',
  },
  stun_immune: {
    kind: 'stun_immune',
    slotType: 'passive',
    label: 'Stun immunity',
    description: 'The owner shrugs off stuns: instead of skipping the turn, the stun is cleared and the turn proceeds. The combat log uses the skill\'s name.',
    targeting: 'self',
    params: [],
    seedExample: 'Knight — Iron Will',
  },
  healing_received_bonus: {
    kind: 'healing_received_bonus',
    slotType: 'passive',
    label: 'Healing received bonus',
    description: 'Healing the owner receives (direct heals, and heal-over-time computed at cast) is increased by this fraction. First-match: only the first equipped skill with this option counts — duplicates do not stack.',
    targeting: 'self',
    params: [
      { key: 'flatValue', label: 'Bonus healing received', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
    ],
    seedExample: 'Knight — Tenacity',
  },
  conditional_ally_damage: {
    kind: 'conditional_ally_damage',
    slotType: 'passive',
    label: 'Class allies damage when hurt',
    description: 'While the owner is below the HP threshold, party members of the chosen class deal increased damage. Multiple sources each apply their own multiplier (multiplicative).',
    targeting: 'allies of a class',
    params: [
      { key: 'targetClass', label: 'Boosted class', input: 'class', required: true },
      { key: 'flatValue', label: 'Damage bonus', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
      { key: 'hpThreshold', label: 'Owner HP threshold', help: 'Fires while the owner is below this fraction of max HP. Defaults to 0.50.', input: 'percent', min: 0, max: 1, step: 0.01 },
    ],
    seedExample: 'Knight — War Cry',
  },
  conditional_damage_bonus: {
    kind: 'conditional_damage_bonus',
    slotType: 'passive',
    label: 'Conditional damage bonus',
    description: 'Increases the owner\'s damage when the condition holds: target above 75% HP, owner positioned in the front column, or target bleeding/stunned. Multiple options each apply their own multiplier (multiplicative).',
    targeting: 'self',
    params: [
      { key: 'flatValue', label: 'Damage bonus', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
      { key: 'condition', label: 'Condition', input: 'condition', required: true },
    ],
    seedExample: 'Archer — Marksman',
  },
  crit_damage_bonus: {
    kind: 'crit_damage_bonus',
    slotType: 'passive',
    label: 'Critical damage bonus',
    description: 'Adds to the critical hit multiplier (base 2×; +1.00 makes crits 3×). Contributions from multiple options sum.',
    targeting: 'self',
    params: [
      { key: 'flatValue', label: 'Added crit multiplier', input: 'percent', min: 0, max: 10, step: 0.01, required: true },
    ],
    seedExample: 'Archer — Precision',
  },
  stacking_same_target: {
    kind: 'stacking_same_target',
    slotType: 'passive',
    label: 'Consecutive-hit damage',
    description: 'The owner deals +value damage per consecutive attack on the same target; the streak resets when switching. Targets are tracked by monster NAME, so identical monsters share one streak. First-match: only the first equipped skill with this option counts.',
    targeting: 'self',
    params: [
      { key: 'flatValue', label: 'Bonus per consecutive hit', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
    ],
    seedExample: 'Archer — Focus',
  },
  heal_power: {
    kind: 'heal_power',
    slotType: 'passive',
    label: 'Healing power',
    description: 'Increases healing the owner deals (heals and heal-over-time) by (value% × level). Contributions from multiple options sum.',
    targeting: 'self',
    params: [
      { key: 'valuePerLevel', label: 'Heal % per level', help: 'Whole percent per level — 3 means +3% healing per level.', input: 'number', min: 0, step: 1, required: true },
    ],
    seedExample: 'Priest — Devotion',
  },
  holy_damage_party: {
    kind: 'holy_damage_party',
    slotType: 'passive',
    label: 'Party holy damage',
    description: 'While the owner is alive at combat start, every party member\'s attack adds (value × owner level) holy damage, reduced only by monster holy resistance. Contributions sum across owners.',
    targeting: 'party',
    params: [
      { key: 'valuePerLevel', label: 'Holy damage per level', input: 'number', min: 0, step: 1, required: true },
    ],
    seedExample: 'Priest — Blessed Arms',
  },
  consecrate: {
    kind: 'consecrate',
    slotType: 'passive',
    label: 'Consecrate (stub)',
    description: 'Placeholder: undead killed by any party member stay dead. Has NO engine effect until the undead system ships.',
    targeting: 'party',
    params: [],
    seedExample: 'Priest — Consecrate',
  },
  martyr: {
    kind: 'martyr',
    slotType: 'passive',
    label: 'Martyr heal bonus',
    description: 'When a Knight in the party (other than the owner) takes any damage — direct hit or DoT tick — the owner\'s next heal is boosted by this fraction. Capped at ONE stack between heals; each owner tracks their own stack. First-match: only the first equipped skill with this option counts.',
    targeting: 'self',
    params: [
      { key: 'flatValue', label: 'Next-heal bonus', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
    ],
    seedExample: 'Priest — Martyr',
  },
  resurrection: {
    kind: 'resurrection',
    slotType: 'passive',
    label: 'Resurrection',
    description: 'Once per battle, when an ally would die while the owner lives, they revive at this fraction of max HP (a value of 0 falls back to 20%). First-match: only the first equipped skill with this option counts; one use per battle per owner.',
    targeting: 'dying ally',
    params: [
      { key: 'flatValue', label: 'Revive HP fraction', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
    ],
    seedExample: 'Priest — Resurrection',
  },
  intensify: {
    kind: 'intensify',
    slotType: 'passive',
    label: 'Intensify (auto ↔ active trade)',
    description: 'Trades auto-attack damage for active skill damage: auto attacks deal ×(1 − value), active skills deal ×(1 + value). First-match: only the first equipped skill with this option counts — duplicates do not stack.',
    targeting: 'self',
    params: [
      { key: 'flatValue', label: 'Trade fraction', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
    ],
    seedExample: 'Mage — Intensify',
  },
  dot_on_auto: {
    kind: 'dot_on_auto',
    slotType: 'passive',
    label: 'Permanent burn on hit',
    description: 'Every single-target hit adds a PERMANENT DoT stack dealing (value × pre-resistance damage) magical damage per tick for the rest of combat; resistance is applied at tick time. AoE hits never apply stacks. Each equipped option adds its own stack per hit. DoT log entries group by skill name — two skills with the same name merge in the log.',
    targeting: 'single enemy',
    params: [
      { key: 'dotPercent', label: 'Stack damage fraction', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
    ],
    seedExample: 'Mage — Ignite',
  },
  arcane_surge: {
    kind: 'arcane_surge',
    slotType: 'passive',
    label: 'Arcane Surge cadence',
    description: 'Every second active skill the owner successfully casts deals double damage. Wasted casts (whole-cast no-ops) do not advance the cadence.',
    targeting: 'self',
    params: [],
    seedExample: 'Mage — Arcane Surge',
  },
  overflow: {
    kind: 'overflow',
    slotType: 'passive',
    label: 'Overkill splash',
    description: 'When one of the owner\'s single-target hits kills, the overkill damage splashes to one random living enemy. Never triggers on AoE hits.',
    targeting: 'random enemy',
    params: [],
    seedExample: 'Mage — Overflow',
  },
  scorch: {
    kind: 'scorch',
    slotType: 'passive',
    label: 'Scorch debuff on hit',
    description: 'Enemies damaged by the owner take +value magical/holy damage from all sources for 2 turns (duration fixed by the engine). Shared debuff bucket: every scorch option writes the same "scorch" debuff — reapplying (from any skill) refreshes the duration instead of stacking. Only magical/holy attackers benefit. First-match: only the first equipped skill\'s value is applied.',
    targeting: 'single enemy',
    params: [
      { key: 'flatValue', label: 'Bonus damage taken', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
    ],
    seedExample: 'Mage — Scorch',
  },
  cooldown_reduction: {
    kind: 'cooldown_reduction',
    slotType: 'passive',
    label: 'Cooldown reduction',
    description: 'Reduces active skill cooldowns by this many attacks (effective cooldown never drops below 1). Self-only by default; with the party-wide flag it also applies to every OTHER living party member. Contributions sum.',
    targeting: 'self (party with flag)',
    params: [
      { key: 'flatValue', label: 'Cooldown ticks removed', input: 'number', min: 0, step: 1, required: true },
      { key: 'partyWide', label: 'Party-wide', help: 'Off = affects only the owner (Tempo). On = also reduces every other living member\'s cooldowns (Encore).', input: 'boolean' },
    ],
    seedExample: 'Bard — Tempo / Encore',
  },
  dodge_party: {
    kind: 'dodge_party',
    slotType: 'passive',
    label: 'Party dodge per member',
    description: 'At combat start, grants the whole party (value × party size) chance to dodge monster attacks and direct-damage skills (AoE skills roll dodge per player). Only counted when "scales per party member" is enabled. Contributions sum.',
    targeting: 'party',
    params: [
      { key: 'flatValue', label: 'Dodge per member', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
      { key: 'perPartyMember', label: 'Scales per party member', help: 'Must be enabled — the engine only counts per-member scaling for this option.', input: 'boolean', required: true },
    ],
    seedExample: 'Bard — Nimble',
  },
  xp_bonus: {
    kind: 'xp_bonus',
    slotType: 'passive',
    label: 'Party XP boost',
    description: 'Increases XP the whole party earns from victories by this fraction. Read from every member\'s equipped skills at battle end; contributions sum across members and options.',
    targeting: 'party',
    params: [
      { key: 'flatValue', label: 'Bonus XP', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
    ],
    seedExample: 'Bard — Inspiration',
  },
  enemy_damage_reduction_party: {
    kind: 'enemy_damage_reduction_party',
    slotType: 'passive',
    label: 'Enemy damage reduction per member',
    description: 'At combat start, reduces all enemy attack damage by (value × party size). Only counted when "scales per party member" is enabled. Contributions sum.',
    targeting: 'all enemies',
    params: [
      { key: 'flatValue', label: 'Reduction per member', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
      { key: 'perPartyMember', label: 'Scales per party member', help: 'Must be enabled — the engine only counts per-member scaling for this option.', input: 'boolean', required: true },
    ],
    seedExample: 'Bard — Unnerve',
  },

  // ===== ACTIVE OPTIONS =====
  stun_single: {
    kind: 'stun_single',
    slotType: 'active',
    label: 'Attack + stun chance',
    description: 'Attacks the current grid target for full active damage, then rolls the chance to stun for 1 turn (stuns refresh to 1, never stack).',
    targeting: 'single enemy',
    params: [
      { key: 'stunChance', label: 'Stun chance', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
    ],
    seedExample: 'Knight — Bash',
  },
  stun_aoe: {
    kind: 'stun_aoe',
    slotType: 'active',
    label: 'Mass stun chance',
    description: 'Rolls the stun chance against every living enemy; deals no damage. If nothing gets stunned this option is a no-op (and if every option of the skill no-ops, the cast falls back to a normal attack).',
    targeting: 'all enemies',
    params: [
      { key: 'stunChance', label: 'Stun chance per enemy', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
    ],
    seedExample: 'Bard — Drumroll',
  },
  heal_lowest: {
    kind: 'heal_lowest',
    slotType: 'active',
    label: 'Heal lowest ally',
    description: 'Heals the ally at the lowest HP percentage for (caster level × value), boosted by the caster\'s heal power and Martyr stack, and by the target\'s healing-received bonus. No-op when nobody is injured.',
    targeting: 'lowest-HP ally',
    params: [
      { key: 'healMultiplier', label: 'Heal per level', input: 'number', min: 0, step: 1, required: true },
    ],
    seedExample: 'Priest — Minor Heal',
  },
  multi_hit: {
    kind: 'multi_hit',
    slotType: 'active',
    label: 'Multi-hit volley',
    description: 'Fires N hits at (value × active damage) each. Every hit re-picks the grid target, so kills mid-volley roll over to the next enemy. Hits count as single-target (Ignite/Overflow apply).',
    targeting: 'single enemy',
    params: [
      { key: 'hitCount', label: 'Number of hits', input: 'number', min: 1, max: 20, step: 1, required: true },
      { key: 'damagePercent', label: 'Damage per hit', input: 'percent', min: 0, max: 10, step: 0.01, required: true },
    ],
    seedExample: 'Mage — Magic Missile',
  },
  target_lowest_hp: {
    kind: 'target_lowest_hp',
    slotType: 'active',
    label: 'Strike lowest-HP enemy',
    description: 'Deals normal active damage to the enemy with the lowest current HP instead of the grid target.',
    targeting: 'lowest-HP enemy',
    params: [],
    seedExample: 'Archer — Cut Down',
  },
  redirect_hit: {
    kind: 'redirect_hit',
    slotType: 'active',
    label: 'Intercept next attack',
    description: 'Instead of attacking, the caster intercepts: the next single-target attack or monster skill aimed at another ally is redirected to the caster. Consumed after one redirect.',
    targeting: 'self',
    params: [],
    seedExample: 'Knight — Intercept',
  },
  brace_reflect: {
    kind: 'brace_reflect',
    slotType: 'active',
    label: 'Brace and reflect',
    description: 'Instead of attacking, brace: physical damage taken before the caster\'s next turn accumulates, then (value × accumulated) is reflected to EVERY living enemy at end of tick. Magical and holy hits never build the reflect. Only the FIRST equipped skill with this option is consulted for the end-of-tick reflect. The combat log uses the skill\'s name.',
    targeting: 'all enemies',
    params: [
      { key: 'reflectPercent', label: 'Reflect fraction', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
    ],
    seedExample: 'Knight — Shield Slam',
  },
  stacking_mark: {
    kind: 'stacking_mark',
    slotType: 'active',
    label: 'Attack + stacking mark',
    description: 'Deals normal active damage and marks the target: each stack increases damage the target takes from ALL sources by this fraction. Stacks have no cap; the most recently applied option\'s multiplier is used for every stack on the target.',
    targeting: 'single enemy',
    params: [
      { key: 'markMultiplier', label: 'Damage taken per stack', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
    ],
    seedExample: 'Knight — Sunder',
  },
  remove_buffs: {
    kind: 'remove_buffs',
    slotType: 'active',
    label: 'Attack + dispel buffs',
    description: 'Deals normal active damage and strips all buffs from the target.',
    targeting: 'single enemy',
    params: [],
    seedExample: 'Knight — Dispel',
  },
  multi_hit_random: {
    kind: 'multi_hit_random',
    slotType: 'active',
    label: 'Random-target volley',
    description: 'Hits N randomly chosen living enemies for (value × active damage) each. Counts as AoE: no Ignite stacks, no Overflow splash.',
    targeting: 'random enemies',
    params: [
      { key: 'hitCount', label: 'Number of hits', input: 'number', min: 1, max: 20, step: 1, required: true },
      { key: 'damagePercent', label: 'Damage per hit', input: 'percent', min: 0, max: 10, step: 0.01, required: true },
    ],
    seedExample: 'Archer — Triple Shot',
  },
  ignore_dr_single: {
    kind: 'ignore_dr_single',
    slotType: 'active',
    label: 'Piercing strike',
    description: 'Deals (value × active damage) directly to the grid target\'s HP, bypassing monster resistances and skipping on-hit riders (Blessed Arms holy, Ignite, Scorch application). Overflow still splashes the overkill.',
    targeting: 'single enemy',
    params: [
      { key: 'damagePercent', label: 'Damage multiplier', input: 'percent', min: 0, max: 10, step: 0.01, required: true },
    ],
    seedExample: 'Archer — Snipe',
  },
  dot_attack: {
    kind: 'dot_attack',
    slotType: 'active',
    label: 'Attack + damage over time',
    description: 'Deals normal active damage, then applies a DoT worth (value × damage dealt) split over N ticks in the caster\'s damage type. Applications stack; resistance applies at tick time. DoT log entries group by skill name — two skills with the same name merge in the log.',
    targeting: 'single enemy',
    params: [
      { key: 'dotPercent', label: 'DoT fraction of damage', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
      { key: 'dotTicks', label: 'DoT ticks', input: 'number', min: 1, max: 20, step: 1, required: true },
    ],
    seedExample: 'Archer — Bleed',
  },
  debuff_attack: {
    kind: 'debuff_attack',
    slotType: 'active',
    label: 'Attack + weaken',
    description: 'Deals normal active damage and reduces the target\'s damage by this fraction for N turns. Shared debuff bucket: every debuff_attack writes the "crippling_shot" debuff type — applications from different skills all land and each multiplies the target\'s damage down.',
    targeting: 'single enemy',
    params: [
      { key: 'debuffPercent', label: 'Damage reduction', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
      { key: 'debuffDuration', label: 'Duration (turns)', input: 'number', min: 1, max: 20, step: 1, required: true },
    ],
    seedExample: 'Archer — Crippling Shot',
  },
  smite: {
    kind: 'smite',
    slotType: 'active',
    label: 'Smite',
    description: 'Deals normal active damage to the grid target. The bonus holy damage vs undead (caster level × value) is stubbed until the undead system ships — the multiplier is stored but not yet consumed.',
    targeting: 'single enemy',
    params: [
      { key: 'holyMultiplier', label: 'Holy damage per level vs undead', help: 'Stored but inert until the undead system ships.', input: 'number', min: 0, step: 1 },
    ],
    seedExample: 'Priest — Smite',
  },
  cure_debuffs: {
    kind: 'cure_debuffs',
    slotType: 'active',
    label: 'Cure afflictions',
    description: 'Removes all debuffs, DoTs, and stuns from the ally at the lowest HP percentage. No-op when there is nothing to cure.',
    targeting: 'lowest-HP ally',
    params: [],
    seedExample: 'Priest — Cure',
  },
  hot_lowest: {
    kind: 'hot_lowest',
    slotType: 'active',
    label: 'Heal over time',
    description: 'Applies a heal-over-time to the lowest-HP% ally: (caster level × value) HP per tick for N ticks. Heal power and the target\'s healing-received bonus are applied at cast time. HoT log entries group by skill name.',
    targeting: 'lowest-HP ally',
    params: [
      { key: 'healMultiplier', label: 'Heal per level per tick', input: 'number', min: 0, step: 1, required: true },
      { key: 'dotTicks', label: 'Ticks', input: 'number', min: 1, max: 20, step: 1, required: true },
    ],
    seedExample: 'Priest — Mending',
  },
  shield_non_knight: {
    kind: 'shield_non_knight',
    slotType: 'active',
    label: 'Shield squishiest ally',
    description: 'Shields the lowest-HP% non-Knight ally, absorbing up to (caster level × value) incoming damage. No-op when no valid target exists or the target is already shielded.',
    targeting: 'lowest-HP non-Knight ally',
    params: [
      { key: 'shieldMultiplier', label: 'Shield per level', input: 'number', min: 0, step: 1, required: true },
    ],
    seedExample: 'Priest — Sanctuary',
  },
  damage_percent: {
    kind: 'damage_percent',
    slotType: 'active',
    label: 'Single-target damage',
    description: 'Deals (value × active damage) to the grid target through the normal damage pipeline (resistances, on-hit riders apply).',
    targeting: 'single enemy',
    params: [
      { key: 'damagePercent', label: 'Damage multiplier', input: 'percent', min: 0, max: 10, step: 0.01, required: true },
    ],
    seedExample: 'Mage — Zap',
  },
  damage_aoe_all: {
    kind: 'damage_aoe_all',
    slotType: 'active',
    label: 'Damage all enemies',
    description: 'Hits every living enemy. Two modes: with "flat damage per level" set, deals (value × caster level) true damage that bypasses resistances and on-hit riders; otherwise deals (percent × active damage) per enemy through the normal pipeline as AoE (no Ignite/Overflow).',
    targeting: 'all enemies',
    params: [
      { key: 'damagePercent', label: 'Damage multiplier', help: 'Percent mode — ignored when flat damage per level is set.', input: 'percent', min: 0, max: 10, step: 0.01 },
      { key: 'damagePerLevel', label: 'Flat damage per level', help: 'Flat mode: value × caster level true damage; overrides percent mode when set.', input: 'number', min: 0, step: 0.1 },
    ],
    seedExample: 'Mage — Blizzard / Bard — Dissonance',
  },
  high_damage_single: {
    kind: 'high_damage_single',
    slotType: 'active',
    label: 'Heavy single-target nuke',
    description: 'Deals (value × active damage) to the grid target — identical pipeline to single-target damage, intended for big multipliers.',
    targeting: 'single enemy',
    params: [
      { key: 'damagePercent', label: 'Damage multiplier', input: 'percent', min: 0, max: 10, step: 0.01, required: true },
    ],
    seedExample: 'Mage — Arcane Blast',
  },
  party_buff_permanent: {
    kind: 'party_buff_permanent',
    slotType: 'active',
    label: 'Permanent party damage buff',
    description: 'Permanently increases party damage by this fraction for the rest of combat. Each cast stacks additively.',
    targeting: 'party',
    params: [
      { key: 'buffPercent', label: 'Damage bonus per cast', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
    ],
    seedExample: 'Bard — War Song',
  },
  enemy_debuff_aoe: {
    kind: 'enemy_debuff_aoe',
    slotType: 'active',
    label: 'Weaken all enemies',
    description: 'All living enemies deal this fraction less damage for N turns. Shared debuff bucket: every enemy_debuff_aoe writes the same "lullaby" debuff — recasting (from any skill) refreshes the duration instead of stacking.',
    targeting: 'all enemies',
    params: [
      { key: 'debuffPercent', label: 'Damage reduction', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
      { key: 'debuffDuration', label: 'Duration (turns)', input: 'number', min: 1, max: 20, step: 1, required: true },
    ],
    seedExample: 'Bard — Lullaby',
  },
  chaos: {
    kind: 'chaos',
    slotType: 'active',
    label: 'Sow chaos',
    description: 'Every living enemy attacks a random enemy (possibly itself) on its next turn instead of the party.',
    targeting: 'all enemies',
    params: [],
    seedExample: 'Bard — Chaos',
  },
} satisfies Record<PassiveEffectKind | ActiveEffectKind, SkillOptionDefinition>;

/**
 * One entry per engine-supported effect kind (27 passive + 23 active).
 * Modeled on MONSTER_SKILL_CATALOG. The `satisfies` check above guarantees
 * exactly one entry per kind at compile time.
 */
export const SKILL_OPTION_CATALOG: Record<string, SkillOptionDefinition> = CATALOG;

// --- Validation ---

/**
 * Validate an editable skill definition against the option catalog.
 * Returns a list of human-readable errors; empty array means valid.
 * Used by server PUT routes AND the admin client pre-save.
 */
export function validateSkillDefinition(def: SkillDefinition, _content?: SkillContent): string[] {
  const errors: string[] = [];

  if (!def.id || typeof def.id !== 'string' || !def.id.trim()) {
    errors.push('Skill id is required.');
  }
  if (!def.name || typeof def.name !== 'string' || !def.name.trim()) {
    errors.push('Skill name is required.');
  }
  if (!(ALL_CLASS_NAMES as string[]).includes(def.className)) {
    errors.push(`Unknown class "${def.className}".`);
  }
  if (def.type !== 'passive' && def.type !== 'active') {
    errors.push('Skill type must be "passive" or "active".');
  }

  if (def.unlockLevel !== null) {
    if (!Number.isInteger(def.unlockLevel) || def.unlockLevel < 1 || def.unlockLevel > 100) {
      errors.push('Unlock level must be null (grant-only) or an integer from 1 to 100.');
    }
  }

  if (def.type === 'active') {
    if (def.cooldown === undefined || !Number.isFinite(def.cooldown) || def.cooldown < 1) {
      errors.push('Active skills require a cooldown of at least 1.');
    }
  } else if (def.cooldown !== undefined) {
    errors.push('Cooldown only applies to active skills.');
  }

  const passiveEffects = def.passiveEffects ?? [];
  const activeEffects = def.activeEffects ?? [];

  if (def.type === 'passive' && activeEffects.length > 0) {
    errors.push('Passive skills cannot have active options.');
  }
  if (passiveEffects.length + activeEffects.length === 0) {
    errors.push('Skill needs at least one option.');
  }

  passiveEffects.forEach((effect, i) => validateOption(effect, 'passive', i, errors));
  activeEffects.forEach((effect, i) => validateOption(effect, 'active', i, errors));

  return errors;
}

/** Validate one option (effect) against its catalog entry's param specs. */
function validateOption(
  effect: PassiveEffect | ActiveEffect,
  expectedSlotType: SkillSlotType,
  index: number,
  errors: string[],
): void {
  const option = (SKILL_OPTION_CATALOG as Record<string, SkillOptionDefinition | undefined>)[effect.kind];
  if (!option) {
    errors.push(`Unknown ${expectedSlotType} option kind "${effect.kind}" (option ${index + 1}).`);
    return;
  }
  if (option.slotType !== expectedSlotType) {
    errors.push(`Option "${option.label}" is a ${option.slotType} kind and cannot be used as a ${expectedSlotType} option.`);
    return;
  }

  const values = effect as unknown as Record<string, unknown>;
  for (const spec of option.params) {
    const value = values[spec.key];
    if (value === undefined || value === null) {
      if (spec.required) {
        errors.push(`Option "${option.label}" is missing required parameter "${spec.label}".`);
      }
      continue;
    }
    if (spec.input === 'number' || spec.input === 'percent') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`Option "${option.label}" parameter "${spec.label}" must be a number.`);
        continue;
      }
      if (spec.min !== undefined && value < spec.min) {
        errors.push(`Option "${option.label}" parameter "${spec.label}" must be at least ${spec.min}.`);
      }
      if (spec.max !== undefined && value > spec.max) {
        errors.push(`Option "${option.label}" parameter "${spec.label}" must be at most ${spec.max}.`);
      }
    } else if (spec.input === 'boolean') {
      if (typeof value !== 'boolean') {
        errors.push(`Option "${option.label}" parameter "${spec.label}" must be a boolean.`);
      }
    } else if (spec.input === 'class') {
      if (typeof value !== 'string' || !(ALL_CLASS_NAMES as string[]).includes(value)) {
        errors.push(`Option "${option.label}" parameter "${spec.label}" must be a valid class name.`);
      }
    } else if (spec.input === 'condition') {
      if (typeof value !== 'string' || !(SKILL_CONDITION_VALUES as readonly string[]).includes(value)) {
        errors.push(`Option "${option.label}" parameter "${spec.label}" must be one of: ${SKILL_CONDITION_VALUES.join(', ')}.`);
      }
    }
  }
}
