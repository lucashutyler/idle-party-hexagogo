import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemDefinition, ServerStateMessage } from '@idle-party-rpg/shared';
import { CharItemsScreen } from '../src/screens/CharItemsScreen';
import { dismissTop } from '../src/ui/ModalStack';
import { forgetMissingAssets, missingAssetRetryCount } from '../src/ui/assets';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;

const ITEMS: Record<string, ItemDefinition> = {
  rusty_sword: { id: 'rusty_sword', name: 'Rusty Sword', rarity: 'common', equipSlot: 'mainhand', bonusAttackMin: 1, bonusAttackMax: 3 },
  small_shield: { id: 'small_shield', name: 'Small Shield', rarity: 'common', equipSlot: 'offhand', damageReductionMin: 1, damageReductionMax: 2 },
  iron_battleaxe: { id: 'iron_battleaxe', name: 'Iron Battleaxe', rarity: 'uncommon', equipSlot: 'twohanded', classRestriction: ['Knight'], bonusAttackMin: 3, bonusAttackMax: 6 },
  old_boot: { id: 'old_boot', name: 'Old Boot', rarity: 'common', equipSlot: 'foot' },
};

type Social = { mailbox?: unknown[]; proposedTrades?: unknown[] };

const SKILLS = {
  bash: { id: 'bash', name: 'Bash', className: 'Knight', type: 'active', sortOrder: 1, unlockLevel: 1, description: 'Hit it.' },
  cleave: { id: 'cleave', name: 'Cleave', className: 'Knight', type: 'active', sortOrder: 2, unlockLevel: 1, description: 'Hit them.' },
  smite: { id: 'smite', name: 'Smite', className: 'Knight', type: 'active', sortOrder: 3, unlockLevel: 50, description: 'Hit hard.' },
};

function makeState(className: string, inventory: Record<string, number>, equipment: Record<string, string | null>, social: Social = {}): ServerStateMessage {
  return {
    username: 'me',
    character: {
      className,
      level: 5,
      xp: 0,
      xpForNextLevel: 100,
      gold: 10,
      baseDamage: 2,
      maxHp: 20,
      inventory,
      equipment,
      skillLoadout: { equippedSkills: [] },
      xpRate: { startTime: Date.now(), totalXp: 0 },
    },
    itemDefinitions: ITEMS,
    setDefinitions: {},
    social: { mailbox: [], proposedTrades: [], ...social },
  } as unknown as ServerStateMessage;
}

function setup(className: string, inventory: Record<string, number>, equipment: Record<string, string | null>, social: Social = {}, activate = true) {
  document.body.innerHTML = '<div id="charitems"></div>';
  const listeners = new Set<StateListener>();
  let bestiaryListener = () => {};
  let lastState = makeState(className, inventory, equipment, social);
  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    onEquipBlocked: () => () => {},
    onBestiary: (l: () => void) => { bestiaryListener = l; return () => {}; },
    requestBestiary: vi.fn(),
    sendEquipItem: vi.fn(),
    sendUnequipItem: vi.fn(),
    sendCancelTrade: vi.fn(),
    sendDestroyItems: vi.fn(),
    sendEquipSkill: vi.fn(),
    sendUnequipSkill: vi.fn(),
  };
  const worldCache = {
    getSkillContent: () => ({ skills: SKILLS }),
    getSlotSchedule: () => [{ type: 'active', unlocksAtLevel: 1 }],
    getSkill: (id: string) => SKILLS[id as keyof typeof SKILLS] ?? null,
    contentGeneration: 0,
  } as unknown as WorldCache;

  const screen = new CharItemsScreen('charitems', gameClient as unknown as GameClient, worldCache);
  if (activate) screen.onActivate();

  const push = (state: ServerStateMessage) => {
    lastState = state;
    for (const l of listeners) l(lastState);
  };
  const openInventoryItem = (itemId: string) => {
    document.querySelector<HTMLElement>(`.items-inv-grid .item-square[data-item="${itemId}"]`)!.click();
  };
  const emitBestiary = () => bestiaryListener();
  const slot = (name: string) => document.querySelector<HTMLElement>(`.items-equip-slot-square[data-slot="${name}"]`)!;
  return { screen, gameClient, push, emitBestiary, openInventoryItem, slot };
}

