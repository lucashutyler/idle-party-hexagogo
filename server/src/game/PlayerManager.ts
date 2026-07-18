import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { offsetToCube, cubeDistance, cubeToKey } from '@idle-party-rpg/shared';
import type { HexGrid, HexTile, OtherPlayerState, ClientSocialState, ChatMessage, PartyGridPosition, PartyRole, ClassName, NotificationEntry } from '@idle-party-rpg/shared';
import { PlayerSession } from './PlayerSession.js';
import type { WorldGrids } from './WorldGrids.js';
import type { GameStateStore, PlayerSaveData } from './GameStateStore.js';
import { FriendsSystem } from './social/FriendsSystem.js';
import { GuildSystem } from './social/GuildSystem.js';
import type { GuildStore } from './social/GuildStore.js';
import { ChatSystem } from './social/ChatSystem.js';
import { PartySystem } from './social/PartySystem.js';
import { TradeSystem } from './social/TradeSystem.js';
import { MailboxSystem } from './social/MailboxSystem.js';
import { NotificationSystem } from './social/NotificationSystem.js';
import { NotificationService } from './social/NotificationService.js';
import { InAppNotificationDriver } from './social/InAppNotificationDriver.js';
import { BrowserPushNotificationDriver } from './social/BrowserPushNotificationDriver.js';
import { EmailNotificationDriver } from './social/EmailNotificationDriver.js';
import { PartyBattleManager } from './PartyBattleManager.js';
import type { ContentStore } from './ContentStore.js';
import type { AccountStore } from '../auth/AccountStore.js';

export class PlayerManager {
  private sessions = new Map<string, PlayerSession>();
  private connections = new Map<WebSocket, string>();
  private playerConnections = new Map<string, Set<WebSocket>>();
  private grids: WorldGrids;
  private content: ContentStore;
  private accountStore: AccountStore;
  private store: GameStateStore;
  readonly friends: FriendsSystem;
  readonly guilds: GuildSystem;
  readonly chat: ChatSystem;
  readonly parties: PartySystem;
  readonly trades: TradeSystem;
  readonly mailboxes: MailboxSystem;
  readonly notifications: NotificationSystem;
  readonly notify: NotificationService;
  readonly partyBattles: PartyBattleManager;
  private getAllUsernames: () => string[];
  private readonly serverVersion = Date.now().toString();

  constructor(grids: WorldGrids, content: ContentStore, guildStore: GuildStore, accountStore: AccountStore, store: GameStateStore) {
    this.grids = grids;
    this.content = content;
    this.accountStore = accountStore;
    this.store = store;
    this.friends = new FriendsSystem();
    this.chat = new ChatSystem();
    this.guilds = new GuildSystem(guildStore);
    this.parties = new PartySystem();
    this.trades = new TradeSystem();
    this.mailboxes = new MailboxSystem();
    this.notifications = new NotificationSystem();
    this.notify = new NotificationService(
      (username) => this.sessions.get(username)?.getNotificationPreferences(),
      [
        new InAppNotificationDriver(this.notifications, (username, ctx) => this.sendNotificationToPlayer(username, ctx.entry)),
        new BrowserPushNotificationDriver(
          (username) => this.sessions.get(username)?.getPushSubscriptions() ?? [],
          (username, endpoint) => this.sessions.get(username)?.removePushSubscription(endpoint),
        ),
        new EmailNotificationDriver((username) => accountStore.findByUsername(username)?.email ?? null),
      ],
    );
    this.getAllUsernames = () => accountStore.getAllUsernames();
    this.partyBattles = new PartyBattleManager(
      grids,
      content,
      (username) => this.sessions.get(username),
      (username) => this.sendStateToPlayer(username),
      (members) => {
        this.cancelInvitesOnMove(members);
      },
    );
  }

