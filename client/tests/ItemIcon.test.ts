import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemDefinition } from '@idle-party-rpg/shared';
import { renderItemIcon, renderItemCell, renderEmptySlotIcon, wireRoleButtons } from '../src/ui/ItemIcon';
import { closeItemPopup, renderItemPopupContent, showItemPopup } from '../src/ui/ItemPopup';
import { dismissTop } from '../src/ui/ModalStack';

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

  it('tracks the slot dogear image over its glyph fallback', () => {
    const square = mount(renderItemIcon('icon_dogear', def('icon_dogear'), { showSlotIcon: true, slotOverride: 'mainhand' }));
    const dogear = square.querySelector<HTMLImageElement>('.item-dogear img')!;
    expect(dogear.classList.contains('asset-img')).toBe(true);
    expect(dogear.getAttribute('src')).toBe('/slot-icons/mainhand.png');
    expect(dogear.dataset.fallback).toBeUndefined();
    expect(square.querySelector('.item-dogear-glyph')).not.toBeNull();
  });

  it('renders an empty slot with its ghost art', () => {
    const square = mount(renderEmptySlotIcon('offhand'));
    expect(square.classList.contains('item-square-empty')).toBe(true);
    expect(square.querySelector('.item-slot-ghost img')?.getAttribute('src')).toBe('/slot-icons/offhand.png');
  });
});

describe('renderItemCell', () => {
  it('puts the name under the square, outside its clipping box', () => {
    const cell = mount(renderItemCell('cell_name', def('cell_name'), { dataAttrs: { item: 'cell_name' } }));
    expect(cell.classList.contains('item-cell')).toBe(true);
    expect(cell.getAttribute('role')).toBe('button');
    expect(cell.querySelector('.item-square[data-item="cell_name"]')).not.toBeNull();
    expect(cell.querySelector('.item-square .item-cell-name')).toBeNull();
    expect(cell.querySelector('.item-cell-name')?.textContent).toBe('Iron Battleaxe');
  });

  it('marks an item the class cannot use, in text as well', () => {
    const cell = mount(renderItemCell('cell_dim', def('cell_dim'), { unusable: true }));
    expect(cell.classList.contains('item-cell-unusable')).toBe(true);
    expect(cell.getAttribute('aria-label')).toContain("can't be used");
  });

  it('escapes the name', () => {
    const cell = mount(renderItemCell('cell_esc', def('cell_esc', { name: '<i>Odd</i>' })));
    expect(cell.querySelector('.item-cell-name i')).toBeNull();
    expect(cell.querySelector('.item-cell-name')?.textContent).toBe('<i>Odd</i>');
  });
});

describe('interactive squares', () => {
  it('stay plain unless asked', () => {
    expect(mount(renderItemIcon('plain', def('plain'))).hasAttribute('role')).toBe(false);
    expect(mount(renderEmptySlotIcon('head')).hasAttribute('role')).toBe(false);
  });

  it('name an empty slot for hover and assistive tech', () => {
    const square = mount(renderEmptySlotIcon('head', { interactive: true }));
    expect(square.getAttribute('title')).toBe('Head');
    expect(square.getAttribute('aria-label')).toBe('Head, empty');
    expect(square.tabIndex).toBe(0);
  });

  it('activate from Enter and Space when the parent is wired', () => {
    const root = mount(`<div>${renderItemIcon('keyed', def('keyed'), { interactive: true })}</div>`);
    wireRoleButtons(root);
    const onClick = vi.fn();
    root.addEventListener('click', onClick);
    const square = root.querySelector('.item-square')!;
    square.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    square.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    square.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe('showItemPopup', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    while (dismissTop());
  });

  it('registers with the modal stack so Back and Escape close it', () => {
    showItemPopup(def('popup_stack'));
    expect(document.querySelector('.item-popup-overlay')).not.toBeNull();
    expect(dismissTop()).toBe(true);
    expect(document.querySelector('.item-popup-overlay')).toBeNull();
    expect(dismissTop()).toBe(false);
  });

  it('closes from the X and the backdrop', () => {
    showItemPopup(def('popup_x'));
    document.querySelector<HTMLElement>('.item-popup-close')!.click();
    expect(document.querySelector('.item-popup-overlay')).toBeNull();

    showItemPopup(def('popup_backdrop'));
    document.querySelector<HTMLElement>('.item-popup-overlay')!.click();
    expect(document.querySelector('.item-popup-overlay')).toBeNull();
    expect(dismissTop()).toBe(false);
  });

  it('stays open on a click inside', () => {
    const overlay = showItemPopup(def('popup_inside'));
    document.querySelector<HTMLElement>('.item-popup-name')!.click();
    expect(overlay.isConnected).toBe(true);
    closeItemPopup(overlay);
    expect(dismissTop()).toBe(false);
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
    expect(document.querySelector('[data-class-restriction] .item-popup-class-denied')?.textContent).toBe('Knight');
    expect(document.querySelector('[data-class-restriction] .item-popup-class-allowed')).toBeNull();
    document.body.innerHTML = renderItemPopupContent(restricted, { className: 'Knight' });
    expect(document.querySelector('[data-class-restriction] .item-popup-class-allowed')?.textContent).toBe('Knight');
    expect(document.querySelector('[data-class-restriction] .item-popup-class-denied')).toBeNull();
  });
});
