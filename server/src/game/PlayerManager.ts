import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { HexGrid, offsetToCube, cubeDistance, cubeToKey, CLASS_ICONS } from '@idle-party-rpg/shared';
import type { HexTile, OtherPlayerState, ClientSocialState, ChatMessage, PartyGridPosition, PartyRole, ClassName } from '@idle-party-rpg/shared';
import { PlayerSession } from './PlayerSession.js';
import type { GameStateStore, PlayerSaveData } from './GameStateStore.js';
import { FriendsSystem } from './social/FriendsSystem.js';
import { GuildSystem } from './social/GuildSystem.js';
import type { GuildStore } from './social/GuildStore.js';
import { ChatSystem } from './social/ChatSystem.js';
import { PartySystem } from './social/PartySystem.js';
import { TradeSystem } from './social/TradeSystem.js';
import { PartyBattleManager } from './PartyBattleManager.js';
import type { ContentStore } from './ContentStore.js';
import type { AccountStore } from '../auth/AccountStore.js';

export class PlayerManager {
  private sessions = new Map<string, PlayerSession>();
  private connections = new Map<WebSocket, string>();
  private playerConnections = new Map<string, Set<WebSocket>>();
  private grid: HexGrid;
  private content: ContentStore;
  private accountStore: AccountStore;
  private store: GameStateStore;
  readonly friends: FriendsSystem;
  readonly guilds: GuildSystem;
  readonly chat: ChatSystem;
  readonly parties: PartySystem;
  readonly trades: TradeSystem;
  readonly partyBattles: PartyBattleManager;
  private getAllUsernames: () => string[];
  private readonly serverVersion = Date.now().toString();

  constructor(grid: HexGrid, content: ContentStore, guildStore: GuildStore, accountStore: AccountStore, store: GameStateStore) {
    this.grid = grid;
    this.content = content;
    this.accountStore = accountStore;
    this.store = store;
    this.friends = new FriendsSystem();
    this.chat = new ChatSystem();
    this.guilds = new GuildSystem(guildStore);
    this.parties = new PartySystem();
    this.trades = new TradeSystem();
    this.getAllUsernames = () => accountStore.getAllUsernames();
    this.partyBattles = new PartyBattleManager(
      grid,
      content,
      (username) => this.sessions.get(username),
      (username) => this.sendStateToPlayer(username),
      (members) => {
        this.cancelTradesOnMove(members);
        this.cancelInvitesOnMove(members);
      },
    );
  }

  async login(ws: WebSocket, username: string): Promise<PlayerSession> {
    // Associate this connection with the username
    this.connections.set(ws, username);

    let wsSet = this.playerConnections.get(username);
    if (!wsSet) {
      wsSet = new Set();
      this.playerConnections.set(username, wsSet);
    }
    wsSet.add(ws);

    // Record last activity timestamp
    this.accountStore.updateLastActive(username).catch(() => {});

    // Create session if it doesn't exist (or resume existing)
    let session = this.sessions.get(username);
    if (!session) {
      // Try to load saved data from disk (e.g. unbanned player returning)
      const saveData = await this.store.load(username);
      if (saveData) {
        // Session was not in memory (skipped during restore, e.g. was banned).
        // Reset position to start tile and clear party state (party not in memory).
        const startPos = this.content.getStartTile();
        saveData.position = { col: startPos.col, row: startPos.row };
        saveData.target = null;
        saveData.movementQueue = [];
        saveData.partyId = null;
        saveData.partyRole = undefined;
        saveData.partyGridPosition = undefined;
        session = PlayerSession.fromSaveData(saveData, this.grid, this.content);
      } else {
        session = new PlayerSession(username, this.grid, this.content);
      }
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
        // Cancel any active trade when all connections are gone (player fully disconnected)
        const cancelledTrade = this.trades.cancelTrade(username, 'Player disconnected');
        if (cancelledTrade) {
          const partner = cancelledTrade.initiator.username === username
            ? cancelledTrade.target?.username
            : cancelledTrade.initiator.username;
          if (partner) {
            this.sendStateToPlayer(partner);
          }
        }
      }
    }

