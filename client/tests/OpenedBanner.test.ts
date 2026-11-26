import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwayLedger, CombatLogEntry, ServerStateMessage } from '@idle-party-rpg/shared';
import { OPENED_BANNER_MS, OpenedBanner, newOpenings } from '../src/ui/OpenedBanner';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

interface FakeClient {
  lastState: ServerStateMessage | null;
  listener: ((state: ServerStateMessage) => void) | null;
  subscribe(cb: (state: ServerStateMessage) => void, opts?: { replay?: boolean }): () => void;
  push(log: CombatLogEntry[], awayRecap?: AwayLedger): void;
}

function fakeClient(firstLog: CombatLogEntry[] | null): FakeClient {
  const c: FakeClient = {
    lastState: firstLog ? ({ combatLog: firstLog } as ServerStateMessage) : null,
    listener: null,
    subscribe(cb, opts) {
      c.listener = cb;
      if (opts?.replay && c.lastState) cb(c.lastState);
      return () => { c.listener = null; };
    },
    push(log, awayRecap) {
      c.lastState = { combatLog: log, awayRecap } as ServerStateMessage;
      c.listener?.(c.lastState);
    },
  };
  return c;
}

const line = (id: number, text: string, type: CombatLogEntry['type'] = 'victory', roomId?: string): CombatLogEntry =>
  ({ id, text, type, ...(roomId ? { roomId } : {}) });

function banner(): HTMLButtonElement | null {
  return document.querySelector('.opened-banner');
}

/** The party is on map `vale` while the player looks at map `grotto`, which is the one drawn. */
const worldCache = {
  getTileByGuid: (id: string) => ({ east: { mapId: 'vale' }, cave: { mapId: 'grotto' } } as Record<string, { mapId: string }>)[id],
  getCurrentMapId: () => 'grotto',
} as unknown as WorldCache;

function mount(client: FakeClient) {
  const actions = { showRoom: vi.fn(), showMap: vi.fn() };
  return { opened: new OpenedBanner(client as unknown as GameClient, worldCache, actions), ...actions };
}

describe('newOpenings', () => {
  it('lists the openings after the last seen id, oldest first', () => {
    const log = [line(1, 'Now open: A', 'opened'), line(2, 'Victory!'), line(3, 'Now open: B', 'opened'), line(4, '+5 XP')];
    expect(newOpenings(log, 0).map(e => e.text)).toEqual(['Now open: A', 'Now open: B']);
    expect(newOpenings(log, 1).map(e => e.text)).toEqual(['Now open: B']);
    expect(newOpenings(log, 3)).toEqual([]);
    expect(newOpenings(log.slice(0, 2), 1)).toEqual([]);
  });
});

describe('OpenedBanner', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing for openings already in the first state', () => {
    const client = fakeClient([line(1, 'Now open: Old Mill', 'opened')]);
    const { opened } = mount(client);
    expect(banner()).toBeNull();
    client.push([line(1, 'Now open: Old Mill', 'opened'), line(2, 'Victory!')]);
    expect(banner()).toBeNull();
    opened.destroy();
  });

  it('seeds from the first state even when it arrives after mounting', () => {
    const client = fakeClient(null);
    const { opened } = mount(client);
    client.push([line(4, 'Now open: Old Mill', 'opened')]);
    expect(banner()).toBeNull();
    opened.destroy();
  });

  it('shows a gold status banner for a new opening that opens the room when tapped', () => {
    const client = fakeClient([line(1, 'Victory!')]);
    const { opened, showRoom, showMap } = mount(client);
    client.push([line(1, 'Victory!'), line(2, 'Completed quest: Bridge'), line(3, 'Now open: Cave Mouth', 'opened', 'cave')]);

    const el = banner()!;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.textContent).toBe('🔓 Now open: Cave Mouth');
    el.click();
    expect(showRoom).toHaveBeenCalledWith('cave');
    expect(showMap).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
    opened.destroy();
  });

  it('opens the room on the party\'s map while the player is looking at another one', () => {
    const client = fakeClient([line(1, 'Victory!')]);
    const { opened, showRoom, showMap } = mount(client);
    client.push([line(1, 'Victory!'), line(2, 'Now open: East Field', 'opened', 'east')]);
    banner()!.click();
    expect(showRoom).toHaveBeenCalledWith('east');
    expect(showMap).not.toHaveBeenCalled();
    opened.destroy();
  });

  it('opens just the map for a line without a room the client knows', () => {
    const client = fakeClient([line(1, 'Victory!')]);
    const { opened, showRoom, showMap } = mount(client);
    client.push([line(1, 'Victory!'), line(2, 'Now open: Somewhere', 'opened', 'unknown-room')]);
    banner()!.click();
    client.push([line(1, 'Victory!'), line(2, 'Now open: Somewhere', 'opened', 'unknown-room'), line(3, 'Now open: Anywhere', 'opened')]);
    banner()!.click();
    expect(showMap).toHaveBeenCalledTimes(2);
    expect(showRoom).not.toHaveBeenCalled();
    opened.destroy();
  });

  it('never shows the same line twice, and goes away on its own', () => {
    const client = fakeClient([]);
    const { opened } = mount(client);
    const log = [line(1, 'Now open: East Field', 'opened')];
    client.push(log);
    expect(banner()).toBeTruthy();
    vi.advanceTimersByTime(OPENED_BANNER_MS);
    expect(banner()).toBeNull();
    client.push(log);
    client.push([...log, line(2, 'Victory!')]);
    expect(banner()).toBeNull();
    opened.destroy();
  });

  it('says how many more opened alongside the newest one', () => {
    const client = fakeClient([line(1, 'Victory!')]);
    const { opened } = mount(client);
    client.push([
      line(1, 'Victory!'),
      line(2, 'Now open: Old Mill', 'opened', 'mill'),
      line(3, 'Now open: East Field', 'opened', 'east'),
      line(4, 'Now open: Old Mill → Sewers', 'opened', 'mill'),
    ]);
    expect(banner()!.textContent).toBe('🔓 Now open: Old Mill → Sewers (+2 more)');
    opened.destroy();
  });

  it('leaves openings to the away recap when it already tells them', () => {
    const client = fakeClient([line(1, 'Victory!')]);
    const { opened } = mount(client);
    const recap = { moments: [{ at: 1, kind: 'opened', text: 'Now open: East Field' }] } as unknown as AwayLedger;
    client.push([line(1, 'Victory!'), line(2, 'Now open: East Field', 'opened', 'east')], recap);
    expect(banner()).toBeNull();
    client.push([line(1, 'Victory!'), line(2, 'Now open: East Field', 'opened', 'east'), line(3, 'Victory!')]);
    expect(banner()).toBeNull();
    client.push([line(2, 'Now open: East Field', 'opened', 'east'), line(4, 'Now open: Old Mill', 'opened', 'mill')], {
      moments: [{ at: 1, kind: 'level_up', text: 'Reached level 3' }],
    } as unknown as AwayLedger);
    expect(banner()!.textContent).toBe('🔓 Now open: Old Mill');
    opened.destroy();
  });

  it('starts over without a banner when the journal is reset', () => {
    const client = fakeClient([line(40, 'Victory!')]);
    const { opened } = mount(client);
    client.push([line(1, 'Now open: Old Mill', 'opened')]);
    expect(banner()).toBeNull();
    client.push([line(1, 'Now open: Old Mill', 'opened'), line(2, 'Now open: East Field', 'opened')]);
    expect(banner()!.textContent).toBe('🔓 Now open: East Field');
    opened.destroy();
    expect(banner()).toBeNull();
    expect(client.listener).toBeNull();
  });
});
