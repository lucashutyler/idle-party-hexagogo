import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, ClientSocialState, ChatMessage, ChatChannelType } from '@idle-party-rpg/shared';
import { MAX_PARTY_SIZE } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

type SubTab = 'users' | 'friends' | 'guild' | 'party' | 'chat';

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'friends', label: 'Friends' },
  { id: 'guild', label: 'Guild' },
  { id: 'party', label: 'Party' },
  { id: 'chat', label: 'Chat' },
];

export class SocialScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;
  private activeTab: SubTab = (sessionStorage.getItem('socialSubTab') as SubTab) || 'users';
  private unsubscribe?: () => void;
  private unsubChat?: () => void;
  private unsubChatHistory?: () => void;

  private tabBar!: HTMLElement;
  private panelContainer!: HTMLElement;
  private searchInput!: HTMLInputElement;

  private lastSocial: ClientSocialState | null = null;
  private lastState: ServerStateMessage | null = null;
  private searchQuery = '';
  private sortBy: 'name' | 'status' = 'status';
  private filterBy: 'all' | 'friends' | 'guild' | 'party' | 'room' | 'zone' = 'all';

  // Chat state — unified timeline
  private chatMessages: ChatMessage[] = [];
  private chatFilters = new Set<ChatChannelType>(['tile', 'zone', 'party', 'guild', 'dm', 'global'] as ChatChannelType[]);
  private chatSendChannel: ChatChannelType = 'zone';
  private chatDmTarget = '';
  private hasUnread = false;
  private chatHistoryLoaded = new Set<string>();
  private chatFocusAfterRender = false;
  private chatPrefsInitialized = false;

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.buildDOM();
  }

  onActivate(): void {
    this.isActive = true;
    this.hasUnread = false;
    this.unsubscribe = this.gameClient.subscribe((state) => {
      if (this.isActive) this.updateFromState(state);
    });
    this.unsubChat = this.gameClient.onChat((msg) => {
      // Add to unified timeline (dedupe by id)
      const isNew = !this.chatMessages.some(m => m.id === msg.id);
      if (isNew) {
        this.chatMessages.push(msg);
      }
      if (this.isActive && this.activeTab === 'chat') {
        if (isNew) this.appendChatMessage(msg);
      } else {
        this.hasUnread = true;
      }
    });
    this.unsubChatHistory = this.gameClient.onChatHistory((_type, _id, messages) => {
      // Merge into unified timeline (dedupe by id)
      const existing = new Set(this.chatMessages.map(m => m.id));
      for (const msg of messages) {
        if (!existing.has(msg.id)) {
          this.chatMessages.push(msg);
        }
      }
      this.chatMessages.sort((a, b) => a.timestamp - b.timestamp);
      if (this.isActive && this.activeTab === 'chat') {
        // Skip re-render if user is typing in chat input
        const active = document.activeElement;
        if (active && active instanceof HTMLInputElement && this.panelContainer.contains(active)) {
          return;
        }
        this.renderChatPanel();
      }
    });
    const state = this.gameClient.lastState;
    if (state) this.updateFromState(state);
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubChat?.();
    this.unsubChat = undefined;
    this.unsubChatHistory?.();
    this.unsubChatHistory = undefined;
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="social-content">
        <div class="social-tab-bar"></div>
        <div class="social-panel"></div>
      </div>
    `;
    this.tabBar = this.container.querySelector('.social-tab-bar')!;
    this.panelContainer = this.container.querySelector('.social-panel')!;
    this.wireDelegatedClicks();
    this.renderTabBar();
  }

  /** Single delegated click handler on panelContainer — survives innerHTML replacements. */
  private wireDelegatedClicks(): void {
    this.panelContainer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('button');
      if (!btn) return;

      const username = btn.getAttribute('data-username')
        || btn.closest('.social-user-row')?.getAttribute('data-username')
        || null;
      const partyId = btn.getAttribute('data-party-id') || null;

      // Party actions
      if (btn.matches('.social-promote-btn') && username) { this.gameClient.sendPromotePartyLeader(username); return; }
      if (btn.matches('.social-demote-btn') && username) { this.gameClient.sendDemotePartyMember(username); return; }
      if (btn.matches('.social-transfer-btn') && username) { this.gameClient.sendTransferPartyOwnership(username); return; }
      if (btn.matches('.social-kick-btn') && username) { this.gameClient.sendKickPartyMember(username); return; }
      if (btn.matches('.social-party-leave-btn')) { this.gameClient.sendLeaveParty(); return; }
      if (btn.matches('.social-accept-invite') && partyId) { this.gameClient.sendAcceptPartyInvite(partyId); return; }
      if (btn.matches('.social-decline-invite') && partyId) { this.gameClient.sendDeclinePartyInvite(partyId); return; }
      if (btn.matches('.social-nearby-invite') && username) {
        this.gameClient.sendInviteParty(username);
        btn.textContent = 'Invited';
        (btn as HTMLButtonElement).disabled = true;
        return;
      }

      // Friend actions
      if (btn.matches('.social-accept-friend') && username) { this.gameClient.sendAcceptFriendRequest(username); return; }
      if (btn.matches('.social-decline-friend') && username) { this.gameClient.sendDeclineFriendRequest(username); return; }
      if (btn.matches('.social-revoke-friend') && username) { this.gameClient.sendRevokeFriendRequest(username); return; }
      if (btn.matches('.remove-friend-btn') && username) { this.gameClient.sendRemoveFriend(username); return; }

      // Guild actions
      if (btn.matches('.social-guild-leave-btn')) { this.gameClient.sendLeaveGuild(); return; }

      // Guild invite button
      if (btn.matches('.social-guild-invite-btn')) {
        const input = this.panelContainer.querySelector('.social-guild-invite-input') as HTMLInputElement | null;
        const name = input?.value.trim();
        if (name) { this.gameClient.sendInviteGuild(name); input!.value = ''; }
        return;
      }
      if (btn.matches('.social-guild-create-btn')) {
        const input = this.panelContainer.querySelector('.social-guild-name-input') as HTMLInputElement | null;
        const name = input?.value.trim();
        if (name) this.gameClient.sendCreateGuild(name);
        return;
      }

      // Users panel data-action buttons
      const action = btn.getAttribute('data-action');
      if (action && username) {
        switch (action) {
          case 'chat': this.startDm(username); break;
          case 'send_friend_request': this.gameClient.sendFriendRequest(username); break;
          case 'accept_friend_request': this.gameClient.sendAcceptFriendRequest(username); break;
          case 'decline_friend_request': this.gameClient.sendDeclineFriendRequest(username); break;
          case 'revoke_friend_request': this.gameClient.sendRevokeFriendRequest(username); break;
          case 'remove_friend': this.gameClient.sendRemoveFriend(username); break;
          case 'block': this.gameClient.sendBlockUser(username, 'all'); break;
          case 'unblock': this.gameClient.sendUnblockUser(username); break;
        }
        return;
      }

      // Chat (just the DM shortcut; chat input wiring stays in renderChatPanel)
      if (btn.matches('.social-chat-user-btn') && username) { this.startDm(username); return; }
    });

    // Grid cell clicks for party position
    this.panelContainer.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest('.social-party-cell:not(.occupied)');
      if (!cell) return;
      const pos = parseInt(cell.getAttribute('data-pos')!, 10);
      this.gameClient.sendSetPartyGridPosition(pos);
    });
  }

  private renderTabBar(): void {
    this.tabBar.innerHTML = SUB_TABS.map(t => {
      const chatUnread = t.id === 'chat' && this.hasUnread && this.activeTab !== 'chat';
      const partyInvites = t.id === 'party' && (this.lastSocial?.pendingInvites?.length ?? 0) > 0;
      const friendRequests = t.id === 'friends' && (this.lastSocial?.incomingFriendRequests?.length ?? 0) > 0;
      const hasBadge = chatUnread || partyInvites || friendRequests;
      return `<button class="social-tab-btn${t.id === this.activeTab ? ' active' : ''}" data-tab="${t.id}">${t.label}${hasBadge ? '<span class="social-tab-badge"></span>' : ''}</button>`;
    }).join('');

    for (const btn of this.tabBar.querySelectorAll('.social-tab-btn')) {
      btn.addEventListener('click', () => {
        this.activeTab = btn.getAttribute('data-tab') as SubTab;
        sessionStorage.setItem('socialSubTab', this.activeTab);
        if (this.activeTab === 'chat') this.hasUnread = false;
        this.renderTabBar();
        this.renderPanel();
      });
    }
  }

  private updateFromState(state: ServerStateMessage): void {
    this.lastSocial = state.social ?? null;
    this.lastState = state;
    // Initialize chat preferences from server on first state received
    if (!this.chatPrefsInitialized && state.social?.chatPreferences) {
      this.chatSendChannel = state.social.chatPreferences.sendChannel;
      this.chatDmTarget = state.social.chatPreferences.dmTarget;
      this.chatPrefsInitialized = true;
    }
    // Skip re-render if user is interacting with an input or select (state updates would steal focus / close dropdowns)
    const active = document.activeElement;
    if (active && (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) && this.panelContainer.contains(active)) {
      return;
    }
    this.renderTabBar();
    this.renderPanel();
  }

  private renderPanel(): void {
    // Chat needs overflow hidden so flex layout pins input bar to bottom
    this.panelContainer.classList.toggle('chat-active', this.activeTab === 'chat');
    switch (this.activeTab) {
      case 'users': this.renderUsersPanel(); break;
      case 'friends': this.renderFriendsPanel(); break;
      case 'guild': this.renderGuildPanel(); break;
      case 'party': this.renderPartyPanel(); break;
      case 'chat': this.renderChatPanel(); break;
    }
  }

  // ── Users Panel ──────────────────────────────────────────────

  private renderUsersPanel(): void {
    const social = this.lastSocial;
    if (!social) {
      this.panelContainer.innerHTML = '<div class="social-placeholder">Loading...</div>';
      return;
    }

    const onlineSet = new Set(social.onlinePlayers ?? []);
    const friends = new Set(social.friends ?? []);
    const blocked = social.blockedUsers ?? {};
    const selfUsername = this.lastState?.username ?? '';
    const incomingFrom = new Set((social.incomingFriendRequests ?? []).map(r => r.fromUsername));
    const outgoingTo = new Set((social.outgoingFriendRequests ?? []).map(r => r.toUsername));

    // Full player list from all registered accounts (excludes self)
    const allPlayerSet = new Set(social.allPlayers ?? []);
    allPlayerSet.delete(selfUsername);

    // Build filter sets
    const guildMembers = new Set((social.guildMembers ?? []).map(m => m.username));
    const partyMembers = new Set((social.party?.members ?? []).map(m => m.username));
    const otherPlayers = this.lastState?.otherPlayers ?? [];
    const myCol = this.lastState?.party.col;
    const myRow = this.lastState?.party.row;
    const myZone = this.lastState?.zoneName ?? '';
    const roomPlayers = new Set(otherPlayers.filter(p => p.col === myCol && p.row === myRow).map(p => p.username));
    const zonePlayers = new Set(otherPlayers.filter(p => p.zone === myZone).map(p => p.username));

    // Filter
    let players = [...allPlayerSet];
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      players = players.filter(p => p.toLowerCase().includes(q));
    }
    switch (this.filterBy) {
      case 'friends': players = players.filter(p => friends.has(p)); break;
      case 'guild': players = players.filter(p => guildMembers.has(p)); break;
      case 'party': players = players.filter(p => partyMembers.has(p)); break;
      case 'room': players = players.filter(p => roomPlayers.has(p)); break;
      case 'zone': players = players.filter(p => zonePlayers.has(p)); break;
    }

    // Sort
    if (this.sortBy === 'name') {
      players.sort((a, b) => a.localeCompare(b));
    } else {
      // Online first, then friends, then alphabetical
      players.sort((a, b) => {
        const ao = onlineSet.has(a) ? 0 : 1;
        const bo = onlineSet.has(b) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        const af = friends.has(a) ? 0 : 1;
        const bf = friends.has(b) ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.localeCompare(b);
      });
    }

    const filters: { id: string; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'room', label: 'Room' },
      { id: 'zone', label: 'Zone' },
      { id: 'friends', label: 'Friends' },
      { id: 'guild', label: 'Guild' },
      { id: 'party', label: 'Party' },
    ];

    this.panelContainer.innerHTML = `
      <div class="social-users-toolbar">
        <input class="social-search" type="text" placeholder="Search..." value="${this.escapeHtml(this.searchQuery)}" />
        <div class="social-toolbar-btns">
          ${filters.map(f => `<button class="social-filter-btn${this.filterBy === f.id ? ' active' : ''}" data-filter="${f.id}">${f.label}</button>`).join('')}
          <button class="social-sort-btn" title="Sort">${this.sortBy === 'name' ? '\u25B2 A-Z' : '\u25BC Status'}</button>
        </div>
      </div>
      <div class="social-user-count">${players.length} player${players.length !== 1 ? 's' : ''}</div>
      <div class="social-user-list">
        ${players.length === 0 ? '<div class="social-empty">No players found</div>' : (() => {
          if (this.sortBy === 'status') {
            const onlinePlayers = players.filter(p => onlineSet.has(p));
            const offlinePlayers = players.filter(p => !onlineSet.has(p));
            return `
              <div class="social-group-header">Online (${onlinePlayers.length})</div>
              ${onlinePlayers.length === 0
                ? '<div class="social-empty">No online users</div>'
                : onlinePlayers.map(p => this.renderUserRow(p, friends, blocked, onlineSet, incomingFrom, outgoingTo)).join('')}
              <div class="social-group-header">Offline (${offlinePlayers.length})</div>
              ${offlinePlayers.length === 0
                ? '<div class="social-empty">No offline users</div>'
                : offlinePlayers.map(p => this.renderUserRow(p, friends, blocked, onlineSet, incomingFrom, outgoingTo)).join('')}
            `;
          }
          return players.map(p => this.renderUserRow(p, friends, blocked, onlineSet, incomingFrom, outgoingTo)).join('');
        })()}
      </div>
    `;

    // Wire search
    this.searchInput = this.panelContainer.querySelector('.social-search')!;
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value;
      this.renderUsersPanel();
    });

    // Wire filter buttons
    for (const btn of this.panelContainer.querySelectorAll('.social-filter-btn')) {
      btn.addEventListener('click', () => {
        this.filterBy = btn.getAttribute('data-filter') as typeof this.filterBy;
        this.renderUsersPanel();
      });
    }

    // Wire sort button
    const sortBtn = this.panelContainer.querySelector('.social-sort-btn');
    sortBtn?.addEventListener('click', () => {
      this.sortBy = this.sortBy === 'name' ? 'status' : 'name';
      this.renderUsersPanel();
    });

    // Action buttons (chat, friend, block) are handled by delegated click handler
  }

  private renderUserRow(p: string, friends: Set<string>, blocked: Record<string, unknown>, onlineSet: Set<string>, incomingFrom: Set<string>, outgoingTo: Set<string>): string {
    const isFriend = friends.has(p);
    const isBlocked = p in blocked;
    const isOnline = onlineSet.has(p);
    const hasIncoming = incomingFrom.has(p);
    const hasSentTo = outgoingTo.has(p);

    let friendBtn = '';
    if (isFriend) {
      friendBtn = `<button class="social-action-btn remove-friend" data-action="remove_friend">Unfriend</button>`;
    } else if (hasIncoming) {
      friendBtn = `<button class="social-action-btn add-friend" data-action="accept_friend_request">Accept</button>`
        + `<button class="social-action-btn remove-friend" data-action="decline_friend_request">Decline</button>`;
    } else if (hasSentTo) {
      friendBtn = `<button class="social-action-btn remove-friend" data-action="revoke_friend_request">Revoke</button>`;
    } else {
      friendBtn = `<button class="social-action-btn add-friend" data-action="send_friend_request">Add</button>`;
    }

    let statusBadge = '';
    if (isFriend) statusBadge = '<span class="social-badge friend">Friend</span>';
    else if (hasIncoming) statusBadge = '<span class="social-badge friend">Request</span>';
    else if (hasSentTo) statusBadge = '<span class="social-badge">Pending</span>';

    return `<div class="social-user-row" data-username="${this.escapeHtml(p)}">
      <span class="social-status-dot ${isOnline ? 'online' : 'offline'}"></span>
      <span class="social-user-name">${this.escapeHtml(p)}</span>
      <span class="social-user-badges">
        ${statusBadge}
        ${isBlocked ? '<span class="social-badge blocked">Blocked</span>' : ''}
      </span>
      <div class="social-user-actions">
        <button class="social-action-btn social-chat-user-btn" data-action="chat">Chat</button>
        ${friendBtn}
        ${isBlocked
          ? `<button class="social-action-btn unblock" data-action="unblock">Unblock</button>`
          : `<button class="social-action-btn block" data-action="block">Block</button>`
        }
      </div>
    </div>`;
  }

  // ── Friends Panel ────────────────────────────────────────────

  private renderFriendsPanel(): void {
    const social = this.lastSocial;
    if (!social) {
      this.panelContainer.innerHTML = '<div class="social-placeholder">Loading...</div>';
      return;
    }

    const friends = social.friends ?? [];
    const onlineSet = new Set(social.onlinePlayers ?? []);
    const incoming = social.incomingFriendRequests ?? [];
    const outgoing = social.outgoingFriendRequests ?? [];

    const online = friends.filter(f => onlineSet.has(f)).sort();
    const offline = friends.filter(f => !onlineSet.has(f)).sort();
    const hasContent = incoming.length > 0 || friends.length > 0 || outgoing.length > 0;

    this.panelContainer.innerHTML = `
      <div class="social-friends-list">
        ${!hasContent
          ? '<div class="social-empty">No friends yet. Add friends from the Users tab!</div>'
          : `
            ${incoming.length > 0 ? `
              <div class="social-group-header">Friend Requests (${incoming.length})</div>
              ${incoming.map(r => `
                <div class="social-user-row" data-username="${this.escapeHtml(r.fromUsername)}">
                  <span class="social-status-dot ${onlineSet.has(r.fromUsername) ? 'online' : 'offline'}"></span>
                  <span class="social-user-name">${this.escapeHtml(r.fromUsername)}</span>
                  <div class="social-user-actions">
                    <button class="social-action-btn add-friend social-accept-friend" data-username="${this.escapeHtml(r.fromUsername)}">Accept</button>
                    <button class="social-action-btn remove-friend social-decline-friend" data-username="${this.escapeHtml(r.fromUsername)}">Decline</button>
                  </div>
                </div>
              `).join('')}
            ` : ''}
            ${online.length > 0 ? `
              <div class="social-group-header">Online (${online.length})</div>
              ${online.map(f => this.renderFriendRow(f, true)).join('')}
            ` : ''}
            ${offline.length > 0 ? `
              <div class="social-group-header">Offline (${offline.length})</div>
              ${offline.map(f => this.renderFriendRow(f, false)).join('')}
            ` : ''}
            ${outgoing.length > 0 ? `
              <div class="social-group-header">Pending Sent (${outgoing.length})</div>
              ${outgoing.map(r => `
                <div class="social-user-row" data-username="${this.escapeHtml(r.toUsername)}">
                  <span class="social-status-dot ${onlineSet.has(r.toUsername) ? 'online' : 'offline'}"></span>
                  <span class="social-user-name">${this.escapeHtml(r.toUsername)}</span>
                  <div class="social-user-actions">
                    <button class="social-action-btn remove-friend social-revoke-friend" data-username="${this.escapeHtml(r.toUsername)}">Revoke</button>
                  </div>
                </div>
              `).join('')}
            ` : ''}
          `
        }
      </div>
    `;

    // Action buttons (accept, decline, revoke, remove, chat) handled by delegated click handler
  }

  private renderFriendRow(username: string, isOnline: boolean): string {
    return `<div class="social-user-row" data-username="${this.escapeHtml(username)}">
      <span class="social-status-dot ${isOnline ? 'online' : 'offline'}"></span>
      <span class="social-user-name">${this.escapeHtml(username)}</span>
      <div class="social-user-actions">
        <button class="social-action-btn social-chat-user-btn" data-action="chat">Chat</button>
        <button class="social-action-btn remove-friend remove-friend-btn" data-action="remove_friend">Remove</button>
      </div>
    </div>`;
  }

  // ── Guild Panel ──────────────────────────────────────────────

  private renderGuildPanel(): void {
    const social = this.lastSocial;
    if (!social) {
      this.panelContainer.innerHTML = '<div class="social-placeholder">Loading...</div>';
      return;
    }

    const guild = social.guild;
    const members = social.guildMembers ?? [];

    if (!guild) {
      // No guild — show create form
      this.panelContainer.innerHTML = `
        <div class="social-guild-create">
          <div class="social-empty">You are not in a guild.</div>
          <div class="social-guild-form">
            <input class="social-search social-guild-name-input" type="text" placeholder="Guild name..." maxlength="20" />
            <button class="social-action-btn add-friend social-guild-create-btn">Create Guild</button>
          </div>
          <div class="social-guild-note">Requires level 20+</div>
        </div>
      `;

      // Create button handled by delegated click handler
      return;
    }

    // In a guild — show info + members
    const onlineSet = new Set(social.onlinePlayers ?? []);

    this.panelContainer.innerHTML = `
      <div class="social-guild-info">
        <div class="social-guild-header">
          <span class="social-guild-name">${this.escapeHtml(guild.name)}</span>
          <button class="social-action-btn remove-friend social-guild-leave-btn">Leave</button>
        </div>
        <div class="social-guild-leader">Leader: ${this.escapeHtml(guild.leaderUsername)}</div>
      </div>
      <div class="social-group-header">Members (${members.length})</div>
      <div class="social-user-list">
        ${members.map(m => `
          <div class="social-user-row" data-username="${this.escapeHtml(m.username)}">
            <span class="social-status-dot ${onlineSet.has(m.username) ? 'online' : 'offline'}"></span>
            <span class="social-user-name">${this.escapeHtml(m.username)}</span>
            <span class="social-user-badges">
              ${m.role === 'leader' ? '<span class="social-badge friend">Leader</span>' : ''}
            </span>
            <div class="social-user-actions">
              <button class="social-action-btn social-chat-user-btn" data-action="chat">Chat</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="social-guild-invite-form">
        <input class="social-search social-guild-invite-input" type="text" placeholder="Invite player..." />
        <button class="social-action-btn add-friend social-guild-invite-btn">Invite</button>
      </div>
    `;

    // Leave, invite, and chat buttons handled by delegated click handler
  }

  // ── Party Panel ─────────────────────────────────────────────

  private renderPartyPanel(): void {
    const social = this.lastSocial;
    if (!social) {
      this.panelContainer.innerHTML = '<div class="social-placeholder">Loading...</div>';
      return;
    }

    const party = social.party;

    if (!party) {
      this.panelContainer.innerHTML = '<div class="social-placeholder">Loading...</div>';
      return;
    }

    const selfUsername = this.lastState?.username ?? '';
    const selfMember = party.members.find(m => m.username === selfUsername);
    const selfRole = selfMember?.role ?? 'member';
    const isOwner = selfRole === 'owner';
    const isLeaderOrOwner = selfRole === 'owner' || selfRole === 'leader';
    const isSolo = party.members.length === 1;
    const onlineSet = new Set(social.onlinePlayers ?? []);
    const memberMap = new Map(party.members.map(m => [m.gridPosition, m]));
    const partyMembers = new Set(party.members.map(m => m.username));

    // Pending invites for this player
    const pendingInvites = social.pendingInvites ?? [];
    const invitesHtml = pendingInvites.length > 0 ? `
      <div class="social-group-header">Party Invites</div>
      <div class="social-user-list">
        ${pendingInvites.map(inv => `
          <div class="social-user-row" data-party-id="${this.escapeHtml(inv.partyId)}">
            <span class="social-user-name">${this.escapeHtml(inv.inviterUsername)}'s party</span>
            <div class="social-user-actions">
              <button class="social-action-btn add-friend social-accept-invite" data-party-id="${this.escapeHtml(inv.partyId)}">Accept</button>
              <button class="social-action-btn remove-friend social-decline-invite" data-party-id="${this.escapeHtml(inv.partyId)}">Decline</button>
            </div>
          </div>
        `).join('')}
      </div>
    ` : '';

    // Same-tile players (not already in our party)
    const sameTilePlayers = (this.lastState?.otherPlayers ?? [])
      .filter(p => p.col === this.lastState?.party.col && p.row === this.lastState?.party.row)
      .filter(p => !partyMembers.has(p.username))
      .map(p => p.username)
      .sort();
    const outgoingInvites = new Set(social.outgoingPartyInvites ?? []);

    const nearbyHtml = isLeaderOrOwner ? `
      <div class="social-group-header">Nearby Players</div>
      <div class="social-user-list">
        ${sameTilePlayers.length === 0
          ? '<div class="social-empty">No other players in this room</div>'
          : sameTilePlayers.map(p => {
            const alreadyInvited = outgoingInvites.has(p);
            return `
            <div class="social-user-row" data-username="${this.escapeHtml(p)}">
              <span class="social-status-dot online"></span>
              <span class="social-user-name">${this.escapeHtml(p)}</span>
              <div class="social-user-actions">
                <button class="social-action-btn add-friend social-nearby-invite" data-username="${this.escapeHtml(p)}"${alreadyInvited ? ' disabled' : ''}>${alreadyInvited ? 'Invited' : 'Invite'}</button>
              </div>
            </div>
          `;}).join('')}
      </div>
    ` : '';

    // Render 3x3 grid
    let gridHtml = '<div class="social-party-grid">';
    for (let i = 0; i < 9; i++) {
      const member = memberMap.get(i as any);
      const row = Math.floor(i / 3);
      const rowLabel = row === 0 ? 'Front' : row === 1 ? 'Mid' : 'Back';
      gridHtml += `<div class="social-party-cell${member ? ' occupied' : ''}" data-pos="${i}" title="${rowLabel} row">`;
      if (member) {
        const isOnline = onlineSet.has(member.username);
        gridHtml += `<span class="social-status-dot ${isOnline ? 'online' : 'offline'}"></span>`;
        gridHtml += `<span class="social-party-cell-name">${this.escapeHtml(member.username)}</span>`;
        const roleBadge = member.role === 'owner' ? 'O' : member.role === 'leader' ? 'L' : '';
        const badgeClass = member.role === 'owner' ? 'owner' : 'friend';
        if (roleBadge) {
          gridHtml += `<span class="social-badge ${badgeClass}">${roleBadge}</span>`;
        }
      } else {
        gridHtml += '<span class="social-party-cell-empty">Empty</span>';
      }
      gridHtml += '</div>';
    }
    gridHtml += '</div>';

    // Build member action buttons based on viewer's role
    const renderMemberActions = (m: { username: string; role: string }): string => {
      if (m.username === selfUsername) return '';
      const actions: string[] = [];
      actions.push(`<button class="social-action-btn social-chat-user-btn" data-action="chat">Chat</button>`);

      if (isOwner) {
        if (m.role === 'member') {
          actions.push(`<button class="social-action-btn add-friend social-promote-btn" data-username="${this.escapeHtml(m.username)}">Promote</button>`);
        }
        if (m.role === 'leader') {
          actions.push(`<button class="social-action-btn remove-friend social-demote-btn" data-username="${this.escapeHtml(m.username)}">Demote</button>`);
        }
        actions.push(`<button class="social-action-btn add-friend social-transfer-btn" data-username="${this.escapeHtml(m.username)}">Transfer</button>`);
        actions.push(`<button class="social-action-btn remove-friend social-kick-btn" data-username="${this.escapeHtml(m.username)}">Kick</button>`);
      } else if (selfRole === 'leader') {
        if (m.role === 'member') {
          actions.push(`<button class="social-action-btn add-friend social-promote-btn" data-username="${this.escapeHtml(m.username)}">Promote</button>`);
        }
        if (m.role !== 'owner') {
          actions.push(`<button class="social-action-btn remove-friend social-kick-btn" data-username="${this.escapeHtml(m.username)}">Kick</button>`);
        }
      }

      return actions.join('');
    };

    this.panelContainer.innerHTML = `
      ${invitesHtml}
      ${isSolo ? '<div class="social-empty">You\'re all alone. Invite someone to your party!</div>' : ''}
      ${gridHtml}
      ${!isSolo ? `
        <div class="social-party-actions">
          <button class="social-action-btn remove-friend social-party-leave-btn">Leave Party</button>
        </div>
      ` : ''}
      <div class="social-group-header">Members (${party.members.length}/${MAX_PARTY_SIZE})</div>
      <div class="social-user-list">
        ${party.members.map(m => `
          <div class="social-user-row" data-username="${this.escapeHtml(m.username)}">
            <span class="social-status-dot ${onlineSet.has(m.username) ? 'online' : 'offline'}"></span>
            <span class="social-user-name">${this.escapeHtml(m.username)}</span>
            <span class="social-user-badges">
              ${m.role === 'owner' ? '<span class="social-badge owner">Owner</span>' : ''}
              ${m.role === 'leader' ? '<span class="social-badge friend">Leader</span>' : ''}
            </span>
            <div class="social-user-actions">
              ${renderMemberActions(m)}
            </div>
          </div>
        `).join('')}
      </div>
      ${nearbyHtml}
    `;

    // All party buttons (leave, accept/decline invite, nearby invite, promote, demote,
    // transfer, kick, chat, grid position) handled by delegated click handler
  }

  // ── Chat Panel ───────────────────────────────────────────────

  private static readonly CHAT_CHANNELS: { type: ChatChannelType; tag: string; label: string }[] = [
    { type: 'tile', tag: 'R', label: 'Room' },
    { type: 'zone', tag: 'Z', label: 'Zone' },
    { type: 'party', tag: 'P', label: 'Party' },
    { type: 'guild', tag: 'G', label: 'Guild' },
    { type: 'global', tag: 'W', label: 'World' },
    { type: 'dm', tag: 'DM', label: 'DM' },
  ];

  /** Resolve the channel ID for a given channel type from current game state. */
  private resolveChatChannelId(type: ChatChannelType): string {
    const state = this.gameClient.lastState;
    const social = this.lastSocial;
    switch (type) {
      case 'tile': return state ? `${state.party.col},${state.party.row}` : '';
      case 'zone': return state?.zoneName ?? '';
      case 'party': return social?.party?.id ?? '';
      case 'guild': return social?.guild?.id ?? '';
      case 'global': return 'global';
      case 'dm': return this.chatDmTarget;
    }
  }

  /** Switch to chat tab with DM pre-selected for a user. */
  startDm(username: string): void {
    this.chatSendChannel = 'dm';
    this.chatDmTarget = username;
    this.activeTab = 'chat';
    this.loadChatHistory('dm', username);
    this.renderTabBar();
    this.renderPanel();
  }

  /** Request chat history for a channel if not already loaded. */
  private loadChatHistory(type: ChatChannelType, id: string): void {
    if (!id && type !== 'dm') return;
    const key = `${type}:${id || '_all'}`;
    if (this.chatHistoryLoaded.has(key)) return;
    this.chatHistoryLoaded.add(key);
    this.gameClient.sendRequestChatHistory(type, id);
  }

  /** Load history for all enabled filter channels. */
  private loadAllChatHistory(): void {
    for (const ch of SocialScreen.CHAT_CHANNELS) {
      if (this.chatFilters.has(ch.type)) {
        const id = this.resolveChatChannelId(ch.type);
        this.loadChatHistory(ch.type, id);
      }
    }
  }

  private renderChatPanel(): void {
    // Load history on first render
    this.loadAllChatHistory();

    // Filter messages by enabled channel types
    const filtered = this.chatMessages.filter(m => this.chatFilters.has(m.channelType));

    // Build send channel options — all shown, some disabled based on context
    const social = this.lastSocial;
    const sendOptions = SocialScreen.CHAT_CHANNELS.map(ch => {
      let disabled = false;
      if (ch.type === 'party') disabled = (social?.party?.members.length ?? 0) <= 1;
      if (ch.type === 'guild') disabled = !social?.guild;
      return { ...ch, disabled };
    });

    // Capture scroll position before re-render
    const oldMsgContainer = this.panelContainer.querySelector('.social-chat-messages');
    const oldScrollTop = oldMsgContainer ? oldMsgContainer.scrollTop : 0;
    const wasAtBottom = !oldMsgContainer || (oldScrollTop + oldMsgContainer.clientHeight >= oldMsgContainer.scrollHeight - 20);

    this.panelContainer.innerHTML = `
      <div class="social-chat-container">
        <div class="social-chat-filters">
          ${SocialScreen.CHAT_CHANNELS.map(ch => `
            <button class="chat-filter-btn chat-color-${ch.type}${this.chatFilters.has(ch.type) ? ' active' : ''}"
              data-channel="${ch.type}">${ch.label}</button>
          `).join('')}
        </div>
        <div class="social-chat-messages">
          ${filtered.length === 0
            ? '<div class="social-empty">No messages yet</div>'
            : filtered.map(m => {
              const ch = SocialScreen.CHAT_CHANNELS.find(c => c.type === m.channelType);
              const tag = ch?.tag ?? '?';
              const selfName = this.lastState?.username ?? '';
              // For DMs sent by the current user, show "to: recipient"
              const dmTo = (m.channelType === 'dm' && m.senderUsername === selfName)
                ? ` <span class="chat-dm-to">to ${this.escapeHtml(m.channelId)}</span>` : '';
              return `<div class="social-chat-msg">
                <span class="chat-tag chat-color-${m.channelType}">[${tag}]</span>
                <span class="social-chat-sender chat-color-${m.channelType}">${this.escapeHtml(m.senderUsername)}${dmTo}</span>
                <span class="social-chat-text">${this.escapeHtml(m.text)}</span>
              </div>`;
            }).join('')
          }
        </div>
        <div class="social-chat-input-bar">
          <select class="chat-send-select">
            ${sendOptions.map(ch => `<option value="${ch.type}"${ch.type === this.chatSendChannel ? ' selected' : ''}${ch.disabled ? ' disabled' : ''}>${ch.label}</option>`).join('')}
          </select>
          <div class="chat-dm-wrapper${this.chatSendChannel === 'dm' ? '' : ' hidden'}">
            <input class="social-search chat-dm-input" type="text"
              placeholder="To..." value="${this.escapeHtml(this.chatDmTarget)}" autocomplete="off" />
            <div class="chat-dm-suggestions"></div>
          </div>
          <input class="social-search social-chat-input" type="text" placeholder="Type a message..." maxlength="500" />
          <button class="social-action-btn add-friend social-chat-send-btn">Send</button>
        </div>
      </div>
    `;

    // Restore scroll position: auto-scroll to bottom if user was there, otherwise preserve position
    const msgContainer = this.panelContainer.querySelector('.social-chat-messages');
    if (msgContainer) {
      if (wasAtBottom) {
        msgContainer.scrollTop = msgContainer.scrollHeight;
      } else {
        msgContainer.scrollTop = oldScrollTop;
      }
    }

    // Wire filter toggles
    for (const btn of this.panelContainer.querySelectorAll('.chat-filter-btn')) {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-channel') as ChatChannelType;
        if (this.chatFilters.has(type)) {
          this.chatFilters.delete(type);
        } else {
          this.chatFilters.add(type);
          // Load history for newly enabled channel
          const id = this.resolveChatChannelId(type);
          this.loadChatHistory(type, id);
        }
        this.renderChatPanel();
      });
    }

    // Wire channel selector
    const selectEl = this.panelContainer.querySelector('.chat-send-select') as HTMLSelectElement;
    const dmWrapper = this.panelContainer.querySelector('.chat-dm-wrapper') as HTMLElement;
    const dmInput = this.panelContainer.querySelector('.chat-dm-input') as HTMLInputElement;
    const dmSuggestions = this.panelContainer.querySelector('.chat-dm-suggestions') as HTMLElement;
    const chatInput = this.panelContainer.querySelector('.social-chat-input') as HTMLInputElement;
    const sendBtn = this.panelContainer.querySelector('.social-chat-send-btn') as HTMLButtonElement;

    // All known player names for autocomplete
    const allPlayerNames = social?.allPlayers ?? [];
    const selfUsername = this.lastState?.username ?? '';

    // DM validation helper
    const isDmValid = () => {
      if (this.chatSendChannel !== 'dm') return true;
      const target = this.chatDmTarget.toLowerCase();
      return target.length > 0 && allPlayerNames.some(p => p.toLowerCase() === target) && target !== selfUsername.toLowerCase();
    };

    // Update disabled state of message input and send button
    const updateDmState = () => {
      const valid = isDmValid();
      if (this.chatSendChannel === 'dm') {
        chatInput.disabled = !valid;
        sendBtn.disabled = !valid;
        chatInput.placeholder = valid ? 'Type a message...' : 'Enter a valid recipient first';
        dmInput.classList.toggle('dm-valid', valid && this.chatDmTarget.length > 0);
        dmInput.classList.toggle('dm-invalid', !valid && this.chatDmTarget.length > 0);
      } else {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.placeholder = 'Type a message...';
      }
    };

    selectEl.addEventListener('change', () => {
      this.chatSendChannel = selectEl.value as ChatChannelType;
      if (this.chatSendChannel === 'dm') {
        dmWrapper.classList.remove('hidden');
        dmInput.focus();
      } else {
        dmWrapper.classList.add('hidden');
        dmSuggestions.innerHTML = '';
      }
      updateDmState();
      this.gameClient.sendSetChatPreferences(this.chatSendChannel, this.chatDmTarget);
    });

    // Wire DM autocomplete
    dmInput.addEventListener('input', () => {
      this.chatDmTarget = dmInput.value.trim();
      const q = this.chatDmTarget.toLowerCase();
      if (q.length === 0) {
        dmSuggestions.innerHTML = '';
        updateDmState();
        return;
      }
      const matches = allPlayerNames
        .filter(p => p.toLowerCase().includes(q) && p.toLowerCase() !== selfUsername.toLowerCase())
        .slice(0, 5);
      if (matches.length > 0 && !matches.some(m => m.toLowerCase() === q)) {
        dmSuggestions.innerHTML = matches.map(m =>
          `<div class="chat-dm-suggestion" data-username="${this.escapeHtml(m)}">${this.escapeHtml(m)}</div>`
        ).join('');
      } else {
        dmSuggestions.innerHTML = '';
      }
      updateDmState();
    });

    // Wire suggestion clicks
    dmSuggestions.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.chat-dm-suggestion');
      if (target) {
        const username = target.getAttribute('data-username')!;
        this.chatDmTarget = username;
        dmInput.value = username;
        dmSuggestions.innerHTML = '';
        updateDmState();
        chatInput.focus();
        this.loadChatHistory('dm', username);
        this.gameClient.sendSetChatPreferences(this.chatSendChannel, this.chatDmTarget);
      }
    });

    // Close suggestions on blur (with delay so click registers)
    dmInput.addEventListener('blur', () => {
      setTimeout(() => { dmSuggestions.innerHTML = ''; }, 150);
    });

    // Initialize disabled state
    updateDmState();

    // Wire send
    const doSend = () => {
      if (chatInput.disabled || sendBtn.disabled) return;
      const text = chatInput.value.trim();
      if (!text) return;
      const channelId = this.resolveChatChannelId(this.chatSendChannel);
      if (!channelId) return;
      this.gameClient.sendChat(this.chatSendChannel, channelId, text);
      chatInput.value = '';
      this.chatFocusAfterRender = true;
      chatInput.focus();
    };

    sendBtn.addEventListener('click', doSend);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSend();
    });

    // Restore focus to message input after re-render (e.g. after sending)
    if (this.chatFocusAfterRender) {
      this.chatFocusAfterRender = false;
      chatInput.focus();
    }
  }

  /** Append a single chat message to the existing DOM without full re-render. */
  private appendChatMessage(msg: ChatMessage): void {
    if (!this.chatFilters.has(msg.channelType)) return;

    const msgContainer = this.panelContainer.querySelector('.social-chat-messages');
    if (!msgContainer) return;

    // Remove "No messages yet" placeholder if present
    const emptyEl = msgContainer.querySelector('.social-empty');
    if (emptyEl) emptyEl.remove();

    // Check if user was scrolled to bottom before appending
    const wasAtBottom = msgContainer.scrollTop + msgContainer.clientHeight >= msgContainer.scrollHeight - 20;

    const ch = SocialScreen.CHAT_CHANNELS.find(c => c.type === msg.channelType);
    const tag = ch?.tag ?? '?';
    const selfName = this.lastState?.username ?? '';
    const dmTo = (msg.channelType === 'dm' && msg.senderUsername === selfName)
      ? ` <span class="chat-dm-to">to ${this.escapeHtml(msg.channelId)}</span>` : '';

    const div = document.createElement('div');
    div.className = 'social-chat-msg';
    div.innerHTML = `
      <span class="chat-tag chat-color-${msg.channelType}">[${tag}]</span>
      <span class="social-chat-sender chat-color-${msg.channelType}">${this.escapeHtml(msg.senderUsername)}${dmTo}</span>
      <span class="social-chat-text">${this.escapeHtml(msg.text)}</span>
    `;
    msgContainer.appendChild(div);

    if (wasAtBottom) {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
