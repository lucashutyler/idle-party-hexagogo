import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { offsetToCube, cubeDistance, cubeToKey, hireLevelLimitText, isBlockedUser, isHireWithinLevelLimit } from '@idle-party-rpg/shared';
import type { HexGrid, HexTile, OtherPlayerState, PlayerListEntry, ClientSocialState, ChatChannelType, ChatMessage, PartyGridPosition, PartyRole, ClassName, HiredHenchman, NotificationEntry, RoomEntryFailure, GamePartyMember, AutoRetreatPct, ServerBestiaryMessage, PartyAutoRetreatInfo, ForecastRequestTarget, ServerForecastMessage } from '@idle-party-rpg/shared';
import { PlayerSession } from './PlayerSession.js';
import type { WorldGrids } from './WorldGrids.js';
import type { GameStateStore, PlayerSaveData } from './GameStateStore.js';
import { FriendsSystem } from './social/FriendsSystem.js';
import { GuildSystem } from './social/GuildSystem.js';
import type { GuildStore } from './social/GuildStore.js';
import { ChatSystem } from './social/ChatSystem.js';
import { PartySystem, canMove } from './social/PartySystem.js';
import { TradeSystem } from './social/TradeSystem.js';
import { MailboxSystem, mailboxesWithEntriesFrom } from './social/MailboxSystem.js';
import type { MailboxStore, Mailboxes } from './social/MailboxStore.js';
import { NotificationSystem } from './social/NotificationSystem.js';
import { NotificationService } from './social/NotificationService.js';
import { InAppNotificationDriver } from './social/InAppNotificationDriver.js';
import { BrowserPushNotificationDriver } from './social/BrowserPushNotificationDriver.js';
import { EmailNotificationDriver } from './social/EmailNotificationDriver.js';
import { PartyBattleManager } from './PartyBattleManager.js';
import type { CombatSendOptions } from './PartyBattleManager.js';
import type { ContentStore } from './ContentStore.js';
import type { AccountStore } from '../auth/AccountStore.js';
import { prepareStatePush, encodeStatePush } from './StatePush.js';
import type { SentStateFields } from './StatePush.js';
import { SharedRosters } from './SharedRosters.js';
import type { RosterSnapshot } from './SharedRosters.js';

/** A socket buffering more than this skips droppable combat messages. */
export const COMBAT_BACKPRESSURE_BYTES = 256 * 1024;
/** A socket buffering more than this skips state pushes, which it can catch up on with a single later push. */
export const STATE_BACKPRESSURE_BYTES = 64 * 1024;
/** How soon a player whose state push was skipped is tried again. */
export const STATE_RETRY_MS = 500;
/** How long a new socket's visibility stays unknown before it counts as visible without a `presence` message. */
export const PRESENCE_GRACE_MS = 5000;

type PlayerChatChannel = Exclude<ChatChannelType, 'server'>;

const PLAYER_CHAT_CHANNELS: readonly unknown[] = ['tile', 'zone', 'party', 'guild', 'dm', 'global'] satisfies PlayerChatChannel[];
const INVALID_CHANNEL = 'Invalid channel';

function isPlayerChatChannel(value: unknown): value is PlayerChatChannel {
  return PLAYER_CHAT_CHANNELS.includes(value);
}

/** What a double tap gets once the first tap has gone through. */
export const GIFT_NOT_FOUND = 'Gift not found';
export const LONE_LEAVE_REFUSAL = 'You can\'t leave: you\'re the only player in your party.';

export interface PartyDeparture {
  partyId: string;
  others: string[];
  wasOwner: boolean;
}

export class PlayerManager {
  private sessions = new Map<string, PlayerSession>();
  private connections = new Map<WebSocket, string>();
  private playerConnections = new Map<string, Set<WebSocket>>();
  private combatViewHidden = new WeakSet<WebSocket>();
  /** Sockets whose page reported itself hidden. */
  private pageHidden = new WeakSet<WebSocket>();
  /** New sockets that have not sent `presence` yet: they neither start nor end an absence until the grace runs out. */
  private presencePending = new WeakSet<WebSocket>();
  private sentStateFields = new WeakMap<WebSocket, SentStateFields>();
  private stateRetryPending = new WeakSet<WebSocket>();
  private wholeStateSockets = new WeakSet<WebSocket>();
  private rosters = new SharedRosters(() => this.rosterSnapshot());
  private grids: WorldGrids;
  private content: ContentStore;
  private accountStore: AccountStore;
  private store: GameStateStore;
  private mailboxStore?: MailboxStore;
  private saveQueue: Promise<void> = Promise.resolve();
  /** What the mailbox file holds, as far as this process knows. */
  private savedMailboxes: Mailboxes = new Map();
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

  constructor(grids: WorldGrids, content: ContentStore, guildStore: GuildStore, accountStore: AccountStore, store: GameStateStore, mailboxStore?: MailboxStore) {
    this.mailboxStore = mailboxStore;
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
    this.partyBattles.setHenchmenCallbacks(
      (partyId) => this.parties.getHenchmen(partyId),
      (partyId, mapId) => this.parties.dismissHenchmenOffMap(partyId, mapId),
    );
    this.partyBattles.setCombatDelivery({
      isWatching: (username) => this.hasCombatViewer(username),
      sendRaw: (username, payload, opts) => this.sendCombatRaw(username, payload, opts),
    });
    this.partyBattles.setGridPositionLookup(
      (partyId, username) => this.parties.getParty(partyId)?.members.find(m => m.username === username)?.gridPosition,
    );
    this.partyBattles.setAutoRetreatPolicy((partyId) => this.autoRetreatPolicy(partyId));
    this.partyBattles.setAutoRunPolicy((partyId) => this.parties.isAutoRun(partyId));
    this.partyBattles.setNotifier((username, eventKey, vars) => this.notify.notify(username, eventKey, vars));
  }

