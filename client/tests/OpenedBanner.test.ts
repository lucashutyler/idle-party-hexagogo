import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwayLedger, CombatLogEntry, ServerStateMessage } from '@idle-party-rpg/shared';
import { OPENED_BANNER_MS, OpenedBanner, newOpenings } from '../src/ui/OpenedBanner';
import type { GameClient } from '../src/network/GameClient';

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
    const opened = new OpenedBanner(client as unknown as GameClient, vi.fn());
    expect(banner()).toBeNull();
    client.push([line(1, 'Now open: Old Mill', 'opened'), line(2, 'Victory!')]);
    expect(banner()).toBeNull();
    opened.destroy();
  });

  it('seeds from the first state even when it arrives after mounting', () => {
    const client = fakeClient(null);
    const opened = new OpenedBanner(client as unknown as GameClient, vi.fn());
    client.push([line(4, 'Now open: Old Mill', 'opened')]);
    expect(banner()).toBeNull();
    opened.destroy();
  });

  it('shows a gold status banner for a new opening that opens the room when tapped', () => {
    const client = fakeClient([line(1, 'Victory!')]);
    const onOpen = vi.fn();
    const opened = new OpenedBanner(client as unknown as GameClient, onOpen);
    client.push([line(1, 'Victory!'), line(2, 'Completed quest: Bridge'), line(3, 'Now open: East Field', 'opened', 'east')]);

    const el = banner()!;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.textContent).toBe('🔓 Now open: East Field');
    el.click();
    expect(onOpen).toHaveBeenCalledWith('east');
    expect(banner()).toBeNull();
    opened.destroy();
  });

  it('never shows the same line twice, and goes away on its own', () => {
    const client = fakeClient([]);
    const opened = new OpenedBanner(client as unknown as GameClient, vi.fn());
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
    const opened = new OpenedBanner(client as unknown as GameClient, vi.fn());
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
    const opened = new OpenedBanner(client as unknown as GameClient, vi.fn());
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
    const opened = new OpenedBanner(client as unknown as GameClient, vi.fn());
    client.push([line(1, 'Now open: Old Mill', 'opened')]);
    expect(banner()).toBeNull();
    client.push([line(1, 'Now open: Old Mill', 'opened'), line(2, 'Now open: East Field', 'opened')]);
    expect(banner()!.textContent).toBe('🔓 Now open: East Field');
    opened.destroy();
    expect(banner()).toBeNull();
    expect(client.listener).toBeNull();
  });
});
