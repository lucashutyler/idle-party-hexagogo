import { WebSocket } from 'ws';
import { HexGrid, offsetToCube, cubeDistance, cubeToKey } from '@idle-party-rpg/shared';
import type { HexTile, OtherPlayerState, ClientSocialState, ChatMessage, BlockLevel, PartyGridPosition, PartyRole } from '@idle-party-rpg/shared';
import { PlayerSession } from './PlayerSession.js';
import type { GameStateStore, PlayerSaveData } from './GameStateStore.js';
import { FriendsSystem } from './social/FriendsSystem.js';
import { GuildSystem } from './social/GuildSystem.js';
import type { GuildStore } from './social/GuildStore.js';
import { ChatSystem } from './social/ChatSystem.js';
import { PartySystem } from './social/PartySystem.js';
import { PartyBattleManager } from './PartyBattleManager.js';
import type { ContentStore } from './ContentStore.js';

export class PlayerManager {
  private sessions = new Map<string, PlayerSession>();
  private connections = new Map<WebSocket, string>();
  private playerConnections = new Map<string, Set<WebSocket>>();
  private grid: HexGrid;
  private content: ContentStore;
  readonly friends: FriendsSystem;
  readonly guilds: GuildSystem;
  readonly chat: ChatSystem;
  readonly parties: PartySystem;
  readonly partyBattles: PartyBattleManager;
  private getAllUsernames: () => string[];

  constructor(grid: HexGrid, content: ContentStore, guildStore: GuildStore, getAllUsernames: () => string[]) {
    this.grid = grid;
    this.content = content;
    this.friends = new FriendsSystem();
    this.chat = new ChatSystem();
    this.guilds = new GuildSystem(guildStore);
    this.parties = new PartySystem();
    this.getAllUsernames = getAllUsernames;
    this.partyBattles = new PartyBattleManager(
      grid,
      content,
      (username) => this.sessions.get(username),
      (username) => this.sendStateToPlayer(username),
    );
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
      session = new PlayerSession(username, this.grid, this.content);
      this.sessions.set(username, session);
      this.friends.initPlayer(username, session.getFriends(), session.getOutgoingFriendRequests());
      this.wireCallbacks(session);
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

  /** Broadcast a message to all connected clients. */
  broadcastToAll(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const wsSet of this.playerConnections.values()) {
      for (const ws of wsSet) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
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
      incomingFriendRequests: this.friends.getIncomingRequests(username),
      outgoingFriendRequests: this.friends.getOutgoingRequests(username),
      guild: guildData?.info ?? null,
      guildMembers: guildData?.members ?? [],
      party: partyData,
      pendingInvites: this.parties.getPendingInvites(username),
      outgoingPartyInvites: this.parties.getOutgoingInvites(username),
      onlinePlayers: this.getOnlinePlayers(),
      allPlayers: this.getAllUsernames(),
      blockedUsers: session?.getBlockedUsers() ?? {},
      chatPreferences: {
        sendChannel: session?.getChatSendChannel() ?? 'zone',
        dmTarget: session?.getChatDmTarget() ?? '',
      },
    };
  }

  /** Wire all callbacks onto a session (social state, battle state, position). */
  private wireCallbacks(session: PlayerSession): void {
    session.getSocialState = () => this.getSocialState(session.username);
    session.getBattleState = () => {
      const partyId = session.getPartyId();
      if (!partyId) return null;
      return this.partyBattles.getBattleState(partyId);
    };
    session.getPartyPositionState = () => {
      const partyId = session.getPartyId();
      if (!partyId) return null;
      return this.partyBattles.getPartyState(partyId);
    };
    session.getPartyZone = () => {
      const partyId = session.getPartyId();
      if (!partyId) return null;
      return this.partyBattles.getZone(partyId);
    };
    session.getPartyPosition = () => {
      const partyId = session.getPartyId();
      if (!partyId) return null;
      return this.partyBattles.getPosition(partyId);
    };
  }

  /** Ensure a player is in a party. Auto-creates a solo party if needed. */
  ensureParty(username: string): void {
    const session = this.sessions.get(username);
    if (!session) return;
    if (session.getPartyId()) return; // already in a party

    const result = this.parties.createParty(
      username,
      (u) => this.sessions.get(u)?.getPartyId() ?? null,
      (u, id) => this.sessions.get(u)?.setPartyId(id),
    );

    if (typeof result !== 'string') {
      // Created a party — now create its battle entry
      const startTile = session.getStartingTile();
      this.partyBattles.createEntry(result.id, username, startTile);
    }
  }

