import { describe, expect, it } from 'vitest';
import type { ItemDefinition } from '@idle-party-rpg/shared';
import { renderEquipCompareBlock } from '../src/ui/EquipCompare';

const ITEMS: Record<string, ItemDefinition> = {
  rusty_sword: { id: 'rusty_sword', name: 'Rusty Sword', rarity: 'common', equipSlot: 'mainhand', bonusAttackMin: 1, bonusAttackMax: 3 },
  sharp_sword: { id: 'sharp_sword', name: 'Sharp Sword', rarity: 'rare', equipSlot: 'mainhand', bonusAttackMin: 4, bonusAttackMax: 6 },
  twin_sword: { id: 'twin_sword', name: 'Twin Sword', rarity: 'common', equipSlot: 'mainhand', bonusAttackMin: 2, bonusAttackMax: 2 },
  small_shield: { id: 'small_shield', name: 'Small Shield', rarity: 'uncommon', equipSlot: 'offhand', damageReductionMin: 1, damageReductionMax: 2 },
  big_axe: { id: 'big_axe', name: 'Big Axe', rarity: 'uncommon', equipSlot: 'twohanded', bonusAttackMin: 3, bonusAttackMax: 6 },
  cap: { id: 'cap', name: 'Cap', rarity: 'common', equipSlot: 'head' },
  sneaky: { id: 'sneaky', name: '<b>Sneaky</b> & "Co"', rarity: 'common', equipSlot: 'mainhand', bonusAttackMin: 1, bonusAttackMax: 1 },
};

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

function row(root: HTMLElement, label: string): { new: string; arrow: string; old: string } | null {
  for (const el of root.querySelectorAll('.compare-row')) {
    if (el.querySelector('.compare-cell-label')?.textContent === label) {
      return {
        new: el.querySelector('.compare-cell-new')!.textContent!.trim(),
        arrow: el.querySelector('.compare-cell-arrow')!.textContent!.trim(),
        old: el.querySelector('.compare-cell-old')!.textContent!.trim(),
      };
    }
  }
  return null;
}

describe('renderEquipCompareBlock', () => {
  it('renders nothing when equipping would not displace anything', () => {
    expect(renderEquipCompareBlock(ITEMS.sharp_sword, { mainhand: null }, ITEMS)).toBe('');
    expect(renderEquipCompareBlock(ITEMS.sharp_sword, { mainhand: 'sharp_sword' }, ITEMS)).toBe('');
    expect(renderEquipCompareBlock(ITEMS.cap, { mainhand: 'rusty_sword' }, ITEMS)).toBe('');
  });

  it('renders nothing when the displaced item has no definition', () => {
    expect(renderEquipCompareBlock(ITEMS.sharp_sword, { mainhand: 'gone' }, ITEMS)).toBe('');
  });

  it('compares one-handed weapons with up, down and equal arrows', () => {
    const better = mount(renderEquipCompareBlock(ITEMS.sharp_sword, { mainhand: 'rusty_sword' }, ITEMS));
    expect(better.querySelector('.compare-block-old-name')?.textContent).toBe('Rusty Sword');
    expect(row(better, 'ATK')).toEqual({ new: '+4-6', arrow: '↑', old: '+1-3' });
    expect(better.querySelector('.compare-up')).toBeTruthy();

    const worse = mount(renderEquipCompareBlock(ITEMS.rusty_sword, { mainhand: 'sharp_sword' }, ITEMS));
    expect(row(worse, 'ATK')?.arrow).toBe('↓');
    expect(worse.querySelector('.compare-down')).toBeTruthy();

    const same = mount(renderEquipCompareBlock(ITEMS.twin_sword, { mainhand: 'rusty_sword' }, ITEMS));
    expect(row(same, 'ATK')).toEqual({ new: '+2', arrow: '=', old: '+1-3' });
  });

  it('shows a dash and no arrow when only one side has the stat', () => {
    const root = mount(renderEquipCompareBlock(ITEMS.sharp_sword, { mainhand: 'small_shield' }, ITEMS));
    expect(row(root, 'ATK')).toEqual({ new: '+4-6', arrow: '', old: '—' });
  });

  it('sums a sword and shield displaced by a two-handed weapon and names both', () => {
    const root = mount(renderEquipCompareBlock(ITEMS.big_axe, { mainhand: 'rusty_sword', offhand: 'small_shield' }, ITEMS));
    expect(root.querySelector('.compare-block-old-name')?.textContent).toBe('Rusty Sword + Small Shield');
    expect(row(root, 'ATK')).toEqual({ new: '+3-6', arrow: '↑', old: '+1-3' });
    expect(row(root, 'DR')).toEqual({ new: '—', arrow: '', old: '1-2' });
  });

  it('compares a one-handed weapon against the two-handed weapon it would displace', () => {
    const root = mount(renderEquipCompareBlock(ITEMS.sharp_sword, { mainhand: 'big_axe', offhand: 'big_axe' }, ITEMS));
    expect(root.querySelector('.compare-block-old-name')?.textContent).toBe('Big Axe');
    expect(row(root, 'ATK')).toEqual({ new: '+4-6', arrow: '↑', old: '+3-6' });
  });

  it('says so when neither side has combat stats', () => {
    const items = { ...ITEMS, hat: { id: 'hat', name: 'Hat', rarity: 'common', equipSlot: 'head' } as ItemDefinition };
    const root = mount(renderEquipCompareBlock(items.cap, { head: 'hat' }, items));
    expect(root.querySelector('.compare-grid')?.textContent).toContain('No combat stats');
  });

  it('escapes item names', () => {
    const html = renderEquipCompareBlock(ITEMS.sharp_sword, { mainhand: 'sneaky' }, ITEMS);
    expect(html).not.toContain('<b>');
    const root = mount(html);
    expect(root.querySelector('.compare-block-old-name')?.textContent).toBe('<b>Sneaky</b> & "Co"');
  });
});
