import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'http';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { WS_SERVER_OPTIONS } from '../src/wsServerOptions.js';

let http: Server;
let wss: WebSocketServer;
let url: string;
let serverSocket: Promise<WebSocket>;

beforeEach(async () => {
  http = createServer();
  wss = new WebSocketServer(WS_SERVER_OPTIONS);
  http.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  serverSocket = new Promise(resolve => wss.once('connection', resolve));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => http.close(resolve));
});

function connect(perMessageDeflate: boolean): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise(resolve => ws.once('message', data => resolve(data.toString())));
}

async function wireBytesFor(client: WebSocket, payload: string): Promise<{ bytes: number; received: string }> {
  const server = await serverSocket;
  const before = (client as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
  const message = nextMessage(client);
  server.send(payload);
  const received = await message;
  return { bytes: (client as unknown as { _socket: { bytesRead: number } })._socket.bytesRead - before, received };
}

const STATE_LIKE = JSON.stringify({
  type: 'state',
  otherPlayers: Array.from({ length: 200 }, (_, i) => ({ username: `player_${i}`, col: i % 30, row: i % 20, zone: 'green_fields', className: 'Knight' })),
});

describe('WebSocket compression', () => {
  it('compresses a state-sized message for a browser that offers it, and it arrives intact', async () => {
    const client = await connect(true);
    expect(client.extensions).toContain('permessage-deflate');

    const { bytes, received } = await wireBytesFor(client, STATE_LIKE);

    expect(received).toBe(STATE_LIKE);
    expect(bytes).toBeLessThan(STATE_LIKE.length / 3);
    client.terminate();
  });

  it('compresses a later message the same way, so the shared window never corrupts the stream', async () => {
    const client = await connect(true);
    await wireBytesFor(client, STATE_LIKE);
    const second = STATE_LIKE.replace('player_7"', 'player_seven"');

    const { received } = await wireBytesFor(client, second);

    expect(received).toBe(second);
    client.terminate();
  });

  it('still works for a client that does not offer compression', async () => {
    const client = await connect(false);
    expect(client.extensions).toBe('');

    const { bytes, received } = await wireBytesFor(client, STATE_LIKE);

    expect(received).toBe(STATE_LIKE);
    expect(bytes).toBeGreaterThanOrEqual(STATE_LIKE.length);
    client.terminate();
  });

  it('shrinks a small message that repeats the one before it, because the window carries over', async () => {
    const client = await connect(true);
    const small = JSON.stringify({ type: 'combat', battleId: 1, events: [{ kind: 'attack', source: 'knight', target: 'goblin' }], log: ['The knight hits the goblin.'] });
    await wireBytesFor(client, small);

    const { bytes, received } = await wireBytesFor(client, small);

    expect(received).toBe(small);
    expect(bytes).toBeLessThan(small.length / 3);
    client.terminate();
  });

  it('closes a socket whose small compressed frame would inflate past the limit', async () => {
    const client = await connect(true);
    const server = await serverSocket;
    const rejected = new Promise<Error>(resolve => server.once('error', resolve));
    const closed = new Promise<number>(resolve => client.once('close', code => resolve(code)));

    client.send('a'.repeat(WS_SERVER_OPTIONS.maxPayload! * 4));

    expect((await rejected).message).toContain('Max payload size exceeded');
    expect(await closed).toBe(1009);
  });
});
