import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwayLedger, ForecastResult, ServerForecastMessage } from '@idle-party-rpg/shared';
import { FORECAST_TTL_MS, GameClient, forecastTargetKey } from '../src/network/GameClient';

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

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  ofType(type: string): Record<string, unknown>[] {
    return this.sent.filter(m => m.type === type);
  }
}

let visibility: DocumentVisibilityState = 'visible';
let client: GameClient | null = null;

function connect(): FakeSocket {
  client = new GameClient();
  void client.connect();
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  socket.open();
  return socket;
}

function reconnect(first: FakeSocket): FakeSocket {
  first.readyState = FakeSocket.CLOSED;
  const second = new FakeSocket('reconnect');
  (client as unknown as { ws: FakeSocket }).ws = second;
  second.onopen = first.onopen;
  second.onmessage = first.onmessage;
  second.open();
  return second;
}

function state(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'state',
    username: 'me',
    serverVersion: 'v1',
    combatLog: [],
    character: { level: 3, mastery: { discovered: 2, mastered: 0, version: 7, recent: [] } },
    social: { party: { id: 'p', members: [], forecastKey: 'pk1' } },
    ...extra,
  };
}

function result(partyKey = 'pk1'): ForecastResult {
  return {
    key: `v|1|${partyKey}|room:t1`, partyKey, sims: 50, wins: 45, losses: 5, stalemates: 0, winPct: 90, ci: [80, 95],
    medianMs: 9000, p90Ms: 12000, atMs: 0, killEtaMs: null, reasons: [],
  };
}

function forecastMsg(partyKey = 'pk1', status: ServerForecastMessage['status'] = 'ok'): ServerForecastMessage {
  return { type: 'forecast', target: { kind: 'room', tileId: 't1' }, key: 'k', result: status === 'ok' ? result(partyKey) : null, status };
}

function ledger(id: string): AwayLedger {
  return {
    id, since: 0, battles: 3, wins: 3, losses: 0, retreats: 0, skips: 0, xp: 10, gold: 5, levelFrom: 1, levelTo: 1,
    xpFracFrom: 0, xpFracTo: 0.1, items: {}, notableItems: [], itemsLost: 0, kills: 4, masteryUps: [], dungeons: [],
    retreatLog: [], moments: [],
  };
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GameClient presence', () => {
  it('reports visibility on every open', () => {
    const socket = connect();
    expect(socket.ofType('presence')).toEqual([{ type: 'presence', visible: true }]);
    const again = reconnect(socket);
    expect(again.ofType('presence')).toEqual([{ type: 'presence', visible: true }]);
  });

  it('reports every visibility change, before the resync request', () => {
    const socket = connect();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(socket.ofType('presence').map(m => m.visible)).toEqual([true, false, true]);
    const types = socket.sent.map(m => m.type);
    expect(types.lastIndexOf('presence')).toBeLessThan(types.lastIndexOf('request_state'));
  });

  it('opens a hidden page as not visible', () => {
    visibility = 'hidden';
    const socket = connect();
    expect(socket.ofType('presence')).toEqual([{ type: 'presence', visible: false }]);
  });
});

