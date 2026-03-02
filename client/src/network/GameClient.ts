import type { ServerStateMessage } from '@idle-party-rpg/shared';

const RECONNECT_DELAY = 2000;

type StateListener = (state: ServerStateMessage) => void;
type ConnectionListener = (connected: boolean) => void;

export class GameClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private connected = false;

  private stateListeners = new Set<StateListener>();
  private connectionListeners = new Set<ConnectionListener>();

  /** Pending connect resolve — set during connect() call. */
  private connectResolve?: (result: { success: boolean; error?: string }) => void;

  /** True on connect, false after first state message — used to snap vs tween. */
  isInitialState = true;

  /** Most recent state from the server (null until first message). */
  lastState: ServerStateMessage | null = null;

  constructor() {
    const host = window.location.hostname || 'localhost';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Dev: Vite on :3000, server on :3001 — WS connects to :3001
    // Prod: single server serves both client and WS on the same origin
    const port = window.location.port === '3000' ? '3001' : window.location.port;
    this.url = port
      ? `${protocol}//${host}:${port}`
      : `${protocol}//${host}`;

    // Snap party position when returning from a background browser tab
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.isInitialState = true;
        this.sendRaw({ type: 'request_state' });
      }
    });
  }

  /**
   * Connect to the WebSocket server. Auth is handled via session cookie —
   * the browser sends the cookie automatically on upgrade.
   * Resolves when the first state message is received (proving auth worked).
   */
  connect(): Promise<{ success: boolean; error?: string }> {
    this.connected = false;

    return new Promise((resolve) => {
      this.connectResolve = resolve;
      this.doConnect();
    });
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

  private doConnect(): void {
    if (this.destroyed) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[GameClient] connected');
      this.connected = true;
      this.isInitialState = true;
      for (const listener of this.connectionListeners) {
        listener(true);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.type === 'state') {
          this.lastState = msg;

          // Resolve pending connect on first state message
          if (this.connectResolve) {
            this.connectResolve({ success: true });
            this.connectResolve = undefined;
          }

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

      // If connect() is still waiting, resolve with connection failure
      if (this.connectResolve) {
        this.connectResolve({ success: false, error: 'Could not connect to server' });
        this.connectResolve = undefined;
      }

      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this, so reconnect is handled there
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    // Only auto-reconnect if we've connected at least once
    if (!this.connected) return;

    this.reconnectTimer = setTimeout(() => {
      console.log('[GameClient] reconnecting...');
      this.doConnect();
    }, RECONNECT_DELAY);
  }

  private sendRaw(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendMove(col: number, row: number): void {
    this.sendRaw({ type: 'move', col, row });
  }

  sendSetPriorityStat(stat: string | null): void {
    this.sendRaw({ type: 'set_priority_stat', stat });
  }

  sendEquipItem(itemId: string): void {
    this.sendRaw({ type: 'equip_item', itemId });
  }

  sendUnequipItem(slot: string): void {
    this.sendRaw({ type: 'unequip_item', slot });
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
