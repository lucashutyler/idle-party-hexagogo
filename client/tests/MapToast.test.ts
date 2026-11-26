import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerErrorCode } from '@idle-party-rpg/shared';
import { dismissMapToast, MAP_TOAST_MS, showMapToast } from '../src/ui/MapToast';
import { MapScreen } from '../src/screens/MapScreen';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

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

    expect(toast.textContent).toBe(message);
    expect(toast.style.getPropertyValue('--toast-ms')).toBe(`${MAP_TOAST_MS}ms`);
    vi.advanceTimersByTime(MAP_TOAST_MS - 1);
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
    vi.advanceTimersByTime(MAP_TOAST_MS - 1);
    expect(second.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
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

  function mountScreen(onScreen = true) {
    document.body.innerHTML = '<div id="map-screen"></div><div id="game-container"></div>';
    const errorListeners: ErrorListener[] = [];
    const gameClient = {
      lastState: null,
      onMoveBlocked: () => () => {},
      onRouteConfirm: () => () => {},
      onLockInfo: () => () => {},
      onConnection: () => () => {},
      onServerError: (l: ErrorListener) => { errorListeners.push(l); return () => {}; },
    } as unknown as GameClient;
    const screen = new MapScreen('map-screen', gameClient, {} as WorldCache);
    (screen as unknown as { active: boolean }).active = onScreen;
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

  it('shows a travel refusal over the map, or over the page while another screen is up', () => {
    const { sendError, toast } = mountScreen();
    sendError('Only the party owner or a leader can change Autorun', 'travel_refused');
    expect(toast()?.textContent).toBe('Only the party owner or a leader can change Autorun');

    const away = mountScreen(false);
    away.sendError('Only the party owner or a leader can leave a dungeon', 'travel_refused');
    expect(away.toast()).toBeNull();
    expect(document.querySelector('body > .map-toast')?.textContent).toBe('Only the party owner or a leader can leave a dungeon');
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

describe('map toast layout', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/pixel-theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

  it('sizes a centred toast to its text, so a long refusal is not squeezed into half the screen', () => {
    const centred = rules.find(r => r.selector === '.map-toast' && /left:\s*50%/.test(r.body));
    expect(centred?.body).toMatch(/width:\s*max-content/);
    expect(centred?.body).toMatch(/max-width:\s*min\(90%/);
  });
});