  /** Ensure a player is in a party, creating battle entry at a specific tile. */
  ensurePartyAtTile(username: string, tile: import('@idle-party-rpg/shared').HexTile): void {
    const session = this.sessions.get(username);
    if (!session) return;
    if (session.getPartyId()) return;

    const result = this.parties.createParty(
      username,
      (u) => this.sessions.get(u)?.getPartyId() ?? null,
      (u, id) => this.sessions.get(u)?.setPartyId(id),
    );

    if (typeof result !== 'string') {
      this.partyBattles.createEntry(result.id, username, tile);
    }
  }

  /** Handle a player joining a party (after accept invite). */
  handlePartyJoin(username: string, partyId: string, oldPartyId: string | null): void {
    // Destroy old solo party battle entry
    if (oldPartyId) {
      this.partyBattles.destroyEntry(oldPartyId);
    }

    // Add to new party's battle
    this.partyBattles.addMember(partyId, username);
  }

  /** Handle a player leaving/being kicked from a party. Creates new solo party at current position. */
  handlePartyLeave(username: string, oldPartyId: string): void {
    // Remove from party battle
    this.partyBattles.removeMember(oldPartyId, username);

    // Get the position they were at (from the party they just left, if it still exists)
    const pos = this.partyBattles.getPosition(oldPartyId);
    let tile: import('@idle-party-rpg/shared').HexTile | null = null;
    if (pos) {
      const coord = offsetToCube(pos);
      tile = this.grid.getTile(coord) ?? null;
    }

    // Create new solo party at that position
    if (tile) {
      this.ensurePartyAtTile(username, tile);
    } else {
      this.ensureParty(username);
    }
  }

  /** Check if two players are on the same tile (uses party positions). */
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
      const partyId = session.getPartyId();
      const movementData = partyId ? this.partyBattles.getMovementSaveData(partyId) : undefined;

      // Get party role/position info
      let partyInfo: { role: 'owner' | 'leader' | 'member'; gridPosition: number } | undefined;
      if (partyId) {
        const party = this.parties.getParty(partyId);
        if (party) {
          const member = party.members.find(m => m.username === session.username);
          if (member) {
            partyInfo = { role: member.role, gridPosition: member.gridPosition };
          }
        }
      }

