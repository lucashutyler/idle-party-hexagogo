import { describe, it, expect } from 'vitest';
import {
  SKILL_OPTION_CATALOG,
  SKILL_CONDITION_VALUES,
  ALL_PASSIVE_EFFECT_KINDS,
  ALL_ACTIVE_EFFECT_KINDS,
  validateSkillDefinition,
} from '../src/systems/SkillOptionCatalog';
import { SEED_SKILLS } from '../src/systems/SkillTypes';
import { SKILL_TRIGGER_VALUES } from '../src/systems/SkillTypes';
import type { SkillDefinition } from '../src/systems/SkillTypes';

function makeActive(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 'test_active',
    name: 'Test Active',
    description: 'd',
    className: 'Mage',
    type: 'active',
    unlockLevel: 5,
    sortOrder: 1,
    cooldown: 2,
    activeEffects: [{ kind: 'damage_percent', damagePercent: 0.75 }],
    ...overrides,
  };
}

function makePassive(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 'test_passive',
    name: 'Test Passive',
    description: 'd',
    className: 'Knight',
    type: 'passive',
    unlockLevel: 1,
    sortOrder: 0,
    passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 2 }],
    ...overrides,
  };
}

describe('SKILL_OPTION_CATALOG', () => {
  it('covers all 27 passive and 23 active kinds exactly once (50 total)', () => {
    expect(ALL_PASSIVE_EFFECT_KINDS).toHaveLength(27);
    expect(ALL_ACTIVE_EFFECT_KINDS).toHaveLength(23);
    expect(new Set([...ALL_PASSIVE_EFFECT_KINDS, ...ALL_ACTIVE_EFFECT_KINDS]).size).toBe(50);
    expect(Object.keys(SKILL_OPTION_CATALOG)).toHaveLength(50);
    for (const kind of ALL_PASSIVE_EFFECT_KINDS) {
      expect(SKILL_OPTION_CATALOG[kind], `missing catalog entry for ${kind}`).toBeDefined();
      expect(SKILL_OPTION_CATALOG[kind].kind).toBe(kind);
      expect(SKILL_OPTION_CATALOG[kind].slotType).toBe('passive');
    }
    for (const kind of ALL_ACTIVE_EFFECT_KINDS) {
      expect(SKILL_OPTION_CATALOG[kind], `missing catalog entry for ${kind}`).toBeDefined();
      expect(SKILL_OPTION_CATALOG[kind].kind).toBe(kind);
      expect(SKILL_OPTION_CATALOG[kind].slotType).toBe('active');
    }
  });

  it('every entry has a label, description, targeting, and seed example', () => {
    for (const option of Object.values(SKILL_OPTION_CATALOG)) {
      expect(option.label.trim()).not.toBe('');
      expect(option.description.trim()).not.toBe('');
      expect(option.targeting.trim()).not.toBe('');
      expect(option.seedExample.trim()).not.toBe('');
      expect(Array.isArray(option.params)).toBe(true);
    }
  });

  it('first-match kinds document their non-stacking behavior', () => {
    // These kinds resolve via first-match (getPassiveValue) — duplicates don't stack.
    for (const kind of ['martyr', 'scorch', 'resurrection', 'stun_on_phys_hit', 'intensify', 'stacking_same_target', 'healing_received_bonus']) {
      expect(SKILL_OPTION_CATALOG[kind].description.toLowerCase()).toContain('first');
    }
  });

  it('shared-debuff-bucket kinds document their collision behavior', () => {
    expect(SKILL_OPTION_CATALOG.scorch.description).toContain('scorch');
    expect(SKILL_OPTION_CATALOG.enemy_debuff_aoe.description).toContain('lullaby');
    expect(SKILL_OPTION_CATALOG.debuff_attack.description).toContain('crippling_shot');
    // DoT grouping by skill name
    expect(SKILL_OPTION_CATALOG.dot_attack.description).toContain('skill name');
    expect(SKILL_OPTION_CATALOG.dot_on_auto.description).toContain('skill name');
  });

  it('describes timing in seconds, pulses and actions — never turns or rounds', () => {
    for (const option of Object.values(SKILL_OPTION_CATALOG)) {
      const text = `${option.label} ${option.description} ${option.params.map(p => p.label).join(' ')}`.toLowerCase();
      expect(text, option.kind).not.toMatch(/\bturns?\b|\brounds?\b|every nth/);
    }
    expect(SKILL_OPTION_CATALOG.cooldown_reduction.description.toLowerCase()).toContain('second');
  });

  it('exposes the three engine condition strings', () => {
    expect([...SKILL_CONDITION_VALUES]).toEqual(['target_above_75_hp', 'front_column', 'target_bleeding_or_stunned']);
  });
});

