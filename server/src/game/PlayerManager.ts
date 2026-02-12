import { WebSocket } from 'ws';
import { HexGrid } from '@idle-party-rpg/shared';
import type { OtherPlayerState } from '@idle-party-rpg/shared';
import { PlayerSession } from './PlayerSession';
import type { GameStateStore, PlayerSaveData } from './GameStateStore';

export class PlayerManager {
  private sessions = new Map<string, PlayerSession>();
  private connections = new Map<WebSocket, string>();
  private playerConnections = new Map<string, Set<WebSocket>>();
  private grid: HexGrid;

  constructor(grid: HexGrid) {
    this.grid = grid;
  }

  login(ws: WebSocket, username: string): PlayerSession {
    // Associate this connection with the username
    this.connections.set(ws, username);

    let wsSet = this.playerConnections.get(username);
    if (!wsSet) {
      wsSet = new Set();
      this.playerConnections.set(username, wsSet);
    }
    wsSet.add(ws);

    // Create session if it doesn't exist (or resume existing)
    let session = this.sessions.get(username);
    if (!session) {
      session = new PlayerSession(username, this.grid, () => {
        this.sendStateToPlayer(username);
      });
      this.sessions.set(username, session);
      console.log(`[PlayerManager] New session for "${username}" (${this.sessions.size} total sessions)`);
    } else {
      console.log(`[PlayerManager] "${username}" connected (${wsSet.size} connections, ${this.sessions.size} sessions)`);
    }

    return session;
  }

  removeConnection(ws: WebSocket): void {
    const username = this.connections.get(ws);
    if (!username) return;

    this.connections.delete(ws);

    const wsSet = this.playerConnections.get(username);
    if (wsSet) {
      wsSet.delete(ws);
      if (wsSet.size === 0) {
        this.playerConnections.delete(username);
      }
    }

    console.log(`[PlayerManager] "${username}" disconnected (session preserved, ${this.connectionCount} connections)`);
  }

  getSession(ws: WebSocket): PlayerSession | undefined {
    const username = this.connections.get(ws);
    if (!username) return undefined;
    return this.sessions.get(username);
  }

  getUsernameForWs(ws: WebSocket): string | undefined {
    return this.connections.get(ws);
  }

  sendStateToPlayer(username: string): void {
    const wsSet = this.playerConnections.get(username);
    if (!wsSet || wsSet.size === 0) return;

    const session = this.sessions.get(username);
    if (!session) return;

    const otherPlayers = this.getOtherPlayers(username);
    const state = JSON.stringify({ type: 'state' as const, ...session.getState(otherPlayers) });

    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(state);
      }
    }
  }

  getOtherPlayers(excludeUsername: string): OtherPlayerState[] {
    const others: OtherPlayerState[] = [];
    for (const [username, session] of this.sessions) {
      if (username === excludeUsername) continue;
      const pos = session.getPosition();
      others.push({ username, col: pos.col, row: pos.row });
    }
    return others;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get connectionCount(): number {
    let count = 0;
    for (const wsSet of this.playerConnections.values()) {
      count += wsSet.size;
    }
    return count;
  }

  /**
   * Collect save data for all active sessions.
   */
  getAllSaveData(): PlayerSaveData[] {
    const data: PlayerSaveData[] = [];
    for (const session of this.sessions.values()) {
      data.push(session.toSaveData());
    }
    return data;
  }

  /**
   * Restore sessions from saved data. Called on server startup before any connections.
   */
  restoreFromSaveData(saves: PlayerSaveData[]): void {
    for (const data of saves) {
      try {
        const session = PlayerSession.fromSaveData(data, this.grid, () => {
          this.sendStateToPlayer(data.username);
        });
        this.sessions.set(data.username, session);
        console.log(`[PlayerManager] Restored session for "${data.username}"`);
      } catch (err) {
        console.error(`[PlayerManager] Failed to restore "${data.username}":`, err);
      }
    }
    if (saves.length > 0) {
      console.log(`[PlayerManager] Restored ${this.sessions.size} sessions`);
    }
  }

  /**
   * Save all sessions to the store.
   */
  async saveAll(store: GameStateStore): Promise<void> {
    const data = this.getAllSaveData();
    if (data.length === 0) return;
    await store.saveAll(data);
  }

  /**
   * Add a "Server shutting down" log entry to all sessions before saving.
   */
  addShutdownLog(): void {
    for (const session of this.sessions.values()) {
      session.addLogEntry('Server shutting down — saving state...', 'battle');
    }
  }
}
