import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CLASS_NAMES, CLASS_DEFINITIONS, COMBAT_PACE, paceActionSeconds, paceKit } from '@idle-party-rpg/shared';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import {
  CLASS_CHOICE_TIMEOUT_MS,
  CLASS_NO_REPLY_NOTICE,
  ClassSelectScreen,
} from '../src/screens/ClassSelectScreen';
import { OFFLINE_NOTICE, type GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;
type ErrorListener = (message: string, code?: string) => void;

function mount(skills: Record<string, unknown> = {}) {
  document.body.innerHTML = '<div id="screen-class-select"></div>';
  const stateListeners = new Set<StateListener>();
  const errorListeners = new Set<ErrorListener>();
  const sendSetClass = vi.fn(() => true);
  const gameClient = {
    sendSetClass,
    subscribe: (l: StateListener) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; },
    onServerError: (l: ErrorListener) => { errorListeners.add(l); return () => { errorListeners.delete(l); }; },
  } as unknown as GameClient;
  const worldCache = { getSkillContent: () => ({ skills }) } as unknown as WorldCache;
  const onChosen = vi.fn();
  const screen = new ClassSelectScreen('screen-class-select', gameClient, worldCache, onChosen);
  screen.onActivate();

  const card = (name: string) => document.querySelector<HTMLElement>(`.class-card[data-class="${name}"]`)!;
  const confirm = () => document.querySelector<HTMLButtonElement>('.class-confirm-btn')!;
  const error = () => document.querySelector<HTMLElement>('.login-error')!;
  const pushCharacter = (character: unknown) => {
    for (const l of [...stateListeners]) l({ character } as ServerStateMessage);
  };
  const serverError = (message: string, code?: string) => {
    for (const l of [...errorListeners]) l(message, code);
  };
  return { screen, sendSetClass, onChosen, card, confirm, error, pushCharacter, serverError, stateListeners, errorListeners };
}

