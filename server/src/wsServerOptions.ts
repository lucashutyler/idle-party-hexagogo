import type { ServerOptions } from 'ws';

/**
 * The numbers behind these are in docs/architecture/client.md → WebSocket data use.
 * Keep context takeover on: ws keeps each socket's deflate context either way, so turning it off saves no memory.
 */
export const WS_SERVER_OPTIONS = {
  noServer: true,
  // A small compressed frame can inflate to this; the ws default is 100 MiB. Client messages are all well below it.
  maxPayload: 64 * 1024,
  perMessageDeflate: {
    zlibDeflateOptions: { level: 3, memLevel: 7 },
  },
} satisfies ServerOptions;