      data.push(session.toSaveData(movementData ?? undefined, partyInfo));
    }
    return data;
  }

  /**
   * Restore sessions from saved data. Called on server startup before any connections.
   * Groups players by saved partyId to reconstruct multi-player parties.
   * Players with invalid positions (e.g. after map migration) are moved to start tile.
   */
  restoreFromSaveData(saves: PlayerSaveData[]): void {
    const startPos = this.content.getStartTile();
    const startCoord = offsetToCube(startPos);
    const startTile = this.grid.getTile(startCoord);

    // Phase 1: Restore all sessions
    const validSaves: PlayerSaveData[] = [];
    for (const data of saves) {
      if (!data.username || data.username === 'undefined' || !data.position) {
        console.warn(`[PlayerManager] Skipping invalid save data (username="${data.username}", position=${JSON.stringify(data.position)})`);
        continue;
      }

      // Check if saved position is valid on current map
      const coord = offsetToCube(data.position);
      const tile = this.grid.getTile(coord);
      if (!tile) {
        console.warn(`[PlayerManager] Moved "${data.username}" to start tile (old position ${data.position.col},${data.position.row} no longer exists)`);
        data.position = { col: startPos.col, row: startPos.row };
        data.target = null;
        data.movementQueue = [];
      }

      try {
        const session = PlayerSession.fromSaveData(data, this.grid, this.content);
        this.sessions.set(data.username, session);
        this.friends.initPlayer(data.username, session.getFriends(), session.getOutgoingFriendRequests());
        this.wireCallbacks(session);
        validSaves.push(data);
        console.log(`[PlayerManager] Restored session for "${data.username}"`);
      } catch (err) {
        console.error(`[PlayerManager] Failed to restore "${data.username}":`, err);
      }
    }

    // Phase 2: Group by saved partyId
    const partyGroups = new Map<string, PlayerSaveData[]>();
    const soloSaves: PlayerSaveData[] = [];

    for (const data of validSaves) {
      if (data.partyId && data.partyRole !== undefined) {
        const group = partyGroups.get(data.partyId) ?? [];
        group.push(data);
        partyGroups.set(data.partyId, group);
      } else {
        soloSaves.push(data);
      }
    }

    // Phase 3: Restore multi-player parties
    for (const [savedPartyId, group] of partyGroups) {
      // If only one member left, treat as solo
      if (group.length === 1) {
        soloSaves.push(group[0]);
        continue;
      }

      // Use the owner's (or first member's) position/movement data for the party
      const ownerData = group.find(d => d.partyRole === 'owner') ?? group[0];
      const coord = offsetToCube(ownerData.position);
      const currentTile = this.grid.getTile(coord);
      if (!currentTile) {
        // Fall back to solo for all members
        soloSaves.push(...group);
        continue;
      }

      let targetTile = null;
      if (ownerData.target) {
        targetTile = this.grid.getTile(offsetToCube(ownerData.target)) ?? null;
      }
      const movementQueue = ownerData.movementQueue
        .map(p => this.grid.getTile(offsetToCube(p)))
        .filter((t): t is NonNullable<typeof t> => t !== null);

      // Restore the party in PartySystem
      const members = group.map(d => ({
        username: d.username,
        role: (d.partyRole ?? 'member') as PartyRole,
        gridPosition: (d.partyGridPosition ?? 4) as PartyGridPosition,
      }));

      const party = this.parties.restoreParty(
        savedPartyId,
        members,
        (u, id) => this.sessions.get(u)?.setPartyId(id),
      );

      // Create battle entry with the first member, then add the rest
      const firstUsername = members[0].username;
      this.partyBattles.createEntryFromSave(
        party.id,
        firstUsername,
        currentTile,
        targetTile,
        movementQueue,
      );

      for (let i = 1; i < members.length; i++) {
        this.partyBattles.addMember(party.id, members[i].username);
      }

      console.log(`[PlayerManager] Restored party "${savedPartyId}" with ${members.length} members`);
    }

    // Phase 4: Restore solo players (no party or single-member groups)
    for (const data of soloSaves) {
      const coord = offsetToCube(data.position);
      const currentTile = this.grid.getTile(coord);
      if (!currentTile) {
        // Position was already corrected to start tile above, but double-check
        if (startTile) {
          this.createSoloPartyAtTile(data.username, startTile, null, []);
        }
        continue;
      }

      let targetTile = null;
      if (data.target) {
        targetTile = this.grid.getTile(offsetToCube(data.target)) ?? null;
      }
      const movementQueue = data.movementQueue
        .map(p => this.grid.getTile(offsetToCube(p)))
        .filter((t): t is NonNullable<typeof t> => t !== null);

      this.createSoloPartyAtTile(data.username, currentTile, targetTile, movementQueue);
    }

    if (saves.length > 0) {
      console.log(`[PlayerManager] Restored ${this.sessions.size} sessions`);
    }
  }

  /** Helper to create a solo party and its battle entry at a specific tile. */
  private createSoloPartyAtTile(
    username: string,
    currentTile: import('@idle-party-rpg/shared').HexTile,
    targetTile: import('@idle-party-rpg/shared').HexTile | null,
    movementQueue: import('@idle-party-rpg/shared').HexTile[],
  ): void {
    const partyResult = this.parties.createParty(
      username,
      (u) => this.sessions.get(u)?.getPartyId() ?? null,
      (u, id) => this.sessions.get(u)?.setPartyId(id),
    );

    if (typeof partyResult !== 'string') {
      this.partyBattles.createEntryFromSave(
        partyResult.id,
        username,
        currentTile,
        targetTile,
        movementQueue,
      );
    }
  }

  /**
   * After a deploy, find all parties on unreachable tiles and relocate them.
   * Returns the number of parties relocated.
   */
  relocateDisplacedParties(grid: HexGrid, content: ContentStore): number {
    const startPos = content.getStartTile();
    const startCoord = offsetToCube(startPos);
    const reachable = grid.getReachableTiles(startCoord);

    let relocated = 0;

    for (const partyId of this.partyBattles.getAllPartyIds()) {
      const tile = this.partyBattles.getTile(partyId);
      if (!tile) continue;

      const tileKey = cubeToKey(tile.coord);
      if (reachable.has(tileKey)) continue;

      // Find nearest reachable tile
      let bestTile: HexTile | null = null;
      let bestDist = Infinity;
      for (const key of reachable) {
        const candidate = grid.getTileByKey(key);
        if (!candidate) continue;
        const dist = cubeDistance(tile.coord, candidate.coord);
        if (dist < bestDist) {
          bestDist = dist;
          bestTile = candidate;
        }
      }

      if (!bestTile) {
        // Fallback to start tile
        bestTile = grid.getTile(startCoord) ?? null;
        if (!bestTile) continue;
      }

      // Relocate the party
      this.partyBattles.relocateParty(partyId, bestTile);

      // Unlock the area for all members and log
      const members = this.partyBattles.getMembers(partyId);
      if (members) {
        for (const username of members) {
          const session = this.sessions.get(username);
          if (session) {
            session.forceUnlockTileArea(bestTile);
            session.addLogEntry('World updated — relocated to a safe room.', 'move');
          }
        }
      }

      relocated++;
    }

    return relocated;
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
