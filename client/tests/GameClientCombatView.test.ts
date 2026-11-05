import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameClient } from '../src/network/GameClient';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  combatViews(): boolean[] {
    return this.sent.filter(m => m.type === 'combat_view').map(m => m.visible as boolean);
  }
}

let visibility: DocumentVisibilityState = 'visible';
let client: GameClient | null = null;

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

function connect(): FakeSocket {
  client = new GameClient();
  void client.connect();
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  socket.open();
  return socket;
}

beforeEach(() => {
  FakeSocket.instances = [];
  visibility = 'visible';
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  client?.destroy();
  client = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GameClient combat_view', () => {
  it('tells a new socket the combat view is hidden until a screen asks for it', () => {
    const socket = connect();
    expect(socket.combatViews()).toEqual([false]);
  });

  it('sends the requested value on open and only changes afterwards', () => {
    const socket = connect();
    client!.sendCombatView(true);
    client!.sendCombatView(true);
    client!.sendCombatView(false);
    client!.sendCombatView(false);
    expect(socket.combatViews()).toEqual([false, true, false]);
  });

  it('re-sends the current value on every open, bypassing de-duplication', () => {
    const first = connect();
    client!.sendCombatView(true);
    first.readyState = FakeSocket.CLOSED;
    const second = new FakeSocket('reconnect');
    (client as unknown as { ws: FakeSocket }).ws = second;
    second.onopen = first.onopen;
    second.open();
    expect(first.combatViews()).toEqual([false, true]);
    expect(second.combatViews()).toEqual([true]);
  });

  it('reports hidden while the page is hidden and restores the requested value when it returns', () => {
    const socket = connect();
    client!.sendCombatView(true);
    setVisibility('hidden');
    setVisibility('visible');
    expect(socket.combatViews()).toEqual([false, true, false, true]);
    const types = socket.sent.map(m => m.type);
    expect(types.slice(-2)).toEqual(['combat_view', 'request_state']);
  });

  it('stays hidden across page visibility changes when no screen asked for the view', () => {
    const socket = connect();
    setVisibility('hidden');
    setVisibility('visible');
    expect(socket.combatViews()).toEqual([false]);
  });

  it('does not report visible when the screen asks while the page is hidden, until the page returns', () => {
    const socket = connect();
    setVisibility('hidden');
    client!.sendCombatView(true);
    expect(socket.combatViews()).toEqual([false]);
    setVisibility('visible');
    expect(socket.combatViews()).toEqual([false, true]);
  });

  it('opens a socket hidden when the page is hidden even if the screen asked for the view', () => {
    visibility = 'hidden';
    client = new GameClient();
    client.sendCombatView(true);
    void client.connect();
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    socket.open();
    expect(socket.combatViews()).toEqual([false]);
  });
});
