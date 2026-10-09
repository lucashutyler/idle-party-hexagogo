import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HenchmanOffer, ItemDefinition, ServerStateMessage, SetDefinition, ShopItem } from '@idle-party-rpg/shared';
import { ShopPopup } from '../src/ui/ShopPopup';
import { OFFLINE_NOTICE, type GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;
type ErrorListener = (message: string, code?: string) => void;

const ITEMS: Record<string, ItemDefinition> = {
  iron_battleaxe: { id: 'iron_battleaxe', name: 'Iron Battleaxe', rarity: 'uncommon', equipSlot: 'twohanded', classRestriction: ['Knight'], bonusAttackMin: 3, bonusAttackMax: 6 },
  oak_staff: { id: 'oak_staff', name: 'Oak Staff', rarity: 'common', equipSlot: 'mainhand', bonusAttackMin: 1, bonusAttackMax: 2 },
  hunter_bow: { id: 'hunter_bow', name: 'Hunter Bow', rarity: 'common', equipSlot: 'twohanded', classRestriction: ['Archer', 'Knight'], bonusAttackMin: 2, bonusAttackMax: 4 },
  potion: { id: 'potion', name: 'Red Potion', rarity: 'common', consumable: true, classRestriction: ['Knight'] },
  gem: { id: 'gem', name: 'Gem', rarity: 'rare' },
};

const STOCK: ShopItem[] = [
  { itemId: 'iron_battleaxe', price: 50 },
  { itemId: 'oak_staff', price: 20 },
  { itemId: 'hunter_bow', price: 500 },
  { itemId: 'potion', price: 5 },
];

const OFFER: HenchmanOffer = { henchmanId: 'h_bob', name: 'Bob', emoji: '🗡️', level: 3, maxHp: 30, baseDamage: 4 };

interface StateParts {
  gold?: number;
  className?: string;
  inventory?: Record<string, number>;
  equipment?: Record<string, string | null>;
  stock?: ShopItem[];
  offers?: HenchmanOffer[];
  sets?: Record<string, SetDefinition>;
}

function makeState(parts: StateParts = {}): ServerStateMessage {
  return {
    character: {
      className: parts.className ?? 'Mage',
      gold: parts.gold ?? 100,
      inventory: parts.inventory ?? {},
      equipment: parts.equipment ?? { mainhand: 'oak_staff', offhand: null },
    },
    shopDefinition: { id: 'smithy', name: 'Smithy', inventory: parts.stock ?? STOCK },
    henchmanOffers: parts.offers ?? [],
    itemDefinitions: ITEMS,
    setDefinitions: parts.sets ?? {},
    social: { party: { members: [{ username: 'me' }], henchmen: [] } },
  } as unknown as ServerStateMessage;
}

function setup(initial: StateParts = {}) {
  const stateListeners = new Set<StateListener>();
  const errorListeners = new Set<ErrorListener>();
  let lastState = makeState(initial);

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; },
    onServerError: (l: ErrorListener) => { errorListeners.add(l); return () => { errorListeners.delete(l); }; },
    sendShopBuy: vi.fn(() => true),
    sendShopSell: vi.fn(),
    sendHireHenchman: vi.fn(),
  };
  const worldCache = { getSkillContent: () => ({ skills: {} }) } as unknown as WorldCache;

  const popup = new ShopPopup(gameClient as unknown as GameClient, worldCache);
  popup.show(lastState);

  const push = (parts: StateParts) => {
    lastState = makeState({ ...initial, ...parts });
    for (const l of stateListeners) l(lastState);
  };
  const serverError = (message: string, code?: string) => {
    for (const l of errorListeners) l(message, code);
  };
  const square = (itemId: string) => document.querySelector<HTMLElement>(`.shop-item-square[data-item-id="${itemId}"]`)!;
  const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);

  return { popup, gameClient, push, serverError, square, q };
}

