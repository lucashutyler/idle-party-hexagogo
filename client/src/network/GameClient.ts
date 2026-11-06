import type { ServerStateMessage, ServerEquipBlockedMessage, ServerCombatMessage,
  ServerMoveBlockedMessage, PlayerProfileMessage, BlockLevel, ChatMessage, ChatChannelType, TradeOfferItem, NotificationEntry, NotificationPreferences, WebPushSubscription, ServerErrorCode,
  ServerForecastMessage, ServerBestiaryMessage, ForecastTarget, ForecastRequestTarget, AutoRetreatPct, AwayLedger, ItemDefinition } from '@idle-party-rpg/shared';
import { PARTIAL_STATE_PARAM, restoreElidedState } from '@idle-party-rpg/shared';
import { CombatLogBuffer } from '../combat/CombatLogBuffer';

const RECONNECT_DELAY = 2000;
export const FORECAST_TTL_MS = 60_000;
const FORECAST_RETRY_MS = 15_000;
const FORECAST_UNAVAILABLE_TTL_MS = 10_000;
const BESTIARY_RETRY_MS = 15_000;
const FORECAST_CACHE_MAX = 200;

type StateListener = (state: ServerStateMessage) => void;
type ChatListener = (message: ChatMessage) => void;
type SyncChatListener = (messages: ChatMessage[], full: boolean) => void;
type ConnectionListener = (connected: boolean) => void;
type WorldUpdateListener = () => void;
type EquipBlockedListener = (msg: ServerEquipBlockedMessage) => void;
type SuspensionListener = () => void;
type ResumeListener = () => void;
type MoveBlockedListener = (msg: ServerMoveBlockedMessage) => void;
type PlayerProfileListener = (profile: PlayerProfileMessage) => void;
type NotificationListener = (notification: NotificationEntry) => void;
export const OFFLINE_NOTICE = "You're offline — reconnecting. Try again in a moment.";

export interface ServerErrorDetail {
  questId?: string;
}
type ServerErrorListener = (message: string, code?: ServerErrorCode, detail?: ServerErrorDetail) => void;
type CombatListener = (message: ServerCombatMessage, receivedAt: number) => void;
type ForecastListener = (message: ServerForecastMessage) => void;
type BestiaryListener = (message: ServerBestiaryMessage) => void;
type RecapListener = (recap: AwayLedger | null) => void;

interface CachedForecast {
  message: ServerForecastMessage;
  at: number;
}

function setBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > FORECAST_CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** Stable cache key for a forecast target (property order independent). */
export function forecastTargetKey(target: ForecastTarget): string {
  switch (target.kind) {
    case 'room': return JSON.stringify({ kind: 'room', tileId: target.tileId });
    case 'dungeon': return JSON.stringify({ kind: 'dungeon', dungeonId: target.dungeonId });
    case 'battle': return JSON.stringify({ kind: 'battle', battleId: target.battleId });
  }
}

