import type { ServerStateMessage, ServerMessage, ClientMessage } from '@idle-party-rpg/shared';

const RECONNECT_DELAY = 2000;

type StateListener = (state: ServerStateMessage) => void;
type ConnectionListener = (connected: boolean) => void;

export class GameClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  private stateListeners = new Set<StateListener>();
  private connectionListeners = new Set<ConnectionListener>();

  /** True on connect, false after first state message — used to snap vs tween. */
  isInitialState = true;

  /** Most recent state from the server (null until first message). */
  lastState: ServerStateMessage | null = null;

  constructor() {
    const host = window.location.hostname || 'localhost';
    this.url = `ws://${host}:3001`;
    this.connect();
  }

  /** Subscribe to state updates. Returns an unsubscribe function. */
  subscribe(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => { this.connectionListeners.delete(listener); };
  }

  private connect(): void {
    if (this.destroyed) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[GameClient] connected');
      this.isInitialState = true;
      for (const listener of this.connectionListeners) {
        listener(true);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data as string);

        if (msg.type === 'state') {
          this.lastState = msg;
          for (const listener of this.stateListeners) {
            listener(msg);
          }
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
      for (const listener of this.connectionListeners) {
        listener(false);
      }
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
    this.stateListeners.clear();
    this.connectionListeners.clear();
  }
}