describe('ShopPopup', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
  });

  describe('buy grid', () => {
    it('badges gear the player class cannot equip, with a tooltip naming who can', () => {
      const t = setup({ className: 'Mage' });
      expect(t.square('iron_battleaxe').querySelector('.shop-item-unusable')).toBeTruthy();
      expect(t.square('iron_battleaxe').getAttribute('title')).toBe('Iron Battleaxe (Knight only)');
      expect(t.square('hunter_bow').getAttribute('title')).toBe('Hunter Bow (Archer / Knight only)');
      expect(t.square('oak_staff').querySelector('.shop-item-unusable')).toBeNull();
      expect(t.square('oak_staff').dataset.tooltip).toBe('Oak Staff');
    });

    it('never badges consumables, and never for a class that may equip the item', () => {
      const t = setup({ className: 'Knight' });
      expect(t.square('potion').querySelector('.shop-item-unusable')).toBeNull();
      expect(t.square('iron_battleaxe').querySelector('.shop-item-unusable')).toBeNull();
    });

    it('keeps unusable items full-strength and clickable', () => {
      const t = setup({ className: 'Mage' });
      const axe = t.square('iron_battleaxe');
      expect(axe.className).not.toMatch(/dim|disabled|grey/);
      axe.click();
      expect(t.q('.shop-detail-view')).toBeTruthy();
    });

    it('colors only prices the player cannot afford', () => {
      const t = setup({ className: 'Mage', gold: 100 });
      expect(t.square('hunter_bow').querySelector('.shop-item-price')?.classList.contains('unaffordable')).toBe(true);
      expect(t.square('iron_battleaxe').querySelector('.shop-item-price')?.classList.contains('unaffordable')).toBe(false);
      expect(t.square('oak_staff').querySelector('.shop-item-price')?.classList.contains('unaffordable')).toBe(false);
    });

    it('patches gold in place without rebuilding the grid', () => {
      const t = setup({ gold: 100 });
      const grid = t.q('.shop-items-grid');
      t.push({ gold: 30 });
      expect(t.q('.shop-items-grid')).toBe(grid);
      expect(t.q('.shop-gold')?.textContent).toBe('30 gold');
      expect(t.square('iron_battleaxe').querySelector('.shop-item-price')?.classList.contains('unaffordable')).toBe(true);
    });

    it('ignores inventory changes while buying', () => {
      const t = setup();
      const grid = t.q('.shop-items-grid');
      t.push({ inventory: { gem: 2 } });
      expect(t.q('.shop-items-grid')).toBe(grid);
    });
  });

  describe('buy detail', () => {
    it('compares a two-handed weapon with the equipped weapon and explains the class limit', () => {
      const t = setup({ className: 'Mage', gold: 100 });
      t.square('iron_battleaxe').click();

      expect(t.q('.item-popup-compare')).toBeTruthy();
      expect(t.q('.compare-block-old-name')?.textContent).toBe('Oak Staff');
      expect(t.q('.shop-unusable-note')?.textContent).toBe('Knight only — you can still buy it.');

      const buy = t.q<HTMLButtonElement>('.shop-action-confirm')!;
      expect(buy.disabled).toBe(false);
      expect(buy.textContent).toBe('Buy');
      buy.click();
      expect(t.gameClient.sendShopBuy).toHaveBeenCalledWith('iron_battleaxe');
    });

    it('has no note or comparison for usable gear with nothing to replace', () => {
      const t = setup({ className: 'Knight', equipment: { mainhand: null, offhand: null } });
      t.square('iron_battleaxe').click();
      expect(t.q('.shop-unusable-note')).toBeNull();
      expect(t.q('.item-popup-compare')).toBeNull();
    });

    it('disables buying when the player cannot afford one', () => {
      const t = setup({ gold: 100 });
      t.square('hunter_bow').click();

      const buy = t.q<HTMLButtonElement>('.shop-action-confirm')!;
      expect(buy.disabled).toBe(true);
      expect(buy.textContent).toBe('Not enough gold');
      expect(t.q<HTMLButtonElement>('.shop-qty-plus')!.disabled).toBe(true);
      expect(t.q<HTMLButtonElement>('.shop-qty-all')!.disabled).toBe(true);
      buy.click();
      expect(t.gameClient.sendShopBuy).not.toHaveBeenCalled();
    });

    it('caps the quantity at what the player can afford', () => {
      const t = setup({ gold: 100 });
      t.square('oak_staff').click();
      t.q<HTMLButtonElement>('.shop-qty-all')!.click();
      expect(t.q('.shop-qty-value')?.textContent).toBe('5');
      expect(t.q('.shop-detail-total')?.textContent).toBe('Total: 100 gold');
      t.q<HTMLButtonElement>('.shop-qty-plus')!.click();
      expect(t.q('.shop-qty-value')?.textContent).toBe('5');
    });

    it('handles a free item without dividing by zero', () => {
      const t = setup({ gold: 0, stock: [{ itemId: 'gem', price: 0 }] });
      t.square('gem').click();
      expect(t.q<HTMLButtonElement>('.shop-action-confirm')!.disabled).toBe(false);
      t.q<HTMLButtonElement>('.shop-qty-all')!.click();
      expect(t.q('.shop-qty-value')?.textContent).toBe('99');
      expect(t.q('.shop-detail-total')?.textContent).toBe('Total: 0 gold');
    });

    it('keeps the chosen quantity across pushes that do not change what is affordable', () => {
      const t = setup({ gold: 100 });
      t.square('oak_staff').click();
      t.q<HTMLButtonElement>('.shop-qty-plus')!.click();
      const artwork = t.q('.item-popup-artwork img');
      t.push({ gold: 110, inventory: { gem: 1 } });
      expect(t.q('.item-popup-artwork img')).toBe(artwork);
      expect(t.q('.shop-qty-value')?.textContent).toBe('2');
      expect(t.q('.shop-gold')?.textContent).toBe('110 gold');
    });

    it('shows set pieces the player owns, and only re-renders when those change', () => {
      const sets = { staff_set: { id: 'staff_set', name: 'Staff Set', itemIds: ['oak_staff', 'gem'], breakpoints: [] } };
      const t = setup({ gold: 100, sets, inventory: {}, equipment: { mainhand: null, offhand: null } });
      t.square('oak_staff').click();
      expect(t.q('.item-popup-set-piece.owned')).toBeNull();

      const artwork = t.q('.item-popup-artwork img');
      t.push({ inventory: { potion: 1 } });
      expect(t.q('.item-popup-artwork img')).toBe(artwork);

      t.push({ inventory: { potion: 1, gem: 1 } });
      expect(t.q('.item-popup-set-piece.owned')?.textContent).toContain('Gem');
    });

    it('re-renders when the player can no longer afford the item', () => {
      const t = setup({ gold: 100 });
      t.square('iron_battleaxe').click();
      t.push({ gold: 10 });
      expect(t.q<HTMLButtonElement>('.shop-action-confirm')!.disabled).toBe(true);
    });

    it('reports a purchase only once the item arrives', () => {
      const t = setup({ gold: 100, inventory: {} });
      t.square('oak_staff').click();
      t.q<HTMLButtonElement>('.shop-qty-plus')!.click();
      t.q<HTMLButtonElement>('.shop-action-confirm')!.click();
      expect(t.gameClient.sendShopBuy).toHaveBeenCalledTimes(2);
      expect(t.q('.shop-notice')).toBeNull();

      t.push({ gold: 80, inventory: { oak_staff: 1 } });
      expect(t.q('.shop-notice')).toBeNull();
      t.push({ gold: 60, inventory: { oak_staff: 2 } });
      expect(t.q('.shop-notice')?.textContent).toBe('You bought 2 Oak Staff for 40 gold.');
    });

    it('shows the server refusal instead of a purchase', () => {
      const t = setup({ gold: 100, inventory: {} });
      t.square('oak_staff').click();
      t.q<HTMLButtonElement>('.shop-action-confirm')!.click();
      t.serverError('Inventory full');
      expect(t.q('.shop-notice')?.textContent).toBe('Inventory full');
      expect(document.body.textContent).not.toContain('You bought');
    });

    it('reports a partly refused purchase', () => {
      const t = setup({ gold: 100, inventory: {} });
      t.square('oak_staff').click();
      t.q<HTMLButtonElement>('.shop-qty-plus')!.click();
      t.q<HTMLButtonElement>('.shop-action-confirm')!.click();
      t.push({ gold: 80, inventory: { oak_staff: 1 } });
      t.serverError('Inventory full');
      expect(t.q('.shop-notice')?.textContent).toBe('Inventory full. You bought Oak Staff for 20 gold.');
    });

    it('says so at once when the purchase cannot be sent', () => {
      const t = setup({ gold: 100, inventory: {} });
      t.gameClient.sendShopBuy.mockReturnValueOnce(false);
      t.square('oak_staff').click();
      t.q<HTMLButtonElement>('.shop-qty-plus')!.click();
      t.q<HTMLButtonElement>('.shop-action-confirm')!.click();
      expect(t.gameClient.sendShopBuy).toHaveBeenCalledTimes(1);
      expect(t.q('.shop-notice')?.textContent).toBe(OFFLINE_NOTICE);
      t.serverError('Inventory full');
      expect(t.q('.shop-notice')?.textContent).toBe(OFFLINE_NOTICE);
    });

    it('leaves errors from other features alone', () => {
      const t = setup({ gold: 100 });
      t.serverError('Stray error');
      t.serverError('Quest refused', 'quest_refused');
      expect(t.q('.shop-notice')).toBeNull();
    });

    it('holds a state push until a press inside the shop has clicked', () => {
      vi.useFakeTimers();
      const t = setup({ gold: 100 });
      t.square('iron_battleaxe').click();
      const back = t.q<HTMLButtonElement>('.shop-detail-back')!;
      back.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      t.push({ gold: 10 });
      expect(back.isConnected).toBe(true);
      back.click();
      vi.advanceTimersByTime(0);
      expect(t.q('.shop-items-grid')).toBeTruthy();
      expect(t.q('.shop-gold')?.textContent).toBe('10 gold');
    });
  });

  describe('sell', () => {
    it('re-renders the sell grid on inventory changes and keeps its scroll position', () => {
      const t = setup({ inventory: { gem: 3, oak_staff: 1 } });
      t.q<HTMLElement>('.shop-toggle-btn[data-mode="sell"]')!.click();
      const grid = t.q('.shop-items-grid')!;
      grid.scrollTop = 40;
      t.push({ inventory: { gem: 2, oak_staff: 1 } });
      const next = t.q('.shop-items-grid')!;
      expect(next).not.toBe(grid);
      expect(next.scrollTop).toBe(40);
      expect(t.square('gem').querySelector('.item-square-qty')?.textContent).toBe('2');
    });

    it('shows set ownership context in the sell detail', () => {
      const t = setup({ inventory: { gem: 1 } });
      t.q<HTMLElement>('.shop-toggle-btn[data-mode="sell"]')!.click();
      t.square('gem').click();
      expect(t.q('.shop-detail-total')?.textContent).toContain('Available: 1');
      t.q<HTMLButtonElement>('.shop-action-confirm')!.click();
      expect(t.gameClient.sendShopSell).toHaveBeenCalledWith('gem', 1);
    });
  });

  describe('hire', () => {
    it('still hires henchmen', () => {
      const t = setup({ stock: [], offers: [OFFER] });
      expect(t.q('.shop-toggle-btn[data-mode="hire"]')?.classList.contains('active')).toBe(true);
      t.q<HTMLButtonElement>('.shop-hire-btn')!.click();
      expect(t.gameClient.sendHireHenchman).toHaveBeenCalledWith('h_bob');
    });

    it('shows a hire refusal', () => {
      const t = setup({ stock: [], offers: [OFFER] });
      t.q<HTMLButtonElement>('.shop-hire-btn')!.click();
      t.serverError('That henchman is no longer available.');
      expect(t.q('.shop-notice')?.textContent).toBe('That henchman is no longer available.');
    });

    it('renders a henchman portrait as tracked art over the emoji', () => {
      setup({ stock: [], offers: [{ ...OFFER, artworkUrl: '/henchman-artwork/h_bob.png' }] });
      const img = document.querySelector('.shop-hire-portrait img')!;
      expect(img.classList.contains('asset-img')).toBe(true);
      expect(img.classList.contains('shop-hire-img')).toBe(true);
      expect(img.hasAttribute('onload')).toBe(false);
      expect(document.querySelector('.shop-hire-emoji')).toBeTruthy();
    });
  });
});