    console.log(`[PlayerManager] "${username}" disconnected (session preserved, ${this.connectionCount} connections)`);
  }

  /** Kick a player: close all WebSocket connections with suspension code. */
  kickPlayer(username: string): void {
    const wsSet = this.playerConnections.get(username);
    if (wsSet) {
      for (const ws of wsSet) {
        ws.close(4001, 'Account suspended');
        this.connections.delete(ws);
      }
      this.playerConnections.delete(username);
    }
    console.log(`[PlayerManager] Kicked "${username}"`);
  }

  /**
   * Ban a player: save state, remove from party/combat/map, close connections, delete session.
   * The player's save data is preserved on disk (frozen at ban time).
   * Called by admin deactivation — fully vanishes the player from the game.
   */
  async banPlayer(username: string, store?: GameStateStore): Promise<void> {
    const saveStore = store ?? this.store;
    const session = this.sessions.get(username);

    // Cancel any active trade
    const cancelledTrade = this.trades.cancelTrade(username, 'Player suspended');
    if (cancelledTrade) {
      const partner = cancelledTrade.initiator.username === username
        ? cancelledTrade.target?.username
        : cancelledTrade.initiator.username;
      if (partner) this.sendStateToPlayer(partner);
    }

    // Save current state before removal (freezes XP/inventory at ban time)
    if (session) {
      const partyId = session.getPartyId();
      const movementData = partyId ? this.partyBattles.getMovementSaveData(partyId) : undefined;
      let partyInfo: { role: PartyRole; gridPosition: number } | undefined;
      if (partyId) {
        const party = this.parties.getParty(partyId);
        if (party) {
          const member = party.members.find(m => m.username === username);
          if (member) partyInfo = { role: member.role, gridPosition: member.gridPosition };
        }
      }
      const saveData = session.toSaveData(movementData ?? undefined, partyInfo);
      await saveStore.saveAll([saveData]);
    }

    // Remove from party (and its battle entry)
    const partyId = session?.getPartyId();
    if (partyId) {
      // leaveParty handles both solo (deletes party) and multi-player (transfers ownership)
      this.parties.leaveParty(
        username,
        (u) => this.sessions.get(u)?.getPartyId() ?? null,
        (u, id) => this.sessions.get(u)?.setPartyId(id),
      );
      this.partyBattles.removeMember(partyId, username);
    }

    // Remove from friends system
    this.friends.removePlayer(username);

    // Remove session from memory (stops battles, removes from map/player lists)
    this.sessions.delete(username);

    // Close all WebSocket connections
    this.kickPlayer(username);

    console.log(`[PlayerManager] Banned "${username}" — session removed, state saved`);
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

  /** Broadcast a global welcome message when a new player picks their class. */
  broadcastWelcome(username: string, className: ClassName): void {
    const icon = CLASS_ICONS[className] ?? '';
    const text = `Welcome our new ${className}, ${username}, to the world! ${icon}`;
    const recipients = Array.from(this.sessions.keys())
      .map(u => ({ username: u, send: (m: ChatMessage) => this.sendChatToPlayer(u, m) }));
    this.chat.sendMessage('Server', 'server', 'server', text, recipients);
  }

  private static readonly SYNC_CHAT_LIMIT = 200;

  /** Get chat messages for a player since a given message ID (for incremental sync). */
  syncChatForPlayer(username: string, sinceId?: string): { messages: ChatMessage[]; full: boolean } {
    const session = this.sessions.get(username);
    if (!session) return { messages: [], full: true };

    if (!sinceId) {
      // No sinceId — return the latest batch
      const all = session.getChatHistory();
      return {
        messages: all.slice(-PlayerManager.SYNC_CHAT_LIMIT),
        full: true,
      };
    }

    const result = session.getMessagesSince(sinceId);
    if (result.found) {
      return { messages: result.messages, full: true };
    }

    // sinceId not found — client cache is stale, return latest batch
    const all = session.getChatHistory();
    return {
      messages: all.slice(-PlayerManager.SYNC_CHAT_LIMIT),
      full: false,
    };
  }

  sendStateToPlayer(username: string): void {
    const wsSet = this.playerConnections.get(username);
    if (!wsSet || wsSet.size === 0) return;

    const session = this.sessions.get(username);
    if (!session) return;

    const otherPlayers = this.getOtherPlayers(username);
    const state = JSON.stringify({ type: 'state' as const, ...session.getState(otherPlayers), serverVersion: this.serverVersion });

    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(state);
      }
    }
  }

  /** Send an error message to all connections for a specific player. */
  sendErrorToPlayer(username: string, message: string): void {
    const wsSet = this.playerConnections.get(username);
    if (!wsSet || wsSet.size === 0) return;
    const payload = JSON.stringify({ type: 'error', message });
    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
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
      allPlayers: this.getAllUsernames()
        .filter(u => {
          const acct = this.accountStore.findByUsername(u);
          return !acct?.deactivated;
        })
        .map(u => ({
          username: u,
          className: this.sessions.get(u)?.getClassName(),
          level: this.sessions.get(u)?.getLevel(),
        })),
      blockedUsers: session?.getBlockedUsers() ?? {},
      chatPreferences: {
        sendChannel: session?.getChatSendChannel() ?? 'zone',
        dmTarget: session?.getChatDmTarget() ?? '',
      },
      pendingTrade: this.trades.getPlayerTrade(username),
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
    session.getCurrentTile = () => {
      const partyId = session.getPartyId();
      if (!partyId) return null;
      return this.partyBattles.getTile(partyId);
    };
    session.getCurrentPath = () => {
      const partyId = session.getPartyId();
      if (!partyId) return [];
      return this.partyBattles.getPath(partyId);
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
    // Capture the position BEFORE removeMember — if this was the last member, the
    // entry will be destroyed and we'd lose the position (teleporting the player to start).
    const pos = this.partyBattles.getPosition(oldPartyId);

    // Remove from party battle
    this.partyBattles.removeMember(oldPartyId, username);

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
      others.push({ username, col: pos.col, row: pos.row, zone: session.getZone(), className: session.getClassName() });
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
    let phaseStart: number;

    // Phase 1: Restore all sessions
    phaseStart = performance.now();
    const validSaves: PlayerSaveData[] = [];
    for (const data of saves) {
      if (!data.username || data.username === 'undefined' || !data.position) {
        console.warn(`[PlayerManager] Skipping invalid save data (username="${data.username}", position=${JSON.stringify(data.position)})`);
        continue;
      }

      // Skip deactivated (banned) accounts — they should not resume battling
      const account = this.accountStore.findByUsername(data.username);
      if (account?.deactivated) {
        console.log(`[PlayerManager] Skipping deactivated account "${data.username}"`);
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

    console.log(`[Startup] Phase 1: ${validSaves.length} sessions deserialized in ${(performance.now() - phaseStart).toFixed(1)}ms`);

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
    phaseStart = performance.now();
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

    console.log(`[Startup] Phase 3: ${partyGroups.size} multi-player parties restored in ${(performance.now() - phaseStart).toFixed(1)}ms`);

    // Phase 4: Restore solo players (no party or single-member groups)
    phaseStart = performance.now();
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
      console.log(`[Startup] Phase 4: ${soloSaves.length} solo parties created in ${(performance.now() - phaseStart).toFixed(1)}ms`);
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
   * Master reset: reset all players to level 1, 0 XP, start tile, keeping their chosen class.
   * Disbands all parties and restarts everyone as solo at the start tile.
   * Returns the number of players reset.
   */
  masterReset(): number {
    const startPos = this.content.getStartTile();
    const startCoord = offsetToCube(startPos);
    const startTile = this.grid.getTile(startCoord);
    if (!startTile) throw new Error('Invalid starting position for master reset');

    // Destroy all party battle entries
    for (const partyId of this.partyBattles.getAllPartyIds()) {
      this.partyBattles.destroyEntry(partyId);
    }

    // Disband all parties
    this.parties.disbandAll();

    let count = 0;
    for (const session of this.sessions.values()) {
      session.resetForMasterReset(startTile);
      this.wireCallbacks(session);

      // Create a fresh solo party at start tile
      this.createSoloPartyAtTile(session.username, startTile, null, []);
      count++;
    }

    console.log(`[PlayerManager] Master reset: ${count} players reset to start`);
    return count;
  }

  /** Cancel trades for all party members when the party moves to a new tile. */
  private cancelTradesOnMove(members: ReadonlySet<string>): void {
    for (const username of members) {
      const cancelled = this.trades.cancelTrade(username, 'Player moved to a different room');
      if (cancelled) {
        const partner = cancelled.initiator.username === username
          ? cancelled.target?.username
          : cancelled.initiator.username;
        if (partner) {
          this.sendStateToPlayer(partner);
        }
        this.sendStateToPlayer(username);
      }
    }
  }

  /** Cancel any pending party invites involving party members that just moved. */
  private cancelInvitesOnMove(members: ReadonlySet<string>): void {
    const affected = this.parties.cancelInvitesInvolving(members);
    for (const username of affected) {
      this.sendStateToPlayer(username);
    }
  }

  /** Check if either player has the other blocked (in either direction). */
  isTradeBlocked(a: string, b: string): boolean {
    const sessionA = this.sessions.get(a);
    const sessionB = this.sessions.get(b);
    const blockedByA = sessionA?.getBlockedUsers() ?? {};
    const blockedByB = sessionB?.getBlockedUsers() ?? {};
    return b in blockedByA || a in blockedByB;
  }

  /** Check if a player has an item in their unequipped inventory. */
  hasItemInInventory(username: string, itemId: string, quantity: number = 1): boolean {
    const session = this.sessions.get(username);
    if (!session) return false;
    return session.getInventoryCount(itemId) >= quantity;
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

  /**
   * Broadcast a party event to all current members of `partyId`, with a personalized
   * message for the subject of the event ("You were ..." vs "<name> was ...").
   * If the subject is no longer in the party (e.g. just kicked), they get a server
   * channel message instead.
   */
  broadcastPartyEvent(
    partyId: string,
    subjectUsername: string,
    selfText: string,
    othersText: string,
  ): void {
    const party = this.parties.getParty(partyId);
    if (!party) return;

    const timestamp = Date.now();
    const subjectInParty = party.members.some(m => m.username === subjectUsername);

    for (const member of party.members) {
      const text = member.username === subjectUsername ? selfText : othersText;
      this.sendChatToPlayer(member.username, {
        id: randomUUID(),
        channelType: 'party',
        channelId: partyId,
        senderUsername: 'Server',
        text,
        timestamp,
      });
    }

    if (!subjectInParty) {
      this.sendChatToPlayer(subjectUsername, {
        id: randomUUID(),
        channelType: 'server',
        channelId: 'server',
        senderUsername: 'Server',
        text: selfText,
        timestamp,
      });
    }
  }

  /**
   * Broadcast a server chat message to all existing sessions.
   */
  broadcastServerMessage(text: string): void {
    const recipients = Array.from(this.sessions.keys())
      .map(u => ({ username: u, send: (m: ChatMessage) => this.sendChatToPlayer(u, m) }));
    this.chat.sendMessage('Server', 'server', 'server', text, recipients);
  }
}
