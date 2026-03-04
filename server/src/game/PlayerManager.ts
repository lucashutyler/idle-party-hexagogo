import { WebSocket } from 'ws';
import { HexGrid } from '@idle-party-rpg/shared';
import type { OtherPlayerState, ClientSocialState, ChatMessage, BlockLevel } from '@idle-party-rpg/shared';
import { PlayerSession } from './PlayerSession.js';
import type { GameStateStore, PlayerSaveData } from './GameStateStore.js';
import { FriendsSystem } from './social/FriendsSystem.js';
import { GuildSystem } from './social/GuildSystem.js';
import type { GuildStore } from './social/GuildStore.js';
import { ChatSystem } from './social/ChatSystem.js';
import { PartySystem } from './social/PartySystem.js';

export class PlayerManager {
  private sessions = new Map<string, PlayerSession>();
  private connections = new Map<WebSocket, string>();
  private playerConnections = new Map<string, Set<WebSocket>>();
  private grid: HexGrid;
  readonly friends: FriendsSystem;
  readonly guilds: GuildSystem;
  readonly chat: ChatSystem;
  readonly parties: PartySystem;
  private getAllUsernames: () => string[];

  constructor(grid: HexGrid, guildStore: GuildStore, getAllUsernames: () => string[]) {
    this.grid = grid;
    this.friends = new FriendsSystem();
    this.chat = new ChatSystem();
    this.guilds = new GuildSystem(guildStore);
    this.parties = new PartySystem();
    this.getAllUsernames = getAllUsernames;
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
      this.friends.initPlayer(username, session.getFriends());
      this.wireSocialState(session);
      this.ensureParty(username);
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

  getSessionByUsername(username: string): PlayerSession | undefined {
    return this.sessions.get(username);
  }

  getUsernameForWs(ws: WebSocket): string | undefined {
    return this.connections.get(ws);
  }

  /**
   * Rename a player: re-key the session map and update the session's username.
   */
  renamePlayer(oldUsername: string, newUsername: string): boolean {
    const session = this.sessions.get(oldUsername);
    if (!session) return false;

    this.sessions.delete(oldUsername);
    session.username = newUsername;
    this.sessions.set(newUsername, session);

    // Re-key connection maps
    const wsSet = this.playerConnections.get(oldUsername);
    if (wsSet) {
      this.playerConnections.delete(oldUsername);
      this.playerConnections.set(newUsername, wsSet);
      for (const ws of wsSet) {
        this.connections.set(ws, newUsername);
      }
    }

    console.log(`[PlayerManager] Renamed "${oldUsername}" → "${newUsername}"`);
    return true;
  }

  /** Send a chat_message to a specific player (all connections) and store in their history. */
  sendChatToPlayer(username: string, message: ChatMessage): void {
    // Store in player's personal chat history (persists with save data)
    const session = this.sessions.get(username);
    if (session) {
      session.addChatMessage(message);
    }

    const wsSet = this.playerConnections.get(username);
    if (!wsSet || wsSet.size === 0) return;
    const payload = JSON.stringify({ type: 'chat_message', message });
    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /** Get all blocked users map for chat filtering. */
  getAllBlockedUsers(): Record<string, Record<string, BlockLevel>> {
    const result: Record<string, Record<string, BlockLevel>> = {};
    for (const [username, session] of this.sessions) {
      const blocked = session.getBlockedUsers();
      if (Object.keys(blocked).length > 0) {
        result[username] = blocked;
      }
    }
    return result;
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

  /** Get list of online (connected) usernames. */
  getOnlinePlayers(): string[] {
    return Array.from(this.playerConnections.keys());
  }

  /** Build ClientSocialState for a player. */
  getSocialState(username: string): ClientSocialState {
    const session = this.sessions.get(username);
    const guildData = this.guilds.getPlayerGuild(username);
    const partyData = this.parties.getPlayerParty(
      username,
      (u) => this.sessions.get(u)?.getPartyId() ?? null,
    );
    return {
      friends: this.friends.getFriends(username),
      guild: guildData?.info ?? null,
      guildMembers: guildData?.members ?? [],
      party: partyData,
      pendingInvites: this.parties.getPendingInvites(username),
      onlinePlayers: this.getOnlinePlayers(),
      allPlayers: this.getAllUsernames(),
      blockedUsers: session?.getBlockedUsers() ?? {},
    };
  }

  /** Wire the getSocialState callback onto a session. */
  private wireSocialState(session: PlayerSession): void {
    session.getSocialState = () => this.getSocialState(session.username);
    session.onShareVictoryWithParty = (xpGained, goldGained, drops) => {
      const partyId = session.getPartyId();
      if (!partyId) return;
      const party = this.parties.getParty(partyId);
      if (!party) return;
      for (const m of party.members) {
        if (m.username === session.username) continue;
        const memberSession = this.sessions.get(m.username);
        if (memberSession) {
          memberSession.receivePartyShare(xpGained, goldGained, drops);
        }
      }
    };
  }

  /** Ensure a player is in a party. Auto-creates a solo party if needed. */
  ensureParty(username: string): void {
    const session = this.sessions.get(username);
    if (!session) return;
    if (session.getPartyId()) return; // already in a party
    this.parties.createParty(
      username,
      (u) => this.sessions.get(u)?.getPartyId() ?? null,
      (u, id) => this.sessions.get(u)?.setPartyId(id),
    );
  }

  /** Check if two players are on the same tile. */
  areSameTile(a: string, b: string): boolean {
    const sa = this.sessions.get(a);
    const sb = this.sessions.get(b);
    if (!sa || !sb) return false;
    const pa = sa.getPosition();
    const pb = sb.getPosition();
    return pa.col === pb.col && pa.row === pb.row;
  }

  getOtherPlayers(excludeUsername: string): OtherPlayerState[] {
    const others: OtherPlayerState[] = [];
    for (const [username, session] of this.sessions) {
      if (username === excludeUsername) continue;
      const pos = session.getPosition();
      others.push({ username, col: pos.col, row: pos.row, zone: session.getZone() });
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
      // Skip invalid save data
      if (!data.username || data.username === 'undefined' || !data.position) {
        console.warn(`[PlayerManager] Skipping invalid save data (username="${data.username}", position=${JSON.stringify(data.position)})`);
        continue;
      }

      try {
        const session = PlayerSession.fromSaveData(data, this.grid, () => {
          this.sendStateToPlayer(data.username);
        });
        this.sessions.set(data.username, session);
        this.friends.initPlayer(data.username, session.getFriends());
        this.wireSocialState(session);
        this.ensureParty(data.username);
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
