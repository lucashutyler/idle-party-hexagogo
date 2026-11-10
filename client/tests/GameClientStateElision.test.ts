import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARTIAL_STATE_PARAM } from '@idle-party-rpg/shared';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { GameClient } from '../src/network/GameClient';

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'state', serverVersion: 'v1', ...message }) });
  }
}

const CATALOG = { recipes: [{ id: 'r1' }], itemDefs: {} };
const SHOP = { id: 'shop1', name: 'Shop', inventory: [] };

let client: GameClient;
let socket: FakeSocket;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  client = new GameClient();
  void client.connect();
  socket = FakeSocket.instances[0];
  socket.readyState = FakeSocket.OPEN;
  socket.onopen?.();
});

afterEach(() => {
  client.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GameClient state elision', () => {
  it('fills in fields the server left out before anyone sees the state', () => {
    const seen: ServerStateMessage[] = [];
    client.subscribe(state => seen.push(state));

    socket.receive({ battleCount: 1, craftingCatalog: CATALOG });
    socket.receive({ battleCount: 2, unchangedFields: ['craftingCatalog'] });

    expect(seen[1].battleCount).toBe(2);
    expect(seen[1].craftingCatalog).toEqual(CATALOG);
    expect(client.lastState?.craftingCatalog).toEqual(CATALOG);
    expect(client.lastState?.unchangedFields).toBeUndefined();
  });

  it('stamps when the latest state arrived', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      socket.receive({ battleCount: 1 });
      expect(client.lastStateAt).toBe(1_000_000);
      vi.setSystemTime(1_004_000);
      socket.receive({ battleCount: 2 });
      expect(client.lastStateAt).toBe(1_004_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays the whole state to a late subscriber', () => {
    socket.receive({ battleCount: 1, craftingCatalog: CATALOG });
    socket.receive({ battleCount: 2, unchangedFields: ['craftingCatalog'] });

    const replayed: ServerStateMessage[] = [];
    client.subscribe(state => replayed.push(state), { replay: true });

    expect(replayed).toHaveLength(1);
    expect(replayed[0].battleCount).toBe(2);
    expect(replayed[0].craftingCatalog).toEqual(CATALOG);
  });

  it('keeps carrying a field across several pushes', () => {
    socket.receive({ craftingCatalog: CATALOG });
    socket.receive({ unchangedFields: ['craftingCatalog'] });
    socket.receive({ unchangedFields: ['craftingCatalog'] });

    expect(client.lastState?.craftingCatalog).toEqual(CATALOG);
  });

  it('asks the server for partial pushes', () => {
    expect(socket.url).toContain(`${PARTIAL_STATE_PARAM}=1`);
  });

  it('drops a field the server neither sent nor named', () => {
    socket.receive({ shopDefinition: SHOP, craftingCatalog: CATALOG });
    socket.receive({ unchangedFields: ['craftingCatalog'] });

    expect(client.lastState?.shopDefinition).toBeUndefined();
    expect(client.lastState?.craftingCatalog).toEqual(CATALOG);
  });
});

describe('GameClient rosters', () => {
  const alice = { username: 'alice', col: 1, row: 1, zone: 'field' };
  const bob = { username: 'bob', col: 2, row: 2, zone: 'field' };
  const carol = { username: 'carol', col: 3, row: 3, zone: 'field' };
  const emptySocial = { friends: [], allPlayers: [], onlinePlayers: [] };
  const wholeRosters = {
    otherPlayers: { whole: [alice, bob] },
    allPlayers: { whole: [{ username: 'alice' }, { username: 'bob' }] },
    onlinePlayers: { whole: ['alice', 'bob'] },
  };

  function receive(rosters: Record<string, unknown>, extra: Record<string, unknown> = { social: emptySocial }): void {
    socket.receive({ username: 'alice', otherPlayers: [], rosters, ...extra });
  }

  it('hands subscribers whole rosters, without the player themselves', () => {
    const seen: ServerStateMessage[] = [];
    client.subscribe(state => seen.push(state));

    receive(wholeRosters);

    expect(seen[0].otherPlayers).toEqual([bob]);
    expect(seen[0].social?.allPlayers).toEqual([{ username: 'alice' }, { username: 'bob' }]);
    expect(seen[0].social?.onlinePlayers).toEqual(['alice', 'bob']);
    expect(seen[0].rosters).toBeUndefined();
  });

  it('applies changes to the rosters it holds', () => {
    receive(wholeRosters);

    const moved = { ...bob, col: 9 };
    receive({
      otherPlayers: { upserts: [moved, carol, { ...alice, col: 9 }] },
      allPlayers: { upserts: [{ username: 'carol', level: 2 }] },
      onlinePlayers: { upserts: ['carol'], removes: ['bob'] },
    });

    expect(client.lastState?.otherPlayers).toEqual([moved, carol]);
    expect(client.lastState?.social?.allPlayers).toEqual([{ username: 'alice' }, { username: 'bob' }, { username: 'carol', level: 2 }]);
    expect(client.lastState?.social?.onlinePlayers).toEqual(['alice', 'carol']);
  });

  it('drops a player who left the roster', () => {
    receive(wholeRosters);

    receive({ otherPlayers: { removes: ['bob'] } });

    expect(client.lastState?.otherPlayers).toEqual([]);
  });

  it('replaces a roster when a whole copy arrives', () => {
    receive(wholeRosters);

    receive({ otherPlayers: { whole: [alice, carol] } });

    expect(client.lastState?.otherPlayers).toEqual([carol]);
  });

  it('keeps the very same rosters and social object when nothing changed', () => {
    receive(wholeRosters);
    const first = client.lastState!;

    socket.receive({ username: 'alice', otherPlayers: [], rosters: {}, unchangedFields: ['social'] });

    expect(client.lastState?.otherPlayers).toBe(first.otherPlayers);
    expect(client.lastState?.social).toBe(first.social);
  });

  it('keeps the rosters when a fresh social arrives without them', () => {
    receive(wholeRosters);
    const first = client.lastState!;

    receive({}, { social: { ...emptySocial, friends: ['bob'] } });

    expect(client.lastState?.social?.friends).toEqual(['bob']);
    expect(client.lastState?.social?.allPlayers).toBe(first.social?.allPlayers);
    expect(client.lastState?.social?.onlinePlayers).toBe(first.social?.onlinePlayers);
  });

  it('never changes the previous state, which a subscriber may still hold', () => {
    receive(wholeRosters);
    const first = client.lastState!;
    const before = JSON.stringify(first);

    socket.receive({
      username: 'alice',
      otherPlayers: [],
      rosters: { otherPlayers: { upserts: [carol] }, allPlayers: { upserts: [{ username: 'carol' }] }, onlinePlayers: { removes: ['bob'] } },
      unchangedFields: ['social'],
    });

    expect(JSON.stringify(first)).toBe(before);
    expect(client.lastState?.social).not.toBe(first.social);
    expect(client.lastState?.social?.onlinePlayers).toEqual(['alice']);
  });

  it('leaves a state alone that holds its own rosters', () => {
    socket.receive({ username: 'alice', otherPlayers: [bob], social: { ...emptySocial, onlinePlayers: ['alice'] } });

    expect(client.lastState?.otherPlayers).toEqual([bob]);
    expect(client.lastState?.social?.onlinePlayers).toEqual(['alice']);
  });
});
