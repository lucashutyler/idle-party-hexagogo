import type { ServerStateMessage, ServerMessage } from '@idle-party-rpg/shared';

const RECONNECT_DELAY = 2000;

type StateListener = (state: ServerStateMessage) => void;
type ConnectionListener = (connected: boolean) => void;

export class GameClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private username: string | null = null;

  private stateListeners = new Set<StateListener>();
  private connectionListeners = new Set<ConnectionListener>();

  /** Pending login resolve/reject — set during login() call. */
  private loginResolve?: (result: { success: boolean; error?: string }) => void;

  /** True on connect, false after first state message — used to snap vs tween. */
  isInitialState = true;

  /** Most recent state from the server (null until first message). */
  lastState: ServerStateMessage | null = null;

  constructor() {
    const host = window.location.hostname || 'localhost';
    this.url = `ws://${host}:3001`;

    // Snap party position when returning from a background browser tab
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.isInitialState = true;
        this.sendRaw({ type: 'request_state' });
      }
    });
  }

  /**
   * Connect to the server and authenticate with the given username.
   * Resolves when login_success or login_error is received.
   */
  login(username: string): Promise<{ success: boolean; error?: string }> {
    this.username = username;

    return new Promise((resolve) => {
      this.loginResolve = resolve;
      this.connect();
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

  private connect(): void {
    if (this.destroyed) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[GameClient] connected');
      this.isInitialState = true;
      for (const listener of this.connectionListeners) {
        listener(true);
      }

      // Send login message on connect (initial or reconnect)
      if (this.username) {
        this.sendRaw({ type: 'login', username: this.username });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data as string);

        if (msg.type === 'login_success') {
          console.log(`[GameClient] logged in as "${msg.username}"`);
          this.loginResolve?.({ success: true });
          this.loginResolve = undefined;
          return;
        }

        if (msg.type === 'login_error') {
          console.warn('[GameClient] login error:', msg.message);
          this.loginResolve?.({ success: false, error: msg.message });
          this.loginResolve = undefined;
          return;
        }

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

      // If login() is still waiting, resolve with connection failure
      if (this.loginResolve) {
        this.loginResolve({ success: false, error: 'Could not connect to server' });
        this.loginResolve = undefined;
      }

      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this, so reconnect is handled there
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    // Only auto-reconnect if we've logged in at least once
    if (!this.username) return;

    this.reconnectTimer = setTimeout(() => {
      console.log('[GameClient] reconnecting...');
      this.connect();
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