  /** The party's auto-retreat setting: its owner's, read at use time. */
  autoRetreatPolicy(partyId: string): PartyAutoRetreatInfo | null {
    const members = this.parties.getParty(partyId)?.members;
    const owner = members?.find(m => m.role === 'owner') ?? members?.[0];
    const session = owner ? this.sessions.get(owner.username) : undefined;
    if (!owner || !session) return null;
    return { belowPct: session.getCombatPrefs().autoRetreatBelowPct, setBy: owner.username };
  }

  /** The world's default (spawn) map grid. */
  private defaultGrid(): HexGrid {
    return this.grids.getOrThrow(this.content.getWorld().defaultMapId);
  }

  async login(ws: WebSocket, username: string): Promise<PlayerSession> {
    // Associate this connection with the username
    this.connections.set(ws, username);
    this.presencePending.add(ws);
    setTimeout(() => this.endPresenceGrace(ws), PRESENCE_GRACE_MS);

    let wsSet = this.playerConnections.get(username);
    if (!wsSet) {
      wsSet = new Set();
      this.playerConnections.set(username, wsSet);
    }
    wsSet.add(ws);
    this.rosters.invalidate();

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
      this.mailboxes.mergeEntries(username, session.consumeInitialMailbox());
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

    // The caller pushes state right after login, which carries any recap this produces.
    this.refreshPresence(username);
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
        this.rosters.invalidate();
        // Trades are async — they persist across disconnect. Nothing to cancel here.
      }
    }
    this.refreshPresence(username);

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
      this.rosters.invalidate();
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
      await this.saveAll(saveStore);
    }

    // Remove from party (and its battle entry)
    const partyId = session?.getPartyId();
    const departure = this.partyDeparture(username);
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

    if (departure) this.announcePartyDeparture(username, departure);

    // The others' files still hold the run this just ended, which a crash would restore.
    if (session) await this.saveAll(saveStore);

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
   * Rename a player: re-key their session and connections, and move other players' blocks to the new name.
   * Returns whether the player had a session. See docs/architecture/social.md → Renames.
   */
  renamePlayer(oldUsername: string, newUsername: string): boolean {
    this.mailboxes.rename(oldUsername, newUsername);

    const session = this.sessions.get(oldUsername);
    if (session) this.rekeySession(session, oldUsername, newUsername);
    this.moveBlocksToNewName(oldUsername, newUsername);
    return session !== undefined;
  }

  private moveBlocksToNewName(oldUsername: string, newUsername: string): void {
    const blockers = this.getAllSessions().filter(session => session.moveBlockToNewName(oldUsername, newUsername));
    if (blockers.length === 0) return;

    this.store.saveAll(blockers.map(blocker => this.saveDataFor(blocker)))
      .catch(err => console.error(`[PlayerManager] Failed to save blocks moved to "${newUsername}":`, err));
    for (const blocker of blockers) this.sendStateToPlayer(blocker.username);
  }

  private rekeySession(session: PlayerSession, oldUsername: string, newUsername: string): void {
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

  /** Sends a player's message and returns null, or returns why it was refused. See docs/architecture/social.md → Chat. */
  sendPlayerChat(username: string, channelType: unknown, channelId: unknown, text: string): string | null {
    const session = this.sessions.get(username);
    if (!session) return null;
    if (!isPlayerChatChannel(channelType)) return 'Invalid channel type';
    if (typeof channelId !== 'string') return INVALID_CHANNEL;

    const route = this.routeChat(session, channelType, channelId);
    if (typeof route === 'string') return route;

    const recipients = route.recipients.map(u => ({ username: u, send: (m: ChatMessage) => this.sendChatToPlayer(u, m) }));
    const message = this.chat.sendMessage(username, channelType, route.channelId, text, recipients);
    if (!message) return null;

    this.sendChatToPlayer(username, message);
    if (channelType === 'dm') this.notifyDmReceived(route.channelId, username, text);
    return null;
  }

  private routeChat(
    session: PlayerSession,
    channelType: PlayerChatChannel,
    channelId: string,
  ): { channelId: string; recipients: string[] } | string {
    const username = session.username;
    const othersWhere = (matches: (other: PlayerSession) => boolean): string[] =>
      Array.from(this.sessions.entries()).filter(([u, s]) => u !== username && matches(s)).map(([u]) => u);

    switch (channelType) {
      case 'dm': {
        // Accounts match a name in any case but sessions need the exact spelling.
        const recipient = this.accountStore.findByUsername(channelId)?.username;
        return recipient ? { channelId: recipient, recipients: [recipient] } : 'User not found';
      }
      case 'zone':
        if (channelId !== session.getZone()) return 'You aren\'t in that zone';
        return { channelId, recipients: othersWhere(s => s.getZone() === channelId) };
      case 'guild': {
        const members = this.guilds.getGuild(channelId)?.members.map(m => m.username);
        if (!members?.includes(username)) return 'You aren\'t in that guild';
        return { channelId, recipients: members.filter(u => u !== username) };
      }
      case 'party': {
        if (channelId !== '') return INVALID_CHANNEL;
        const partyId = session.getPartyId();
        const members = partyId ? this.parties.getParty(partyId)?.members ?? [] : [];
        return { channelId, recipients: members.map(m => m.username).filter(u => u !== username) };
      }
      case 'tile': {
        if (channelId !== '') return INVALID_CHANNEL;
        const mapId = session.getMapId();
        const { col, row } = session.getPosition();
        return {
          channelId,
          recipients: othersWhere(s => {
            const position = s.getPosition();
            return s.getMapId() === mapId && position.col === col && position.row === row;
          }),
        };
      }
      case 'global':
        if (channelId !== '') return INVALID_CHANNEL;
        return { channelId, recipients: othersWhere(() => true) };
    }
  }

  private notifyDmReceived(recipient: string, sender: string, text: string): void {
    const session = this.sessions.get(recipient);
    if (session && isBlockedUser(sender, session.getBlockedUsers())) return;

    const focus = session?.getChatFocus();
    if (focus?.channelType === 'dm' && focus.channelId === sender) return;

    this.notify.notify(recipient, 'dm_received', {
      title: `Message from ${sender}`,
      body: text.length > 140 ? `${text.slice(0, 140)}…` : text,
      payload: { fromUsername: sender },
    });
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
    if (wsSet) this.pushStateTo(username, wsSet);
  }

  /** This socket gets every field on every push. */
  requireWholeState(ws: WebSocket): void {
    this.wholeStateSockets.add(ws);
  }

  private pushStateTo(username: string, sockets: Iterable<WebSocket>): void {
    const session = this.sessions.get(username);
    if (!session) return;

    // A socket that is behind skips this push: nothing is recorded as sent, so its next push carries the difference.
    const ready: WebSocket[] = [];
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > STATE_BACKPRESSURE_BYTES) this.retryStateSoon(ws);
      else ready.push(ws);
    }
    if (ready.length === 0) return;

    const partial = ready.filter(ws => !this.wholeStateSockets.has(ws));
    if (partial.length > 0) {
      const fields = prepareStatePush({ type: 'state', ...session.getState([]), serverVersion: this.serverVersion });
      const zone = session.getZone();
      for (const ws of partial) {
        ws.send(encodeStatePush(fields, this.sentStateFieldsOf(ws), this.rosters.encodeFor(ws, zone)));
      }
    }
    if (partial.length < ready.length) {
      const fields = prepareStatePush({
        type: 'state',
        ...session.getState(this.getOtherPlayers(username)),
        social: this.getSocialState(username),
        serverVersion: this.serverVersion,
      });
      for (const ws of ready) {
        if (this.wholeStateSockets.has(ws)) ws.send(encodeStatePush(fields, new Map()));
      }
    }
  }

  private rosterSnapshot(): RosterSnapshot {
    const otherPlayersByZone: RosterSnapshot['otherPlayersByZone'] = new Map();
    for (const [username, session] of this.sessions) {
      if (!session.hasCharacter()) continue;
      const zone = session.getZone();
      let inZone = otherPlayersByZone.get(zone);
      if (!inZone) {
        inZone = new Map();
        otherPlayersByZone.set(zone, inZone);
      }
      inZone.set(username, JSON.stringify(this.otherPlayerEntry(username, session)));
    }
    return {
      otherPlayersByZone,
      allPlayers: new Map(this.listedPlayers().map(player => [player.username, JSON.stringify(player)])),
      onlinePlayers: new Map(this.getOnlinePlayers().map(username => [username, JSON.stringify(username)])),
    };
  }

  /** Mid-fight nothing else may push for minutes, so a skipped push can't wait for the next event. */
  private retryStateSoon(ws: WebSocket): void {
    if (this.stateRetryPending.has(ws)) return;
    this.stateRetryPending.add(ws);
    setTimeout(() => {
      this.stateRetryPending.delete(ws);
      const username = this.connections.get(ws);
      if (username) this.pushStateTo(username, [ws]);
    }, STATE_RETRY_MS).unref();
  }

  private sentStateFieldsOf(ws: WebSocket): SentStateFields {
    let sent = this.sentStateFields.get(ws);
    if (!sent) {
      sent = new Map();
      this.sentStateFields.set(ws, sent);
    }
    return sent;
  }

  /** Send a pre-serialised combat message to every open socket of `username` that shows combat. */
  sendCombatRaw(username: string, payload: string, opts: CombatSendOptions): void {
    const wsSet = this.playerConnections.get(username);
    if (!wsSet) return;
    for (const ws of wsSet) {
      if (!this.wantsCombat(ws)) continue;
      if (opts.droppable && ws.bufferedAmount > COMBAT_BACKPRESSURE_BYTES) continue;
      ws.send(payload);
    }
  }

  /** Whether any of this player's sockets would receive combat messages right now. */
  hasCombatViewer(username: string): boolean {
    const wsSet = this.playerConnections.get(username);
    if (!wsSet) return false;
    for (const ws of wsSet) {
      if (this.wantsCombat(ws)) return true;
    }
    return false;
  }

  /** Record whether a socket is showing the combat view; turning it on resyncs the live fight. */
  setCombatView(ws: WebSocket, visible: boolean): void {
    if (!this.connections.has(ws)) return;
    const wasHidden = this.combatViewHidden.has(ws);
    if (visible) {
      this.combatViewHidden.delete(ws);
      if (wasHidden) this.sendCombatResync(ws);
    } else {
      this.combatViewHidden.add(ws);
    }
  }

  /** Record a socket's page visibility (`presence`); becoming visible delivers any recap at once. */
  setPresence(ws: WebSocket, visible: boolean, now: number = Date.now()): void {
    const username = this.connections.get(ws);
    if (!username) return;
    this.presencePending.delete(ws);
    if (visible) this.pageHidden.delete(ws);
    else this.pageHidden.add(ws);
    if (this.refreshPresence(username, now)) this.sendStateToPlayer(username);
  }

  /** Whether any of this player's sockets shows the game (a socket that never sent `presence` counts once its grace is over). */
  hasVisibleSocket(username: string): boolean {
    const wsSet = this.playerConnections.get(username);
    if (!wsSet) return false;
    for (const ws of wsSet) {
      if (!this.pageHidden.has(ws) && !this.presencePending.has(ws)) return true;
    }
    return false;
  }

  private hasPresencePending(username: string): boolean {
    const wsSet = this.playerConnections.get(username);
    return !!wsSet && [...wsSet].some(ws => this.presencePending.has(ws));
  }

  private endPresenceGrace(ws: WebSocket): void {
    if (!this.presencePending.delete(ws)) return;
    const username = this.connections.get(ws);
    if (username && this.refreshPresence(username)) this.sendStateToPlayer(username);
  }

  /**
   * Away begins the moment no socket shows the game (all hidden or all closed) and ends when one does;
   * a socket whose visibility is still unknown changes neither. The session decides whether the
   * finished ledger is worth a recap. Returns whether the pending recap changed.
   */
  private refreshPresence(username: string, now: number = Date.now()): boolean {
    const session = this.sessions.get(username);
    if (!session) return false;
    if (this.hasVisibleSocket(username)) return session.endAway(now);
    if (this.hasPresencePending(username)) return false;
    session.beginAway(now);
    return false;
  }

  /** Clear the player's recap once the client has shown it; state goes to every socket. */
  handleAckRecap(username: string, id: string): boolean {
    const session = this.sessions.get(username);
    if (!session?.ackRecap(id)) return false;
    this.sendStateToPlayer(username);
    return true;
  }

  /** Change the player's auto-retreat threshold. Party members see the owner's setting, so they all get state. */
  handleSetCombatPrefs(username: string, autoRetreatBelowPct: AutoRetreatPct): boolean {
    const session = this.sessions.get(username);
    if (!session) return false;
    const changed = session.setCombatPrefs({ autoRetreatBelowPct });
    const partyId = session.getPartyId();
    if (changed && partyId && this.autoRetreatPolicy(partyId)?.setBy === username) {
      this.partyBattles.clearRetreatHold(partyId);
    }
    this.sendStateToParty(username);
    return changed;
  }

  /** Turn the party's auto run on or off (the caller has checked the role). */
  handleSetAutoRun(username: string, enabled: boolean): boolean {
    const partyId = this.sessions.get(username)?.getPartyId();
    if (!partyId) return false;
    const changed = this.parties.setAutoRun(partyId, enabled);
    if (changed) this.partyBattles.autoRunChanged(partyId);
    this.sendStateToParty(username);
    return changed;
  }

  /** State to every socket of the player and of their party members (whose forecast key follows the player's build). */
  sendStateToParty(username: string): void {
    const partyId = this.sessions.get(username)?.getPartyId();
    const members = partyId ? this.parties.getParty(partyId)?.members.map(m => m.username) : undefined;
    for (const member of members ?? [username]) this.sendStateToPlayer(member);
  }

  /** A player's forecast request for a room or dungeon; every reply goes through `reply`. */
  handleForecastRequest(username: string, target: ForecastRequestTarget, reply: (message: ServerForecastMessage) => void): void {
    const partyId = this.sessions.get(username)?.getPartyId();
    if (!partyId) {
      reply({ type: 'forecast', target, key: '', result: null, status: 'unavailable' });
      return;
    }
    this.partyBattles.requestForecast(partyId, username, target, reply);
  }

  /** The player's full kill-mastery list for the bestiary. */
  buildBestiary(username: string): ServerBestiaryMessage | null {
    const session = this.sessions.get(username);
    if (!session) return null;
    return { type: 'bestiary', version: session.getMasterySummary().version, entries: session.getBestiary() };
  }

  /** Send one socket the live fight as a full snapshot plus the recent log and live forecast. No-op between battles. */
  sendCombatResync(ws: WebSocket): void {
    if (!this.wantsCombat(ws)) return;
    const username = this.connections.get(ws);
    const partyId = username ? this.sessions.get(username)?.getPartyId() : null;
    if (!partyId) return;
    const message = this.partyBattles.buildCombatResync(partyId);
    if (message) ws.send(JSON.stringify(message));
    for (const forecast of this.partyBattles.liveForecastResync(partyId)) ws.send(JSON.stringify(forecast));
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

  private wantsCombat(ws: WebSocket): boolean {
    return ws.readyState === WebSocket.OPEN && !this.combatViewHidden.has(ws);
  }

  private validHenchmen(saved: HiredHenchman[], partyMapId: string): HiredHenchman[] {
    return saved.filter(h => h.mapId === partyMapId && this.content.getHenchman(h.henchmanId));
  }

  private resolveHenchmen(henchmen: HiredHenchman[] | undefined): HiredHenchman[] {
    if (!henchmen?.length) return [];
    return henchmen.map(h => {
      const def = this.content.getHenchman(h.henchmanId);
      return {
        ...h,
        name: def?.name ?? 'Unknown henchman',
        emoji: def?.emoji ?? '❓',
        artworkUrl: def?.artworkUrl,
        level: def?.level,
      };
    });
  }

  private resolvePartyMembers(members: GamePartyMember[]): GamePartyMember[] {
    return members.map(m => {
      const session = this.sessions.get(m.username);
      if (!session?.hasCharacter()) return { ...m };
      return { ...m, level: session.getLevel(), className: session.getClassName() ?? undefined };
    });
  }

  /** Build ClientSocialState for a player. Without rosters, `allPlayers` and `onlinePlayers` are empty: `SharedRosters` sends them. */
  getSocialState(username: string, withRosters = true): ClientSocialState {
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
      party: partyData && {
        ...partyData,
        members: this.resolvePartyMembers(partyData.members),
        henchmen: this.resolveHenchmen(partyData.henchmen),
        autoRetreat: this.autoRetreatPolicy(partyData.id) ?? undefined,
        forecastKey: this.partyBattles.forecastKey(partyData.id),
      },
      pendingInvites: this.parties.getPendingInvites(username),
      outgoingPartyInvites: this.parties.getOutgoingInvites(username),
      onlinePlayers: withRosters ? this.getOnlinePlayers() : [],
      allPlayers: withRosters ? this.listedPlayers() : [],
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

  private listedPlayers(): PlayerListEntry[] {
    return this.getAllUsernames()
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
      }));
  }

  /** Wire all callbacks onto a session (social state, battle state, position). */
  private wireCallbacks(session: PlayerSession): void {
    session.getSocialState = () => this.getSocialState(session.username, false);
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
    session.getPartyTopLevel = () => this.partyTopLevel(session.username);
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
    session.getXpGauge = () => {
      const partyId = session.getPartyId();
      return partyId ? this.partyBattles.getXpGauge(partyId, session.username) : null;
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

  /** After a class is set: a new character gets a party (its first fight already uses the class); an existing party restarts its fight. */
  applyClassChange(username: string): void {
    const session = this.sessions.get(username);
    if (!session) return;
    const existingPartyId = session.getPartyId();
    this.ensureParty(username);
    if (existingPartyId) this.partyBattles.restartBattle(existingPartyId);
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

  /** Hire into the player's party, or swap out `replaceInstanceId`. Returns the hire or an error string. */
  hireHenchman(username: string, henchmanId: string, mapId: string, replaceInstanceId?: string): HiredHenchman | string {
    this.settleBeforeRosterChange(username);
    const hireLevel = this.content.getHenchman(henchmanId)?.level ?? 0;
    const topLevel = this.partyTopLevel(username);
    if (!isHireWithinLevelLimit(hireLevel, topLevel)) return hireLevelLimitText(hireLevel, topLevel);
    const getPartyId = (u: string) => this.sessions.get(u)?.getPartyId() ?? null;
    return this.parties.hireHenchman(username, henchmanId, mapId, getPartyId, replaceInstanceId);
  }

  /** Dismiss a hire from the player's party. Returns the dismissed hire or an error string. */
  dismissHenchman(username: string, instanceId: string): HiredHenchman | string {
    this.settleBeforeRosterChange(username);
    return this.parties.dismissHenchman(username, instanceId, u => this.sessions.get(u)?.getPartyId() ?? null);
  }

  /** The highest human level in a player's party. */
  private partyTopLevel(username: string): number {
    const partyId = this.sessions.get(username)?.getPartyId();
    const members = partyId ? this.parties.getParty(partyId)?.members : undefined;
    const names = members?.map(m => m.username) ?? [username];
    return Math.max(0, ...names.map(name => this.sessions.get(name)?.getLevel() ?? 0));
  }

  /** A win still in its kill beat is shared among the roster that fought it. */
  private settleBeforeRosterChange(username: string): void {
    const partyId = this.sessions.get(username)?.getPartyId();
    if (partyId) this.partyBattles.settlePendingResult(partyId);
  }

  /** Who a player's departure from their current party concerns. Read it before they leave. */
  partyDeparture(username: string): PartyDeparture | null {
    const partyId = this.sessions.get(username)?.getPartyId();
    const members = partyId ? this.parties.getParty(partyId)?.members : undefined;
    if (!partyId || !members) return null;
    const others = members.filter(m => m.username !== username).map(m => m.username);
    if (others.length === 0) return null;
    return { partyId, others, wasOwner: members.find(m => m.username === username)?.role === 'owner' };
  }

  /** Tell the members left behind that a player has gone, and who owns the party now if that changed. */
  announcePartyDeparture(username: string, { partyId, others, wasOwner }: PartyDeparture): void {
    this.broadcastPartyEvent(partyId, username, 'You left your old party.', `${username} left the party.`);
    const newOwner = wasOwner ? this.parties.getParty(partyId)?.members.find(m => m.role === 'owner') : undefined;
    if (newOwner) {
      this.broadcastPartyEvent(partyId, newOwner.username, 'You became the new party owner.', `${newOwner.username} became the new party owner.`);
      this.notify.notify(newOwner.username, 'party_ownership_transferred', {
        title: 'Party ownership',
        body: 'You became the new party owner.',
        payload: {},
      });
    }
    for (const member of others) {
      this.sendStateToPlayer(member);
      this.notify.notify(member, 'party_member_left', {
        title: 'Party',
        body: `${username} left your party.`,
        payload: { leftUsername: username },
      });
    }
  }

  /** Accept a party invite, leaving the current party. Returns why it was refused, or null. */
  acceptPartyInvite(username: string, partyId: string): string | null {
    const oldPartyId = this.sessions.get(username)?.getPartyId() ?? null;
    if (oldPartyId === partyId) return null;
    if (this.partyBattles.isInDungeonRun(partyId)) return 'That party is in a dungeon right now.';

    const departure = this.partyDeparture(username);
    const result = this.parties.acceptInvite(
      username,
      partyId,
      (u) => this.sessions.get(u)?.getPartyId() ?? null,
      (u, id) => this.sessions.get(u)?.setPartyId(id),
      (a, b) => this.areSameTile(a, b),
    );
    if (typeof result === 'string') return result;

    this.handlePartyJoin(username, partyId, oldPartyId);
    this.broadcastPartyEvent(partyId, username, 'You joined the party.', `${username} joined the party.`);
    for (const m of result.joined.members) {
      this.sendStateToPlayer(m.username);
      if (m.username !== username) {
        this.notify.notify(m.username, 'party_member_joined', {
          title: 'Party',
          body: `${username} joined your party.`,
          payload: { joinedUsername: username },
        });
      }
    }
    // A joiner arrives mid-fight, and only full snapshots carry what the board and boss bar need.
    for (const ws of this.playerConnections.get(username) ?? []) this.sendCombatResync(ws);
    if (departure) this.announcePartyDeparture(username, departure);
    return null;
  }

  /** Leave the party for a new solo one. Returns why it was refused, or null. */
  leaveParty(username: string): string | null {
    const session = this.sessions.get(username);
    if (!session) return null;
    const partyId = session.getPartyId();
    if (partyId && this.parties.getParty(partyId)?.members.length === 1) return LONE_LEAVE_REFUSAL;
    const departure = this.partyDeparture(username);

    const result = this.parties.leaveParty(
      username,
      (u) => this.sessions.get(u)?.getPartyId() ?? null,
      (u, id) => this.sessions.get(u)?.setPartyId(id),
    );
    if (typeof result === 'string') return result;

    if (partyId) this.handlePartyLeave(username, partyId);
    else this.ensureParty(username);
    this.sendStateToPlayer(username);
    if (departure) this.announcePartyDeparture(username, departure);
    return null;
  }

  /** Kick a member into a new solo party. Returns why it was refused, or null. */
  kickPartyMember(username: string, target: string): string | null {
    const session = this.sessions.get(username);
    if (!session) return null;
    const partyId = session.getPartyId();

    const result = this.parties.kickMember(
      username,
      target,
      (u) => this.sessions.get(u)?.getPartyId() ?? null,
      (u, id) => this.sessions.get(u)?.setPartyId(id),
    );
    if (typeof result === 'string') return result;

    if (partyId) {
      this.broadcastPartyEvent(partyId, target, 'You were kicked from the party.', `${target} was kicked from the party.`);
      this.handlePartyLeave(target, partyId);
      for (const m of this.parties.getParty(partyId)?.members ?? []) this.sendStateToPlayer(m.username);
    } else {
      this.ensureParty(target);
      this.sendStateToPlayer(username);
    }
    this.sendStateToPlayer(target);
    this.notify.notify(target, 'party_kicked', {
      title: 'Party',
      body: 'You were removed from your party.',
      payload: {},
    });
    return null;
  }

  /** Handle a player joining a party (after accept invite). */
  handlePartyJoin(username: string, partyId: string, oldPartyId: string | null): void {
    if (oldPartyId) this.partyBattles.removeMember(oldPartyId, username);

    this.partyBattles.addMember(partyId, username);

    const joiner = this.sessions.get(username);
    const tile = this.partyBattles.getTile(partyId);
    if (joiner && tile) joiner.switchMapGrid(tile);
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

    const party = this.parties.getParty(partyId);
    if (party) {
      const member = party.members.find(m => m.username === username);
      if (!member || !canMove(member.role)) return 'Only owners and leaders can enter a dungeon.';
    }

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
   * the transition on its current room. On failure the result carries an error
   * string, plus `blocked` when the refusal was an unmet entry requirement
   * rather than a structural problem.
   */
  handleEnterTransition(
    username: string,
    targetTileId: string,
  ): { success: true } | { success: false; error: string; blocked?: RoomEntryFailure } {
    const session = this.sessions.get(username);
    if (!session) return { success: false, error: 'No session.' };
    const partyId = session.getPartyId();
    if (!partyId) return { success: false, error: 'No party.' };
    return this.partyBattles.enterTransition(partyId, targetTileId);
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
      others.push(this.otherPlayerEntry(username, session));
    }
    return others;
  }

  private otherPlayerEntry(username: string, session: PlayerSession): OtherPlayerState {
    const pos = session.getPosition();
    const dungeon = session.getDungeonState?.();
    return {
      username,
      col: pos.col,
      row: pos.row,
      mapId: session.getMapId(),
      zone: session.getZone(),
      className: session.getClassName() ?? undefined,
      partyId: session.getPartyId() ?? undefined,
      inDungeon: dungeon ? true : undefined,
      dungeonName: dungeon?.name,
    };
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
    return this.getAllSessions().map(session => this.saveDataFor(session));
  }

  private saveDataFor(session: PlayerSession): PlayerSaveData {
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

    const henchmen = partyId ? this.parties.getHenchmen(partyId) : [];
    const autoRun = partyId ? this.parties.isAutoRun(partyId) : false;
    return session.toSaveData(movementData ?? undefined, partyInfo, dungeonData, henchmen, autoRun);
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
        // dungeonRun.entrance is a bare (col,row) against the old map — it cannot survive.
        data.dungeonRun = undefined;
        data.position = { col: startPos.col, row: startPos.row };
        data.mapId = defaultMapId;
        data.target = null;
        data.movementQueue = [];
      }

      try {
        const session = PlayerSession.fromSaveData(data, this.grids, this.content);
        this.sessions.set(data.username, session);
        this.friends.initPlayer(data.username, session.getFriends(), session.getOutgoingFriendRequests());
        this.mailboxes.mergeEntries(data.username, session.consumeInitialMailbox());
        const initialNotifications = session.consumeInitialNotifications();
        if (initialNotifications.length > 0) this.notifications.setInbox(data.username, initialNotifications);
        this.wireCallbacks(session);
        session.beginAway();
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

      // Every member's save mirrors the roster — read only the owner's or they duplicate.
      if (ownerData.partyHenchmen?.length) {
        this.parties.restoreHenchmen(party.id, this.validHenchmen(ownerData.partyHenchmen, partyMapId));
      }

      this.parties.setAutoRun(party.id, ownerData.partyAutoRun === true);

      // After the henchmen, so a run dropped for vanished content can announce them rejoining.
      if (ownerData.dungeonRun) {
        this.partyBattles.restoreDungeonRun(party.id, ownerData.dungeonRun);
      }

      this.partyBattles.startEntry(party.id);

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
          const partyId = this.createSoloPartyAtTile(data.username, startTile, null, [], defaultMapId);
          if (partyId) this.partyBattles.startEntry(partyId);
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

      const partyId = this.createSoloPartyAtTile(data.username, currentTile, targetTile, movementQueue, soloMapId);
      if (!partyId) continue;

      if (data.partyGridPosition !== undefined) {
        this.parties.setGridPosition(data.username, data.partyGridPosition as PartyGridPosition, () => partyId);
      }
      if (data.partyHenchmen?.length) {
        this.parties.restoreHenchmen(partyId, this.validHenchmen(data.partyHenchmen, soloMapId));
      }
      this.parties.setAutoRun(partyId, data.partyAutoRun === true);
      // After the henchmen, so a run dropped for vanished content can announce them rejoining.
      if (data.dungeonRun) this.partyBattles.restoreDungeonRun(partyId, data.dungeonRun);
      this.partyBattles.startEntry(partyId);
    }

    if (saves.length > 0) {
      console.log(`[Startup] Phase 4: ${soloSaves.length} solo parties created in ${(performance.now() - phaseStart).toFixed(1)}ms`);
      console.log(`[PlayerManager] Restored ${this.sessions.size} sessions`);
    }
  }

  /** Create a solo party and its (not yet started) battle entry at a specific tile. Returns the party id. */
  private createSoloPartyAtTile(
    username: string,
    currentTile: import('@idle-party-rpg/shared').HexTile,
    targetTile: import('@idle-party-rpg/shared').HexTile | null,
    movementQueue: import('@idle-party-rpg/shared').HexTile[],
    mapId: string,
  ): string | null {
    const partyResult = this.parties.createParty(
      username,
      (u) => this.sessions.get(u)?.getPartyId() ?? null,
      (u, id) => this.sessions.get(u)?.setPartyId(id),
    );
    if (typeof partyResult === 'string') return null;

    this.partyBattles.createEntryFromSave(
      partyResult.id,
      username,
      currentTile,
      targetTile,
      movementQueue,
      mapId,
    );
    return partyResult.id;
  }

  /**
   * After a deploy, find all parties on unreachable tiles — or standing in a
   * room whose entry requirements they no longer meet — and relocate them.
   * Returns the number of parties relocated.
   *
   * The reachability sweep only runs on the map that holds the world start
   * tile. It walks the grid from that start, which is only a meaningful notion
   * of "reachable" where players actually spawn and walk; on any other map a
   * room is reached through a transition, possibly one-way, so a party can sit
   * somewhere perfectly legitimate that no walk from that map's own start tile
   * would ever find. Uprooting them would be worse than leaving them be.
   * Revisiting this properly is issue #374.
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

      // A content change can gate the room a party is already standing in.
      // There is no "nearest room they qualify for" worth computing — the
      // neighbours are usually gated the same way — so send them to the world
      // start tile, the one room guaranteed to be ungated.
      const gateFailure = this.partyBattles.checkPartyRoomEntry(partyId, tile);
      if (gateFailure) {
        targetMapId = defaultMapId;
        bestTile = this.defaultGrid().getTile(offsetToCube(world.startTile)) ?? null;
        if (bestTile) {
          this.relocatePartyTo(partyId, bestTile, targetMapId, currentMapId,
            `The world changed — ${gateFailure.reason} Your party was moved to the starting room.`,
            'world_room_gated');
          relocated++;
          continue;
        }
      }

      if (!grid) {
        // The party's whole map was deleted — drop them at the default map's start.
        targetMapId = defaultMapId;
        bestTile = this.defaultGrid().getTile(offsetToCube(world.startTile)) ?? null;
      } else if (currentMapId !== defaultMapId) {
        // Off the start tile's map, reachability isn't decidable from one grid
        // alone — see the note on this method. Existence still is.
        if (grid.getTile(tile.coord)) continue;
        const meta = world.maps.find(m => m.id === currentMapId);
        bestTile = grid.getTile(offsetToCube(meta?.startTile ?? world.startTile)) ?? null;
        if (!bestTile) {
          targetMapId = defaultMapId;
          bestTile = this.defaultGrid().getTile(offsetToCube(world.startTile)) ?? null;
        }
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
      this.relocatePartyTo(partyId, bestTile, targetMapId, currentMapId,
        'World updated — relocated to a safe room.');

      relocated++;
    }

    return relocated;
  }

  /**
   * Move a party to `tile`, re-seat every member's fog of war, and tell them
   * why. Passing `eventKey` also raises a notification — used when the move is
   * something a player would be surprised by on next login, like being sent
   * back to the start because a room they were standing in became gated.
   */
  private relocatePartyTo(
    partyId: string,
    tile: HexTile,
    targetMapId: string,
    currentMapId: string,
    logMessage: string,
    eventKey?: string,
  ): void {
    const mapChanged = targetMapId !== currentMapId;
    this.partyBattles.relocateParty(partyId, tile, targetMapId);

    const members = this.partyBattles.getMembers(partyId);
    if (!members) return;
    for (const username of members) {
      const session = this.sessions.get(username);
      if (!session) continue;
      if (mapChanged) session.switchMapGrid(tile);
      else session.forceUnlockTileArea(tile);
      session.addLogEntry(logMessage, 'move');
      if (eventKey) {
        this.notify.notify(username, eventKey, {
          title: 'Your party was moved',
          body: logMessage,
        });
      }
      this.sendStateToPlayer(username);
    }
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
        const partyId = this.createSoloPartyAtTile(session.username, startTile, null, [], defaultMapId);
        if (partyId) this.partyBattles.startEntry(partyId);
      }
      count++;
    }
    for (const username of this.sessions.keys()) this.refreshPresence(username);

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
    return isBlockedUser(b, blockedByA) || isBlockedUser(a, blockedByB);
  }

  /** Returns why the gift can't be sent, or null once it has gone. */
  sendGift(fromUsername: string, targetUsername: string, itemId: string, quantity: number): string | null {
    if (!Number.isInteger(quantity) || quantity < 1) return 'Invalid quantity';
    const target = this.accountStore.findByUsername(targetUsername);
    if (!target?.username) return 'Player not found';
    // Accounts match a name in any case, but mailboxes are keyed by the exact one.
    const toUsername = target.username;
    if (toUsername === fromUsername) return 'Cannot gift to yourself';
    // One message for both, so a refusal doesn't reveal that someone blocked you.
    if (target.deactivated || this.isTradeBlocked(fromUsername, toUsername)) return 'That player can\'t receive gifts';
    const sender = this.sessions.get(fromUsername);
    if (!sender) return 'No session';
    if (!sender.removeFromInventory(itemId, quantity)) return 'Not enough items in inventory';

    this.mailboxes.addEntry(toUsername, fromUsername, itemId, quantity);
    sender.addLogEntry(`Sent ${this.giftLabel(itemId, quantity)} to ${toUsername}`, 'unlock');

    this.sendStateToPlayer(fromUsername);
    this.sendStateToPlayer(toUsername);
    return null;
  }

  /** Returns why the gift can't be accepted, or null once it has been. */
  acceptGift(username: string, entryId: string): string | null {
    const session = this.sessions.get(username);
    if (!session) return 'No session';
    const entry = this.mailboxes.findEntry(username, entryId);
    if (!entry) return GIFT_NOT_FOUND;
    if (!session.addToInventory(entry.itemId, entry.quantity)) return 'Inventory full for that item (max 99)';

    this.mailboxes.removeEntry(username, entryId);
    session.addLogEntry(`Accepted ${this.giftLabel(entry.itemId, entry.quantity)} from ${entry.fromUsername}`, 'unlock');

    this.sendStateToPlayer(username);
    return null;
  }

  /** Returns why the gift can't be declined, or null once it has been. */
  denyGift(username: string, entryId: string): string | null {
    const entry = this.mailboxes.findEntry(username, entryId);
    if (!entry) return GIFT_NOT_FOUND;
    const returnTo = this.accountStore.findByUsername(entry.fromUsername)?.username;
    if (!entry.returned && !returnTo) return 'That gift can\'t be sent back';

    this.mailboxes.removeEntry(username, entryId);
    // A returned gift that is declined again is dropped, so it can't ping-pong forever.
    if (!entry.returned && returnTo) {
      this.mailboxes.addEntry(returnTo, username, entry.itemId, entry.quantity, { returned: true });
      this.sendStateToPlayer(returnTo);
    }
    const session = this.sessions.get(username);
    session?.addLogEntry(`Declined ${this.giftLabel(entry.itemId, entry.quantity)} from ${entry.fromUsername}`, 'move');

    this.sendStateToPlayer(username);
    return null;
  }

  /** At startup, so entries taken in from old saves are in the store before any player save drops them. */
  saveMailboxes(): Promise<void> {
    return this.inSaveOrder(async () => {
      const boxes = this.mailboxes.snapshot();
      await this.mailboxStore?.save(boxes);
      this.savedMailboxes = boxes;
    });
  }

  private giftLabel(itemId: string, quantity: number): string {
    const name = this.content.getItem(itemId)?.name ?? itemId;
    return quantity > 1 ? `${name} x${quantity}` : name;
  }

  /** A shutdown can land during a periodic save, and an older mailbox file must not be written last. */
  private inSaveOrder(pass: () => Promise<void>): Promise<void> {
    const done = this.saveQueue.then(pass);
    this.saveQueue = done.catch(() => {});
    return done;
  }

  /** A mailbox fault mustn't cost every player's progress too, so it is logged and tried again next pass. */
  private async writeMailboxes(boxes: Mailboxes): Promise<void> {
    try {
      await this.mailboxStore?.save(boxes);
      this.savedMailboxes = boxes;
    } catch (err) {
      console.error('[PlayerManager] Failed to save mailboxes:', err);
    }
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
  saveAll(store: GameStateStore): Promise<void> {
    return this.inSaveOrder(async () => {
      const boxes = this.mailboxes.snapshot();
      const data = this.getAllSaveData();
      // New entries land before player files change, and old ones go after, so a crash mid-pass can't lose a gift.
      const onDiskOrRemoved = mailboxesWithEntriesFrom(this.savedMailboxes, this.mailboxes.takeRemoved());
      await this.writeMailboxes(mailboxesWithEntriesFrom(onDiskOrRemoved, boxes));
      if (data.length > 0) await store.saveAll(data);
      await this.writeMailboxes(boxes);
    });
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
