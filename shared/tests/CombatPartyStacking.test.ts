import { describe, expect, it } from 'vitest';
import { createPartyCombatState, processCombatStep } from '../src/systems/CombatEngine';
import type { PartyCombatState } from '../src/systems/CombatEngine';
import type { ActiveEffect, PassiveEffect, SkillDefinition } from '../src/systems/SkillTypes';
import type { ClassName } from '../src/systems/CharacterStats';
import { useCooldownMs } from '../src/systems/combat/CombatPassives';
import { AUTHORED_PACE } from '../src/systems/CombatPace';
import { validateSkillDefinition, SKILL_OPTION_CATALOG } from '../src/systems/SkillOptionCatalog';
import { getSkillCardType } from '../src/systems/SkillTypes';
import { makeMonster, makePlayer } from './combatTestUtils';
import type { PlayerOptions } from './combatTestUtils';

function passive(className: ClassName, ...passiveEffects: PassiveEffect[]): SkillDefinition {
  return { id: `p_${passiveEffects[0].kind}`, name: 'Passive', description: '', className, type: 'passive', unlockLevel: 1, sortOrder: 0, passiveEffects };
}

function active(className: ClassName, ...activeEffects: ActiveEffect[]): SkillDefinition {
  return { id: 'a', name: 'Active', description: '', className, type: 'active', unlockLevel: 1, sortOrder: 0, cooldown: 1, warmup: 0, activeEffects };
}

function fight(players: { name: string; opts: PlayerOptions }[]): PartyCombatState {
  const inits = players.map((p, i) => makePlayer(p.name, i as 0, p.opts));
  return createPartyCombatState(inits, [makeMonster(4, { hp: 100_000 })]);
}

const rally = (flatValue: number, extra: Partial<PassiveEffect> = {}): SkillDefinition =>
  passive('Bard', { kind: 'party_damage_mult', flatValue, perPartyMember: true, ...extra });

function bard(name: string, skill: SkillDefinition, level = 1) {
  return { name, opts: { className: 'Bard' as const, level, skills: [skill] } };
}

function other(name: string, className: ClassName, isHenchman = false) {
  return { name, opts: { className, isHenchman } };
}

describe('Rally per different class', () => {
  const distinct = rally(0.1, { perDistinctClass: true, stackGroup: 'rally', stackFactor: 0 });

  it('scales by the different classes in the fight, not by heads', () => {
    expect(fight([bard('a', distinct), other('b', 'Knight'), other('c', 'Knight')]).rallyMultiplier).toBeCloseTo(0.2, 12);
    expect(fight([bard('a', distinct), other('b', 'Knight'), other('c', 'Mage')]).rallyMultiplier).toBeCloseTo(0.3, 12);
    expect(fight([bard('a', distinct)]).rallyMultiplier).toBeCloseTo(0.1, 12);
  });

  it('counts a hire as a different class', () => {
    expect(fight([bard('a', distinct), other('hire', 'Priest', true)]).rallyMultiplier).toBeCloseTo(0.2, 12);
  });

  it('takes the strongest copy only with a factor of 0', () => {
    const weak = rally(0.05, { perDistinctClass: true, stackGroup: 'rally', stackFactor: 0 });
    expect(fight([bard('a', weak), bard('b', distinct)]).rallyMultiplier).toBeCloseTo(0.1, 12);
  });

  it('keeps counting heads and adding copies on content without the new fields', () => {
    const old = rally(0.2);
    expect(fight([bard('a', old), bard('b', old), other('c', 'Knight')]).rallyMultiplier).toBeCloseTo(1.2, 12);
  });
});

