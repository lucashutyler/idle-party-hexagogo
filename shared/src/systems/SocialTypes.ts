// ── Social System Types ─────────────────────────────────────

import type { NotificationEntry, NotificationPreferences } from './NotificationTypes.js';
// Must stay `import type`: erases the HenchmanTypes <-> SocialTypes cycle at compile time.
import type { HiredHenchman } from './HenchmanTypes.js';
import type { PartyAutoRetreatInfo } from './ForecastTypes.js';

// --- Friend System ---
export interface FriendRequest {
  fromUsername: string;
  toUsername: string;
  timestamp: number;
}

export interface FriendEntry {
  username: string;
  addedAt: number;
}

// --- Guild System ---
export interface GuildInfo {
  id: string;
  name: string;
  leaderUsername: string;
  createdAt: number;
}

export interface GuildMemberEntry {
  username: string;
  joinedAt: number;
  role: 'leader' | 'member';
}

export const MIN_GUILD_LEVEL = 5;

/** How long a guild invite stays open. */
export const GUILD_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A guild invite as its target sees it. */
export interface GuildInviteInfo {
  guildId: string;
  guildName: string;
  inviterUsername: string;
}

// --- Party System ---
export type PartyRole = 'owner' | 'leader' | 'member';
export type PartyGridPosition = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const MAX_PARTY_SIZE = 5;
/** Henchmen one party may hold at once, each a different henchman. Henchmen also count toward MAX_PARTY_SIZE. */
export const MAX_HENCHMEN_PER_PARTY = MAX_PARTY_SIZE - 1;

export interface GamePartyMember {
  username: string;
  role: PartyRole;
  gridPosition: PartyGridPosition;
  /** Resolved at send time, never persisted. */
  level?: number;
  className?: string;
}

export interface GamePartyInfo {
  id: string;
  members: GamePartyMember[];
  /** Never merge into `members` — member call sites all resolve an account. Grid slots are shared. */
  henchmen?: HiredHenchman[];
  /** Auto-retreat policy in effect: the party owner's setting. */
  autoRetreat?: PartyAutoRetreatInfo;
  /** While on and with a route to walk, the party spends `AUTO_RUN_ROOM_MS` on each room, leaving its fight early. */
  autoRun?: boolean;
  /** Digest of the party's forecast inputs; a forecast whose `partyKey` differs is stale. */
  forecastKey?: string;
}

/** How long a party invite stays open. */
export const PARTY_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PartyInvite {
  partyId: string;
  inviterUsername: string;
  targetUsername: string;
  timestamp: number;
  /** Absent → `timestamp + PARTY_INVITE_TTL_MS`. */
  expiresAt?: number;
  /** Where the inviting party is, filled per viewer at send time and never stored. Absent when unknown. */
  roomName?: string;
  zoneName?: string;
  sameMap?: boolean;
}

export function partyInviteExpiresAt(invite: Pick<PartyInvite, 'timestamp' | 'expiresAt'>): number {
  return invite.expiresAt ?? invite.timestamp + PARTY_INVITE_TTL_MS;
}

// --- Trade System ---
export type TradeStatus = 'pending' | 'countered' | 'confirmed' | 'cancelled';

export interface TradeOfferItem {
  itemId: string;
  quantity: number;
}

export interface TradeOffer {
  username: string;
  items: TradeOfferItem[];
}

/**
 * Trades are asynchronous: they persist server-side until both parties confirm or
 * either cancels. Each player can have multiple proposed trades — listed in
 * ClientSocialState.proposedTrades. `lastUpdatedBy` indicates who needs to act next:
 * the OTHER player. (If `lastUpdatedBy === self`, you are waiting on the partner.)
 */
export interface TradeState {
  id: string;
  status: TradeStatus;
  initiator: TradeOffer;
  target: TradeOffer | null;
  timestamp: number;
  /** Username of the player who last took action on this trade (proposed/countered). */
  lastUpdatedBy: string;
  /**
   * Confirmation token, rotated on every offer change. A `confirm_trade` must echo
   * the nonce of the exact offer the player saw, so a captured confirm frame
   * cannot be replayed and an offer cannot be swapped out from under a
   * confirmation already in flight.
   */
  nonce: string;
  cancelReason?: string;
}

// --- Mailbox / Gift System ---
export interface MailboxEntry {
  id: string;
  fromUsername: string;
  itemId: string;
  quantity: number;
  sentAt: number;
  /** True if this entry is a returned (denied) gift back to the original sender. */
  returned?: boolean;
}

// --- Chat System ---
export type ChatChannelType = 'tile' | 'zone' | 'party' | 'guild' | 'dm' | 'global' | 'server';

export interface ChatMessage {
  id: string;
  channelType: ChatChannelType;
  channelId: string;
  senderUsername: string;
  text: string;
  timestamp: number;
}

export interface ChatChannel {
  type: ChatChannelType;
  id: string;
  name: string;
  unreadCount: number;
}