  /** The world's default (spawn) map grid. */
  private defaultGrid(): HexGrid {
    return this.grids.getOrThrow(this.content.getWorld().defaultMapId);
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
        saveData.mapId = this.content.getWorld().defaultMapId;
        saveData.target = null;
        saveData.movementQueue = [];
        saveData.partyId = null;
        saveData.partyRole = undefined;
        saveData.partyGridPosition = undefined;
        session = PlayerSession.fromSaveData(saveData, this.grids, this.content);
      } else {
        session = new PlayerSession(username, this.grids, this.content);
      }
      this.sessions.set(username, session);
      this.friends.initPlayer(username, session.getFriends(), session.getOutgoingFriendRequests());
      const initialMailbox = session.consumeInitialMailbox();
      if (initialMailbox.length > 0) this.mailboxes.setMailbox(username, initialMailbox);
      const initialNotifications = session.consumeInitialNotifications();
      if (initialNotifications.length > 0) this.notifications.setInbox(username, initialNotifications);
      this.wireCallbacks(session);
      if (session.hasCharacter()) {
        this.ensureParty(username);
      }
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
        // Trades are async — they persist across disconnect. Nothing to cancel here.
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

    // Cancel all active trades involving this player
    const cancelledTrades = this.trades.cancelAllForPlayer(username, 'Player suspended');
    for (const t of cancelledTrades) {
      const partner = t.initiator.username === username
        ? t.target?.username
        : t.initiator.username;
      if (partner) this.sendStateToPlayer(partner);
    }

