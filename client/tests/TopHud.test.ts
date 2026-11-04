import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { formatGoldChip, hudStatus, TopHud } from '../src/ui/TopHud';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

describe('TopHud', () => {
  function setup() {
    document.body.innerHTML = '<div id="top-hud"></div>';
    let listener: () => void = () => {};
    const gameClient = {
      lastState: null as unknown,
      subscribe: (l: () => void) => { listener = l; },
      onConnection: () => {},
    };
    const push = (className: string): void => {
      gameClient.lastState = {
        username: 'me',
        currentMapId: 'm1',
        zoneName: 'Some Zone',
        unlocked: [],
        party: { col: 0, row: 0, path: [] },
        character: { className, level: 3, gold: 10 },
      };
      listener();
    };
    const world = { getTileOn: () => ({ id: 'r', name: 'Here' }) } as unknown as WorldCache;
    new TopHud(gameClient as unknown as GameClient, world);
    return { push };
  }

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('holds the avatar repaint while it is pressed, so the click lands', () => {
    vi.useFakeTimers();
    const t = setup();
    t.push('Knight');
    const avatarChild = document.querySelector('.top-hud-avatar-icon') as HTMLElement;

    avatarChild.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    t.push('Bard');
    expect(avatarChild.isConnected).toBe(true);

    avatarChild.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    vi.advanceTimersByTime(1000);
    expect(avatarChild.isConnected).toBe(false);
    expect(document.querySelector('.top-hud-avatar-img')?.getAttribute('alt')).toBe('Bard');
  });

  it('names the map button after the current room', () => {
    const t = setup();
    t.push('Knight');
    expect(document.querySelector('.top-hud-status')?.getAttribute('aria-label')).toBe('Open map, Here');
  });
});

describe('formatGoldChip', () => {
  it('shows the full localized number below 10,000', () => {
    expect(formatGoldChip(0)).toBe('0');
    expect(formatGoldChip(9999)).toBe((9999).toLocaleString());
    expect(formatGoldChip(9999)).toMatch(/^9.?999$/);
  });

  it('abbreviates thousands with one floored decimal', () => {
    expect(formatGoldChip(10_000)).toBe('10k');
    expect(formatGoldChip(12_345)).toBe('12.3k');
    expect(formatGoldChip(99_999)).toBe('99.9k');
  });

  it('drops the decimal from three-digit abbreviations', () => {
    expect(formatGoldChip(100_000)).toBe('100k');
    expect(formatGoldChip(999_999)).toBe('999k');
  });

  it('abbreviates millions and billions', () => {
    expect(formatGoldChip(1_000_000)).toBe('1M');
    expect(formatGoldChip(1_234_567)).toBe('1.2M');
    expect(formatGoldChip(2_500_000_000)).toBe('2.5B');
  });
});

describe('hudStatus', () => {
  const rooms: Record<string, { id: string; name: string }> = {
    '0,0': { id: 'r-here', name: 'Here' },
    '2,0': { id: 'r-known', name: 'Known Place' },
    '3,0': { id: 'r-unknown', name: 'Secret Place' },
  };
  const world = {
    getTileOn: (_mapId: string, col: number, row: number) => rooms[`${col},${row}`],
  } as unknown as Pick<WorldCache, 'getTileOn'>;

  function state(path: { col: number; row: number }[], extra: Partial<ServerStateMessage> = {}): ServerStateMessage {
    return {
      currentMapId: 'm1',
      zoneName: 'Some Zone',
      unlocked: ['r-here', 'r-known'],
      party: { col: 0, row: 0, path },
      ...extra,
    } as unknown as ServerStateMessage;
  }

  it('shows the room and zone when standing still', () => {
    expect(hudStatus(state([]), world, true)).toEqual({ room: 'Here', detail: 'Some Zone' });
  });

  it('names an explored destination with the room count', () => {
    const path = [{ col: 1, row: 0 }, { col: 2, row: 0 }];
    expect(hudStatus(state(path), world, true).detail).toBe('→ Known Place · 2 rooms');
  });

  it('never names an unexplored destination', () => {
    const detail = hudStatus(state([{ col: 3, row: 0 }]), world, true).detail;
    expect(detail).toBe('→ 1 room');
  });

  it('shows the dungeon floor', () => {
    const dungeon = { name: 'The Deep', floor: 2, totalFloors: 5 };
    expect(hudStatus(state([], { dungeon } as Partial<ServerStateMessage>), world, true).detail).toBe('The Deep · Floor 2/5');
  });

  it('puts reconnecting ahead of everything else', () => {
    expect(hudStatus(state([{ col: 2, row: 0 }]), world, false).detail).toBe('Reconnecting…');
  });

  it('falls back to the zone name for an unknown room', () => {
    const elsewhere = state([]);
    (elsewhere.party as { col: number }).col = 9;
    expect(hudStatus(elsewhere, world, true).room).toBe('Some Zone');
  });
});
