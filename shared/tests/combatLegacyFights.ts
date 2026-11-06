import { buildClientCombatSnapshot, createPartyCombatState, processCombatStep } from '../src/systems/CombatEngine';
import type { CombatSetup, PartyCombatantInit } from '../src/systems/CombatEngine';
import { createRng } from '../src/systems/combat/CombatRng';
import { AUTHORED_PACE, COMBAT_PACE } from '../src/systems/CombatPace';
import { createMonsterInstance } from '../src/systems/MonsterTypes';
import type { MonsterDefinition } from '../src/systems/MonsterTypes';
import type { ClassName } from '../src/systems/CharacterStats';
import { CLASS_DEFINITIONS } from '../src/systems/CharacterStats';
import type { PartyGridPosition } from '../src/systems/SocialTypes';
import type { ActiveEffect, PassiveEffect, SkillDefinition, SkillTrigger } from '../src/systems/SkillTypes';

interface ActiveFields {
  cooldown: number;
  castTime?: number;
  warmup?: number;
  trigger?: SkillTrigger;
}

function active(id: string, className: ClassName, effect: ActiveEffect, fields: ActiveFields): SkillDefinition {
  return { id, name: id, description: '', className, type: 'active', unlockLevel: 1, sortOrder: 1, activeEffects: [effect], ...fields };
}

function passive(id: string, className: ClassName, effect: PassiveEffect): SkillDefinition {
  return { id, name: id, description: '', className, type: 'passive', unlockLevel: 1, sortOrder: 0, passiveEffects: [effect] };
}

const PARTY: { name: string; pos: PartyGridPosition; className: ClassName; hp: number; damage: number; skills: SkillDefinition[] }[] = [
  {
    name: 'Knight', pos: 5, className: 'Knight', hp: 2600, damage: 30, skills: [
      passive('guard', 'Knight', { kind: 'physical_reduction', valuePerLevel: 2 }),
      active('bash', 'Knight', { kind: 'stun_single', stunChance: 0.3 }, { cooldown: 2 }),
      active('intercept', 'Knight', { kind: 'redirect_hit' }, { cooldown: 2, trigger: 'ally_targeted' }),
      active('slam', 'Knight', { kind: 'brace_reflect', reflectPercent: 0.1 }, { cooldown: 1, trigger: 'self_hit' }),
      active('dispel', 'Knight', { kind: 'remove_buffs' }, { cooldown: 5, trigger: 'enemy_cast' }),
    ],
  },
  {
    name: 'Archer', pos: 2, className: 'Archer', hp: 1400, damage: 35, skills: [
      passive('pierce', 'Archer', { kind: 'crit_chance', flatValue: 0.2 }),
      active('snipe', 'Archer', { kind: 'ignore_dr_single', damagePercent: 2 }, { cooldown: 5, castTime: 1 }),
      active('bleed', 'Archer', { kind: 'dot_attack', dotPercent: 0.3, dotTicks: 3 }, { cooldown: 3, warmup: 1 }),
    ],
  },
  {
    name: 'Priest', pos: 0, className: 'Priest', hp: 1300, damage: 12, skills: [
      passive('tempo', 'Priest', { kind: 'cooldown_reduction', flatValue: 1, partyWide: true }),
      active('heal', 'Priest', { kind: 'heal_lowest', healMultiplier: 6 }, { cooldown: 2 }),
      active('cure', 'Priest', { kind: 'cure_debuffs' }, { cooldown: 3, trigger: 'ally_afflicted' }),
      active('mending', 'Priest', { kind: 'hot_lowest', healMultiplier: 2, dotTicks: 3 }, { cooldown: 4, trigger: 'ally_low_hp' }),
    ],
  },
  {
    name: 'Mage', pos: 8, className: 'Mage', hp: 1200, damage: 32, skills: [
      passive('ignite', 'Mage', { kind: 'dot_on_auto', dotPercent: 0.1 }),
      active('blizzard', 'Mage', { kind: 'damage_aoe_all', damagePercent: 0.6 }, { cooldown: 6, castTime: 1.5 }),
      active('zap', 'Mage', { kind: 'damage_percent', damagePercent: 0.75 }, { cooldown: 1 }),
    ],
  },
  {
    name: 'Bard', pos: 3, className: 'Bard', hp: 1300, damage: 18, skills: [
      active('song', 'Bard', { kind: 'party_buff_permanent', buffPercent: 0.1 }, { cooldown: 4, warmup: 0 }),
      active('drumroll', 'Bard', { kind: 'stun_aoe', stunChance: 0.25 }, { cooldown: 4, trigger: 'enemy_cast' }),
    ],
  },
];

