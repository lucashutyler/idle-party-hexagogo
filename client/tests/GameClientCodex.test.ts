import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameClient } from '../src/network/GameClient';

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = 0;
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

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  state(marker?: string): void {
    this.receive({ type: 'state', serverVersion: 'v1', character: marker === undefined ? { level: 1 } : { level: 1, codexVersion: marker } });
  }

  codexRequests(): number {
    return this.sent.filter(m => m.type === 'request_codex').length;
  }
}

const reply = (version: string) => ({ type: 'codex', version, monsters: [], items: [], shops: [], fights: [], tables: [], dungeons: [], recent: [] });

let client: GameClient;
let socket: FakeSocket;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  client = new GameClient();
  void client.connect();
  socket = FakeSocket.instances[0];
  socket.open();
});

afterEach(() => {
  client.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GameClient Codex', () => {
  it('sends nothing while the state carries no marker', () => {
    socket.state();
    expect(client.requestCodex()).toBeNull();
    expect(socket.codexRequests()).toBe(0);
  });

  it('asks once, keeps the reply, and serves it while the marker matches', () => {
    const seen = vi.fn();
    client.onCodex(seen);
    socket.state('a');
    expect(client.requestCodex()).toBeNull();
    expect(client.requestCodex()).toBeNull();
    expect(socket.codexRequests()).toBe(1);

    socket.receive(reply('a'));
    expect(seen).toHaveBeenCalledOnce();
    expect(client.requestCodex()?.version).toBe('a');
    expect(socket.codexRequests()).toBe(1);
  });

  it('returns the stale copy at once while a fresh one is asked for', () => {
    socket.state('a');
    client.requestCodex();
    socket.receive(reply('a'));
    socket.state('b');
    expect(client.requestCodex()?.version).toBe('a');
    expect(socket.codexRequests()).toBe(2);
  });

  it('asks again only after the retry window when no reply comes', () => {
    socket.state('a');
    client.requestCodex();
    vi.advanceTimersByTime(14_999);
    client.requestCodex();
    expect(socket.codexRequests()).toBe(1);
    vi.advanceTimersByTime(1);
    client.requestCodex();
    expect(socket.codexRequests()).toBe(2);
  });

  it('asks again on a new socket when a request was outstanding', () => {
    socket.state('a');
    client.requestCodex();
    socket.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(2000);
    const next = FakeSocket.instances[1];
    next.open();
    expect(next.codexRequests()).toBe(1);
  });

  it('does not ask again on a new socket once answered', () => {
    socket.state('a');
    client.requestCodex();
    socket.receive(reply('a'));
    socket.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(2000);
    FakeSocket.instances[1].open();
    expect(FakeSocket.instances[1].codexRequests()).toBe(0);
  });

  it('drops its copy when the world changes', () => {
    socket.state('a');
    client.requestCodex();
    socket.receive(reply('a'));
    socket.receive({ type: 'world_update' });
    expect(client.lastCodex).toBeNull();
  });
});
