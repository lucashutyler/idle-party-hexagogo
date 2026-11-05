import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CombatSkillBar } from '../src/combat/CombatSkillBar';

let root: HTMLElement;
let bar: CombatSkillBar;

const card = { id: 'bash', name: 'Bash', cardType: 'attack' as const };
const sweep = () => root.querySelector<HTMLElement>('.combat-skill-sweep')!;

function cooldown(remainingMs: number) {
  return { id: 'bash', state: remainingMs > 0 ? 'cooldown' as const : 'ready' as const, remainingMs, cooldownMs: 1000 };
}

beforeEach(() => {
  document.body.innerHTML = '<div class="combat-skillbar"></div>';
  root = document.querySelector('.combat-skillbar')!;
  bar = new CombatSkillBar(root, vi.fn());
});

describe('CombatSkillBar', () => {
  it('writes the cooldown on the sweep only, skipping changes too small to see', () => {
    bar.setLayout({ cards: [card], passives: [] });
    bar.update([cooldown(500)], false);
    expect(sweep().style.getPropertyValue('--cd')).toBe('0.50');
    expect(root.querySelector<HTMLElement>('.combat-skill')!.style.getPropertyValue('--cd')).toBe('');

    bar.update([cooldown(490)], false);
    expect(sweep().style.getPropertyValue('--cd')).toBe('0.50');
    bar.update([cooldown(470)], false);
    expect(sweep().style.getPropertyValue('--cd')).toBe('0.47');
  });

  it('always clears the sweep when the cooldown ends', () => {
    bar.setLayout({ cards: [card], passives: [] });
    bar.update([cooldown(10)], false);
    bar.update([cooldown(0)], false);
    expect(sweep().style.getPropertyValue('--cd')).toBe('0.00');
  });

  it('renders an actionable note as a link and a passing one as plain text', () => {
    bar.setLayout({ cards: [], passives: [], note: 'No active skill equipped', noteLinksToSkills: true });
    const link = root.querySelector<HTMLElement>('.combat-skillbar-note')!;
    expect(link.tagName).toBe('BUTTON');
    expect(link.dataset.nav).toBe('items:skills');
    expect(root.classList.contains('empty')).toBe(true);

    bar.setLayout({ cards: [card], passives: [], note: 'Joining next battle' });
    expect(root.querySelector('.combat-skillbar-note')!.tagName).toBe('SPAN');
    expect(root.classList.contains('empty')).toBe(false);
  });
});
