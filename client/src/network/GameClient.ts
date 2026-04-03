import type { ServerStateMessage, ServerEquipBlockedMessage, PlayerProfileMessage, BlockLevel, ChatMessage, ChatChannelType, TradeOfferItem } from '@idle-party-rpg/shared';

const RECONNECT_DELAY = 2000;

type StateListener = (state: ServerStateMessage) => void;
type ChatListener = (message: ChatMessage) => void;
type SyncChatListener = (messages: ChatMessage[], full: boolean) => void;
type ConnectionListener = (connected: boolean) => void;
type WorldUpdateListener = () => void;
type EquipBlockedListener = (msg: ServerEquipBlockedMessage) => void;
type SuspensionListener = () => void;
type ResumeListener = () => void;
type PlayerProfileListener = (profile: PlayerProfileMessage) => void;

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
  private suspensionListeners = new Set<SuspensionListener>();
  private resumeListeners = new Set<ResumeListener>();
  private playerProfileListeners = new Set<PlayerProfileListener>();

  /** Pending connect resolve — set during connect() call. */
  private connectResolve?: (result: { success: boolean; error?: string }) => void;

  /** True on connect, false after first state message — used to snap vs tween. */
  isInitialState = true;

  /** Most recent state from the server (null until first message). */
  lastState: ServerStateMessage | null = null;

  /** Server version from first state message — reload if it changes. */
  private knownServerVersion: string | null = null;

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
      for (const listener of this.connectionListeners) {
        listener(true);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

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
        } else if (msg.type === 'chat_message') {
          for (const listener of this.chatListeners) {
            listener(msg.message);
          }
        } else if (msg.type === 'sync_chat') {
          for (const listener of this.syncChatListeners) {
            listener(msg.messages, msg.full);
          }
        } else if (msg.type === 'world_update') {
          for (const listener of this.worldUpdateListeners) {
            listener();
          }
        } else if (msg.type === 'equip_blocked') {
          for (const listener of this.equipBlockedListeners) {
            listener(msg);
          }
        } else if (msg.type === 'player_profile') {
          for (const listener of this.playerProfileListeners) {
            listener(msg);
          }
        } else if (msg.type === 'error') {
          console.warn('[GameClient] server error:', msg.message);
        }
      } catch {
        console.error('[GameClient] failed to parse message');
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

  sendRun(): void {
    this.sendRaw({ type: 'run' });
  }

  sendUnlockSkill(skillId: string): void {
    this.sendRaw({ type: 'unlock_skill', skillId });
  }

  sendEquipSkill(skillId: string, slotIndex: number): void {
    this.sendRaw({ type: 'equip_skill', skillId, slotIndex });
  }

  sendUnequipSkill(slotIndex: number): void {
    this.sendRaw({ type: 'unequip_skill', slotIndex });
  }

  sendSetClass(className: string): void {
    this.sendRaw({ type: 'set_class', className });
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

  resetXpRate(): void {
    this.sendRaw({ type: 'reset_xp_rate' });
  }

  // --- Shop ---

  sendShopBuy(itemId: string): void {
    this.sendRaw({ type: 'shop_buy', itemId });
  }

  sendShopSell(itemId: string, quantity: number): void {
    this.sendRaw({ type: 'shop_sell', itemId, quantity });
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

  sendSetPartyGridPosition(position: number): void {
    this.sendRaw({ type: 'set_party_grid_position', position });
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

  // --- Chat ---

  sendChat(channelType: ChatChannelType, channelId: string, text: string): void {
    this.sendRaw({ type: 'send_chat', channelType, channelId, text });
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

  // --- Trade ---

  sendProposeTrade(targetUsername: string, items: TradeOfferItem[]): void {
    console.log('[Trade] sendProposeTrade →', targetUsername, items);
    this.sendRaw({ type: 'propose_trade', targetUsername, items });
  }

  sendCounterTrade(items: TradeOfferItem[]): void {
    console.log('[Trade] sendCounterTrade →', items);
    this.sendRaw({ type: 'counter_trade', items });
  }

  sendConfirmTrade(): void {
    this.sendRaw({ type: 'confirm_trade' });
  }

  sendCancelTrade(): void {
    this.sendRaw({ type: 'cancel_trade' });
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
  }
}
