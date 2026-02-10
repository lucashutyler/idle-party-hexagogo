import type { ServerStateMessage, ServerMessage, ClientMessage } from '@idle-party-rpg/shared';

const RECONNECT_DELAY = 2000;

export class GameClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  /** True on connect, false after first state message — used to snap vs tween. */
  isInitialState = true;

  /** Called every time the server sends a full state update. */
  onState?: (state: ServerStateMessage) => void;

  /** Called on connection status changes. */
  onConnectionChange?: (connected: boolean) => void;

  constructor() {
    const host = window.location.hostname || 'localhost';
    this.url = `ws://${host}:3001`;
    this.connect();
  }

  private connect(): void {
    if (this.destroyed) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[GameClient] connected');
      this.isInitialState = true;
      this.onConnectionChange?.(true);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data as string);

        if (msg.type === 'state') {
          this.onState?.(msg);
          this.isInitialState = false;
        } else if (msg.type === 'error') {
          console.warn('[GameClient] server error:', msg.message);
        }
      } catch {
        console.error('[GameClient] failed to parse message');
      }
    };

    this.ws.onclose = () => {
      console.log('[GameClient] disconnected');
      this.onConnectionChange?.(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this, so reconnect is handled there
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    this.reconnectTimer = setTimeout(() => {
      console.log('[GameClient] reconnecting...');
      this.connect();
    }, RECONNECT_DELAY);
  }

  sendMove(col: number, row: number): void {
    const msg: ClientMessage = { type: 'move', col, row };
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
    this.ws = null;
  }
}
