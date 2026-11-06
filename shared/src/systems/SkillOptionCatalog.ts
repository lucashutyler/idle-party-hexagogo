import { ALL_CLASS_NAMES } from './CharacterStats.js';
import { SKILL_TRIGGER_VALUES, getSkillTrigger, isTimedSkill } from './SkillTypes.js';
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

const MAX_CAST_TIME_SECONDS = 10;
const MAX_WARMUP_SECONDS = 60;
const MAX_CHARGE_SECONDS = 120;

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
    description: 'Physical armor for the owner: rating = 2 × value × owner level; mitigation = rating / (rating + 4 × attacker level), max 80%. Applies to direct hits and to physical DoT pulses. Contributions from multiple options/skills sum.',
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
    description: 'Party-wide magical AND holy rating while the owner is alive: rating = 2 × value × owner level; mitigation = rating / (rating + 4 × attacker level), max 80%. Applies to direct hits and DoT pulses; this is the only reduction that touches holy damage. Bless uses the highest owner — owners do not stack.',
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
    description: 'When the owner is hit by a physical attack (even one fully absorbed), chance to stun the attacker for 1 second; a stunned enemy caster loses its spell. Never triggers from magical or holy hits. First-match: only the first equipped skill with this option counts — duplicates do not stack. The combat log uses the skill\'s name.',
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
    description: 'The owner resists every stun as it lands and is never stunned. The combat log uses the skill\'s name.',
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
    description: 'When a Knight in the party (other than the owner) takes any damage — direct hit or DoT pulse — the owner\'s next heal is boosted by this fraction. Capped at ONE stack between heals; each owner tracks their own stack. First-match: only the first equipped skill with this option counts.',
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
    description: 'Every single-target hit adds a PERMANENT DoT stack dealing (value × pre-resistance damage) magical damage on each of the target\'s pulses (once per second) for the rest of combat; resistance is applied at pulse time. AoE hits never apply stacks. Each equipped option adds its own stack per hit. DoT log entries group by skill name — two skills with the same name merge in the log.',
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
    description: 'Every second active skill the owner successfully uses deals double damage (counted when the skill resolves, including reactions). Fizzled uses do not advance the cadence.',
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
    description: 'Enemies damaged by the owner take +value magical/holy damage from all sources for 2 seconds (duration fixed by the engine). Shared debuff bucket: every scorch option writes the same "scorch" debuff — reapplying (from any skill) refreshes the duration instead of stacking. Only magical/holy attackers benefit. First-match: only the first equipped skill\'s value is applied.',
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
    description: 'Reduces active skill cooldowns by this many seconds (effective cooldown never drops below 1 second). Never shortens skills with the Enemy casts trigger. On a skill with charge, each point takes the combat clock in real seconds off its charge, never off its recovery, and never touches Attack. Self-only by default; with the party-wide flag it also applies to every OTHER living party member. Contributions sum.',
    targeting: 'self (party with flag)',
    params: [
      { key: 'flatValue', label: 'Seconds removed', input: 'number', min: 0, step: 0.1, required: true },
      { key: 'partyWide', label: 'Party-wide', help: 'Off = affects only the owner (Tempo). On = also reduces every other living member\'s cooldowns (Encore).', input: 'boolean' },
    ],
    seedExample: 'Bard — Tempo / Encore',
  },
  dodge_party: {
    kind: 'dodge_party',
    slotType: 'passive',
    label: 'Party dodge per member',
    description: 'At combat start, grants the whole party (value × party size) chance to dodge monster attacks and direct-damage spells (AoE spells roll dodge per player). Only counted when "scales per party member" is enabled. Contributions sum.',
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
    description: 'Attacks an enemy that is casting (first in enemy order), else the current grid target, for full active damage, then rolls the chance to stun it for 1 second (stuns refresh, never stack). A landed stun interrupts an enemy spell.',
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
    description: 'Rolls the stun chance (1 second) against every living enemy; deals no damage. If nothing gets stunned the option fizzles; if every option fizzles the cooldown is still spent and the action falls back to a normal attack.',
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
    description: 'Heals the most wounded ally (lowest HP percentage) for (caster level × value), boosted by the caster\'s heal power and Martyr stack, and by the target\'s healing-received bonus. Held until an ally is below half health or missing at least half the heal.',
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
    label: 'Intercept attack',
    description: 'Reaction (requires the Ally targeted trigger): when an enemy aims a single-target attack or spell at an ally with less max HP than the owner, the owner takes it instead. While an enemy spell is locked onto another ally, it saves itself for that spell. Does not cost an action.',
    targeting: 'attacked ally',
    params: [],
    seedExample: 'Knight — Intercept',
  },
  brace_reflect: {
    kind: 'brace_reflect',
    slotType: 'active',
    label: 'Brace and reflect',
    description: 'Reaction (requires the Hit by an enemy trigger): when a physical hit damages the owner, (value × damage taken) is reflected to EVERY living enemy, bypassing resistances. Magical and holy hits never reflect. Does not cost an action. The combat log uses the skill\'s name.',
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
    description: 'Deals normal active damage and marks the target: each application adds this fraction to the damage the target takes from single-target player attacks and skills. Stacks have no cap and each keeps its own multiplier.',
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
    description: 'Deals normal active damage, then applies a DoT worth (value × damage dealt) split over N pulses (one per second) in the caster\'s damage type. Applications stack; resistance applies at pulse time. DoT log entries group by skill name — two skills with the same name merge in the log.',
    targeting: 'single enemy',
    params: [
      { key: 'dotPercent', label: 'DoT fraction of damage', input: 'percent', min: 0, max: 5, step: 0.01, required: true },
      { key: 'dotTicks', label: 'DoT pulses (seconds)', input: 'number', min: 1, max: 20, step: 1, required: true },
    ],
    seedExample: 'Archer — Bleed',
  },
  debuff_attack: {
    kind: 'debuff_attack',
    slotType: 'active',
    label: 'Attack + weaken',
    description: 'Deals normal active damage and reduces the target\'s damage by this fraction for N seconds. Shared debuff bucket: every debuff_attack writes the "crippling_shot" debuff type — applications from different skills all land and each multiplies the target\'s damage down.',
    targeting: 'single enemy',
    params: [
      { key: 'debuffPercent', label: 'Damage reduction', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
      { key: 'debuffDuration', label: 'Duration (seconds)', input: 'number', min: 1, max: 20, step: 1, required: true },
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
    description: 'Removes all debuffs, DoTs, and stuns from an afflicted ally (stunned allies first, then lowest HP percentage). A cured caster resumes its paused spell. Held while nobody is afflicted.',
    targeting: 'afflicted ally',
    params: [],
    seedExample: 'Priest — Cure',
  },
  hot_lowest: {
    kind: 'hot_lowest',
    slotType: 'active',
    label: 'Heal over time',
    description: 'Applies a heal-over-time to the most wounded ally: (caster level × value) HP on each of the target\'s pulses (once per second) for N pulses. Heal power and the target\'s healing-received bonus are applied when it lands. Held until an ally is below half health or missing at least half of one pulse. HoT log entries group by skill name.',
    targeting: 'lowest-HP ally',
    params: [
      { key: 'healMultiplier', label: 'Heal per level per second', input: 'number', min: 0, step: 1, required: true },
      { key: 'dotTicks', label: 'Pulses (seconds)', input: 'number', min: 1, max: 20, step: 1, required: true },
    ],
    seedExample: 'Priest — Mending',
  },
  shield_non_knight: {
    kind: 'shield_non_knight',
    slotType: 'active',
    label: 'Shield squishiest ally',
    description: 'Shields the most wounded unshielded non-Knight ally, absorbing up to (caster level × value) incoming damage. Held while every non-Knight ally is already shielded.',
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
    description: 'All living enemies deal this fraction less damage for N seconds. Shared debuff bucket: every enemy_debuff_aoe writes the same "lullaby" debuff — recasting (from any skill) refreshes the duration instead of stacking.',
    targeting: 'all enemies',
    params: [
      { key: 'debuffPercent', label: 'Damage reduction', input: 'percent', min: 0, max: 1, step: 0.01, required: true },
      { key: 'debuffDuration', label: 'Duration (seconds)', input: 'number', min: 1, max: 20, step: 1, required: true },
    ],
    seedExample: 'Bard — Lullaby',
  },
  chaos: {
    kind: 'chaos',
    slotType: 'active',
    label: 'Sow chaos',
    description: 'Every living enemy attacks a random enemy (possibly itself) on its next action instead of the party.',
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
export function validateSkillDefinition(def: SkillDefinition, content?: SkillContent): string[] {
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
  if (def.type !== 'passive' && def.type !== 'active' && def.type !== 'attack') {
    errors.push('Skill type must be "passive", "active" or "attack".');
  }

  if (def.unlockLevel !== null) {
    if (!Number.isInteger(def.unlockLevel) || def.unlockLevel < 1 || def.unlockLevel > 100) {
      errors.push('Unlock level must be null (grant-only) or an integer from 1 to 100.');
    }
  }

  const passiveEffects = def.passiveEffects ?? [];
  const activeEffects = def.activeEffects ?? [];

  if (def.type === 'active') {
    validateActiveTiming(def, activeEffects, errors);
  } else {
    if (def.cooldown !== undefined) errors.push('Cooldown only applies to active skills.');
    if (def.castTime !== undefined) errors.push('Cast time only applies to active skills.');
    if (def.trigger !== undefined) errors.push('Trigger only applies to active skills.');
  }
  if (def.type === 'passive') {
    if (def.warmup !== undefined) errors.push('Warm-up only applies to active and attack skills.');
    if (def.charge !== undefined) errors.push('Charge only applies to active and attack skills.');
    if (def.recovery !== undefined) errors.push('Recovery only applies to active and attack skills.');
  }
  if (def.type === 'attack') validateAttackSkill(def, content, errors);

  if (def.type === 'passive' && activeEffects.length > 0) {
    errors.push('Passive skills cannot have active options.');
  }
  if (def.type !== 'attack' && passiveEffects.length + activeEffects.length === 0) {
    errors.push('Skill needs at least one option.');
  }

  passiveEffects.forEach((effect, i) => validateOption(effect, 'passive', i, errors));
  activeEffects.forEach((effect, i) => validateOption(effect, 'active', i, errors));

  return errors;
}

function validateAttackSkill(def: SkillDefinition, content: SkillContent | undefined, errors: string[]): void {
  if ((def.activeEffects?.length ?? 0) + (def.passiveEffects?.length ?? 0) > 0) {
    errors.push('Attack skills cannot have options: they are the class\'s basic attack.');
  }
  if (def.unlockLevel !== 1) errors.push('Attack skills must unlock at level 1.');
  if (!isTimedSkill(def)) errors.push('Attack skills require a charge or a recovery.');
  validateChargeAndRecovery(def, errors);
  if (def.warmup !== undefined && !isNumberInRange(def.warmup, 0, MAX_WARMUP_SECONDS)) {
    errors.push(`Initial charge must be between 0 and ${MAX_WARMUP_SECONDS} seconds.`);
  }
  const other = content && findAttackSkillConflict(def, content.skills);
  if (other) errors.push(`${def.className} already has an attack skill ("${other.id}").`);
}

function findAttackSkillConflict(def: SkillDefinition, skills: Record<string, SkillDefinition>): SkillDefinition | undefined {
  return Object.values(skills).find(s => s.type === 'attack' && s.className === def.className && s.id !== def.id);
}

function validateChargeAndRecovery(def: SkillDefinition, errors: string[]): void {
  if (def.charge !== undefined && !isNumberInRange(def.charge, 0, MAX_CHARGE_SECONDS)) {
    errors.push(`Charge must be between 0 and ${MAX_CHARGE_SECONDS} seconds.`);
  }
  if (def.recovery !== undefined && !isNumberInRange(def.recovery, 0, MAX_CHARGE_SECONDS)) {
    errors.push(`Recovery must be between 0 and ${MAX_CHARGE_SECONDS} seconds.`);
  }
  if (isTimedSkill(def) && !getSkillTrigger(def) && !((def.charge ?? 0) > 0 || (def.recovery ?? 0) > 0)) {
    errors.push('Charge and recovery cannot both be 0.');
  }
}

function validateInstantTiming(def: SkillDefinition, errors: string[]): void {
  if ((def.recovery ?? 0) > 0) errors.push('A skill with a trigger is an Instant and cannot have a recovery: add it to the charge instead.');
  if (!((def.charge ?? 0) > 0)) errors.push('A skill with a trigger is an Instant and needs a charge above 0.');
}

function validateActiveTiming(def: SkillDefinition, activeEffects: ActiveEffect[], errors: string[]): void {
  if (isTimedSkill(def)) {
    validateChargeAndRecovery(def, errors);
    if (getSkillTrigger(def)) validateInstantTiming(def, errors);
  } else if (def.cooldown === undefined || !Number.isFinite(def.cooldown) || def.cooldown < 1) {
    errors.push('Active skills require a cooldown of at least 1 second.');
  }
  if (def.castTime !== undefined && !isNumberInRange(def.castTime, 0, MAX_CAST_TIME_SECONDS)) {
    errors.push(`Cast time must be between 0 and ${MAX_CAST_TIME_SECONDS} seconds.`);
  }
  if (def.warmup !== undefined && !isNumberInRange(def.warmup, 0, MAX_WARMUP_SECONDS)) {
    errors.push(`Warm-up must be between 0 and ${MAX_WARMUP_SECONDS} seconds.`);
  }
  if (def.trigger !== undefined && !SKILL_TRIGGER_VALUES.includes(def.trigger)) {
    errors.push(`Unknown trigger "${String(def.trigger)}". Expected one of: ${SKILL_TRIGGER_VALUES.join(', ')}.`);
  }

  const hasRedirect = activeEffects.some(e => e.kind === 'redirect_hit');
  const hasBrace = activeEffects.some(e => e.kind === 'brace_reflect');
  const trigger = getSkillTrigger(def);
  if (hasRedirect && hasBrace) {
    errors.push('A skill cannot combine the Intercept attack and Brace and reflect options.');
  } else if (hasRedirect && trigger !== 'ally_targeted') {
    errors.push('The Intercept attack option requires the "ally_targeted" trigger.');
  } else if (hasBrace && trigger !== 'self_hit') {
    errors.push('The Brace and reflect option requires the "self_hit" trigger.');
  }
  if (trigger !== undefined && (def.castTime ?? 0) > 0) {
    errors.push('Triggered skills cannot have a cast time.');
  }
}

function isNumberInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
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