describe('ClassSelectScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers every class as a radio with art over its icon', () => {
    const t = mount();
    const group = document.querySelector('[role="radiogroup"]')!;
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(ALL_CLASS_NAMES.length);
    const art = t.card(ALL_CLASS_NAMES[0]).querySelector('.class-card-art')!;
    expect(art.querySelector('.class-card-icon')).toBeTruthy();
    expect(art.querySelector<HTMLImageElement>('img.class-card-img')!.getAttribute('src'))
      .toBe(`/class-artwork/${ALL_CLASS_NAMES[0].toLowerCase()}.png`);
  });

  it('shows each class\'s damage as it hits in play and how often it acts', () => {
    const t = mount();
    const oneDecimal = (value: number): number => Math.round(value * 10) / 10;
    for (const name of ALL_CLASS_NAMES) {
      const kit = paceKit(COMBAT_PACE, name);
      const def = CLASS_DEFINITIONS[name];
      const stats = [...t.card(name).querySelectorAll('.class-card-stats span')].map(s => s.textContent);
      expect(stats).toContain(`${Math.round(def.baseDamage * kit)} ${def.damageType} damage, +${oneDecimal(def.damagePerLevel * kit)} a level`);
      expect(stats).toContain(`Acts every ${oneDecimal(paceActionSeconds(COMBAT_PACE, name))} seconds`);
    }
  });

  it('times a class by its Attack skill when it has one', () => {
    const t = mount({
      archer_attack: { id: 'archer_attack', name: 'Attack', description: '', className: 'Archer', type: 'attack', unlockLevel: 1, sortOrder: 0, charge: 0.4, recovery: 1.6 },
      knight_attack: { id: 'knight_attack', name: 'Attack', description: '', className: 'Knight', type: 'attack', unlockLevel: 1, sortOrder: 0, recovery: 5 },
    });
    const stats = (name: string) => [...t.card(name).querySelectorAll('.class-card-stats span')].map(s => s.textContent);
    expect(stats('Archer')).toContain('Acts every 2 seconds');
    expect(stats('Knight')).toContain('Acts every 5 seconds');
    expect(stats('Mage')).toContain(`Acts every ${Math.round(paceActionSeconds(COMBAT_PACE, 'Mage') * 10) / 10} seconds`);
  });

  it('enables the confirm button once a class is picked and names it', () => {
    const t = mount();
    expect(t.confirm().disabled).toBe(true);
    t.card('Mage').click();
    expect(t.confirm().disabled).toBe(false);
    expect(t.confirm().textContent).toBe('Play as Mage');
    expect(t.card('Mage').getAttribute('aria-checked')).toBe('true');
    t.card('Bard').click();
    expect(t.card('Mage').getAttribute('aria-checked')).toBe('false');
    expect(t.card('Mage').classList.contains('selected')).toBe(false);
  });

  it('moves the choice with the arrow keys', () => {
    const t = mount();
    const first = ALL_CLASS_NAMES[0];
    t.card(first).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(t.card(ALL_CLASS_NAMES[1]).getAttribute('aria-checked')).toBe('true');
    expect(t.card(ALL_CLASS_NAMES[1]).tabIndex).toBe(0);
    expect(t.card(first).tabIndex).toBe(-1);
  });

  it('enters the game when the character arrives', async () => {
    const t = mount();
    t.card('Knight').click();
    t.confirm().click();
    expect(t.sendSetClass).toHaveBeenCalledWith('Knight');
    expect(t.confirm().disabled).toBe(true);
    expect(t.confirm().textContent).toBe('Creating…');

    t.pushCharacter(null);
    expect(t.onChosen).not.toHaveBeenCalled();
    t.pushCharacter({ className: 'Knight' });
    await Promise.resolve();
    expect(t.onChosen).toHaveBeenCalledTimes(1);
    expect(t.stateListeners.size).toBe(0);
    expect(t.errorListeners.size).toBe(0);

    vi.advanceTimersByTime(CLASS_CHOICE_TIMEOUT_MS);
    expect(t.error().textContent).toBe('');
  });

  it('gives the button back with an error after the timeout, and a late reply still enters', async () => {
    const t = mount();
    t.card('Knight').click();
    t.confirm().click();
    vi.advanceTimersByTime(CLASS_CHOICE_TIMEOUT_MS - 1);
    expect(t.error().textContent).toBe('');
    vi.advanceTimersByTime(1);
    expect(t.error().textContent).toBe(CLASS_NO_REPLY_NOTICE);
    expect(t.confirm().disabled).toBe(false);
    expect(t.confirm().textContent).toBe('Play as Knight');

    t.pushCharacter({ className: 'Knight' });
    await Promise.resolve();
    expect(t.onChosen).toHaveBeenCalledTimes(1);
  });

  it('retrying after a timeout leaves one listener of each kind', () => {
    const t = mount();
    t.card('Knight').click();
    t.confirm().click();
    vi.advanceTimersByTime(CLASS_CHOICE_TIMEOUT_MS);
    t.confirm().click();
    expect(t.sendSetClass).toHaveBeenCalledTimes(2);
    expect(t.stateListeners.size).toBe(1);
    expect(t.errorListeners.size).toBe(1);
    expect(t.error().textContent).toBe('');
  });

  it('shows a server refusal and lets the player try again', () => {
    const t = mount();
    t.card('Knight').click();
    t.confirm().click();
    t.serverError('Cannot change class');
    expect(t.error().textContent).toBe('Cannot change class');
    expect(t.confirm().disabled).toBe(false);
    vi.advanceTimersByTime(CLASS_CHOICE_TIMEOUT_MS);
    expect(t.error().textContent).toBe('Cannot change class');
  });

  it('ignores errors meant for other screens', () => {
    const t = mount();
    t.card('Knight').click();
    t.confirm().click();
    t.serverError('Quest refused', 'quest_refused');
    expect(t.error().textContent).toBe('');
    expect(t.confirm().disabled).toBe(true);
  });

  it('says so at once when the choice cannot be sent', () => {
    const t = mount();
    t.sendSetClass.mockReturnValueOnce(false);
    t.card('Knight').click();
    t.confirm().click();
    expect(t.error().textContent).toBe(OFFLINE_NOTICE);
    expect(t.confirm().disabled).toBe(false);
    expect(t.stateListeners.size).toBe(0);
  });

  it('stops listening when the screen goes away', () => {
    const t = mount();
    t.card('Knight').click();
    t.confirm().click();
    t.screen.onDeactivate();
    expect(t.stateListeners.size).toBe(0);
    expect(t.errorListeners.size).toBe(0);
    vi.advanceTimersByTime(CLASS_CHOICE_TIMEOUT_MS);
    expect(t.error().textContent).toBe('');
  });
});
