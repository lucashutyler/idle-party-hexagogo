// ── Social System Types ─────────────────────────────────────

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

// --- Party System ---
export type PartyRole = 'owner' | 'leader' | 'member';
export type PartyGridPosition = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const MAX_PARTY_SIZE = 5;

export interface GamePartyMember {
  username: string;
  role: PartyRole;
  gridPosition: PartyGridPosition;
}

export interface GamePartyInfo {
  id: string;
  members: GamePartyMember[];
}

export interface PartyInvite {
  partyId: string;
  inviterUsername: string;
  targetUsername: string;
  timestamp: number;
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

export interface TradeState {
  id: string;
  status: TradeStatus;
  initiator: TradeOffer;
  target: TradeOffer | null;
  timestamp: number;
  cancelReason?: string;
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

// --- Block System ---
export type BlockLevel = 'dm' | 'all';

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
  party: GamePartyInfo | null;
  pendingInvites: PartyInvite[];
  outgoingPartyInvites: string[];
  onlinePlayers: string[];
  allPlayers: PlayerListEntry[];
  blockedUsers: Record<string, BlockLevel>;
  chatPreferences?: ChatPreferences;
  pendingTrade?: TradeState | null;
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

export interface ClientJoinGuildMessage {
  type: 'join_guild';
  guildId: string;
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
  items: TradeOfferItem[];
}

export interface ClientConfirmTradeMessage {
  type: 'confirm_trade';
}

export interface ClientCancelTradeMessage {
  type: 'cancel_trade';
}

export type ClientSocialMessage =
  | ClientSendFriendRequestMessage
  | ClientAcceptFriendRequestMessage
  | ClientDeclineFriendRequestMessage
  | ClientRevokeFriendRequestMessage
  | ClientRemoveFriendMessage
  | ClientCreateGuildMessage
  | ClientInviteGuildMessage
  | ClientJoinGuildMessage
  | ClientLeaveGuildMessage
  | ClientCreatePartyMessage
  | ClientInvitePartyMessage
  | ClientLeavePartyMessage
  | ClientKickPartyMemberMessage
  | ClientSetPartyGridPositionMessage
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
  | ClientCancelTradeMessage;

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