    // Save current state before removal (freezes XP/inventory at ban time)
    if (session) {
      const partyId = session.getPartyId();
      const movementData = partyId ? this.partyBattles.getMovementSaveData(partyId) : undefined;
      const dungeonData = partyId ? this.partyBattles.getDungeonSaveData(partyId) : null;
      let partyInfo: { role: PartyRole; gridPosition: number } | undefined;
      if (partyId) {
        const party = this.parties.getParty(partyId);
        if (party) {
          const member = party.members.find(m => m.username === username);
          if (member) partyInfo = { role: member.role, gridPosition: member.gridPosition };
        }
      }
      const saveData = session.toSaveData(movementData ?? undefined, partyInfo, dungeonData);
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

  /** All in-memory sessions — online and offline (idle sessions keep running). */
  getAllSessions(): PlayerSession[] {
    return Array.from(this.sessions.values());
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

  /** Push a live notification toast over any open WebSocket connections (in_app channel). */
  sendNotificationToPlayer(username: string, notification: NotificationEntry): void {
    const wsSet = this.playerConnections.get(username);
    if (!wsSet || wsSet.size === 0) return;
    const payload = JSON.stringify({ type: 'notification', notification });
    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /** Broadcast a global welcome message when a new player picks their class. */
  broadcastWelcome(username: string, className: ClassName): void {
    const text = `Welcome our new ${className}, ${username}, to the world!`;
    const recipients = Array.from(this.sessions.entries())
      .filter(([, s]) => s.hasCharacter())
      .map(([u]) => ({ username: u, send: (m: ChatMessage) => this.sendChatToPlayer(u, m) }));
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

  /** Get the size of the player's current party (1 = solo). */
  getPartySize(username: string): number {
    const session = this.sessions.get(username);
    const partyId = session?.getPartyId();
    if (!partyId) return 1;
    const party = this.parties.getParty(partyId);
    return party?.members.length ?? 1;
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
          if (acct?.deactivated) return false;
          const s = this.sessions.get(u);
          if (s && !s.hasCharacter()) return false;
          return true;
        })
        .map(u => ({
          username: u,
          className: this.sessions.get(u)?.getClassName() ?? undefined,
          level: this.sessions.get(u)?.getLevel(),
        })),
      blockedUsers: session?.getBlockedUsers() ?? {},
      chatPreferences: {
        sendChannel: session?.getChatSendChannel() ?? 'zone',
        dmTarget: session?.getChatDmTarget() ?? '',
      },
      proposedTrades: this.trades.getPlayerTrades(username),
      mailbox: this.mailboxes.getMailbox(username),
      notifications: this.notifications.getInbox(username),
      notificationPreferences: session?.getNotificationPreferences(),
    };
  }

  /** Wire all callbacks onto a session (social state, battle state, position). */
  private wireCallbacks(session: PlayerSession): void {
    session.getSocialState = () => this.getSocialState(session.username);
    session.getMailbox = () => this.mailboxes.getMailbox(session.username);
    session.getNotifications = () => this.notifications.getInbox(session.username);
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
    session.getPartyMapId = () => {
      const partyId = session.getPartyId();
      if (!partyId) return null;
      return this.partyBattles.getMapId(partyId);
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
    session.getDungeonState = () => {
      const partyId = session.getPartyId();
      if (!partyId) return null;
      return this.partyBattles.getDungeonRunInfo(partyId);
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
      // Created a party — now create its battle entry on the default (spawn) map
      const startTile = session.getStartingTile();
      this.partyBattles.createEntry(result.id, username, startTile, this.content.getWorld().defaultMapId);
    }
  }

  /** Ensure a player is in a party, creating battle entry at a specific tile on `mapId`. */
  ensurePartyAtTile(username: string, tile: import('@idle-party-rpg/shared').HexTile, mapId: string): void {
    const session = this.sessions.get(username);
    if (!session) return;
    if (session.getPartyId()) return;

    const result = this.parties.createParty(
      username,
      (u) => this.sessions.get(u)?.getPartyId() ?? null,
      (u, id) => this.sessions.get(u)?.setPartyId(id),
    );

    if (typeof result !== 'string') {
      this.partyBattles.createEntry(result.id, username, tile, mapId);
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
    // Capture the position + map BEFORE removeMember — if this was the last member, the
    // entry will be destroyed and we'd lose them (teleporting the player to start).
    const pos = this.partyBattles.getPosition(oldPartyId);
    const mapId = this.partyBattles.getMapId(oldPartyId) ?? this.content.getWorld().defaultMapId;

    // Remove from party battle
    this.partyBattles.removeMember(oldPartyId, username);

    let tile: import('@idle-party-rpg/shared').HexTile | null = null;
    if (pos) {
      const coord = offsetToCube(pos);
      tile = this.grids.get(mapId)?.getTile(coord) ?? null;
    }

    // Create new solo party at that position on the same map
    if (tile) {
      this.ensurePartyAtTile(username, tile, mapId);
    } else {
      this.ensureParty(username);
    }
  }

  /**
   * Handle a dungeon entry request. The whole party enters together.
   * Returns an error string on failure, or null on success.
   */
  handleEnterDungeon(username: string, col: number, row: number, dungeonId: string): string | null {
    const session = this.sessions.get(username);
    if (!session) return 'No session.';
    const partyId = session.getPartyId();
    if (!partyId) return 'No party.';

    // The party must actually be standing on the requested entrance room.
    const pos = this.partyBattles.getPosition(partyId);
    if (!pos || pos.col !== col || pos.row !== row) {
      return 'You must be at the dungeon entrance.';
    }

    const result = this.partyBattles.enterDungeon(partyId, dungeonId);
    if (!result.success) return result.error;

    // State for every member is pushed by enterDungeon's broadcast.
    return null;
  }

  /** Handle a dungeon bail-out request. Returns true if the party left a dungeon. */
  handleLeaveDungeon(username: string): boolean {
    const session = this.sessions.get(username);
    if (!session) return false;
    const partyId = session.getPartyId();
    if (!partyId) return false;
    return this.partyBattles.leaveDungeon(partyId);
  }

  /**
   * Handle a map-transition request. The whole party travels together through
   * the transition on its current room. Returns an error string on failure, or
   * null on success.
   */
  handleEnterTransition(username: string, targetTileId: string): string | null {
    const session = this.sessions.get(username);
    if (!session) return 'No session.';
    const partyId = session.getPartyId();
    if (!partyId) return 'No party.';
    const result = this.partyBattles.enterTransition(partyId, targetTileId);
    return result.success ? null : result.error;
  }

  /** Check if two players are on the same tile (uses party positions). */
  areSameTile(a: string, b: string): boolean {
    const sa = this.sessions.get(a);
    const sb = this.sessions.get(b);
    if (!sa || !sb) return false;
    const pa = sa.getPosition();
    const pb = sb.getPosition();
    return sa.getMapId() === sb.getMapId() && pa.col === pb.col && pa.row === pb.row;
  }

  getOtherPlayers(excludeUsername: string): OtherPlayerState[] {
    const others: OtherPlayerState[] = [];
    for (const [username, session] of this.sessions) {
      if (username === excludeUsername) continue;
      if (!session.hasCharacter()) continue;
      const pos = session.getPosition();
      const dungeon = session.getDungeonState?.();
      others.push({
        username,
        col: pos.col,
        row: pos.row,
        mapId: session.getMapId(),
        zone: session.getZone(),
        className: session.getClassName() ?? undefined,
        partyId: session.getPartyId() ?? undefined,
        inDungeon: dungeon ? true : undefined,
        dungeonName: dungeon?.name,
      });
    }
    return others;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Tick all sessions' craft queues. Sessions whose queues advance receive a state push
   * (only if currently online — otherwise the next reconnect will push state anyway).
   */
  tickAllCrafting(now: number = Date.now()): void {
    for (const [username, session] of this.sessions) {
      if (session.processCraftCompletions(now)) {
        if (this.playerConnections.has(username)) {
          this.sendStateToPlayer(username);
        }
      }
    }
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
      const dungeonData = partyId ? this.partyBattles.getDungeonSaveData(partyId) : null;

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

      data.push(session.toSaveData(movementData ?? undefined, partyInfo, dungeonData));
    }
    return data;
  }

  /**
   * Restore sessions from saved data. Called on server startup before any connections.
   * Groups players by saved partyId to reconstruct multi-player parties.
   * Players with invalid positions (e.g. after map migration) are moved to start tile.
   */
  restoreFromSaveData(saves: PlayerSaveData[]): void {
    const defaultMapId = this.content.getWorld().defaultMapId;
    const startPos = this.content.getStartTile();
    const startCoord = offsetToCube(startPos);
    const startTile = this.defaultGrid().getTile(startCoord);
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

      // Check if the saved position is valid on its map. If the map or tile is
      // gone (deleted content), send the player back to the default-map start.
      const saveMapId = data.mapId ?? defaultMapId;
      const tile = this.grids.get(saveMapId)?.getTile(offsetToCube(data.position));
      if (!tile) {
        console.warn(`[PlayerManager] Moved "${data.username}" to start tile (old position ${saveMapId}:${data.position.col},${data.position.row} no longer exists)`);
        data.position = { col: startPos.col, row: startPos.row };
        data.mapId = defaultMapId;
        data.target = null;
        data.movementQueue = [];
      }

      try {
        const session = PlayerSession.fromSaveData(data, this.grids, this.content);
        this.sessions.set(data.username, session);
        this.friends.initPlayer(data.username, session.getFriends(), session.getOutgoingFriendRequests());
        const initialMailbox = session.consumeInitialMailbox();
        if (initialMailbox.length > 0) this.mailboxes.setMailbox(data.username, initialMailbox);
        const initialNotifications = session.consumeInitialNotifications();
        if (initialNotifications.length > 0) this.notifications.setInbox(data.username, initialNotifications);
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
      // Skip characterless players — they don't exist in the game yet
      const session = this.sessions.get(data.username);
      if (session && !session.hasCharacter()) continue;

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

      // Use the owner's (or first member's) position/movement/map data for the party
      const ownerData = group.find(d => d.partyRole === 'owner') ?? group[0];
      const partyMapId = ownerData.mapId ?? defaultMapId;
      const partyGrid = this.grids.get(partyMapId);
      const currentTile = partyGrid?.getTile(offsetToCube(ownerData.position));
      if (!partyGrid || !currentTile) {
        // Fall back to solo for all members
        soloSaves.push(...group);
        continue;
      }

      let targetTile = null;
      if (ownerData.target) {
        targetTile = partyGrid.getTile(offsetToCube(ownerData.target)) ?? null;
      }
      const movementQueue = ownerData.movementQueue
        .map(p => partyGrid.getTile(offsetToCube(p)))
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
        partyMapId,
      );

      for (let i = 1; i < members.length; i++) {
        this.partyBattles.addMember(party.id, members[i].username);
      }

      // Resume an in-progress dungeon run (uses the owner's saved run).
      if (ownerData.dungeonRun) {
        this.partyBattles.restoreDungeonRun(party.id, ownerData.dungeonRun);
      }

      console.log(`[PlayerManager] Restored party "${savedPartyId}" with ${members.length} members`);
    }

    console.log(`[Startup] Phase 3: ${partyGroups.size} multi-player parties restored in ${(performance.now() - phaseStart).toFixed(1)}ms`);

    // Phase 4: Restore solo players (no party or single-member groups)
    phaseStart = performance.now();
    for (const data of soloSaves) {
      const soloMapId = data.mapId ?? defaultMapId;
      const soloGrid = this.grids.get(soloMapId);
      const currentTile = soloGrid?.getTile(offsetToCube(data.position));
      if (!soloGrid || !currentTile) {
        // Position was already corrected to start tile above, but double-check
        if (startTile) {
          this.createSoloPartyAtTile(data.username, startTile, null, [], defaultMapId);
        }
        continue;
      }

      let targetTile = null;
      if (data.target) {
        targetTile = soloGrid.getTile(offsetToCube(data.target)) ?? null;
      }
      const movementQueue = data.movementQueue
        .map(p => soloGrid.getTile(offsetToCube(p)))
        .filter((t): t is NonNullable<typeof t> => t !== null);

      this.createSoloPartyAtTile(data.username, currentTile, targetTile, movementQueue, soloMapId);

      // Resume an in-progress dungeon run for this solo player.
      if (data.dungeonRun) {
        const partyId = this.sessions.get(data.username)?.getPartyId();
        if (partyId) this.partyBattles.restoreDungeonRun(partyId, data.dungeonRun);
      }
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
    mapId: string,
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
        mapId,
      );
    }
  }

  /**
   * After a deploy, find all parties on unreachable tiles and relocate them.
   * Returns the number of parties relocated.
   */
  relocateDisplacedParties(grids: WorldGrids, content: ContentStore): number {
    const world = content.getWorld();
    const defaultMapId = world.defaultMapId;
    let relocated = 0;

    for (const partyId of this.partyBattles.getAllPartyIds()) {
      const tile = this.partyBattles.getTile(partyId);
      if (!tile) continue;
      const currentMapId = this.partyBattles.getMapId(partyId) ?? defaultMapId;
      const grid = grids.get(currentMapId);

      let targetMapId = currentMapId;
      let bestTile: HexTile | null = null;

      if (!grid) {
        // The party's whole map was deleted — drop them at the default map's start.
        targetMapId = defaultMapId;
        bestTile = this.defaultGrid().getTile(offsetToCube(world.startTile)) ?? null;
      } else {
        // Reachability is computed within the party's own map.
        const meta = world.maps.find(m => m.id === currentMapId);
        const startCoord = offsetToCube(meta?.startTile ?? world.startTile);
        const reachable = grid.getReachableTiles(startCoord);
        if (reachable.has(cubeToKey(tile.coord))) continue; // still reachable

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
        if (!bestTile) bestTile = grid.getTile(startCoord) ?? null;
      }

      if (!bestTile) continue;
      const mapChanged = targetMapId !== currentMapId;
      this.partyBattles.relocateParty(partyId, bestTile, targetMapId);

      // Unlock the area for all members and log.
      const members = this.partyBattles.getMembers(partyId);
      if (members) {
        for (const username of members) {
          const session = this.sessions.get(username);
          if (!session) continue;
          if (mapChanged) session.switchMapGrid(bestTile);
          else session.forceUnlockTileArea(bestTile);
          session.addLogEntry('World updated — relocated to a safe room.', 'move');
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
    const defaultMapId = this.content.getWorld().defaultMapId;
    const startTile = this.defaultGrid().getTile(startCoord);
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

      // Create a fresh solo party at start tile (only for players with characters)
      if (session.hasCharacter()) {
        this.createSoloPartyAtTile(session.username, startTile, null, [], defaultMapId);
      }
      count++;
    }

    console.log(`[PlayerManager] Master reset: ${count} players reset to start`);
    return count;
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
    const recipients = Array.from(this.sessions.entries())
      .filter(([, s]) => s.hasCharacter())
      .map(([u]) => ({ username: u, send: (m: ChatMessage) => this.sendChatToPlayer(u, m) }));
    this.chat.sendMessage('Server', 'server', 'server', text, recipients);
  }
}
