import { describe, expect, it } from 'vitest';
import { ALL_CLASS_NAMES, COMBAT_PACE, paceActionSeconds } from '@idle-party-rpg/shared';
import type { SkillDefinition } from '@idle-party-rpg/shared';
import {
  classAttackSkill,
  formatSeconds,
  renderSkillCardChip,
  renderSkillCardMeta,
  skillComputedLine,
  skillMetaParts,
  summarizeSkillCard,
} from '../src/ui/SkillCardChip';

const action = (seconds: number, className: string): string => formatSeconds(seconds * paceActionSeconds(COMBAT_PACE, className));
const knightAction = (seconds: number): string => action(seconds, 'Knight');
const reaction = (seconds: number): string => formatSeconds(seconds * COMBAT_PACE.clock);

function skill(overrides: Partial<SkillDefinition>): SkillDefinition {
  return {
    id: 'test_skill',
    name: 'Test Skill',
    description: '',
    className: 'Knight',
    type: 'active',
    unlockLevel: 1,
    sortOrder: 0,
    activeEffects: [{ kind: 'aoe_damage', valuePerLevel: 1 } as never],
    ...overrides,
  };
}

describe('formatSeconds', () => {
  it('drops trailing zeros and float noise', () => {
    expect(formatSeconds(1)).toBe('1s');
    expect(formatSeconds(1.5)).toBe('1.5s');
    expect(formatSeconds(0.1 + 0.2)).toBe('0.3s');
  });
});

describe('summarizeSkillCard', () => {
  it('shows the cooldown in real seconds, defaulting to one authored second for actives', () => {
    expect(summarizeSkillCard(skill({ cooldown: 3 })).cooldown).toBe(`CD ${knightAction(3)}`);
    expect(summarizeSkillCard(skill({ cooldown: undefined })).cooldown).toBe(`CD ${knightAction(1)}`);
  });

  it('shows cast time in real seconds only when positive', () => {
    expect(summarizeSkillCard(skill({ castTime: 1.5 })).castTime).toBe(`Cast ${knightAction(1.5)}`);
    expect(summarizeSkillCard(skill({ castTime: 0 })).castTime).toBeNull();
    expect(summarizeSkillCard(skill({})).castTime).toBeNull();
  });

  it('times actions by the skill\'s class and reactions by the clock', () => {
    for (const className of ALL_CLASS_NAMES) {
      expect(summarizeSkillCard(skill({ className, cooldown: 3, castTime: 1 })))
        .toMatchObject({
          cooldown: `CD ${action(3, className)}`,
          castTime: `Cast ${action(1, className)}`,
        });
      expect(summarizeSkillCard(skill({ className, cooldown: 3, trigger: 'enemy_cast' })).cooldown).toBe(`CD ${reaction(3)}`);
    }
  });

  it('times a cross-class action by an explicit owner class, and leaves reactions on the clock', () => {
    expect(action(3, 'Priest')).not.toBe(action(3, 'Knight'));
    for (const className of ALL_CLASS_NAMES) {
      expect(summarizeSkillCard(skill({ className: 'Knight', cooldown: 3, castTime: 1 }), className))
        .toMatchObject({
          cooldown: `CD ${action(3, className)}`,
          castTime: `Cast ${action(1, className)}`,
        });
      expect(summarizeSkillCard(skill({ className: 'Knight', cooldown: 3, trigger: 'enemy_cast' }), className).cooldown).toBe(`CD ${reaction(3)}`);
    }
  });

  describe('charge and recovery', () => {
    const attack = skill({ id: 'knight_attack', type: 'attack', activeEffects: undefined, charge: 3.6, recovery: 0 });

    it('replaces the cooldown on a skill that has them', () => {
      expect(summarizeSkillCard(skill({ cooldown: 3, charge: 6.3, recovery: 0.9 })))
        .toMatchObject({ cooldown: null, charge: 'Charge 6.3s', recovery: 'Recovery 0.9s' });
    });

    it('reads a missing field as 0 when the other is set', () => {
      expect(skillMetaParts(skill({ recovery: 1.8 }))).toEqual(['Charge 0s', 'Recovery 1.8s']);
      expect(skillMetaParts(skill({ charge: 2 }))).toEqual(['Charge 2s', 'Recovery 0s']);
    });

    it('shows the time the skill plays for, snapped to the fight\'s steps', () => {
      expect(summarizeSkillCard(skill({ charge: 3.65, recovery: 0.05 })))
        .toMatchObject({ charge: 'Charge 3.6s', recovery: 'Recovery 0.2s' });
    });

    it('keeps the cast and trigger alongside them', () => {
      expect(skillMetaParts(skill({ charge: 7, recovery: 0.5, castTime: 1 })))
        .toEqual(['Charge 7s', 'Recovery 0.5s', `Cast ${action(1, 'Knight')}`]);
      expect(skillMetaParts(skill({ charge: 1.8, trigger: 'ally_targeted' })))
        .toEqual(['Charge 1.8s', 'Trigger: Ally targeted']);
    });

    it('gives an instant no Recovery line, even with a stale value', () => {
      expect(summarizeSkillCard(skill({ charge: 9, recovery: 0.9, trigger: 'enemy_cast' }))).toMatchObject({ charge: 'Charge 9s', recovery: null });
      const inferred = skill({ charge: 1.8, recovery: 1.8, activeEffects: [{ kind: 'redirect_hit' } as never] });
      expect(summarizeSkillCard(inferred).recovery).toBeNull();
      expect(renderSkillCardMeta(inferred)).not.toContain('Recovery');
    });

    it('renders them on the card', () => {
      const html = renderSkillCardMeta(attack);
      expect(html).toContain('data-card-type="basic"');
      expect(html).toContain('Basic attack');
      expect(html).toContain('Charge 3.6s');
      expect(html).toContain('Recovery 0s');
      expect(html).not.toContain('CD ');
    });

    it('leaves content without them on today\'s text', () => {
      expect(summarizeSkillCard(skill({ cooldown: 3 }))).toMatchObject({ cooldown: `CD ${action(3, 'Knight')}`, charge: null, recovery: null });
      expect(skillMetaParts(skill({ cooldown: 3 }))).toEqual([`CD ${action(3, 'Knight')}`]);
    });

    it('ignores them on a passive, which never has any', () => {
      const s = summarizeSkillCard(skill({ type: 'passive', activeEffects: undefined, charge: 1 }));
      expect(s.charge).toBeNull();
      expect(s.recovery).toBeNull();
    });

    it('finds a class\'s Attack only when it has timing the engine will play', () => {
      expect(classAttackSkill('Knight', { knight_attack: attack })).toBe(attack);
      expect(classAttackSkill('Mage', { knight_attack: attack })).toBeUndefined();
      expect(classAttackSkill('Knight', { knight_attack: { ...attack, charge: undefined, recovery: undefined } })).toBeUndefined();
    });
  });

  it('labels explicit and inferred triggers', () => {
    expect(summarizeSkillCard(skill({ trigger: 'ally_low_hp' })).trigger).toBe('Ally below half health');
    const inferred = skill({ activeEffects: [{ kind: 'redirect_hit' } as never] });
    expect(summarizeSkillCard(inferred).trigger).toBe('Ally targeted');
    expect(summarizeSkillCard(inferred).cardType).toBe('instant');
  });

  it('gives passives no timing and a passive card type', () => {
    const passive = skill({
      type: 'passive',
      activeEffects: undefined,
      passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 1 } as never],
    });
    const s = summarizeSkillCard(passive);
    expect(s.cooldown).toBeNull();
    expect(s.castTime).toBeNull();
    expect(s.trigger).toBeNull();
    expect(s.cardType).toBe('passive');
  });
});