describe('stackGroup', () => {
  it('weights each further copy by the factor of the one before, strongest first', () => {
    const copy = (flatValue: number) => rally(flatValue, { stackGroup: 'g', stackFactor: 0.5 });
    const state = fight([bard('a', copy(0.1)), bard('b', copy(0.3)), bard('c', copy(0.2))]);
    expect(state.rallyMultiplier).toBeCloseTo(3 * (0.3 + 0.2 * 0.5 + 0.1 * 0.25), 12);
  });

  it('reads no factor as counting in full', () => {
    const copy = rally(0.1, { stackGroup: 'g' });
    expect(fight([bard('a', copy), bard('b', copy)]).rallyMultiplier).toBeCloseTo(2 * (0.1 + 0.1), 12);
  });

  it('keeps separate groups and ungrouped copies apart', () => {
    const state = fight([
      bard('a', rally(0.1, { stackGroup: 'g', stackFactor: 0 })),
      bard('b', rally(0.1, { stackGroup: 'g', stackFactor: 0 })),
      bard('c', rally(0.1, { stackGroup: 'h', stackFactor: 0 })),
      bard('d', rally(0.1)),
    ]);
    expect(state.rallyMultiplier).toBeCloseTo(4 * 0.3, 12);
  });

  it('applies to Blessed Arms at each owner\'s level', () => {
    const arms = (extra: Partial<PassiveEffect> = {}) => passive('Priest', { kind: 'holy_damage_party', valuePerLevel: 1, ...extra });
    const priest = (name: string, level: number, skill: SkillDefinition) => ({ name, opts: { className: 'Priest' as const, level, skills: [skill] } });
    const stacked = arms({ stackGroup: 'arms', stackFactor: 0.85 });
    expect(fight([priest('a', 10, stacked), priest('b', 20, stacked)]).blessedArmsDamage).toBeCloseTo(20 + 10 * 0.85, 12);
    expect(fight([priest('a', 10, arms()), priest('b', 20, arms())]).blessedArmsDamage).toBe(30);
  });

  describe('party-wide cooldown reduction', () => {
    const partyCdr = (extra: Partial<PassiveEffect> = {}) => passive('Bard', { kind: 'cooldown_reduction', flatValue: 1, partyWide: true, ...extra });
    const timed: SkillDefinition = { id: 'nuke', name: 'Nuke', description: '', className: 'Mage', type: 'active', unlockLevel: 1, sortOrder: 0, cooldown: 10, activeEffects: [{ kind: 'high_damage_single', damagePercent: 1 }] };

    function cooldownOf(party: { name: string; opts: PlayerOptions }[]): number {
      const state = fight([{ name: 'mage', opts: { className: 'Mage', skills: [timed] } }, ...party]);
      const mage = state.players.find(p => p.username === 'mage')!;
      return useCooldownMs(AUTHORED_PACE, mage, timed, state.players);
    }

    it('adds copies without a group', () => {
      expect(cooldownOf([bard('a', partyCdr()), bard('b', partyCdr())])).toBe(8000);
    });

    it('takes one copy with a group and a factor of 0', () => {
      const one = partyCdr({ stackGroup: 'g', stackFactor: 0 });
      expect(cooldownOf([bard('a', one), bard('b', one)])).toBe(9000);
    });

    it('counts the owner\'s own copy in the group, not on top of it', () => {
      const one = partyCdr({ stackGroup: 'g', stackFactor: 0 });
      const state = fight([
        { name: 'owner', opts: { className: 'Bard', skills: [one, timed] } },
        { name: 'other', opts: { className: 'Bard', skills: [one] } },
      ]);
      const owner = state.players.find(p => p.username === 'owner')!;
      expect(useCooldownMs(AUTHORED_PACE, owner, timed, state.players)).toBe(9000);
    });
  });
});

