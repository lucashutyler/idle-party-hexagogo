// ── Social System Types ─────────────────────────────────────

// --- Friend System ---
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
export type PartyRole = 'leader' | 'member';
export type PartyGridPosition = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

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

// --- Chat System ---
export type ChatChannelType = 'tile' | 'zone' | 'party' | 'guild' | 'dm' | 'global';

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
export interface ClientSocialState {
  friends: string[];
  guild: GuildInfo | null;
  guildMembers: GuildMemberEntry[];
  party: GamePartyInfo | null;
  pendingInvites: PartyInvite[];
  onlinePlayers: string[];
  allPlayers: string[];
  blockedUsers: Record<string, BlockLevel>;
}

// --- Client -> Server messages ---
export interface ClientAddFriendMessage {
  type: 'add_friend';
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

export interface ClientRequestChatHistoryMessage {
  type: 'request_chat_history';
  channelType: ChatChannelType;
  channelId: string;
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

export type ClientSocialMessage =
  | ClientAddFriendMessage
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
  | ClientAcceptPartyInviteMessage
  | ClientDeclinePartyInviteMessage
  | ClientSendChatMessage
  | ClientRequestChatHistoryMessage
  | ClientBlockUserMessage
  | ClientUnblockUserMessage;

// --- Server -> Client messages ---
export interface ServerSocialStateMessage {
  type: 'social_state';
  social: ClientSocialState;
}

export interface ServerChatMessageMessage {
  type: 'chat_message';
  message: ChatMessage;
}

export interface ServerChatHistoryMessage {
  type: 'chat_history';
  channelType: ChatChannelType;
  channelId: string;
  messages: ChatMessage[];
}