describe('skillMetaParts', () => {
  it('orders cooldown, cast time, trigger and omits absent parts', () => {
    expect(skillMetaParts(skill({ cooldown: 6, castTime: 1.5 }))).toEqual([`CD ${knightAction(6)}`, `Cast ${knightAction(1.5)}`]);
    expect(skillMetaParts(skill({ cooldown: 4, trigger: 'enemy_cast' })))
      .toEqual([`CD ${reaction(4)}`, 'Trigger: Enemy casts']);
  });
});

describe('rendering', () => {
  it('renders a chip with the card icon, label and type attribute', () => {
    const html = renderSkillCardChip(skill({ trigger: 'enemy_cast' }));
    const el = document.createElement('div');
    el.innerHTML = html;
    const chip = el.querySelector('.skill-card-chip')!;
    expect(chip.getAttribute('data-card-type')).toBe('instant');
    expect(chip.querySelector('.skill-card-chip-icon')!.textContent).toBe('⚡');
    expect(chip.querySelector('.skill-card-chip-label')!.textContent).toBe('Instant');
  });

  it('renders the meta line with timing parts and the trigger description as a tooltip', () => {
    const el = document.createElement('div');
    el.innerHTML = renderSkillCardMeta(skill({ cooldown: 2, trigger: 'ally_targeted' }));
    const meta = el.querySelector('.skill-card-meta')!;
    expect(meta.getAttribute('data-card-type')).toBe('instant');
    expect([...meta.querySelectorAll('.skill-card-meta-part')].map(p => p.textContent)).toEqual([`CD ${reaction(2)}`]);
    const trigger = meta.querySelector('.skill-card-meta-trigger')!;
    expect(trigger.textContent).toBe('Trigger: Ally targeted');
    expect(trigger.getAttribute('title')).toContain('single-target');
  });

  it('renders the meta line\'s timing for an explicit owner class', () => {
    const el = document.createElement('div');
    el.innerHTML = renderSkillCardMeta(skill({ className: 'Knight', cooldown: 3, castTime: 1 }), 'Priest');
    expect([...el.querySelectorAll('.skill-card-meta-part')].map(p => p.textContent))
      .toEqual([`CD ${action(3, 'Priest')}`, `Cast ${action(1, 'Priest')}`]);
  });
});

describe('skillComputedLine', () => {
  const guard = skill({
    type: 'passive',
    activeEffects: undefined,
    passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 2 }],
  });

  it('computes Guard/Bless-style mitigation against same-level enemies', () => {
    expect(skillComputedLine(guard)).toBe('≈50\u202f% vs enemies of your level');
    const weak = skill({ type: 'passive', activeEffects: undefined, passiveEffects: [{ kind: 'magical_reduction_party', valuePerLevel: 1 }] });
    expect(skillComputedLine(weak)).toBe('≈33\u202f% vs enemies of your level');
  });

  it('labels each rating when a skill has both', () => {
    const both = skill({
      type: 'passive',
      activeEffects: undefined,
      passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 2 }, { kind: 'magical_reduction_party', valuePerLevel: 1 }],
    });
    expect(skillComputedLine(both)).toBe('Physical ≈50\u202f% · Magical & holy ≈33\u202f% vs enemies of your level');
  });

  it('has no line for other skills', () => {
    expect(skillComputedLine(skill({}))).toBeNull();
    expect(skillComputedLine(skill({ type: 'passive', activeEffects: undefined, passiveEffects: [{ kind: 'crit_chance', flatValue: 0.2 }] }))).toBeNull();
  });

  it('appends the line to the meta row', () => {
    const el = document.createElement('div');
    el.innerHTML = renderSkillCardMeta(guard);
    expect(el.querySelector('.skill-card-meta-computed')!.textContent).toBe('≈50\u202f% vs enemies of your level');
  });
});