/** Chat history is capped per bucket. See docs/architecture/social.md → Chat history. */
export type ChatBucket = 'dm' | 'group' | 'public';
export type ChatCaps = Readonly<Record<ChatBucket, number>>;

export const CHAT_BUCKETS: readonly ChatBucket[] = ['dm', 'group', 'public'];
export const SERVER_CHAT_CAPS: ChatCaps = { dm: 300, group: 200, public: 500 };
export const CLIENT_CHAT_CAPS: ChatCaps = { dm: 150, group: 100, public: 250 };

/** Anything unknown counts as public: saved history can hold channel types no longer sent. */
export function chatBucket(channelType: ChatChannelType): ChatBucket {
  switch (channelType) {
    case 'dm':
      return 'dm';
    case 'party':
    case 'guild':
      return 'group';
    default:
      return 'public';
  }
}

export function countChatBuckets(messages: readonly Pick<ChatMessage, 'channelType'>[]): Record<ChatBucket, number> {
  const counts: Record<ChatBucket, number> = { dm: 0, group: 0, public: 0 };
  for (const message of messages) counts[chatBucket(message.channelType)]++;
  return counts;
}

/** Drops the oldest messages of each bucket over its cap; the rest keep their order. */
export function trimChatHistory<T extends Pick<ChatMessage, 'channelType'>>(messages: readonly T[], caps: ChatCaps): T[] {
  const excess = countChatBuckets(messages);
  for (const bucket of CHAT_BUCKETS) excess[bucket] -= caps[bucket];
  if (CHAT_BUCKETS.every(bucket => excess[bucket] <= 0)) return [...messages];
  return messages.filter(message => {
    const bucket = chatBucket(message.channelType);
    if (excess[bucket] <= 0) return true;
    excess[bucket]--;
    return false;
  });
}

// --- Block System ---
export type BlockLevel = 'dm' | 'all';

/** Own keys only: an older account can be called `constructor` or `__proto__`. */
export function isBlockedUser(username: string, blocked: Readonly<Record<string, BlockLevel>>): boolean {
  return Object.prototype.hasOwnProperty.call(blocked, username);
}

// --- Social State (sent to client) ---
export interface PlayerListEntry {
  username: string;
  className?: string;
  level?: number;
}

export interface ClientSocialState {
  friends: string[];
  incomingFriendRequests: FriendRequest[];
  outgoingFriendRequests: FriendRequest[];
  guild: GuildInfo | null;
  guildMembers: GuildMemberEntry[];
  /** Open invites to join a guild; only sent while this player is in none. */
  guildInvites?: GuildInviteInfo[];
  /** Players with an open invite to this player's guild. */
  outgoingGuildInvites?: string[];
  party: GamePartyInfo | null;
  pendingInvites: PartyInvite[];
  outgoingPartyInvites: string[];
  onlinePlayers: string[];
  allPlayers: PlayerListEntry[];
  blockedUsers: Record<string, BlockLevel>;
  chatPreferences?: ChatPreferences;
  /** All async trades involving this player (initiated by or targeted at). */
  proposedTrades?: TradeState[];
  /** Pending gift entries in this player's mailbox. */
  mailbox?: MailboxEntry[];
  /** This player's notification inbox (capped, most recent last). */
  notifications?: NotificationEntry[];
  notificationPreferences?: NotificationPreferences;
}

export interface ChatPreferences {
  sendChannel: ChatChannelType;
  dmTarget: string;
}

// --- Client -> Server messages ---
export interface ClientSendFriendRequestMessage {
  type: 'send_friend_request';
  username: string;
}

export interface ClientAcceptFriendRequestMessage {
  type: 'accept_friend_request';
  username: string;
}

export interface ClientDeclineFriendRequestMessage {
  type: 'decline_friend_request';
  username: string;
}

export interface ClientRevokeFriendRequestMessage {
  type: 'revoke_friend_request';
  username: string;
}

export interface ClientRemoveFriendMessage {
  type: 'remove_friend';
  username: string;
}

export interface ClientCreateGuildMessage {
  type: 'create_guild';
  name: string;
}

export interface ClientInviteGuildMessage {
  type: 'invite_guild';
  username: string;
}

export interface ClientAcceptGuildInviteMessage {
  type: 'accept_guild_invite';
  guildId: string;
}

export interface ClientDeclineGuildInviteMessage {
  type: 'decline_guild_invite';
  guildId: string;
}

export interface ClientKickGuildMemberMessage {
  type: 'kick_guild_member';
  username: string;
}

export interface ClientLeaveGuildMessage {
  type: 'leave_guild';
}

export interface ClientCreatePartyMessage {
  type: 'create_party';
}

export interface ClientInvitePartyMessage {
  type: 'invite_party';
  username: string;
}

export interface ClientLeavePartyMessage {
  type: 'leave_party';
}

export interface ClientKickPartyMemberMessage {
  type: 'kick_party_member';
  username: string;
}

