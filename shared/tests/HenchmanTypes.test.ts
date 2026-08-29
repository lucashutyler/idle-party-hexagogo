import { describe, it, expect } from 'vitest';
import { buildHenchmanCombatant, henchmanDisplayNames } from '../src/systems/HenchmanTypes.js';
import type { HenchmanDefinition, HiredHenchman } from '../src/systems/HenchmanTypes.js';
import type { SkillDefinition } from '../src/systems/SkillTypes.js';

function makeDef(overrides: Partial<HenchmanDefinition> = {}): HenchmanDefinition {
  return {
    id: 'hench_a',
    name: 'Grim',
    className: 'Knight',
    level: 4,
    maxHp: 90,
    baseDamage: 7,
    skillIds: [],
    emoji: '🗡️',
    ...overrides,
  };
}

function makeHire(overrides: Partial<HiredHenchman> = {}): HiredHenchman {
  return {
    instanceId: 'h1',
    henchmanId: 'hench_a',
    gridPosition: 3,
    mapId: 'overworld',
    ...overrides,
  };
}

const noSkills = () => undefined;

describe('henchmanDisplayNames', () => {
  it('leaves distinct names untouched', () => {
    expect(henchmanDisplayNames(['Grim', 'Vera'])).toEqual(['Grim', 'Vera']);
  });

  it('disambiguates repeats so one battle cannot hold two identical names', () => {
    // Names key DoT sourceUsername and heal-target prose, and a party may hold
    // two hires of the same definition.
    expect(henchmanDisplayNames(['Grim', 'Grim', 'Grim'])).toEqual(['Grim', 'Grim #2', 'Grim #3']);
  });

  it('disambiguates each repeated name independently', () => {
    expect(henchmanDisplayNames(['Grim', 'Vera', 'Grim'])).toEqual(['Grim', 'Vera', 'Grim #2']);
  });

  it('renames a henchman that collides with a real party member', () => {
    // The dangerous case: the FIRST hire, unsuffixed, sharing a name with an
    // account. Two combatants with one username break DoT attribution, heal
    // targeting, and the client's "You" substitution.
    expect(henchmanDisplayNames(['Grim'], ['Grim'])).toEqual(['Grim #2']);
  });

  it('keeps a henchman name that collides with nobody', () => {
    expect(henchmanDisplayNames(['Grim'], ['alice'])).toEqual(['Grim']);
  });

  it('resolves a collision against both an account and another henchman', () => {
    expect(henchmanDisplayNames(['Grim', 'Grim'], ['Grim'])).toEqual(['Grim #2', 'Grim #3']);
  });

  it('returns an empty list for an empty party', () => {
    expect(henchmanDisplayNames([])).toEqual([]);
  });
});

describe('buildHenchmanCombatant', () => {
  it('builds a full-health combatant from fixed definition stats', () => {
    const c = buildHenchmanCombatant(makeDef(), makeHire(), noSkills, 'Grim');

    expect(c.username).toBe('Grim');
    expect(c.isHenchman).toBe(true);
    expect(c.maxHp).toBe(90);
    expect(c.currentHp).toBe(90);
    expect(c.baseDamage).toBe(7);
    expect(c.className).toBe('Knight');
    expect(c.level).toBe(4);
    expect(c.gridPosition).toBe(3);
  });

  it('carries no equipment or set bonuses — a henchman has neither', () => {
    const c = buildHenchmanCombatant(makeDef(), makeHire(), noSkills, 'Grim');

    expect(c.equipBonuses).toBeUndefined();
    expect(c.setBonuses).toBeUndefined();
  });

  it('defaults damage type to physical and honours an override', () => {
    expect(buildHenchmanCombatant(makeDef(), makeHire(), noSkills, 'Grim').playerDamageType).toBe('physical');
    expect(
      buildHenchmanCombatant(makeDef({ damageType: 'holy' }), makeHire(), noSkills, 'Grim').playerDamageType,
    ).toBe('holy');
  });

  it('resolves equipped skills through the provided resolver', () => {
    const skill = { id: 'skill_a', name: 'Cleave' } as unknown as SkillDefinition;
    const c = buildHenchmanCombatant(
      makeDef({ skillIds: ['skill_a'] }),
      makeHire(),
      id => (id === 'skill_a' ? skill : undefined),
      'Grim',
    );

    expect(c.equippedSkills).toEqual([skill]);
  });

  it('turns an unresolvable skill id into an empty slot rather than throwing', () => {
    // This runs inside the battle timer's interval callback, which has no
    // try/catch above it — a throw here would take down the process, not one
    // party. A live server may simply not hold the skill.
    expect(() =>
      buildHenchmanCombatant(makeDef({ skillIds: ['missing'] }), makeHire(), noSkills, 'Grim'),
    ).not.toThrow();

    const c = buildHenchmanCombatant(makeDef({ skillIds: ['missing', 'also_missing'] }), makeHire(), noSkills, 'Grim');
    expect(c.equippedSkills).toEqual([null, null]);
  });

  it('floors a fractional maxHp to at least 1 so a combatant is never born dead', () => {
    const c = buildHenchmanCombatant(makeDef({ maxHp: 0 }), makeHire(), noSkills, 'Grim');
    expect(c.maxHp).toBe(1);
    expect(c.currentHp).toBe(1);
  });

  it('clamps a negative baseDamage to zero', () => {
    expect(buildHenchmanCombatant(makeDef({ baseDamage: -5 }), makeHire(), noSkills, 'Grim').baseDamage).toBe(0);
  });

  it('starts with clean per-battle combat state', () => {
    const c = buildHenchmanCombatant(makeDef(), makeHire(), noSkills, 'Grim');

    expect(c.dots).toEqual([]);
    expect(c.hots).toEqual([]);
    expect(c.debuffs).toEqual([]);
    expect(c.damageShield).toBe(0);
    expect(c.stunTurns).toBe(0);
    expect(c.attackCount).toBe(0);
    expect(c.hasResurrected).toBe(false);
  });
});
