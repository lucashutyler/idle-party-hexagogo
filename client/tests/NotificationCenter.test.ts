import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationEntry, ServerStateMessage } from '@idle-party-rpg/shared';
import { NotificationCenter } from '../src/ui/NotificationCenter';
import { dismissTop } from '../src/ui/ModalStack';
import type { GameClient } from '../src/network/GameClient';

type StateListener = (state: ServerStateMessage) => void;

function entry(id: string, overrides: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    id,
    category: 'system',
    eventKey: 'system_notice',
    title: `Title ${id}`,
    body: `Body ${id}`,
    createdAt: Date.now(),
    readAt: null,
    ...overrides,
  };
}

function setup() {
  document.body.innerHTML = '<div id="notification-center-root"></div>';
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = null;
  const sendMarkNotificationRead = vi.fn();
  const sendDismissNotification = vi.fn();
  const sendClearAllNotifications = vi.fn();
  const onNavigate = vi.fn();

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    onNotification: () => () => {},
    sendMarkNotificationRead,
    sendDismissNotification,
    sendMarkAllNotificationsRead: vi.fn(),
    sendClearAllNotifications,
  } as unknown as GameClient;

  new NotificationCenter(gameClient, onNavigate);

  const push = (notifications: NotificationEntry[]) => {
    lastState = { social: { notifications } } as unknown as ServerStateMessage;
    for (const l of listeners) l(lastState);
  };

  const bell = () => document.querySelector('.notif-bell-btn') as HTMLButtonElement;
  const badge = () => document.querySelector('.notif-bell-badge') as HTMLElement;
  const dropdown = () => document.querySelector('.notif-dropdown');
  const row = (id: string) => document.querySelector(`.notif-row-main[data-id="${id}"]`) as HTMLButtonElement | null;
  const dismissBtn = (id: string) => document.querySelector(`.notif-row-dismiss[data-id="${id}"]`) as HTMLButtonElement | null;

  return { push, bell, badge, dropdown, row, dismissBtn, sendMarkNotificationRead, sendDismissNotification, sendClearAllNotifications, onNavigate };
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

describe('NotificationCenter dropdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('offers only the actions that have something to do', () => {
    const t = setup();
    const mark = () => document.querySelector('.notif-mark-all-btn') as HTMLButtonElement;
    const clear = () => document.querySelector('.notif-clear-all-btn') as HTMLButtonElement;

    t.push([]);
    t.bell().click();
    expect(mark().hidden).toBe(true);
    expect(clear().hidden).toBe(true);

    t.push([entry('n1', { readAt: 1 })]);
    expect(mark().hidden).toBe(true);
    expect(clear().hidden).toBe(false);

    t.push([entry('n1', { readAt: null })]);
    expect(mark().hidden).toBe(false);
    expect(clear().hidden).toBe(false);
  });

  it('keeps row nodes across an identical state push', () => {
    const t = setup();
    t.push([entry('n1'), entry('n2')]);
    t.bell().click();
    const before = t.row('n1');
    expect(before).not.toBeNull();

    t.push([entry('n1'), entry('n2')]);
    expect(t.row('n1')).toBe(before);
  });

  it('holds a list rebuild while a row is pressed so the click still lands', () => {
    const t = setup();
    t.push([entry('n1', { category: 'party' })]);
    t.bell().click();
    const pressed = t.row('n1')!;

    press(pressed);
    t.push([entry('n2'), entry('n1', { category: 'party' })]);
    expect(t.badge().textContent).toBe('2');
    expect(t.row('n1')).toBe(pressed);
    expect(pressed.isConnected).toBe(true);
    expect(t.row('n2')).toBeNull();

    pressed.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    pressed.click();
    expect(t.sendMarkNotificationRead).toHaveBeenCalledWith('n1');
    expect(t.onNavigate).toHaveBeenCalledWith({ kind: 'party' });
    expect(t.dropdown()).toBeNull();

    vi.advanceTimersByTime(0);
    expect(t.dropdown()).toBeNull();
  });

  it('applies the held rebuild once the press is over', () => {
    const t = setup();
    t.push([entry('n1')]);
    t.bell().click();
    const pressed = t.row('n1')!;

    press(pressed);
    t.push([entry('n1'), entry('n2')]);
    expect(t.row('n2')).toBeNull();

    pressed.click();
    expect(t.sendMarkNotificationRead).toHaveBeenCalledWith('n1');
    expect(t.onNavigate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(t.row('n2')).not.toBeNull();
  });

  it('dismisses a notification without marking it read or navigating', () => {
    const t = setup();
    t.push([entry('n1', { category: 'party' })]);
    t.bell().click();

    t.dismissBtn('n1')!.click();
    expect(t.sendDismissNotification).toHaveBeenCalledWith('n1');
    expect(t.sendMarkNotificationRead).not.toHaveBeenCalled();
    expect(t.onNavigate).not.toHaveBeenCalled();
    expect(t.dropdown()).not.toBeNull();
  });

  it('renders the list again when the dropdown is reopened with unchanged state', () => {
    const t = setup();
    t.push([entry('n1')]);
    t.bell().click();
    t.bell().click();
    expect(t.dropdown()).toBeNull();

    t.bell().click();
    expect(t.row('n1')).not.toBeNull();
  });

  it('shows the empty state', () => {
    const t = setup();
    t.push([]);
    t.bell().click();
    expect(document.querySelector('.notif-empty')?.textContent).toContain('No notifications yet');
  });

  it('asks before clearing everything', async () => {
    vi.useRealTimers();
    const t = setup();
    t.push([entry('n1')]);
    t.bell().click();

    (document.querySelector('.notif-clear-all-btn') as HTMLButtonElement).click();
    expect(t.sendClearAllNotifications).not.toHaveBeenCalled();
    (document.querySelector('.confirm-cancel') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r));
    expect(t.sendClearAllNotifications).not.toHaveBeenCalled();
    expect(t.dropdown()).not.toBeNull();

    (document.querySelector('.notif-clear-all-btn') as HTMLButtonElement).click();
    (document.querySelector('.confirm-ok') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r));
    expect(t.sendClearAllNotifications).toHaveBeenCalledOnce();
  });

  it('closes the dropdown from the modal stack', () => {
    const t = setup();
    t.push([]);
    t.bell().click();
    expect(dismissTop()).toBe(true);
    expect(t.dropdown()).toBeNull();
  });
});

describe('NotificationCenter bell mount', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('falls back to its own root with no HUD', () => {
    setup();
    expect(document.querySelector('#notification-center-root .notif-bell-btn')).not.toBeNull();
  });

  it('mounts in the HUD slot when there is one', () => {
    const makeClient = () => ({
      lastState: null,
      subscribe: () => () => {},
      onNotification: () => () => {},
    }) as unknown as GameClient;
    document.body.innerHTML = '<div id="top-hud"><div class="top-hud-bell-slot"></div></div><div id="notification-center-root"></div>';
    new NotificationCenter(makeClient(), vi.fn());
    expect(document.querySelector('.top-hud-bell-slot .notif-bell-btn')).not.toBeNull();
  });
});
