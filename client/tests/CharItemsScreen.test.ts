import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemDefinition, ServerStateMessage } from '@idle-party-rpg/shared';
import { CharItemsScreen } from '../src/screens/CharItemsScreen';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;

const ITEMS: Record<string, ItemDefinition> = {
  rusty_sword: { id: 'rusty_sword', name: 'Rusty Sword', rarity: 'common', equipSlot: 'mainhand', bonusAttackMin: 1, bonusAttackMax: 3 },
  small_shield: { id: 'small_shield', name: 'Small Shield', rarity: 'common', equipSlot: 'offhand', damageReductionMin: 1, damageReductionMax: 2 },
  iron_battleaxe: { id: 'iron_battleaxe', name: 'Iron Battleaxe', rarity: 'uncommon', equipSlot: 'twohanded', classRestriction: ['Knight'], bonusAttackMin: 3, bonusAttackMax: 6 },
};

function makeState(className: string, inventory: Record<string, number>, equipment: Record<string, string | null>, gold = 10): ServerStateMessage {
  return {
    username: 'me',
    character: {
      className,
      level: 5,
      xp: 0,
      xpForNextLevel: 100,
      gold,
      baseDamage: 2,
      maxHp: 20,
      inventory,
      equipment,
      skillLoadout: { equippedSkills: [] },
      xpRate: { startTime: Date.now(), totalXp: 0 },
    },
    itemDefinitions: ITEMS,
    setDefinitions: {},
    social: { mailbox: [], proposedTrades: [] },
  } as unknown as ServerStateMessage;
}

function setup(className: string, inventory: Record<string, number>, equipment: Record<string, string | null>) {
  document.body.innerHTML = '<div id="charitems"></div>';
  const listeners = new Set<StateListener>();
  let lastState = makeState(className, inventory, equipment);
  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    onEquipBlocked: () => () => {},
    sendEquipItem: vi.fn(),
  };
  const worldCache = {
    getSkillContent: () => ({ skills: {} }),
    getSlotSchedule: () => [],
    getSkill: () => null,
    contentGeneration: 0,
  } as unknown as WorldCache;

  const screen = new CharItemsScreen('charitems', gameClient as unknown as GameClient, worldCache);
  screen.onActivate();

  const push = (state: ServerStateMessage) => {
    lastState = state;
    for (const l of listeners) l(lastState);
  };
  const openInventoryItem = (itemId: string) => {
    document.querySelector<HTMLElement>(`.items-inv-grid .item-square[data-item="${itemId}"]`)!.click();
  };
  return { screen, gameClient, push, openInventoryItem };
}

describe('CharItemsScreen', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
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
});
