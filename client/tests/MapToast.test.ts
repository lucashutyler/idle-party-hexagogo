import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerErrorCode } from '@idle-party-rpg/shared';
import { dismissMapToast, mapToastDurationMs, showMapToast } from '../src/ui/MapToast';
import { MapScreen } from '../src/screens/MapScreen';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

describe('mapToastDurationMs', () => {
  it('gives short messages at least five seconds', () => {
    expect(mapToastDurationMs('')).toBe(5000);
    expect(mapToastDurationMs('Already in a dungeon')).toBe(5000);
  });

  it('adds reading time for longer messages', () => {
    expect(mapToastDurationMs('x'.repeat(60))).toBe(5600);
  });

  it('caps at nine seconds', () => {
    expect(mapToastDurationMs('x'.repeat(500))).toBe(9000);
  });
});

describe('showMapToast', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    dismissMapToast();
    vi.useRealTimers();
  });

  const toasts = () => container.querySelectorAll('.map-toast');

  it('shows the message and removes it when its time is up', () => {
    const message = 'You need the Rusty Key to enter. Missing: alice, bob';
    const toast = showMapToast(container, message);
    const duration = mapToastDurationMs(message);

    expect(toast.textContent).toBe(message);
    expect(toast.style.getPropertyValue('--toast-ms')).toBe(`${duration}ms`);
    vi.advanceTimersByTime(duration - 1);
    expect(toast.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toast.isConnected).toBe(false);
  });

  it('replaces a toast that is still up, and the old timer does not cut the new one short', () => {
    const first = showMapToast(container, 'First');
    vi.advanceTimersByTime(4000);
    const second = showMapToast(container, 'Second');

    expect(first.isConnected).toBe(false);
    expect([...toasts()]).toEqual([second]);
    vi.advanceTimersByTime(1500);
    expect(second.isConnected).toBe(true);
    vi.advanceTimersByTime(3500);
    expect(second.isConnected).toBe(false);
  });

  it('disappears when tapped', () => {
    const toast = showMapToast(container, 'Only the party owner or a leader can move');
    toast.click();
    expect(toasts()).toHaveLength(0);

    const next = showMapToast(container, 'Again');
    toast.click();
    expect(next.isConnected).toBe(true);
  });
});

describe('MapScreen dungeon refusals', () => {
  type ErrorListener = (message: string, code?: ServerErrorCode) => void;

  function mountScreen() {
    document.body.innerHTML = '<div id="map-screen"></div><div id="game-container"></div>';
    const errorListeners: ErrorListener[] = [];
    const gameClient = {
      lastState: null,
      onMoveBlocked: () => () => {},
      onServerError: (l: ErrorListener) => { errorListeners.push(l); return () => {}; },
    } as unknown as GameClient;
    const screen = new MapScreen('map-screen', gameClient, {} as WorldCache);
    const sendError = (message: string, code?: ServerErrorCode) => { for (const l of errorListeners) l(message, code); };
    const toast = () => document.querySelector('#map-screen .map-toast');
    return { screen, sendError, toast };
  }

  afterEach(() => dismissMapToast());

  it('shows a dungeon refusal over the map', () => {
    const { sendError, toast } = mountScreen();
    sendError('Thorn must be at least level 5 to enter.', 'dungeon_entry_refused');
    expect(toast()?.textContent).toBe('Thorn must be at least level 5 to enter.');
  });

  it('leaves other errors and refusals the open entry popup shows itself alone', () => {
    const { screen, sendError, toast } = mountScreen();
    sendError("That quest isn't offered in this room.", 'quest_refused');
    sendError('Something else');
    expect(toast()).toBeNull();

    (screen as unknown as { dungeonEntryPopup: { isOpen: boolean } }).dungeonEntryPopup = { isOpen: true };
    sendError('Thorn must be at least level 5 to enter.', 'dungeon_entry_refused');
    expect(toast()).toBeNull();
  });
});