const EMPTY = { mainhand: null, offhand: null };

function makeTrade(id: string, lastUpdatedBy: string) {
  return { id, status: 'proposed', lastUpdatedBy, initiator: { username: 'me', items: [] }, target: { username: 'friend', items: [] } };
}

describe('CharItemsScreen', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
  });

  it('prebuilds while hidden with no subscription and no request to the server', () => {
    const t = setup('Knight', { old_boot: 1 }, EMPTY, {}, false);
    const cell = () => document.querySelector('.items-inv-grid .item-square[data-item="old_boot"]');
    expect(cell()).toBeNull();

    t.screen.prebuild();
    expect(cell()).toBeTruthy();
    expect(t.gameClient.requestBestiary).not.toHaveBeenCalled();

    t.push(makeState('Knight', {}, EMPTY));
    expect(cell()).toBeTruthy();
  });

  it('keeps the prebuilt nodes on the first visit when nothing changed', () => {
    const t = setup('Knight', { old_boot: 1 }, EMPTY, {}, false);
    t.screen.prebuild();
    const cell = document.querySelector('.items-inv-grid .item-square[data-item="old_boot"]');

    t.screen.onActivate();

    expect(document.querySelector('.items-inv-grid .item-square[data-item="old_boot"]')).toBe(cell);
    t.screen.onDeactivate();
  });

  it('shows the latest state on the first visit after a stale prebuild', () => {
    const t = setup('Knight', { old_boot: 1 }, EMPTY, {}, false);
    t.screen.prebuild();

    t.push(makeState('Knight', { old_boot: 1, rusty_sword: 1 }, EMPTY));
    t.screen.onActivate();

    expect(document.querySelector('.items-inv-grid .item-square[data-item="rusty_sword"]')).toBeTruthy();
    t.screen.onDeactivate();
  });

  it('shows a renamed item on the first visit after a prebuild', () => {
    const t = setup('Knight', { old_boot: 1 }, EMPTY, {}, false);
    t.screen.prebuild();

    const state = makeState('Knight', { old_boot: 1 }, EMPTY);
    t.push({ ...state, itemDefinitions: { ...ITEMS, old_boot: { ...ITEMS.old_boot, name: 'Worn Boot', rarity: 'epic' } } });
    t.screen.onActivate();

    expect(document.querySelector('.items-inv-grid')!.innerHTML).toContain('Worn Boot');
    t.screen.onDeactivate();
  });

  it('keeps bag nodes across pushes that resend the same definitions', () => {
    const t = setup('Knight', { old_boot: 1 }, EMPTY);
    const cell = document.querySelector('.items-inv-grid .item-square[data-item="old_boot"]');

    t.push({ ...makeState('Knight', { old_boot: 1 }, EMPTY), itemDefinitions: { ...ITEMS } });

    expect(document.querySelector('.items-inv-grid .item-square[data-item="old_boot"]')).toBe(cell);
    t.screen.onDeactivate();
  });

  it('rechecks a mailbox gift against the bag when the stack it would join grows', () => {
    const gift = { id: 'g1', itemId: 'old_boot', quantity: 5, fromUsername: 'friend' };
    const t = setup('Knight', { old_boot: 90 }, EMPTY, { mailbox: [gift] }, false);
    t.screen.prebuild();
    const accept = () => document.querySelector<HTMLButtonElement>('[data-mb-action="accept"]')!;
    expect(accept().disabled).toBe(false);

    t.push(makeState('Knight', { old_boot: 96 }, EMPTY, { mailbox: [gift] }));
    t.screen.onActivate();

    expect(accept().disabled).toBe(true);
    t.screen.onDeactivate();
  });

  it('tries failed class art again once failures are forgotten', () => {
    const t = setup('Knight', {}, EMPTY, {}, false);
    t.screen.prebuild();
    const portraitImg = () => document.querySelector<HTMLImageElement>('.hero-portrait-img');
    portraitImg()!.dispatchEvent(new Event('error'));
    t.push(makeState('Knight', {}, EMPTY));

    forgetMissingAssets();
    const forgetAgain = missingAssetRetryCount();
    t.screen.onActivate();

    expect(portraitImg()).toBeTruthy();
    forgetMissingAssets();
    expect(missingAssetRetryCount()).toBe(forgetAgain);
    t.screen.onDeactivate();
  });

  it('compares a two-handed weapon against both hand items it would replace', () => {
    const t = setup('Knight', { iron_battleaxe: 1 }, { mainhand: 'rusty_sword', offhand: 'small_shield' });
    t.openInventoryItem('iron_battleaxe');
    expect(document.querySelector('.item-popup-compare .compare-block-old-name')?.textContent).toBe('Rusty Sword + Small Shield');
  });

  it('keeps an unusable item from being equipped', () => {
    const t = setup('Mage', { iron_battleaxe: 1 }, { mainhand: null, offhand: null });
    t.openInventoryItem('iron_battleaxe');
    document.querySelector<HTMLButtonElement>('.popup-action-equip')!.click();
    expect(t.gameClient.sendEquipItem).not.toHaveBeenCalled();
    expect(document.querySelector('.item-popup')).toBeTruthy();
  });

  it('holds state updates while a press inside the screen is in flight', () => {
    vi.useFakeTimers();
    const t = setup('Knight', { rusty_sword: 1 }, { mainhand: null, offhand: null });
    const square = document.querySelector<HTMLElement>('.items-inv-grid .item-square[data-item="rusty_sword"]')!;
    square.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    t.push(makeState('Knight', { rusty_sword: 1, small_shield: 1 }, { mainhand: null, offhand: null }));
    expect(square.isConnected).toBe(true);

    square.click();
    expect(document.querySelector('.item-popup-name')?.textContent).toBe('Rusty Sword');
    vi.advanceTimersByTime(0);
    expect(document.querySelector('.items-inv-grid .item-square[data-item="small_shield"]')).toBeTruthy();
  });

  describe('segments', () => {
    const content = () => document.querySelector<HTMLElement>('.charitems-content')!;
    const segment = (id: string) => document.querySelector<HTMLElement>(`[data-seg="${id}"]`)!;

    it('switches panes by attribute, keeping every pane in the DOM', () => {
      setup('Knight', { rusty_sword: 1 }, EMPTY);
      const grid = document.querySelector('.items-inv-grid');
      const square = document.querySelector('.items-inv-grid .item-square');
      expect(content().dataset.heroTab).toBe('gear');

      segment('skills').click();
      expect(content().dataset.heroTab).toBe('skills');
      expect(segment('skills').getAttribute('aria-selected')).toBe('true');

      segment('gear').click();
      expect(document.querySelector('.items-inv-grid')).toBe(grid);
      expect(document.querySelector('.items-inv-grid .item-square')).toBe(square);
    });

    it('opens a sub-view by name and ignores unknown ones', () => {
      const t = setup('Knight', {}, EMPTY);
      t.screen.setSubTab('stats');
      expect(content().dataset.heroTab).toBe('stats');
      t.screen.setSubTab('nonsense');
      expect(content().dataset.heroTab).toBe('stats');
    });

    it('comes back on the sub-view it was left on', () => {
      setup('Knight', {}, EMPTY);
      segment('skills').click();
      setup('Knight', {}, EMPTY);
      expect(content().dataset.heroTab).toBe('skills');
    });

    it('badges Gear with what needs acting on', () => {
      setup('Knight', {}, EMPTY, {
        mailbox: [{ id: 'm1', itemId: 'old_boot', quantity: 1, fromUsername: 'friend' }],
        proposedTrades: [makeTrade('t1', 'friend'), makeTrade('t2', 'me')],
      });
      expect(segment('gear').querySelector('.ui-segment-badge')?.textContent).toBe('2');
    });
  });

  describe('gear', () => {
    it('lays out twelve slots in two rows with the weapons last', () => {
      setup('Knight', {}, EMPTY);
      const slots = [...document.querySelectorAll<HTMLElement>('.items-equip-panel .items-equip-slot-square')];
      expect(slots).toHaveLength(12);
      expect(slots[5].dataset.slot).toBe('mainhand');
      expect(slots[11].dataset.slot).toBe('offhand');
    });

    it('puts the mailbox and trades waiting on you above the banner, sent trades below the inventory', () => {
      setup('Knight', {}, EMPTY, {
        mailbox: [{ id: 'm1', itemId: 'old_boot', quantity: 1, fromUsername: 'friend' }],
        proposedTrades: [makeTrade('waiting', 'friend'), makeTrade('sent', 'me')],
      });
      const pane = document.querySelector('[data-pane="gear"]')!;
      const order = [...pane.children].map(el => el.className);
      expect(order.indexOf('items-mailbox')).toBeLessThan(order.indexOf('hero-loadout'));
      expect(order.indexOf('items-trades')).toBeLessThan(order.indexOf('hero-loadout'));
      expect(order.indexOf('items-trades-sent')).toBeGreaterThan(order.indexOf('hero-inventory'));
      expect(document.querySelector('.items-trades [data-trade-id="waiting"]')).toBeTruthy();
      expect(document.querySelector('.items-trades-sent [data-trade-id="sent"]')).toBeTruthy();
    });

    it('dims gear the class cannot equip', () => {
      setup('Mage', { iron_battleaxe: 1, rusty_sword: 1 }, EMPTY);
      const cell = (id: string) => document.querySelector(`.item-square[data-item="${id}"]`)!.closest('.item-cell')!;
      expect(cell('iron_battleaxe').classList.contains('item-cell-unusable')).toBe(true);
      expect(cell('rusty_sword').classList.contains('item-cell-unusable')).toBe(false);
    });

    it('shows each inventory item name under its square and opens it from the name', () => {
      setup('Knight', { rusty_sword: 1 }, EMPTY);
      const name = document.querySelector<HTMLElement>('.item-cell-name')!;
      expect(name.textContent).toBe('Rusty Sword');
      name.click();
      expect(document.querySelector('.item-popup-name')?.textContent).toBe('Rusty Sword');
    });
  });

  describe('empty slot picker', () => {
    const rows = () => [...document.querySelectorAll<HTMLElement>('.hero-picker-row')];

    it('lists only bag items that fit the slot, including two-handers for the main hand', () => {
      const t = setup('Knight', { rusty_sword: 1, iron_battleaxe: 1, small_shield: 1, old_boot: 1 }, EMPTY);
      t.slot('mainhand').click();
      expect(rows().map(r => r.dataset.pickerItem).sort()).toEqual(['iron_battleaxe', 'rusty_sword']);
    });

    it('equips from the list and closes', () => {
      const t = setup('Knight', { old_boot: 1 }, EMPTY);
      t.slot('foot').click();
      document.querySelector<HTMLElement>('[data-picker-equip="old_boot"]')!.click();
      expect(t.gameClient.sendEquipItem).toHaveBeenCalledWith('old_boot');
      expect(document.querySelector('.item-popup')).toBeNull();
    });

    it('offers no Equip on gear the class cannot use, and sinks it to the bottom', () => {
      const t = setup('Mage', { iron_battleaxe: 1, rusty_sword: 1 }, EMPTY);
      t.slot('mainhand').click();
      expect(rows().map(r => r.dataset.pickerItem)).toEqual(['rusty_sword', 'iron_battleaxe']);
      expect(rows()[1].querySelector('[data-picker-equip]')).toBeNull();
      expect(rows()[1].querySelector('.hero-picker-note')?.textContent).toBe('Knight only');
    });

    it('opens item details from a row', () => {
      const t = setup('Knight', { old_boot: 1 }, EMPTY);
      t.slot('foot').click();
      rows()[0].click();
      expect(document.querySelector('.item-popup-name')?.textContent).toBe('Old Boot');
      expect(document.querySelector('.hero-picker-row')).toBeNull();
    });

    it('says so when nothing fits', () => {
      const t = setup('Knight', {}, EMPTY);
      t.slot('head').click();
      expect(document.querySelector('.item-popup .ui-empty')?.textContent).toContain('Nothing in your bag');
    });

    it('is reached from an equipped item through Change, but only when something fits', () => {
      const t = setup('Knight', { old_boot: 1 }, { ...EMPTY, foot: 'old_boot', mainhand: 'rusty_sword' });
      t.slot('mainhand').click();
      expect(document.querySelector('.popup-action-change')).toBeNull();

      t.slot('foot').click();
      document.querySelector<HTMLElement>('.popup-action-change')!.click();
      expect(rows().map(r => r.dataset.pickerItem)).toEqual(['old_boot']);
    });
  });

  describe('panes in the stylesheet', () => {
    it('only ever shows the Gear grid while Gear is the chosen tab', () => {
      const css = readFileSync(resolve(__dirname, '../src/styles/hero.css'), 'utf8');
      const displayRules = [...css.matchAll(/([^{}]*\.hero-pane-gear[^{}]*)\{([^}]*)\}/g)]
        .filter(([, selector, body]) => selector.trim().endsWith('.hero-pane-gear') && /(^|\s)display\s*:/.test(body))
        .map(([, selector]) => selector.trim());
      expect(displayRules.length).toBeGreaterThan(0);
      for (const selector of displayRules) expect(selector).toContain("[data-hero-tab='gear']");
    });
  });

  describe('skill picker', () => {
    const openPicker = () => {
      setup('Knight', {}, EMPTY);
      document.querySelector<HTMLElement>('.charitems-skill-slot[data-slot-index="0"]')!.click();
    };

    it('makes selectable rows keyboard buttons, focuses the first, and leaves locked rows out', () => {
      const state = makeState('Knight', {}, EMPTY);
      state.character!.skillLoadout = { equippedSkills: [null], unlockedSkills: ['bash', 'cleave'] } as never;
      const t = setup('Knight', {}, EMPTY);
      t.push(state);
      document.querySelector<HTMLElement>('.charitems-skill-slot[data-slot-index="0"]')!.click();

      const rows = [...document.querySelectorAll<HTMLElement>('.charitems-skill-row')];
      expect(rows.map(r => r.getAttribute('role'))).toEqual(['button', 'button', null]);
      expect(rows[2].hasAttribute('tabindex')).toBe(false);
      expect(document.activeElement).toBe(rows[0]);

      rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(t.gameClient.sendEquipSkill).toHaveBeenCalledWith('cleave', 0);
      expect(document.querySelector('.charitems-skill-popup-overlay')).toBeNull();
    });

    it('opens with nothing to choose without failing', () => {
      openPicker();
      expect(document.querySelector('.charitems-skill-popup')).toBeTruthy();
      document.querySelector<HTMLElement>('.cancel-btn')!.click();
    });
  });

  describe('stat tooltip', () => {
    it('closes from Back or Escape through the modal stack', () => {
      setup('Knight', {}, EMPTY);
      document.querySelector<HTMLElement>('.charitems-stat')!.click();
      expect(document.querySelector('.charitems-stat-tooltip')).toBeTruthy();
      expect(dismissTop()).toBe(true);
      expect(document.querySelector('.charitems-stat-tooltip')).toBeNull();
      expect(dismissTop()).toBe(false);
    });
  });

  describe('bag repaints', () => {
    it('rewrites only the badge when a stack changes, keeping every cell', () => {
      const t = setup('Knight', { rusty_sword: 2, old_boot: 1 }, EMPTY);
      const cell = document.querySelector('.items-inv-grid .item-cell');
      t.push(makeState('Knight', { rusty_sword: 3, old_boot: 2 }, EMPTY));
      expect(document.querySelector('.items-inv-grid .item-cell')).toBe(cell);
      const qty = (id: string) => document.querySelector(`.item-square[data-item="${id}"] .item-square-qty`)?.textContent;
      expect(qty('rusty_sword')).toBe('3');
      expect(qty('old_boot')).toBe('2');
    });

    it('rebuilds when an item arrives or leaves', () => {
      const t = setup('Knight', { rusty_sword: 2 }, EMPTY);
      const cell = document.querySelector('.items-inv-grid .item-cell');
      t.push(makeState('Knight', { rusty_sword: 2, old_boot: 1 }, EMPTY));
      expect(document.querySelector('.items-inv-grid .item-cell')).not.toBe(cell);
      expect(document.querySelectorAll('.items-inv-grid .item-cell')).toHaveLength(2);
      t.push(makeState('Knight', { old_boot: 1 }, EMPTY));
      expect(document.querySelectorAll('.items-inv-grid .item-cell')).toHaveLength(1);
    });
  });

  describe('item popup dismissal', () => {
    it('goes back to the item when a destroy prompt is cancelled', () => {
      const t = setup('Knight', { rusty_sword: 1, old_boot: 3 }, EMPTY);
      for (const id of ['rusty_sword', 'old_boot']) {
        t.openInventoryItem(id);
        document.querySelector<HTMLElement>('.popup-action-destroy')!.click();
        expect(document.querySelector('.items-modal-confirm')).toBeTruthy();
        document.querySelector<HTMLElement>('.items-modal-cancel')!.click();
        expect(document.querySelector('.items-modal-confirm')).toBeNull();
        expect(document.querySelector('.popup-action-destroy')).toBeTruthy();
        expect(document.querySelector('.item-popup-name')!.textContent).toBe(ITEMS[id].name);
        document.querySelector<HTMLElement>('.item-popup-close')!.click();
      }
      expect(t.gameClient.sendDestroyItems).not.toHaveBeenCalled();
    });

    it('closes from Back or Escape through the modal stack', () => {
      const t = setup('Knight', { rusty_sword: 1 }, EMPTY);
      t.openInventoryItem('rusty_sword');
      expect(dismissTop()).toBe(true);
      expect(document.querySelector('.item-popup')).toBeNull();
      expect(document.querySelector<HTMLElement>('.items-modal-overlay')!.style.display).toBe('none');
      expect(dismissTop()).toBe(false);
    });

    it('closes from the X and the backdrop, not from a click inside', () => {
      const t = setup('Knight', { rusty_sword: 1 }, EMPTY);
      t.openInventoryItem('rusty_sword');
      document.querySelector<HTMLElement>('.item-popup-name')!.click();
      expect(document.querySelector('.item-popup')).toBeTruthy();

      document.querySelector<HTMLElement>('.item-popup-close')!.click();
      expect(document.querySelector('.item-popup')).toBeNull();

      t.openInventoryItem('rusty_sword');
      document.querySelector<HTMLElement>('.item-popup-overlay')!.click();
      expect(document.querySelector('.item-popup')).toBeNull();
    });

    it('closes when the screen is left', () => {
      const t = setup('Knight', { rusty_sword: 1 }, EMPTY);
      t.openInventoryItem('rusty_sword');
      t.screen.onDeactivate();
      expect(document.querySelector('.item-popup')).toBeNull();
      expect(dismissTop()).toBe(false);
    });

    it('escapes item names in the destroy prompts', () => {
      const t = setup('Knight', { tagged: 1 }, EMPTY);
      const defs = ITEMS as Record<string, ItemDefinition>;
      defs.tagged = { id: 'tagged', name: '<b>Tagged</b>', rarity: 'common' };
      t.push(makeState('Knight', { tagged: 2, rusty_sword: 1 }, EMPTY));
      t.openInventoryItem('tagged');
      document.querySelector<HTMLElement>('.popup-action-destroy')!.click();
      expect(document.querySelector('.item-popup-name b')).toBeNull();
      delete defs.tagged;
    });
  });

  it('holds a bestiary repaint while a press inside the screen is in flight', () => {
    vi.useFakeTimers();
    const t = setup('Knight', { rusty_sword: 1 }, EMPTY);
    const square = document.querySelector<HTMLElement>('.items-inv-grid .item-square[data-item="rusty_sword"]')!;
    square.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    t.push(makeState('Knight', { small_shield: 1 }, EMPTY));
    t.emitBestiary();
    expect(square.isConnected).toBe(true);
  });

  it('cancels a trade only after confirming', async () => {
    const t = setup('Knight', {}, EMPTY, { proposedTrades: [makeTrade('t1', 'friend')] });
    document.querySelector<HTMLElement>('[data-trade-cancel="t1"]')!.click();
    expect(t.gameClient.sendCancelTrade).not.toHaveBeenCalled();
    document.querySelector<HTMLElement>('.confirm-ok')!.click();
    await Promise.resolve();
    expect(t.gameClient.sendCancelTrade).toHaveBeenCalledWith('t1');
  });
});