describe('validateSkillDefinition', () => {
  it('accepts every seed skill', () => {
    for (const skill of Object.values(SEED_SKILLS)) {
      expect(validateSkillDefinition(skill), `seed skill ${skill.id} should validate`).toEqual([]);
    }
  });

  it('rejects an unknown option kind', () => {
    const def = makePassive({ passiveEffects: [{ kind: 'nonsense' as never }] });
    const errors = validateSkillDefinition(def);
    expect(errors.some(e => e.includes('Unknown') && e.includes('nonsense'))).toBe(true);
  });

  it('rejects an active kind placed in passiveEffects (wrong slotType array)', () => {
    const def = makePassive({ passiveEffects: [{ kind: 'damage_percent' as never, damagePercent: 0.5 } as never] });
    const errors = validateSkillDefinition(def);
    expect(errors.some(e => e.includes('active kind'))).toBe(true);
  });

  it('rejects a passive kind placed in activeEffects', () => {
    const def = makeActive({ activeEffects: [{ kind: 'crit_chance' as never, flatValue: 0.2 } as never] });
    const errors = validateSkillDefinition(def);
    expect(errors.some(e => e.includes('passive kind'))).toBe(true);
  });

  it('rejects active options on a passive-type skill', () => {
    const def = makePassive({ activeEffects: [{ kind: 'damage_percent', damagePercent: 0.5 }] });
    const errors = validateSkillDefinition(def);
    expect(errors.some(e => e.includes('Passive skills cannot have active options'))).toBe(true);
  });

  it('requires a finite cooldown of at least 1 second on active skills (fractions allowed)', () => {
    for (const cooldown of [undefined, 0, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateSkillDefinition(makeActive({ cooldown })), `cooldown ${cooldown}`)
        .toContain('Active skills require a cooldown of at least 1 second.');
    }
    expect(validateSkillDefinition(makeActive({ cooldown: 1 }))).toEqual([]);
    expect(validateSkillDefinition(makeActive({ cooldown: 2.5 }))).toEqual([]);
  });

  it('rejects timing fields on passive skills', () => {
    const errors = validateSkillDefinition(makePassive({ cooldown: 2, castTime: 1, warmup: 1, trigger: 'self_hit' }));
    expect(errors).toEqual(expect.arrayContaining([
      'Cooldown only applies to active skills.',
      'Cast time only applies to active skills.',
      'Warm-up only applies to active skills.',
      'Trigger only applies to active skills.',
    ]));
  });

  it('bounds castTime to 0–10 s and warmup to 0–60 s', () => {
    expect(validateSkillDefinition(makeActive({ castTime: 0 }))).toEqual([]);
    expect(validateSkillDefinition(makeActive({ castTime: 10 }))).toEqual([]);
    expect(validateSkillDefinition(makeActive({ castTime: -1 })).some(e => e.includes('Cast time'))).toBe(true);
    expect(validateSkillDefinition(makeActive({ castTime: 10.5 })).some(e => e.includes('Cast time'))).toBe(true);
    expect(validateSkillDefinition(makeActive({ warmup: 0 }))).toEqual([]);
    expect(validateSkillDefinition(makeActive({ warmup: 60 }))).toEqual([]);
    expect(validateSkillDefinition(makeActive({ warmup: 61 })).some(e => e.includes('Warm-up'))).toBe(true);
    expect(validateSkillDefinition(makeActive({ warmup: -0.5 })).some(e => e.includes('Warm-up'))).toBe(true);
  });

  it('accepts every known trigger and rejects unknown ones', () => {
    for (const trigger of SKILL_TRIGGER_VALUES) {
      expect(validateSkillDefinition(makeActive({ trigger })), trigger).toEqual([]);
    }
    const errors = validateSkillDefinition(makeActive({ trigger: 'on_sneeze' as never }));
    expect(errors.some(e => e.includes('Unknown trigger') && e.includes('on_sneeze'))).toBe(true);
  });

  it('Intercept and Brace options need their trigger (explicit or inferred)', () => {
    const redirect = { activeEffects: [{ kind: 'redirect_hit' as const }] };
    const brace = { activeEffects: [{ kind: 'brace_reflect' as const, reflectPercent: 0.1 }] };
    expect(validateSkillDefinition(makeActive(redirect))).toEqual([]);
    expect(validateSkillDefinition(makeActive({ ...redirect, trigger: 'ally_targeted' }))).toEqual([]);
    expect(validateSkillDefinition(makeActive({ ...redirect, trigger: 'self_hit' })))
      .toContain('The Intercept attack option requires the "ally_targeted" trigger.');
    expect(validateSkillDefinition(makeActive(brace))).toEqual([]);
    expect(validateSkillDefinition(makeActive({ ...brace, trigger: 'ally_targeted' })))
      .toContain('The Brace and reflect option requires the "self_hit" trigger.');
    expect(validateSkillDefinition(makeActive({ activeEffects: [...redirect.activeEffects, ...brace.activeEffects] })))
      .toContain('A skill cannot combine the Intercept attack and Brace and reflect options.');
  });

  it('a triggered skill (explicit or inferred) cannot have a cast time', () => {
    expect(validateSkillDefinition(makeActive({ trigger: 'enemy_cast', castTime: 1 })))
      .toContain('Triggered skills cannot have a cast time.');
    expect(validateSkillDefinition(makeActive({ activeEffects: [{ kind: 'redirect_hit' }], castTime: 0.5 })))
      .toContain('Triggered skills cannot have a cast time.');
    expect(validateSkillDefinition(makeActive({ trigger: 'enemy_cast', castTime: 0 }))).toEqual([]);
  });

  it('rejects params outside their min/max range', () => {
    const def = makeActive({ activeEffects: [{ kind: 'stun_single', stunChance: 1.5 }] });
    const errors = validateSkillDefinition(def);
    expect(errors.some(e => e.includes('at most'))).toBe(true);
  });

  it('rejects a missing required param', () => {
    const def = makeActive({ activeEffects: [{ kind: 'stun_single' }] });
    const errors = validateSkillDefinition(def);
    expect(errors.some(e => e.includes('missing required parameter'))).toBe(true);
  });

  it('rejects a skill with no options at all', () => {
    const def = makeActive({ activeEffects: [] });
    const errors = validateSkillDefinition(def);
    expect(errors.some(e => e.includes('at least one option'))).toBe(true);
  });

  it('validates unlockLevel range: null OK, 0 and 101 rejected', () => {
    expect(validateSkillDefinition(makePassive({ unlockLevel: null }))).toEqual([]);
    expect(validateSkillDefinition(makePassive({ unlockLevel: 0 })).some(e => e.includes('Unlock level'))).toBe(true);
    expect(validateSkillDefinition(makePassive({ unlockLevel: 101 })).some(e => e.includes('Unlock level'))).toBe(true);
  });

  it('rejects an invalid targetClass and an invalid condition', () => {
    const badClass = makePassive({
      passiveEffects: [{ kind: 'conditional_ally_damage', targetClass: 'Necromancer' as never, flatValue: 0.25 }],
    });
    expect(validateSkillDefinition(badClass).some(e => e.includes('valid class name'))).toBe(true);

    const badCondition = makePassive({
      passiveEffects: [{ kind: 'conditional_damage_bonus', flatValue: 0.15, condition: 'target_asleep' }],
    });
    expect(validateSkillDefinition(badCondition).some(e => e.includes('must be one of'))).toBe(true);
  });

  it('rejects missing name/id/class/type', () => {
    const errors = validateSkillDefinition({
      id: '', name: ' ', description: 'd', className: 'Wizard' as never, type: 'aura' as never,
      unlockLevel: 1, sortOrder: 0,
      passiveEffects: [{ kind: 'crit_chance', flatValue: 0.2 }],
    });
    expect(errors.some(e => e.includes('id'))).toBe(true);
    expect(errors.some(e => e.includes('name'))).toBe(true);
    expect(errors.some(e => e.includes('Unknown class'))).toBe(true);
    expect(errors.some(e => e.includes('passive'))).toBe(true);
  });
});