describe('GameClient forecasts', () => {
  it('keys targets independently of property order', () => {
    expect(forecastTargetKey({ tileId: 'a', kind: 'room' } as never)).toBe(forecastTargetKey({ kind: 'room', tileId: 'a' }));
  });

  it('requests once while pending and serves the cached reply afterwards', () => {
    const socket = connect();
    socket.receive(state());
    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })).toBeNull();
    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })).toBeNull();
    expect(socket.ofType('request_forecast')).toEqual([{ type: 'request_forecast', target: { kind: 'room', tileId: 't1' } }]);

    const listener = vi.fn();
    client!.onForecast(listener);
    socket.receive(forecastMsg());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })?.result?.winPct).toBe(90);
    expect(socket.ofType('request_forecast')).toHaveLength(1);
  });

  it('re-requests when the party key changes or the cache expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const socket = connect();
    socket.receive(state());
    client!.requestForecast({ kind: 'room', tileId: 't1' });
    socket.receive(forecastMsg());

    socket.receive(state({ social: { party: { id: 'p', members: [], forecastKey: 'pk2' } } }));
    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })).toBeNull();
    expect(socket.ofType('request_forecast')).toHaveLength(2);
    expect(client!.peekForecast({ kind: 'room', tileId: 't1' })?.result?.partyKey).toBe('pk1');

    socket.receive(forecastMsg('pk2'));
    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })).not.toBeNull();
    vi.setSystemTime(1_000_000 + FORECAST_TTL_MS + 1);
    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })).toBeNull();
    expect(socket.ofType('request_forecast')).toHaveLength(3);
  });

  it('re-requests once when a reply was computed for an older party', () => {
    const socket = connect();
    socket.receive(state());
    client!.requestForecast({ kind: 'room', tileId: 't1' });
    socket.receive(forecastMsg('pk0'));
    expect(socket.ofType('request_forecast')).toHaveLength(2);
    socket.receive(forecastMsg('pk0'));
    expect(socket.ofType('request_forecast')).toHaveLength(2);
  });

  it('keeps a pending server reply pending and does not cache it', () => {
    const socket = connect();
    socket.receive(state());
    client!.requestForecast({ kind: 'room', tileId: 't1' });
    socket.receive(forecastMsg('pk1', 'pending'));
    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })).toBeNull();
    expect(socket.ofType('request_forecast')).toHaveLength(1);
  });

  it('keeps the last good reply to peek at when the server cannot compute a new one', () => {
    const socket = connect();
    socket.receive(state());
    client!.requestForecast({ kind: 'room', tileId: 't1' });
    socket.receive(forecastMsg());
    socket.receive(state({ social: { party: { id: 'p', members: [], forecastKey: 'pk2' } } }));
    client!.requestForecast({ kind: 'room', tileId: 't1' });
    socket.receive(forecastMsg('pk2', 'unavailable'));
    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })?.status).toBe('unavailable');
    expect(client!.peekForecast({ kind: 'room', tileId: 't1' })?.result?.partyKey).toBe('pk1');
  });

  it('does not cache an unavailable reply for a request another target superseded', () => {
    const socket = connect();
    socket.receive(state());
    const listener = vi.fn();
    client!.onForecast(listener);
    client!.requestForecast({ kind: 'room', tileId: 't1' });
    client!.requestForecast({ kind: 'room', tileId: 't2' });
    socket.receive(forecastMsg('pk1', 'unavailable'));
    expect(listener).toHaveBeenCalledTimes(1);

    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })).toBeNull();
    expect(socket.ofType('request_forecast').map(m => (m.target as { tileId: string }).tileId)).toEqual(['t1', 't2', 't1']);
  });

  it('asks again for a target whose request a later one superseded, and ignores the dropped reply', () => {
    const socket = connect();
    socket.receive(state());
    const listener = vi.fn();
    client!.onForecast(listener);
    client!.requestForecast({ kind: 'room', tileId: 't1' });
    client!.requestForecast({ kind: 'room', tileId: 't2' });
    client!.requestForecast({ kind: 'room', tileId: 't1' });
    expect(socket.ofType('request_forecast')).toHaveLength(3);

    socket.receive(forecastMsg('pk1', 'unavailable'));
    expect(listener).not.toHaveBeenCalled();
    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })).toBeNull();
    expect(socket.ofType('request_forecast')).toHaveLength(3);

    socket.receive(forecastMsg());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(client!.requestForecast({ kind: 'room', tileId: 't1' })?.status).toBe('ok');
  });

  it('re-sends outstanding requests after a reconnect', () => {
    const socket = connect();
    socket.receive(state());
    client!.requestForecast({ kind: 'dungeon', dungeonId: 'd1' });
    const again = reconnect(socket);
    expect(again.ofType('request_forecast')).toEqual([{ type: 'request_forecast', target: { kind: 'dungeon', dungeonId: 'd1' } }]);
  });

  it('delivers server-pushed live battle forecasts to listeners', () => {
    const socket = connect();
    const listener = vi.fn();
    client!.onForecast(listener);
    socket.receive({ type: 'forecast', target: { kind: 'battle', battleId: 4 }, key: 'battle:4:0', result: result(), status: 'ok' });
    expect(listener.mock.calls[0][0].target).toEqual({ kind: 'battle', battleId: 4 });
    expect(client!.peekForecast({ kind: 'battle', battleId: 4 })).not.toBeNull();
  });
});

describe('GameClient bestiary and combat prefs', () => {
  it('requests the bestiary once and serves it while the mastery version matches', () => {
    const socket = connect();
    socket.receive(state());
    expect(client!.requestBestiary()).toBeNull();
    expect(client!.requestBestiary()).toBeNull();
    expect(socket.ofType('request_bestiary')).toHaveLength(1);

    const listener = vi.fn();
    client!.onBestiary(listener);
    socket.receive({ type: 'bestiary', version: 7, entries: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(client!.requestBestiary()?.version).toBe(7);

    socket.receive(state({ character: { level: 3, mastery: { discovered: 3, mastered: 0, version: 8, recent: [] } } }));
    expect(client!.requestBestiary()).toBeNull();
    expect(socket.ofType('request_bestiary')).toHaveLength(2);
  });

  it('re-sends an outstanding bestiary request after a reconnect', () => {
    const socket = connect();
    socket.receive(state());
    client!.requestBestiary();
    expect(reconnect(socket).ofType('request_bestiary')).toHaveLength(1);
  });

  it('sends the auto-retreat setting', () => {
    const socket = connect();
    client!.sendSetCombatPrefs(40);
    expect(socket.ofType('set_combat_prefs')).toEqual([{ type: 'set_combat_prefs', autoRetreatBelowPct: 40 }]);
  });
});

describe('GameClient recap', () => {
  it('caches the recap from state and replays it to late subscribers', () => {
    const socket = connect();
    socket.receive(state({ awayRecap: ledger('r1'), awayRecapItemDefinitions: { sword: { id: 'sword', name: 'Sword' } } }));
    expect(client!.lastRecap?.id).toBe('r1');
    expect(client!.lastRecapItemDefinitions.sword).toBeTruthy();
    const late = vi.fn();
    client!.onRecap(late);
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
  });

  it('notifies once per recap and again when it clears', () => {
    const socket = connect();
    const listener = vi.fn();
    client!.onRecap(listener);
    socket.receive(state({ awayRecap: ledger('r1') }));
    socket.receive(state({ awayRecap: ledger('r1') }));
    socket.receive(state());
    expect(listener.mock.calls.map(c => c[0]?.id ?? null)).toEqual(['r1', null]);
  });

  it('acknowledges and ignores the acked recap while the server catches up', () => {
    const socket = connect();
    const listener = vi.fn();
    client!.onRecap(listener);
    socket.receive(state({ awayRecap: ledger('r1') }));
    client!.sendAckRecap('r1');
    expect(socket.ofType('ack_recap')).toEqual([{ type: 'ack_recap', id: 'r1' }]);
    expect(client!.lastRecap).toBeNull();
    socket.receive(state({ awayRecap: ledger('r1') }));
    expect(client!.lastRecap).toBeNull();
    socket.receive(state({ awayRecap: ledger('r2') }));
    expect(listener.mock.calls.map(c => c[0]?.id ?? null)).toEqual(['r1', 'r2']);
  });
});