export class GameClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private connected = false;

  private stateListeners = new Set<StateListener>();
  private connectionListeners = new Set<ConnectionListener>();
  private chatListeners = new Set<ChatListener>();
  private syncChatListeners = new Set<SyncChatListener>();
  private worldUpdateListeners = new Set<WorldUpdateListener>();
  private equipBlockedListeners = new Set<EquipBlockedListener>();
  private moveBlockedListeners = new Set<MoveBlockedListener>();
  private suspensionListeners = new Set<SuspensionListener>();
  private resumeListeners = new Set<ResumeListener>();
  private playerProfileListeners = new Set<PlayerProfileListener>();
  private notificationListeners = new Set<NotificationListener>();
  private serverErrorListeners = new Set<ServerErrorListener>();
  private combatListeners = new Set<CombatListener>();
  private forecastListeners = new Set<ForecastListener>();
  private bestiaryListeners = new Set<BestiaryListener>();
  private recapListeners = new Set<RecapListener>();
  private combatViewRequested = false;
  private combatViewSent: boolean | null = null;

  /** Keyed by `forecastTargetKey(target)|partyKey`. */
  private forecastCache = new Map<string, CachedForecast>();
  /** Latest message per target regardless of party key, for late mounts. */
  private latestForecast = new Map<string, ServerForecastMessage>();
  /** `inFlight`: requests sent for this target and not yet answered. */
  private forecastPending = new Map<string, { target: ForecastRequestTarget; sentAt: number; inFlight: number }>();
  /** The server keeps one explicit forecast per player: a request for another target drops this one. */
  private lastForecastSent: string | null = null;
  /** `targetKey|forecastKey` pairs already re-requested after a stale reply. */
  private staleRetried = new Set<string>();
  private bestiaryRequestedAt: number | null = null;
  private notifiedRecapId: string | null = null;
  private ackedRecapIds = new Set<string>();

  /** Pending connect resolve — set during connect() call. */
  private connectResolve?: (result: { success: boolean; error?: string }) => void;

  /** True on connect, false after first state message — used to snap vs tween. */
  isInitialState = true;

  /** Most recent state from the server (null until first message). */
  lastState: ServerStateMessage | null = null;

  /** Most recent `combat` message (null until one arrives). */
  lastCombat: ServerCombatMessage | null = null;

  /** Most recent bestiary (null until one arrives). */
  lastBestiary: ServerBestiaryMessage | null = null;

  /** Unacknowledged "while you were away" recap from the latest state (null when none). */
  lastRecap: AwayLedger | null = null;

  /** Definitions for the recap's notable items. */
  lastRecapItemDefinitions: Record<string, ItemDefinition> = {};

  /** Journal + live combat lines, kept whether or not the combat screen is showing. */
  readonly combatLog = new CombatLogBuffer();

  /** Server version from first state message — reload if it changes. */
  private knownServerVersion: string | null = null;

  constructor() {
    const host = window.location.hostname || 'localhost';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Dev: Vite on :3000, server on :3001 — WS connects to :3001
    // Prod: single server serves both client and WS on the same origin
    const port = window.location.port === '3000' ? '3001' : window.location.port;
    this.url = port
      ? `${protocol}//${host}:${port}/?${PARTIAL_STATE_PARAM}=1`
      : `${protocol}//${host}/?${PARTIAL_STATE_PARAM}=1`;

    // Snap party position when returning from a background browser tab
    document.addEventListener('visibilitychange', () => {
      this.sendPresence();
      this.syncCombatView();
      if (document.visibilityState === 'visible') {
        this.isInitialState = true;
        for (const listener of this.resumeListeners) {
          listener();
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.sendRaw({ type: 'request_state' });
        } else if (this.connected && !this.destroyed) {
          // WebSocket died while in background — reconnect immediately
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
          }
          this.doConnect();
        }
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

  /**
   * Subscribe to state updates. Returns an unsubscribe function. `replay` also delivers
   * the cached last state immediately — state pushes are rare mid-fight, so late mounts need it.
   */
  subscribe(listener: StateListener, opts?: { replay?: boolean }): () => void {
    this.stateListeners.add(listener);
    if (opts?.replay && this.lastState) listener(this.lastState);
    return () => { this.stateListeners.delete(listener); };
  }

  /** Subscribe to live combat messages. Returns an unsubscribe function. */
  onCombat(listener: CombatListener): () => void {
    this.combatListeners.add(listener);
    return () => { this.combatListeners.delete(listener); };
  }

  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => { this.connectionListeners.delete(listener); };
  }

  /** Subscribe to account suspension events (WS close code 4001). */
  onSuspension(listener: SuspensionListener): () => void {
    this.suspensionListeners.add(listener);
    return () => { this.suspensionListeners.delete(listener); };
  }

  /** Subscribe to tab resume (visibilitychange → visible). Returns an unsubscribe function. */
  onResume(listener: ResumeListener): () => void {
    this.resumeListeners.add(listener);
    return () => { this.resumeListeners.delete(listener); };
  }

  private doConnect(): void {
    if (this.destroyed) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[GameClient] connected');
      this.connected = true;
      this.isInitialState = true;
      this.syncCombatView(true);
      this.sendPresence();
      this.resendPending();
      for (const listener of this.connectionListeners) {
        listener(true);
      }
    };

    this.ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        console.error('[GameClient] failed to parse message');
        return;
      }

      if (msg.type === 'state') {
        if (msg.serverVersion) {
          if (this.knownServerVersion === null) {
            this.knownServerVersion = msg.serverVersion;
          } else if (msg.serverVersion !== this.knownServerVersion) {
            console.log('[GameClient] Server version changed, reloading...');
            location.reload();
            return;
          }
        }
        restoreElidedState(msg, this.lastState);
        this.lastState = msg;
        this.combatLog.ingestJournal(msg.combatLog ?? []);
        this.updateRecap(msg as ServerStateMessage);

        // Resolve pending connect on first state message
        if (this.connectResolve) {
          this.connectResolve({ success: true });
          this.connectResolve = undefined;
        }

        for (const listener of this.stateListeners) {
          try {
            listener(msg);
          } catch (err) {
            console.error('[GameClient] error in state listener:', err);
          }
        }
        this.isInitialState = false;
      } else if (msg.type === 'combat') {
        this.handleCombat(msg as ServerCombatMessage);
      } else if (msg.type === 'forecast') {
        this.handleForecast(msg as ServerForecastMessage);
      } else if (msg.type === 'bestiary') {
        this.handleBestiary(msg as ServerBestiaryMessage);
      } else if (msg.type === 'chat_message') {
        for (const listener of this.chatListeners) {
          try {
            listener(msg.message);
          } catch (err) {
            console.error('[GameClient] error in chat listener:', err);
          }
        }
      } else if (msg.type === 'sync_chat') {
        for (const listener of this.syncChatListeners) {
          try {
            listener(msg.messages, msg.full);
          } catch (err) {
            console.error('[GameClient] error in sync_chat listener:', err);
          }
        }
      } else if (msg.type === 'world_update') {
        for (const listener of this.worldUpdateListeners) {
          try {
            listener();
          } catch (err) {
            console.error('[GameClient] error in world_update listener:', err);
          }
        }
      } else if (msg.type === 'equip_blocked') {
        for (const listener of this.equipBlockedListeners) {
          try {
            listener(msg);
          } catch (err) {
            console.error('[GameClient] error in equip_blocked listener:', err);
          }
        }
      } else if (msg.type === 'move_blocked') {
        for (const listener of this.moveBlockedListeners) {
          try {
            listener(msg);
          } catch (err) {
            console.error('[GameClient] error in move_blocked listener:', err);
          }
        }
      } else if (msg.type === 'player_profile') {
        for (const listener of this.playerProfileListeners) {
          try {
            listener(msg);
          } catch (err) {
            console.error('[GameClient] error in player_profile listener:', err);
          }
        }
      } else if (msg.type === 'notification') {
        for (const listener of this.notificationListeners) {
          try {
            listener(msg.notification);
          } catch (err) {
            console.error('[GameClient] error in notification listener:', err);
          }
        }
      } else if (msg.type === 'error') {
        console.warn('[GameClient] server error:', msg.message);
        for (const listener of this.serverErrorListeners) {
          try {
            listener(msg.message, msg.code, { questId: msg.questId });
          } catch (err) {
            console.error('[GameClient] error in server-error listener:', err);
          }
        }
      }
    };

    this.ws.onclose = (event) => {
      console.log('[GameClient] disconnected', event.code);

      // Account suspended — don't reconnect, notify listeners
      if (event.code === 4001) {
        this.destroyed = true;
        for (const listener of this.suspensionListeners) {
          listener();
        }
        return;
      }

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

  private handleCombat(msg: ServerCombatMessage): void {
    const receivedAt = performance.now();
    this.lastCombat = msg;
    const events = msg.events ?? [];
    const log = msg.log ?? [];
    if (msg.snapshot?.full && events.length === 0) {
      this.combatLog.replaceLive(msg.battleId, log);
    } else {
      let releaseAt = msg.snapshot?.elapsedMs;
      for (const ev of events) if (releaseAt === undefined || ev.t > releaseAt) releaseAt = ev.t;
      this.combatLog.pushLive(msg.battleId, log, releaseAt);
    }
    for (const listener of this.combatListeners) {
      try {
        listener(msg, receivedAt);
      } catch (err) {
        console.error('[GameClient] error in combat listener:', err);
      }
    }
  }

  private handleForecast(msg: ServerForecastMessage): void {
    if (!msg.target) return;
    const targetKey = forecastTargetKey(msg.target);
    if (msg.status !== 'pending') {
      const pending = this.forecastPending.get(targetKey);
      if (msg.status === 'unavailable' && pending && pending.inFlight > 1) {
        pending.inFlight--;
        return;
      }
      this.forecastPending.delete(targetKey);
      const superseded = msg.status === 'unavailable' && targetKey !== this.lastForecastSent;
      if (!superseded) {
        const partyKey = msg.result?.partyKey ?? this.currentForecastKey();
        setBounded(this.forecastCache, `${targetKey}|${partyKey}`, { message: msg, at: Date.now() });
      }
      if (msg.status === 'ok' && msg.result) setBounded(this.latestForecast, targetKey, msg);
    }
    for (const listener of this.forecastListeners) {
      try {
        listener(msg);
      } catch (err) {
        console.error('[GameClient] error in forecast listener:', err);
      }
    }
    this.retryIfStale(msg, targetKey);
  }

  private retryIfStale(msg: ServerForecastMessage, targetKey: string): void {
    const forecastKey = this.currentForecastKey();
    if (!msg.result || !forecastKey || msg.result.partyKey === forecastKey || msg.target.kind === 'battle') return;
    const retryKey = `${targetKey}|${forecastKey}`;
    if (this.staleRetried.has(retryKey)) return;
    this.staleRetried.add(retryKey);
    this.requestForecast(msg.target);
  }

  private handleBestiary(msg: ServerBestiaryMessage): void {
    this.lastBestiary = msg;
    this.bestiaryRequestedAt = null;
    for (const listener of this.bestiaryListeners) {
      try {
        listener(msg);
      } catch (err) {
        console.error('[GameClient] error in bestiary listener:', err);
      }
    }
  }

  private updateRecap(state: ServerStateMessage): void {
    const recap = state.awayRecap && !this.ackedRecapIds.has(state.awayRecap.id) ? state.awayRecap : null;
    this.lastRecap = recap;
    this.lastRecapItemDefinitions = recap ? (state.awayRecapItemDefinitions ?? {}) : {};
    const id = recap?.id ?? null;
    if (id === this.notifiedRecapId) return;
    this.notifiedRecapId = id;
    for (const listener of this.recapListeners) {
      try {
        listener(recap);
      } catch (err) {
        console.error('[GameClient] error in recap listener:', err);
      }
    }
  }

  private currentForecastKey(): string {
    return this.lastState?.social?.party?.forecastKey ?? '';
  }

  private resendPending(): void {
    const now = Date.now();
    for (const [targetKey, pending] of this.forecastPending) {
      pending.sentAt = now;
      pending.inFlight = 1;
      this.lastForecastSent = targetKey;
      this.sendRaw({ type: 'request_forecast', target: pending.target });
    }
    if (this.bestiaryRequestedAt !== null) {
      this.bestiaryRequestedAt = now;
      this.sendRaw({ type: 'request_bestiary' });
    }
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

  /** False when the socket isn't open and the message was dropped. */
  private sendRaw(msg: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendMove(col: number, row: number): boolean {
    return this.sendRaw({ type: 'move', col, row });
  }

  sendRun(): void {
    this.sendRaw({ type: 'run' });
  }

  /**
   * Whether the active screen shows the live combat view. The server only streams combat messages
   * while this is true and the page is visible; every new socket is told the current value.
   */
  sendCombatView(visible: boolean): void {
    this.combatViewRequested = visible;
    this.syncCombatView();
  }

  private syncCombatView(force = false): void {
    const visible = this.combatViewRequested && document.visibilityState !== 'hidden';
    if (!force && this.combatViewSent === visible) return;
    this.combatViewSent = visible;
    this.sendRaw({ type: 'combat_view', visible });
  }

  private sendPresence(): void {
    this.sendRaw({ type: 'presence', visible: document.visibilityState !== 'hidden' });
  }

  // --- Forecasts ---

  /** Subscribe to forecast replies and server-pushed live battle forecasts. Returns an unsubscribe function. */
  onForecast(listener: ForecastListener): () => void {
    this.forecastListeners.add(listener);
    return () => { this.forecastListeners.delete(listener); };
  }

  /**
   * The cached reply for `target` when fresh for the party's current forecast inputs; otherwise
   * asks the server (once while it is the latest outstanding request) and returns null.
   */
  requestForecast(target: ForecastRequestTarget): ServerForecastMessage | null {
    const targetKey = forecastTargetKey(target);
    const cached = this.forecastCache.get(`${targetKey}|${this.currentForecastKey()}`);
    const now = Date.now();
    if (cached) {
      const ttl = cached.message.status === 'unavailable' ? FORECAST_UNAVAILABLE_TTL_MS : FORECAST_TTL_MS;
      if (now - cached.at <= ttl) return cached.message;
    }
    const pending = this.forecastPending.get(targetKey);
    if (pending && now - pending.sentAt < FORECAST_RETRY_MS && this.lastForecastSent === targetKey) return null;
    this.forecastPending.set(targetKey, { target, sentAt: now, inFlight: (pending?.inFlight ?? 0) + 1 });
    this.lastForecastSent = targetKey;
    this.sendRaw({ type: 'request_forecast', target });
    return null;
  }

  /** Latest successful reply for `target` whatever the party key or age (null when none). */
  peekForecast(target: ForecastTarget): ServerForecastMessage | null {
    return this.latestForecast.get(forecastTargetKey(target)) ?? null;
  }

  // --- Bestiary ---

  onBestiary(listener: BestiaryListener): () => void {
    this.bestiaryListeners.add(listener);
    return () => { this.bestiaryListeners.delete(listener); };
  }

  /** Returns the cached bestiary when it matches the state's mastery version; otherwise requests it. */
  requestBestiary(): ServerBestiaryMessage | null {
    const version = this.lastState?.character?.mastery?.version;
    if (this.lastBestiary && (version === undefined || this.lastBestiary.version === version)) return this.lastBestiary;
    const now = Date.now();
    if (this.bestiaryRequestedAt !== null && now - this.bestiaryRequestedAt < BESTIARY_RETRY_MS) return null;
    this.bestiaryRequestedAt = now;
    this.sendRaw({ type: 'request_bestiary' });
    return null;
  }

  // --- Combat preferences ---

  sendSetCombatPrefs(autoRetreatBelowPct: AutoRetreatPct): void {
    this.sendRaw({ type: 'set_combat_prefs', autoRetreatBelowPct });
  }

  // --- Away recap ---

  /** Called with the current recap right away (when there is one) and whenever it changes or clears. */
  onRecap(listener: RecapListener): () => void {
    this.recapListeners.add(listener);
    if (this.lastRecap) listener(this.lastRecap);
    return () => { this.recapListeners.delete(listener); };
  }

  sendAckRecap(id: string): void {
    this.ackedRecapIds.add(id);
    if (this.lastRecap?.id === id) {
      this.lastRecap = null;
      this.lastRecapItemDefinitions = {};
      this.notifiedRecapId = null;
    }
    this.sendRaw({ type: 'ack_recap', id });
  }

  // --- Dungeons ---

  sendEnterDungeon(col: number, row: number, dungeonId: string): boolean {
    return this.sendRaw({ type: 'enter_dungeon', col, row, dungeonId });
  }

  sendLeaveDungeon(): void {
    this.sendRaw({ type: 'leave_dungeon' });
  }

  /** Travel through the current room's transition to the target room (by GUID). */
  sendEnterTransition(tileId: string): boolean {
    return this.sendRaw({ type: 'enter_transition', tileId });
  }

  sendEquipSkill(skillId: string, slotIndex: number): void {
    this.sendRaw({ type: 'equip_skill', skillId, slotIndex });
  }

  sendUnequipSkill(slotIndex: number): void {
    this.sendRaw({ type: 'unequip_skill', slotIndex });
  }

  sendSetActionOrder(actionOrder: string[]): void {
    this.sendRaw({ type: 'set_action_order', actionOrder });
  }

  sendSetClass(className: string): boolean {
    return this.sendRaw({ type: 'set_class', className });
  }

  sendEquipItem(itemId: string): void {
    this.sendRaw({ type: 'equip_item', itemId });
  }

  sendUnequipItem(slot: string): void {
    this.sendRaw({ type: 'unequip_item', slot });
  }

  sendDestroyItems(itemId: string, count: number): void {
    this.sendRaw({ type: 'destroy_items', itemId, count });
  }

  sendEquipItemForceDestroy(itemId: string): void {
    this.sendRaw({ type: 'equip_item_force_destroy', itemId });
  }

  /** Subscribe to equip_blocked messages. Returns an unsubscribe function. */
  onEquipBlocked(listener: EquipBlockedListener): () => void {
    this.equipBlockedListeners.add(listener);
    return () => { this.equipBlockedListeners.delete(listener); };
  }

  /** Subscribe to move_blocked messages. Returns an unsubscribe function. */
  onMoveBlocked(listener: MoveBlockedListener): () => void {
    this.moveBlockedListeners.add(listener);
    return () => { this.moveBlockedListeners.delete(listener); };
  }

  resetXpRate(): void {
    this.sendRaw({ type: 'reset_xp_rate' });
  }

  // --- Shop ---

  sendShopBuy(itemId: string): boolean {
    return this.sendRaw({ type: 'shop_buy', itemId });
  }

  sendShopSell(itemId: string, quantity: number): boolean {
    return this.sendRaw({ type: 'shop_sell', itemId, quantity });
  }

  // --- Crafting ---

  sendCraftQueue(recipeId: string): void {
    this.sendRaw({ type: 'craft_queue', recipeId });
  }

  sendCraftCancel(index: number): void {
    this.sendRaw({ type: 'craft_cancel', index });
  }

  // --- Quests ---

  sendAcceptQuest(questId: string): boolean {
    return this.sendRaw({ type: 'accept_quest', questId });
  }

  sendTurnInQuest(questId: string): boolean {
    return this.sendRaw({ type: 'turn_in_quest', questId });
  }

  // --- View Player ---

  sendViewPlayer(username: string): void {
    this.sendRaw({ type: 'view_player', username });
  }

  onPlayerProfile(listener: PlayerProfileListener): () => void {
    this.playerProfileListeners.add(listener);
    return () => { this.playerProfileListeners.delete(listener); };
  }

  // --- Social ---

  sendFriendRequest(username: string): void {
    this.sendRaw({ type: 'send_friend_request', username });
  }

  sendAcceptFriendRequest(username: string): void {
    this.sendRaw({ type: 'accept_friend_request', username });
  }

  sendDeclineFriendRequest(username: string): void {
    this.sendRaw({ type: 'decline_friend_request', username });
  }

  sendRevokeFriendRequest(username: string): void {
    this.sendRaw({ type: 'revoke_friend_request', username });
  }

  sendRemoveFriend(username: string): void {
    this.sendRaw({ type: 'remove_friend', username });
  }

  sendBlockUser(username: string, level: BlockLevel): void {
    this.sendRaw({ type: 'block_user', username, level });
  }

  sendUnblockUser(username: string): void {
    this.sendRaw({ type: 'unblock_user', username });
  }

  // --- Notifications ---

  sendMarkNotificationRead(id: string): void {
    this.sendRaw({ type: 'mark_notification_read', id });
  }

  sendMarkAllNotificationsRead(): void {
    this.sendRaw({ type: 'mark_all_notifications_read' });
  }

  sendDismissNotification(id: string): void {
    this.sendRaw({ type: 'dismiss_notification', id });
  }

  sendClearAllNotifications(): void {
    this.sendRaw({ type: 'clear_all_notifications' });
  }

  sendSetNotificationPreferences(preferences: NotificationPreferences): void {
    this.sendRaw({ type: 'set_notification_preferences', preferences });
  }

  sendRegisterPushSubscription(subscription: WebPushSubscription): void {
    this.sendRaw({ type: 'register_push_subscription', subscription });
  }

  sendUnregisterPushSubscription(endpoint: string): void {
    this.sendRaw({ type: 'unregister_push_subscription', endpoint });
  }

  /** Reports which chat thread (if any) the player is actively looking at, so the server can suppress DM notifications for it. */
  sendSetChatFocus(channelType: ChatChannelType | null, channelId: string | null): void {
    this.sendRaw({ type: 'set_chat_focus', channelType, channelId });
  }

  /** Subscribe to live notification toasts. Returns an unsubscribe function. */
  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => { this.notificationListeners.delete(listener); };
  }

  // --- Guild ---

  sendCreateGuild(name: string): void {
    this.sendRaw({ type: 'create_guild', name });
  }

  sendJoinGuild(guildId: string): void {
    this.sendRaw({ type: 'join_guild', guildId });
  }

  sendLeaveGuild(): void {
    this.sendRaw({ type: 'leave_guild' });
  }

  sendInviteGuild(username: string): void {
    this.sendRaw({ type: 'invite_guild', username });
  }

  // --- Party ---

  sendCreateParty(): void {
    this.sendRaw({ type: 'create_party' });
  }

  sendInviteParty(username: string): void {
    this.sendRaw({ type: 'invite_party', username });
  }

  sendLeaveParty(): void {
    this.sendRaw({ type: 'leave_party' });
  }

  sendKickPartyMember(username: string): void {
    this.sendRaw({ type: 'kick_party_member', username });
  }

  /** Moves the sender, or the named henchman when `henchmanInstanceId` is given. */
  sendSetPartyGridPosition(position: number, henchmanInstanceId?: string): void {
    this.sendRaw({
      type: 'set_party_grid_position',
      position,
      ...(henchmanInstanceId ? { henchmanInstanceId } : {}),
    });
  }

  sendPromotePartyLeader(username: string): void {
    this.sendRaw({ type: 'promote_party_leader', username });
  }

  sendDemotePartyMember(username: string): void {
    this.sendRaw({ type: 'demote_party_member', username });
  }

  sendTransferPartyOwnership(username: string): void {
    this.sendRaw({ type: 'transfer_party_ownership', username });
  }

  sendAcceptPartyInvite(partyId: string): void {
    this.sendRaw({ type: 'accept_party_invite', partyId });
  }

  sendDeclinePartyInvite(partyId: string): void {
    this.sendRaw({ type: 'decline_party_invite', partyId });
  }

  // --- Henchmen ---

  /** Hire a henchman from the current room's shop; a refusal comes back as an `error` message. */
  sendHireHenchman(henchmanId: string, replaceInstanceId?: string): void {
    this.sendRaw({ type: 'hire_henchman', henchmanId, ...(replaceInstanceId ? { replaceInstanceId } : {}) });
  }

  sendDismissHenchman(instanceId: string): void {
    this.sendRaw({ type: 'dismiss_henchman', instanceId });
  }

  // --- Chat ---

  /** False when the socket isn't open and nothing was sent. */
  sendChat(channelType: ChatChannelType, channelId: string, text: string): boolean {
    return this.sendRaw({ type: 'send_chat', channelType, channelId, text });
  }

  sendSyncChat(sinceId?: string): void {
    this.sendRaw({ type: 'sync_chat', sinceId });
  }

  sendSetChatPreferences(sendChannel: string, dmTarget: string): void {
    this.sendRaw({ type: 'set_chat_preferences', sendChannel, dmTarget });
  }

  /** Subscribe to incoming chat messages. Returns an unsubscribe function. */
  onChat(listener: ChatListener): () => void {
    this.chatListeners.add(listener);
    return () => { this.chatListeners.delete(listener); };
  }

  /** Subscribe to sync_chat responses. Returns an unsubscribe function. */
  onSyncChat(listener: SyncChatListener): () => void {
    this.syncChatListeners.add(listener);
    return () => { this.syncChatListeners.delete(listener); };
  }

  /** Subscribe to world update notifications. Returns an unsubscribe function. */
  onWorldUpdate(listener: WorldUpdateListener): () => void {
    this.worldUpdateListeners.add(listener);
    return () => { this.worldUpdateListeners.delete(listener); };
  }

  /** Subscribe to server `error` messages. `code` is set only for errors a screen
   *  is expected to react to (see ServerErrorCode). */
  onServerError(listener: ServerErrorListener): () => void {
    this.serverErrorListeners.add(listener);
    return () => { this.serverErrorListeners.delete(listener); };
  }

  // --- Trade ---

  sendProposeTrade(targetUsername: string, items: TradeOfferItem[]): void {
    console.log('[Trade] sendProposeTrade →', targetUsername, items);
    this.sendRaw({ type: 'propose_trade', targetUsername, items });
  }

  sendCounterTrade(tradeId: string, items: TradeOfferItem[]): void {
    console.log('[Trade] sendCounterTrade →', tradeId, items);
    this.sendRaw({ type: 'counter_trade', tradeId, items });
  }

  /** `nonce` must be the one from the offer the player is looking at — the server
   *  rejects a confirm whose nonce no longer matches the current offer. */
  sendConfirmTrade(tradeId: string, nonce: string): void {
    this.sendRaw({ type: 'confirm_trade', tradeId, nonce });
  }

  sendCancelTrade(tradeId: string): void {
    this.sendRaw({ type: 'cancel_trade', tradeId });
  }

  // --- Gift ---

  sendGift(targetUsername: string, itemId: string, quantity: number): void {
    this.sendRaw({ type: 'send_gift', targetUsername, itemId, quantity });
  }

  sendAcceptGift(entryId: string): void {
    this.sendRaw({ type: 'accept_gift', entryId });
  }

  sendDenyGift(entryId: string): void {
    this.sendRaw({ type: 'deny_gift', entryId });
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
    this.chatListeners.clear();
    this.syncChatListeners.clear();
    this.worldUpdateListeners.clear();
    this.resumeListeners.clear();
    this.notificationListeners.clear();
    this.serverErrorListeners.clear();
    this.combatListeners.clear();
    this.forecastListeners.clear();
    this.bestiaryListeners.clear();
    this.recapListeners.clear();
  }
}
