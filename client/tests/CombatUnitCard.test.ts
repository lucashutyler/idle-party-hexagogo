import { describe, expect, it } from 'vitest';
import { UnitCard } from '../src/combat/CombatUnitCard';
import type { CardIdentity } from '../src/combat/CombatUnitCard';
import type { PlaybackUnit } from '../src/combat/CombatPlayback';
import { monsterLevelBadge } from '../src/combat/CombatFormat';

function identity(overrides: Partial<CardIdentity> = {}): CardIdentity {
  return { name: 'Goblin Chieftain', isSelf: false, henchman: false, passive: false, ...overrides };
}

function unit(overrides: Partial<PlaybackUnit> = {}): PlaybackUnit {
  return {
    key: 'monster:4', side: 'monster', pos: 4, hp: 50, maxHp: 100, shield: 0, stunMs: 0, stunTotalMs: 0,
    actionMs: 500, actionTotalMs: 1000, intervalMs: 1000, intervalKnown: true, cast: null, statuses: [], skills: null,
    enrage: null, t0: 0, castEndedAt: -Infinity, attacks: 0, waitIsCast: false, ...overrides,
  };
}

describe('UnitCard level badge and tier frame', () => {
  it('shows an authored level coloured by the viewer and recolours when the viewer levels up', () => {
    const card = new UnitCard('monster:4', 'monster', 4);
    const badge = card.el.querySelector<HTMLElement>('.combat-card-level')!;
    card.setIdentity(identity({ level: monsterLevelBadge({ level: 6, levelSource: 'authored' }, 3) }));
    expect(card.el.classList.contains('has-level')).toBe(true);
    expect(badge.dataset.con).toBe('deadly');
    expect(badge.textContent).toBe('☠6');
    expect(badge.getAttribute('aria-label')).toBe('Level 6, Deadly');
    card.setIdentity(identity({ level: monsterLevelBadge({ level: 6, levelSource: 'authored' }, 6) }));
    expect(badge.dataset.con).toBe('even');
    expect(badge.getAttribute('aria-label')).toBe('Level 6, Even');
  });

  it('shows no number for derived levels', () => {
    const card = new UnitCard('monster:4', 'monster', 4);
    card.setIdentity(identity({ level: monsterLevelBadge({ level: 41, levelSource: 'derived' }, 3), tier: 'boss' }));
    expect(card.el.classList.contains('has-level')).toBe(false);
    expect(card.el.querySelector('.combat-card-level')!.textContent).toBe('');
    expect(card.el.dataset.tier).toBe('boss');
  });

  it('frames elite, boss and raid monsters and leaves trash plain', () => {
    const card = new UnitCard('monster:4', 'monster', 4);
    const glyph = card.el.querySelector('.combat-card-tier')!;
    card.setIdentity(identity({ tier: 'elite' }));
    expect(card.el.dataset.tier).toBe('elite');
    expect(glyph.textContent).toBe('◆');
    expect(card.el.title).toBe('Goblin Chieftain (Elite)');
    card.setIdentity(identity({ tier: 'trash' }));
    expect(card.el.dataset.tier).toBeUndefined();
    expect(glyph.textContent).toBe('');
    card.setIdentity(identity({ tier: 'raid' }));
    expect(card.el.dataset.tier).toBe('raid');
  });

  it('marks enraged units while they live', () => {
    const card = new UnitCard('monster:4', 'monster', 4);
    const enrage = { atMs: 0, stacks: 0, stepMs: 1000, stepPercent: 0.1, maxStacks: 5 };
    card.update(unit({ enrage }), 0);
    expect(card.el.classList.contains('enraged')).toBe(false);
    card.update(unit({ enrage: { ...enrage, stacks: 2 } }), 0);
    expect(card.el.classList.contains('enraged')).toBe(true);
    card.update(unit({ hp: 0, enrage: { ...enrage, stacks: 2 } }), 0);
    expect(card.el.classList.contains('enraged')).toBe(false);
  });
});