const MONSTERS: (Partial<MonsterDefinition> & { pos: PartyGridPosition })[] = [
  {
    pos: 4, id: 'boss', name: 'Warlord', hp: 14000, damage: 90, tier: 'boss', level: 13, attackInterval: 1.2,
    skills: [{ skillId: 'fireball', value: 40, cooldown: 6 }, { skillId: 'fear', value: 0, cooldown: 9 }, { skillId: 'rot', value: 8, cooldown: 4 }],
    enrage: { afterSeconds: 60, stepSeconds: 10, stepPercent: 0.2, maxStacks: 6 },
  },
  { pos: 1, id: 'shaman', name: 'Shaman', hp: 900, damage: 12, skills: [{ skillId: 'heal', value: 200, cooldown: 3 }, { skillId: 'assassinate', value: 160, cooldown: 5 }] },
  { pos: 0, id: 'wall', name: 'Wall', hp: 500, passive: true },
];

function party(): PartyCombatantInit[] {
  return PARTY.map(p => ({
    username: p.name,
    maxHp: p.hp,
    baseDamage: p.damage,
    playerDamageType: CLASS_DEFINITIONS[p.className].damageType,
    gridPosition: p.pos,
    className: p.className,
    level: 12,
    equippedSkills: p.skills,
  }));
}

function monsters() {
  return MONSTERS.map(({ pos, ...def }) => createMonsterInstance({
    id: 'dummy', name: 'Dummy', hp: 1000, damage: 0, damageType: 'physical', xp: 0, goldMin: 0, goldMax: 0, ...def,
  }, pos));
}

function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const OLD_CARD_LABELS: Record<string, string> = {
  dispel: 'interrupt', drumroll: 'interrupt', heal: 'support', song: 'enchantment',
  bash: 'attack', snipe: 'attack', bleed: 'attack', blizzard: 'attack', zap: 'attack',
};

/** The digests predate the merged cards, so they read those labels as they were then. Only the labels differ. */
function wire(value: unknown): string {
  return JSON.stringify(value, (_key, field) => {
    const oldLabel = field?.cardType ? OLD_CARD_LABELS[field.skillId ?? field.id] : undefined;
    return oldLabel ? { ...field, cardType: oldLabel } : field;
  }).replaceAll('"countered":true', '"cardType":"interrupt"');
}

function play(seed: number, setup: CombatSetup): string {
  const state = createPartyCombatState(party(), monsters(), setup);
  const rng = createRng(seed);
  const parts: string[] = [];
  while (!state.finished && state.elapsedMs < 400000) {
    const { events, logEntries } = processCombatStep(state, 100, rng);
    parts.push(wire(events), JSON.stringify(logEntries));
    if (state.tickCount % 25 === 0) parts.push(wire(buildClientCombatSnapshot(state, 1, true)));
  }
  return `${state.result}@${state.elapsedMs}:${digest(parts.join('\n'))}`;
}

/** Fights on content with no charge, recovery or attack skills, as digests of everything a client would see. */
export function legacyFightDigests(): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const seed of [1, 2, 3]) {
    digests[`authored-${seed}`] = play(seed, { pace: AUTHORED_PACE, bossPhases: { thresholds: [0.75, 0.5, 0.25] } });
    digests[`paced-${seed}`] = play(seed, { pace: COMBAT_PACE, bossPhases: { thresholds: [0.75, 0.5, 0.25] } });
  }
  return digests;
}
