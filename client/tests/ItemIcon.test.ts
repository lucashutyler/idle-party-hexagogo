import { beforeEach, describe, expect, it } from 'vitest';
import type { ItemDefinition } from '@idle-party-rpg/shared';
import { renderItemIcon, renderEmptySlotIcon } from '../src/ui/ItemIcon';
import { renderItemPopupContent } from '../src/ui/ItemPopup';

function def(id: string, overrides: Partial<ItemDefinition> = {}): ItemDefinition {
  return { id, name: 'Iron Battleaxe', rarity: 'uncommon', equipSlot: 'twohanded', ...overrides };
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe('renderItemIcon', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('layers tracked artwork over the initials placeholder', () => {
    const square = mount(renderItemIcon('icon_art', def('icon_art')));
    const img = square.querySelector('img')!;
    expect(img.classList.contains('asset-img')).toBe(true);
    expect(img.classList.contains('item-square-img')).toBe(true);
    expect(img.getAttribute('src')).toBe('/item-artwork/icon_art.png');
    expect(img.hasAttribute('onload')).toBe(false);
    expect(img.nextElementSibling?.classList.contains('item-square-initials')).toBe(true);
    expect(square.querySelector('.item-square-initials')?.textContent).toBe('IB');
  });

  it('renders only the initials once the artwork is known to be missing', () => {
    const first = mount(renderItemIcon('icon_missing', def('icon_missing')));
    first.querySelector('img')!.dispatchEvent(new Event('error'));

    const again = mount(renderItemIcon('icon_missing', def('icon_missing')));
    expect(again.querySelector('img')).toBeNull();
    expect(again.querySelector('.item-square-initials')?.textContent).toBe('IB');
  });

  it('renders known-loaded artwork already visible', () => {
    const first = mount(renderItemIcon('icon_loaded', def('icon_loaded')));
    first.querySelector('img')!.dispatchEvent(new Event('load'));

    const again = mount(renderItemIcon('icon_loaded', def('icon_loaded')));
    expect(again.querySelector('img')?.classList.contains('asset-loaded')).toBe(true);
  });

  it('uses the item name as the tooltip unless one is given', () => {
    const plain = mount(renderItemIcon('icon_tip', def('icon_tip')));
    expect(plain.dataset.tooltip).toBe('Iron Battleaxe');
    expect(plain.hasAttribute('title')).toBe(false);

    const custom = mount(renderItemIcon('icon_tip', def('icon_tip'), { tooltip: 'Iron Battleaxe (Knight "only")' }));
    expect(custom.dataset.tooltip).toBe('Iron Battleaxe (Knight "only")');
    expect(custom.getAttribute('title')).toBe('Iron Battleaxe (Knight "only")');
  });

  it('tracks the slot dogear image with a placeholder fallback', () => {
    const square = mount(renderItemIcon('icon_dogear', def('icon_dogear'), { showSlotIcon: true, slotOverride: 'mainhand' }));
    const dogear = square.querySelector<HTMLImageElement>('.item-dogear img')!;
    expect(dogear.classList.contains('asset-img')).toBe(true);
    expect(dogear.getAttribute('src')).toBe('/slot-icons/mainhand.png');
    expect(dogear.dataset.fallback).toContain('placehold.co');
  });

  it('renders an empty slot with its dogear', () => {
    const square = mount(renderEmptySlotIcon('offhand'));
    expect(square.classList.contains('item-square-empty')).toBe(true);
    expect(square.querySelector('.item-dogear img')?.getAttribute('src')).toBe('/slot-icons/offhand.png');
  });
});

describe('renderItemPopupContent artwork', () => {
  it('layers tracked artwork over the popup initials', () => {
    document.body.innerHTML = renderItemPopupContent(def('popup_art'));
    const img = document.querySelector('.item-popup-artwork img')!;
    expect(img.classList.contains('asset-img')).toBe(true);
    expect(img.classList.contains('item-popup-img')).toBe(true);
    expect(img.nextElementSibling?.classList.contains('item-popup-initials')).toBe(true);
  });

  it('colors the class row by whether the viewer can equip the item', () => {
    const restricted = def('popup_class', { classRestriction: ['Knight'] });
    document.body.innerHTML = renderItemPopupContent(restricted, { className: 'Mage' });
    expect(document.querySelector('[data-class-restriction] span:last-child span')?.getAttribute('style')).toContain('#ff6b6b');
    document.body.innerHTML = renderItemPopupContent(restricted, { className: 'Knight' });
    expect(document.querySelector('[data-class-restriction] span:last-child span')?.getAttribute('style')).toContain('#66bb6a');
  });
});