describe('same_class_damage', () => {
  const sameClass = passive('Knight', { kind: 'same_class_damage', flatValue: 0.25 });

  /** The owner's first auto-attack damage, with variance pinned. */
  function firstHit(party: { name: string; opts: PlayerOptions }[]): number {
    const state = createPartyCombatState(party.map((p, i) => makePlayer(p.name, i as 0, p.opts)), [makeMonster(4, { hp: 1_000_000 })]);
    for (let i = 0; i < 200; i++) {
      const tick = processCombatStep(state, undefined, () => 0.5);
      const hit = tick.events.find(e => e.kind === 'damage' && e.src?.side === 'player' && e.src.pos === state.players.find(p => p.username === 'owner')!.gridPosition);
      if (hit) return hit.amount!;
    }
    throw new Error('no hit');
  }
  const owner = { name: 'owner', opts: { className: 'Knight' as const, baseDamage: 100, skills: [sameClass] } };
  const knight = (name: string, isHenchman = false) => ({ name, opts: { className: 'Knight' as const, isHenchman, baseDamage: 1 } });

  it('adds damage per other living human of the class', () => {
    const alone = firstHit([owner]);
    expect(firstHit([owner, knight('b')])).toBe(Math.floor(alone * 1.25));
    expect(firstHit([owner, knight('b'), knight('c')])).toBe(Math.floor(alone * 1.5));
  });

  it('does not count hires or other classes', () => {
    const alone = firstHit([owner]);
    expect(firstHit([owner, knight('hire', true)])).toBe(alone);
    expect(firstHit([owner, { name: 'b', opts: { className: 'Mage', baseDamage: 1 } }])).toBe(alone);
  });

  it('stops counting an ally who has fallen', () => {
    const state = createPartyCombatState([makePlayer('owner', 0, owner.opts), makePlayer('b', 1, knight('b').opts)], [makeMonster(4, { hp: 1_000_000 })]);
    state.players.find(p => p.username === 'b')!.currentHp = 0;
    for (let i = 0; i < 200; i++) {
      const hit = processCombatStep(state, undefined, () => 0.5).events.find(e => e.kind === 'damage');
      if (hit) {
        expect(hit.amount).toBe(firstHit([owner]));
        return;
      }
    }
    throw new Error('no hit');
  });

  it('is a passive card, valid in the catalog', () => {
    expect(SKILL_OPTION_CATALOG.same_class_damage.slotType).toBe('passive');
    expect(getSkillCardType(sameClass)).toBe('passive');
    expect(validateSkillDefinition(sameClass)).toEqual([]);
    expect(validateSkillDefinition(passive('Knight', { kind: 'same_class_damage' }))).not.toEqual([]);
  });
});

describe('sameClassBonus', () => {
  const flatAoe = active('Bard', { kind: 'damage_aoe_all', damagePerLevel: 10, sameClassBonus: 0.25 });

  function firstFlatHit(party: { name: string; opts: PlayerOptions }[]): number {
    const state = createPartyCombatState(party.map((p, i) => makePlayer(p.name, i as 0, p.opts)), [makeMonster(4, { hp: 1_000_000 })]);
    const pos = state.players.find(p => p.username === 'owner')!.gridPosition;
    for (let i = 0; i < 200; i++) {
      const hit = processCombatStep(state, undefined, () => 0.5).events.find(e => e.kind === 'damage' && e.src?.side === 'player' && e.src.pos === pos);
      if (hit) return hit.amount!;
    }
    throw new Error('no hit');
  }
  const owner = { name: 'owner', opts: { className: 'Bard' as const, level: 10, baseDamage: 0, skills: [flatAoe] } };
  const ally = (isHenchman: boolean) => ({ name: isHenchman ? 'hire' : 'ally', opts: { className: 'Bard' as const, isHenchman, baseDamage: 0 } });

  it('grows with other living humans of the class', () => {
    const alone = firstFlatHit([owner]);
    expect(alone).toBeGreaterThan(0);
    expect(firstFlatHit([owner, ally(false)])).toBe(Math.floor(alone * 1.25));
  });

  it('does not count hires', () => {
    expect(firstFlatHit([owner, ally(true)])).toBe(firstFlatHit([owner]));
  });

  it('validates as a percent option', () => {
    expect(validateSkillDefinition({ ...flatAoe, cooldown: 2 })).toEqual([]);
  });
});

describe('catalog validation of the stack fields', () => {
  it('accepts a stack group and factor on party options', () => {
    expect(validateSkillDefinition(rally(0.1, { perDistinctClass: true, stackGroup: 'rally', stackFactor: 0 }))).toEqual([]);
  });

  it('rejects a bad factor, group or flag', () => {
    expect(validateSkillDefinition(rally(0.1, { stackFactor: 1.5 }))).not.toEqual([]);
    expect(validateSkillDefinition(rally(0.1, { stackFactor: -1 }))).not.toEqual([]);
    expect(validateSkillDefinition(rally(0.1, { stackGroup: '  ' }))).not.toEqual([]);
    expect(validateSkillDefinition(rally(0.1, { stackGroup: 3 as unknown as string }))).not.toEqual([]);
    expect(validateSkillDefinition(rally(0.1, { perDistinctClass: 'yes' as unknown as boolean }))).not.toEqual([]);
  });
});