export interface ClientSetPartyGridPositionMessage {
  type: 'set_party_grid_position';
  position: PartyGridPosition;
  /** Move this henchman rather than the sender; authorized on party role, not identity. */
  henchmanInstanceId?: string;
}

export interface ClientHireHenchmanMessage {
  type: 'hire_henchman';
  henchmanId: string;
  /** Hired henchman (its `instanceId`) to swap out for this one. */
  replaceInstanceId?: string;
}

export interface ClientDismissHenchmanMessage {
  type: 'dismiss_henchman';
  instanceId: string;
}

export interface ClientPromotePartyLeaderMessage {
  type: 'promote_party_leader';
  username: string;
}

export interface ClientDemotePartyMemberMessage {
  type: 'demote_party_member';
  username: string;
}

export interface ClientTransferPartyOwnershipMessage {
  type: 'transfer_party_ownership';
  username: string;
}

export interface ClientAcceptPartyInviteMessage {
  type: 'accept_party_invite';
  partyId: string;
}

export interface ClientDeclinePartyInviteMessage {
  type: 'decline_party_invite';
  partyId: string;
}

export interface ClientSendChatMessage {
  type: 'send_chat';
  channelType: ChatChannelType;
  channelId: string;
  text: string;
}

export interface ClientSyncChatMessage {
  type: 'sync_chat';
  sinceId?: string;
}

export interface ClientBlockUserMessage {
  type: 'block_user';
  username: string;
  level: BlockLevel;
}

export interface ClientUnblockUserMessage {
  type: 'unblock_user';
  username: string;
}

export interface ClientSetChatPreferencesMessage {
  type: 'set_chat_preferences';
  sendChannel: ChatChannelType;
  dmTarget: string;
}

export interface ClientProposeTradeMessage {
  type: 'propose_trade';
  targetUsername: string;
  items: TradeOfferItem[];
}

export interface ClientCounterTradeMessage {
  type: 'counter_trade';
  tradeId: string;
  items: TradeOfferItem[];
}

export interface ClientConfirmTradeMessage {
  type: 'confirm_trade';
  tradeId: string;
  /** Must match the current `TradeState.nonce` — see TradeState.nonce. */
  nonce: string;
}

export interface ClientCancelTradeMessage {
  type: 'cancel_trade';
  tradeId: string;
}

export interface ClientSendGiftMessage {
  type: 'send_gift';
  targetUsername: string;
  itemId: string;
  quantity: number;
}

export interface ClientAcceptGiftMessage {
  type: 'accept_gift';
  entryId: string;
}

export interface ClientDenyGiftMessage {
  type: 'deny_gift';
  entryId: string;
}

export type ClientSocialMessage =
  | ClientSendFriendRequestMessage
  | ClientAcceptFriendRequestMessage
  | ClientDeclineFriendRequestMessage
  | ClientRevokeFriendRequestMessage
  | ClientRemoveFriendMessage
  | ClientCreateGuildMessage
  | ClientInviteGuildMessage
  | ClientAcceptGuildInviteMessage
  | ClientDeclineGuildInviteMessage
  | ClientKickGuildMemberMessage
  | ClientLeaveGuildMessage
  | ClientCreatePartyMessage
  | ClientInvitePartyMessage
  | ClientLeavePartyMessage
  | ClientKickPartyMemberMessage
  | ClientSetPartyGridPositionMessage
  | ClientHireHenchmanMessage
  | ClientDismissHenchmanMessage
  | ClientPromotePartyLeaderMessage
  | ClientDemotePartyMemberMessage
  | ClientTransferPartyOwnershipMessage
  | ClientAcceptPartyInviteMessage
  | ClientDeclinePartyInviteMessage
  | ClientSendChatMessage
  | ClientSyncChatMessage
  | ClientBlockUserMessage
  | ClientUnblockUserMessage
  | ClientSetChatPreferencesMessage
  | ClientProposeTradeMessage
  | ClientCounterTradeMessage
  | ClientConfirmTradeMessage
  | ClientCancelTradeMessage
  | ClientSendGiftMessage
  | ClientAcceptGiftMessage
  | ClientDenyGiftMessage;

// --- Server -> Client messages ---
export interface ServerSocialStateMessage {
  type: 'social_state';
  social: ClientSocialState;
}

export interface ServerChatMessageMessage {
  type: 'chat_message';
  message: ChatMessage;
}

export interface ServerSyncChatMessage {
  type: 'sync_chat';
  messages: ChatMessage[];
  full: boolean;
}

export interface ServerTradeProposedMessage {
  type: 'trade_proposed';
  trade: TradeState;
}

export interface ServerTradeCancelledMessage {
  type: 'trade_cancelled';
  tradeId: string;
  reason: string;
}

export interface ServerTradeCompletedMessage {
  type: 'trade_completed';
  trade: TradeState;
  receivedItemId: string;
}
