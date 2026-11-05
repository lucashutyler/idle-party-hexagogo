import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('drops a field the server neither sent nor named', () => {
    socket.receive({ shopDefinition: SHOP, craftingCatalog: CATALOG });
    socket.receive({ unchangedFields: ['craftingCatalog'] });

    expect(client.lastState?.shopDefinition).toBeUndefined();
    expect(client.lastState?.craftingCatalog).toEqual(CATALOG);
  });
});
