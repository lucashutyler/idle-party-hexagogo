import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@idle-party-rpg/shared';
import {
  formatSeconds,
  renderSkillCardChip,
  renderSkillCardMeta,
  skillComputedLine,
  skillMetaParts,
  summarizeSkillCard,
} from '../src/ui/SkillCardChip';

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
  it('shows the cooldown in seconds, defaulting to 1s for actives', () => {
    expect(summarizeSkillCard(skill({ cooldown: 3 })).cooldown).toBe('CD 3s');
    expect(summarizeSkillCard(skill({ cooldown: undefined })).cooldown).toBe('CD 1s');
  });

  it('shows cast time only when positive', () => {
    expect(summarizeSkillCard(skill({ castTime: 1.5 })).castTime).toBe('Cast 1.5s');
    expect(summarizeSkillCard(skill({ castTime: 0 })).castTime).toBeNull();
    expect(summarizeSkillCard(skill({})).castTime).toBeNull();
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
    expect(skillMetaParts(skill({ cooldown: 6, castTime: 1.5 }))).toEqual(['CD 6s', 'Cast 1.5s']);
    expect(skillMetaParts(skill({ cooldown: 4, trigger: 'enemy_cast' })))
      .toEqual(['CD 4s', 'Trigger: Enemy casts']);
  });
});

describe('rendering', () => {
  it('renders a chip with the card icon, label and type attribute', () => {
    const html = renderSkillCardChip(skill({ trigger: 'enemy_cast' }));
    const el = document.createElement('div');
    el.innerHTML = html;
    const chip = el.querySelector('.skill-card-chip')!;
    expect(chip.getAttribute('data-card-type')).toBe('interrupt');
    expect(chip.querySelector('.skill-card-chip-icon')!.textContent).toBe('✋');
    expect(chip.querySelector('.skill-card-chip-label')!.textContent).toBe('Interrupt');
  });

  it('renders the meta line with timing parts and the trigger description as a tooltip', () => {
    const el = document.createElement('div');
    el.innerHTML = renderSkillCardMeta(skill({ cooldown: 2, trigger: 'ally_targeted' }));
    const meta = el.querySelector('.skill-card-meta')!;
    expect(meta.getAttribute('data-card-type')).toBe('instant');
    expect([...meta.querySelectorAll('.skill-card-meta-part')].map(p => p.textContent)).toEqual(['CD 2s']);
    const trigger = meta.querySelector('.skill-card-meta-trigger')!;
    expect(trigger.textContent).toBe('Trigger: Ally targeted');
    expect(trigger.getAttribute('title')).toContain('single-target');
  });
});

describe('skillComputedLine', () => {
  const guard = skill({
    type: 'passive',
    activeEffects: undefined,
    passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 2 }],
  });

  it('computes Guard/Bless-style mitigation against same-level enemies', () => {
    expect(skillComputedLine(guard)).toBe('≈50\u202f% vs same-level enemies');
    const weak = skill({ type: 'passive', activeEffects: undefined, passiveEffects: [{ kind: 'magical_reduction_party', valuePerLevel: 1 }] });
    expect(skillComputedLine(weak)).toBe('≈33\u202f% vs same-level enemies');
  });

  it('labels each rating when a skill has both', () => {
    const both = skill({
      type: 'passive',
      activeEffects: undefined,
      passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 2 }, { kind: 'magical_reduction_party', valuePerLevel: 1 }],
    });
    expect(skillComputedLine(both)).toBe('Physical ≈50\u202f% · Magical & holy ≈33\u202f% vs same-level enemies');
  });

  it('has no line for other skills', () => {
    expect(skillComputedLine(skill({}))).toBeNull();
    expect(skillComputedLine(skill({ type: 'passive', activeEffects: undefined, passiveEffects: [{ kind: 'crit_chance', flatValue: 0.2 }] }))).toBeNull();
  });

  it('appends the line to the meta row', () => {
    const el = document.createElement('div');
    el.innerHTML = renderSkillCardMeta(guard);
    expect(el.querySelector('.skill-card-meta-computed')!.textContent).toBe('≈50\u202f% vs same-level enemies');
  });
});
