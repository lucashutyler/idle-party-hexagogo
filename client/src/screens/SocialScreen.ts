import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, ClientSocialState, ChatMessage, ChatChannelType, PlayerListEntry } from '@idle-party-rpg/shared';
import { MAX_PARTY_SIZE, CLASS_ICONS, UNKNOWN_CLASS_ICON } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

type SubTab = 'users' | 'guild' | 'party' | 'chat';

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'guild', label: 'Guild' },
  { id: 'party', label: 'Party' },
  { id: 'chat', label: 'Chat' },
];

export class SocialScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;
  private activeTab: SubTab = (() => {
    const stored = sessionStorage.getItem('socialSubTab');
    return stored && SUB_TABS.some(t => t.id === stored) ? stored as SubTab : 'users';
  })();
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
  private filterBy: 'all' | 'friends' | 'guild' | 'room' | 'zone' = 'all';

  // Chat state — unified timeline
  private chatMessages: ChatMessage[] = [];
  private chatFilters = new Set<ChatChannelType>(['tile', 'zone', 'party', 'guild', 'dm', 'global'] as ChatChannelType[]);
  private chatSendChannel: ChatChannelType = 'zone';
  private chatDmTarget = '';
  private hasUnread = false;
  private chatHistoryLoaded = new Set<string>();
  private chatFocusAfterRender = false;
  private chatPrefsInitialized = false;

  // User popup
  private popupOverlay: HTMLElement | null = null;

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
        this.renderChatMessages();
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
    this.dismissPopup();
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

      // Username click → show popup (anywhere a .social-user-name or .social-chat-sender appears)
      const nameEl = target.closest('.social-user-name-clickable') as HTMLElement | null;
      if (nameEl) {
        const username = nameEl.getAttribute('data-username')
          || nameEl.closest('[data-username]')?.getAttribute('data-username');
        if (username && username !== this.lastState?.username) {
          this.showUserPopup(username, nameEl);
          return;
        }
      }

      const btn = target.closest('button') as HTMLButtonElement | null;
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
        btn.disabled = true;
        return;
      }

      // Guild actions
      if (btn.matches('.social-guild-leave-btn')) { this.gameClient.sendLeaveGuild(); return; }
      if (btn.matches('.social-guild-create-btn')) {
        const input = this.panelContainer.querySelector('.social-guild-name-input') as HTMLInputElement | null;
        const name = input?.value.trim();
        if (name) this.gameClient.sendCreateGuild(name);
        return;
      }
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
    const friendRequests = (this.lastSocial?.incomingFriendRequests?.length ?? 0) > 0;
    this.tabBar.innerHTML = SUB_TABS.map(t => {
      const chatUnread = t.id === 'chat' && this.hasUnread && this.activeTab !== 'chat';
      const partyInvites = t.id === 'party' && (this.lastSocial?.pendingInvites?.length ?? 0) > 0;
      const usersBadge = t.id === 'users' && friendRequests;
      const hasBadge = chatUnread || partyInvites || usersBadge;
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
    // Skip full re-render if user is interacting with an input or select — do partial updates instead
    const active = document.activeElement;
    if (active && (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) && this.panelContainer.contains(active)) {
      // Partial update: refresh just the data-driven parts without touching inputs/filters
      this.renderTabBar();
      if (this.activeTab === 'users') {
        this.renderUserRows();
      } else if (this.activeTab === 'chat') {
        this.renderChatMessages();
      }
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
      case 'guild': this.renderGuildPanel(); break;
      case 'party': this.renderPartyPanel(); break;
      case 'chat': this.renderChatPanel(); break;
    }
  }

  // ── Class icon helper ────────────────────────────────────────

  private classIcon(className?: string): string {
    if (!className) return UNKNOWN_CLASS_ICON;
    return CLASS_ICONS[className] ?? UNKNOWN_CLASS_ICON;
  }

  // ── User Popup Menu ──────────────────────────────────────────

  private showUserPopup(username: string, anchor: HTMLElement): void {
    this.dismissPopup();

    const social = this.lastSocial;
    if (!social) return;

    const selfUsername = this.lastState?.username ?? '';
    if (username === selfUsername) return;

    const friends = new Set(social.friends ?? []);
    const blocked = social.blockedUsers ?? {};
    const incomingFrom = new Set((social.incomingFriendRequests ?? []).map(r => r.fromUsername));
    const outgoingTo = new Set((social.outgoingFriendRequests ?? []).map(r => r.toUsername));
    const guildMembers = new Set((social.guildMembers ?? []).map(m => m.username));
    const partyMembers = new Set((social.party?.members ?? []).map(m => m.username));
    const otherPlayers = this.lastState?.otherPlayers ?? [];
    const myCol = this.lastState?.party.col;
    const myRow = this.lastState?.party.row;
    const sameRoom = otherPlayers.some(p => p.username === username && p.col === myCol && p.row === myRow);

    const items: string[] = [];

    // Chat
    items.push(`<button class="user-popup-item" data-popup-action="chat">Chat</button>`);

    // Guild invite
    if (social.guild) {
      if (guildMembers.has(username)) {
        items.push(`<button class="user-popup-item disabled" disabled>In Guild</button>`);
      } else {
        items.push(`<button class="user-popup-item" data-popup-action="guild_invite">Invite to Guild</button>`);
      }
    }

    // Friend
    const isFriend = friends.has(username);
    const isBlocked = username in blocked;
    if (isFriend) {
      items.push(`<button class="user-popup-item disabled" disabled>Friends</button>`);
    } else if (incomingFrom.has(username)) {
      items.push(`<button class="user-popup-item" data-popup-action="accept_friend">Accept Friend</button>`);
      items.push(`<button class="user-popup-item" data-popup-action="decline_friend">Decline Friend</button>`);
    } else if (outgoingTo.has(username)) {
      items.push(`<button class="user-popup-item" data-popup-action="revoke_friend">Revoke Request</button>`);
    } else {
      items.push(`<button class="user-popup-item" data-popup-action="add_friend">Add Friend</button>`);
    }

    // Party invite
    if (partyMembers.has(username)) {
      items.push(`<button class="user-popup-item disabled" disabled>In Party</button>`);
    } else if (!sameRoom) {
      items.push(`<button class="user-popup-item disabled" disabled>Different Room</button>`);
    } else {
      items.push(`<button class="user-popup-item" data-popup-action="party_invite">Invite to Party</button>`);
    }

    // Block
    if (isBlocked) {
      items.push(`<button class="user-popup-item" data-popup-action="unblock">Unblock</button>`);
    } else {
      items.push(`<button class="user-popup-item" data-popup-action="block">Block</button>`);
    }

    // Build popup
    const popup = document.createElement('div');
    popup.className = 'user-popup-menu';
    popup.innerHTML = `
      <div class="user-popup-header">${this.classIcon(this.getPlayerClassName(username))} ${this.escapeHtml(username)}</div>
      ${items.join('')}
    `;

    // Position near anchor
    const rect = anchor.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    popup.style.position = 'absolute';
    popup.style.left = `${rect.left - containerRect.left}px`;
    popup.style.top = `${rect.bottom - containerRect.top + 4}px`;
    popup.style.zIndex = '1000';

    // Wire actions
    popup.addEventListener('click', (e) => {
      const actionBtn = (e.target as HTMLElement).closest('[data-popup-action]');
      if (!actionBtn) return;
      const action = actionBtn.getAttribute('data-popup-action');
      switch (action) {
        case 'chat': this.startDm(username); break;
        case 'guild_invite': this.gameClient.sendInviteGuild(username); break;
        case 'accept_friend': this.gameClient.sendAcceptFriendRequest(username); break;
        case 'decline_friend': this.gameClient.sendDeclineFriendRequest(username); break;
        case 'revoke_friend': this.gameClient.sendRevokeFriendRequest(username); break;
        case 'add_friend': this.gameClient.sendFriendRequest(username); break;
        case 'party_invite': this.gameClient.sendInviteParty(username); break;
        case 'block': this.gameClient.sendBlockUser(username, 'all'); break;
        case 'unblock': this.gameClient.sendUnblockUser(username); break;
      }
      this.dismissPopup();
    });

    // Overlay to dismiss on outside click
    const overlay = document.createElement('div');
    overlay.className = 'user-popup-overlay';
    overlay.addEventListener('click', () => this.dismissPopup());

    this.container.style.position = 'relative';
    this.container.appendChild(overlay);
    this.container.appendChild(popup);
    this.popupOverlay = overlay;

    // Adjust if popup goes off-screen
    requestAnimationFrame(() => {
      const popupRect = popup.getBoundingClientRect();
      if (popupRect.right > window.innerWidth) {
        popup.style.left = `${Math.max(0, rect.right - containerRect.left - popupRect.width)}px`;
      }
      if (popupRect.bottom > window.innerHeight) {
        popup.style.top = `${rect.top - containerRect.top - popupRect.height - 4}px`;
      }
    });
  }

  private dismissPopup(): void {
    if (this.popupOverlay) {
      // Remove both overlay and popup (popup is next sibling)
      const popup = this.popupOverlay.nextElementSibling;
      if (popup?.classList.contains('user-popup-menu')) popup.remove();
      this.popupOverlay.remove();
      this.popupOverlay = null;
    }
  }

  private getPlayerClassName(username: string): string | undefined {
    // Check otherPlayers first (has className)
    const other = this.lastState?.otherPlayers?.find(p => p.username === username);
    if (other?.className) return other.className;
    // Check allPlayers
    const entry = this.lastSocial?.allPlayers?.find(p => p.username === username);
    return entry?.className;
  }

  // ── Users Panel ──────────────────────────────────────────────

  private getUsersPanelData() {
    const social = this.lastSocial;
    if (!social) return null;

    const onlineSet = new Set(social.onlinePlayers ?? []);
    const friends = new Set(social.friends ?? []);
    const blocked = social.blockedUsers ?? {};
    const selfUsername = this.lastState?.username ?? '';
    const incomingFrom = new Set((social.incomingFriendRequests ?? []).map(r => r.fromUsername));
    const outgoingTo = new Set((social.outgoingFriendRequests ?? []).map(r => r.toUsername));

    // Full player list from all registered accounts (excludes self)
    const allEntries = (social.allPlayers ?? []).filter(p => p.username !== selfUsername);

    // Build filter sets
    const guildMembers = new Set((social.guildMembers ?? []).map(m => m.username));
    const otherPlayers = this.lastState?.otherPlayers ?? [];
    const myCol = this.lastState?.party.col;
    const myRow = this.lastState?.party.row;
    const myZone = this.lastState?.zoneName ?? '';
    const roomPlayers = new Set(otherPlayers.filter(p => p.col === myCol && p.row === myRow).map(p => p.username));
    const zonePlayers = new Set(otherPlayers.filter(p => p.zone === myZone).map(p => p.username));

    // Filter
    let players = [...allEntries];
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      players = players.filter(p => p.username.toLowerCase().includes(q));
    }
    switch (this.filterBy) {
      case 'friends': players = players.filter(p => friends.has(p.username)); break;
      case 'guild': players = players.filter(p => guildMembers.has(p.username)); break;
      case 'room': players = players.filter(p => roomPlayers.has(p.username)); break;
      case 'zone': players = players.filter(p => zonePlayers.has(p.username)); break;
    }

    // Sort
    if (this.sortBy === 'name') {
      players.sort((a, b) => a.username.localeCompare(b.username));
    } else {
      players.sort((a, b) => {
        const ao = onlineSet.has(a.username) ? 0 : 1;
        const bo = onlineSet.has(b.username) ? 0 : 1;
        if (ao !== bo) return ao - bo;
        const af = friends.has(a.username) ? 0 : 1;
        const bf = friends.has(b.username) ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.username.localeCompare(b.username);
      });
    }

    return { players, onlineSet, friends, blocked, incomingFrom, outgoingTo, social };
  }

  private renderUsersPanel(): void {
    const data = this.getUsersPanelData();
    if (!data) {
      this.panelContainer.innerHTML = '<div class="social-placeholder">Loading...</div>';
      return;
    }

    const { players, social } = data;
    const incoming = social.incomingFriendRequests ?? [];
    const onlineSet = data.onlineSet;

    const filters: { id: string; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'room', label: 'Room' },
      { id: 'zone', label: 'Zone' },
      { id: 'friends', label: 'Friends' },
      { id: 'guild', label: 'Guild' },
    ];

    // Incoming friend requests section
    const incomingHtml = incoming.length > 0 ? `
      <div class="social-group-header">Friend Requests (${incoming.length})</div>
      <div class="social-friend-requests">
        ${incoming.map(r => `
          <div class="social-user-row" data-username="${this.escapeHtml(r.fromUsername)}">
            <span class="social-status-dot ${onlineSet.has(r.fromUsername) ? 'online' : 'offline'}"></span>
            <span class="social-user-name-clickable" data-username="${this.escapeHtml(r.fromUsername)}">${this.classIcon(this.getPlayerClassName(r.fromUsername))} ${this.escapeHtml(r.fromUsername)}</span>
            <div class="social-user-actions">
              <button class="social-action-btn add-friend" data-action="accept_friend_request" data-username="${this.escapeHtml(r.fromUsername)}">Accept</button>
              <button class="social-action-btn remove-friend" data-action="decline_friend_request" data-username="${this.escapeHtml(r.fromUsername)}">Decline</button>
            </div>
          </div>
        `).join('')}
      </div>
    ` : '';

    this.panelContainer.innerHTML = `
      <div class="social-users-toolbar">
        <input class="social-search" type="text" placeholder="Search..." value="${this.escapeHtml(this.searchQuery)}" />
        <div class="social-toolbar-btns">
          ${filters.map(f => `<button class="social-filter-btn${this.filterBy === f.id ? ' active' : ''}" data-filter="${f.id}">${f.label}</button>`).join('')}
          <button class="social-sort-btn" title="Sort">${this.sortBy === 'name' ? '\u25B2 A-Z' : '\u25BC Status'}</button>
        </div>
      </div>
      ${incomingHtml}
      <div class="social-user-count">${players.length} player${players.length !== 1 ? 's' : ''}</div>
      <div class="social-user-list">
        ${this.renderUserListHtml(players, data.onlineSet)}
      </div>
    `;

    // Wire search
    this.searchInput = this.panelContainer.querySelector('.social-search')!;
    this.searchInput.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value;
      this.renderUserRows();
    });

    // Wire filter buttons
    for (const btn of this.panelContainer.querySelectorAll('.social-filter-btn')) {
      btn.addEventListener('click', () => {
        this.filterBy = btn.getAttribute('data-filter') as typeof this.filterBy;
        this.renderUserRows();
        // Update active class without full re-render
        for (const b of this.panelContainer.querySelectorAll('.social-filter-btn')) {
          b.classList.toggle('active', b.getAttribute('data-filter') === this.filterBy);
        }
      });
    }

    // Wire sort button
    const sortBtn = this.panelContainer.querySelector('.social-sort-btn');
    sortBtn?.addEventListener('click', () => {
      this.sortBy = this.sortBy === 'name' ? 'status' : 'name';
      this.renderUsersPanel();
    });

    // Wire accept/decline friend request buttons
    for (const btn of this.panelContainer.querySelectorAll('.social-friend-requests [data-action]')) {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const uname = btn.getAttribute('data-username');
        if (!uname) return;
        if (action === 'accept_friend_request') this.gameClient.sendAcceptFriendRequest(uname);
        if (action === 'decline_friend_request') this.gameClient.sendDeclineFriendRequest(uname);
      });
    }
  }

  /** Update just the user list rows without rebuilding search/filters. */
  private renderUserRows(): void {
    const data = this.getUsersPanelData();
    if (!data) return;
    const listContainer = this.panelContainer.querySelector('.social-user-list');
    const countEl = this.panelContainer.querySelector('.social-user-count');
    if (listContainer) {
      listContainer.innerHTML = this.renderUserListHtml(data.players, data.onlineSet);
    }
    if (countEl) {
      countEl.textContent = `${data.players.length} player${data.players.length !== 1 ? 's' : ''}`;
    }
  }

  private renderUserListHtml(players: PlayerListEntry[], onlineSet: Set<string>): string {
    if (players.length === 0) return '<div class="social-empty">No players found</div>';

    const friends = new Set(this.lastSocial?.friends ?? []);
    const blocked = this.lastSocial?.blockedUsers ?? {};
    const incomingFrom = new Set((this.lastSocial?.incomingFriendRequests ?? []).map(r => r.fromUsername));
    const outgoingTo = new Set((this.lastSocial?.outgoingFriendRequests ?? []).map(r => r.toUsername));

    if (this.sortBy === 'status') {
      const onlinePlayers = players.filter(p => onlineSet.has(p.username));
      const offlinePlayers = players.filter(p => !onlineSet.has(p.username));
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
  }

  private renderUserRow(p: PlayerListEntry, friends: Set<string>, blocked: Record<string, unknown>, onlineSet: Set<string>, incomingFrom: Set<string>, outgoingTo: Set<string>): string {
    const isFriend = friends.has(p.username);
    const isBlocked = p.username in blocked;
    const isOnline = onlineSet.has(p.username);
    const hasIncoming = incomingFrom.has(p.username);
    const hasSentTo = outgoingTo.has(p.username);

    let statusBadge = '';
    if (isFriend) statusBadge = '<span class="social-badge friend">Friend</span>';
    else if (hasIncoming) statusBadge = '<span class="social-badge friend">Request</span>';
    else if (hasSentTo) statusBadge = '<span class="social-badge">Pending</span>';

    return `<div class="social-user-row" data-username="${this.escapeHtml(p.username)}">
      <span class="social-status-dot ${isOnline ? 'online' : 'offline'}"></span>
      <span class="social-user-name-clickable" data-username="${this.escapeHtml(p.username)}">${this.classIcon(p.className)} ${this.escapeHtml(p.username)}</span>
      <span class="social-user-badges">
        ${statusBadge}
        ${isBlocked ? '<span class="social-badge blocked">Blocked</span>' : ''}
      </span>
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
            <span class="social-user-name-clickable" data-username="${this.escapeHtml(m.username)}">${this.classIcon(this.getPlayerClassName(m.username))} ${this.escapeHtml(m.username)}</span>
            <span class="social-user-badges">
              ${m.role === 'leader' ? '<span class="social-badge friend">Leader</span>' : ''}
            </span>
          </div>
        `).join('')}
      </div>
    `;
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
              <span class="social-user-name-clickable" data-username="${this.escapeHtml(p)}">${this.classIcon(this.getPlayerClassName(p))} ${this.escapeHtml(p)}</span>
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
        gridHtml += `<span class="social-party-cell-name">${this.classIcon(this.getPlayerClassName(member.username))} ${this.escapeHtml(member.username)}</span>`;
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
            <span class="social-user-name-clickable" data-username="${this.escapeHtml(m.username)}">${this.classIcon(this.getPlayerClassName(m.username))} ${this.escapeHtml(m.username)}</span>
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
    this.gameClient.sendSetChatPreferences(this.chatSendChannel, this.chatDmTarget);
    this.chatFocusAfterRender = true;
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

  private static formatTimestamp(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  private renderChatMsgHtml(msg: ChatMessage): string {
    const ch = SocialScreen.CHAT_CHANNELS.find(c => c.type === msg.channelType);
    const tag = ch?.tag ?? '?';
    const selfName = this.lastState?.username ?? '';
    const dmTo = (msg.channelType === 'dm' && msg.senderUsername === selfName)
      ? ` <span class="chat-dm-to">to ${this.escapeHtml(msg.channelId)}</span>` : '';
    const time = SocialScreen.formatTimestamp(msg.timestamp);
    return `<div class="social-chat-msg">
      <span class="chat-timestamp">${time}</span>
      <span class="chat-tag chat-color-${msg.channelType} chat-clickable" data-switch-channel="${msg.channelType}">[${tag}]</span>
      <span class="social-chat-sender chat-color-${msg.channelType} social-user-name-clickable" data-username="${this.escapeHtml(msg.senderUsername)}" data-dm-user="${this.escapeHtml(msg.senderUsername)}">${this.classIcon(this.getPlayerClassName(msg.senderUsername))} ${this.escapeHtml(msg.senderUsername)}${dmTo}</span>
      <span class="social-chat-text">${this.escapeHtml(msg.text)}</span>
    </div>`;
  }

  /** Update just the chat message list without rebuilding filters/input. */
  private renderChatMessages(): void {
    const msgContainer = this.panelContainer.querySelector('.social-chat-messages');
    if (!msgContainer) return;

    const wasAtBottom = msgContainer.scrollTop + msgContainer.clientHeight >= msgContainer.scrollHeight - 20;
    const filtered = this.chatMessages.filter(m => this.chatFilters.has(m.channelType));

    msgContainer.innerHTML = filtered.length === 0
      ? '<div class="social-empty">No messages yet</div>'
      : filtered.map(m => this.renderChatMsgHtml(m)).join('');

    if (wasAtBottom) {
      msgContainer.scrollTop = msgContainer.scrollHeight;
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
            : filtered.map(m => this.renderChatMsgHtml(m)).join('')
          }
        </div>
        <div class="social-chat-input-bar">
          <select class="chat-send-select">
            ${sendOptions.map(ch => `<option value="${ch.type}"${ch.type === this.chatSendChannel ? ' selected' : ''}${ch.disabled ? ' disabled' : ''}>${ch.label}</option>`).join('')}
          </select>
          <input class="social-search social-chat-input" type="text" placeholder="Type a message..." maxlength="500" />
          <button class="social-action-btn add-friend social-chat-send-btn">Send</button>
        </div>
      </div>
    `;

    // Restore scroll position
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
          const id = this.resolveChatChannelId(type);
          this.loadChatHistory(type, id);
        }
        btn.classList.toggle('active');
        this.renderChatMessages();
      });
    }

    // Wire channel selector
    const selectEl = this.panelContainer.querySelector('.chat-send-select') as HTMLSelectElement;
    const chatInput = this.panelContainer.querySelector('.social-chat-input') as HTMLInputElement;
    const sendBtn = this.panelContainer.querySelector('.social-chat-send-btn') as HTMLButtonElement;

    // DM state: when DM channel selected but no target, disable input
    const updateDmState = () => {
      if (this.chatSendChannel === 'dm' && !this.chatDmTarget) {
        chatInput.disabled = true;
        sendBtn.disabled = true;
        chatInput.placeholder = 'Select a user to DM first';
      } else {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.placeholder = 'Type a message...';
      }
    };

    selectEl.addEventListener('change', () => {
      this.chatSendChannel = selectEl.value as ChatChannelType;
      updateDmState();
      this.gameClient.sendSetChatPreferences(this.chatSendChannel, this.chatDmTarget);
    });

    updateDmState();

    // Wire clickable elements in messages
    if (msgContainer) {
      msgContainer.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;

        // Click on channel tag → switch send channel
        const switchChannel = target.closest('[data-switch-channel]')?.getAttribute('data-switch-channel') as ChatChannelType | null;
        if (switchChannel) {
          const opt = sendOptions.find(o => o.type === switchChannel);
          if (opt?.disabled) return;
          this.chatSendChannel = switchChannel;
          selectEl.value = switchChannel;
          updateDmState();
          this.gameClient.sendSetChatPreferences(this.chatSendChannel, this.chatDmTarget);
          chatInput.focus();
        }
      });
    }

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

    // Restore focus to message input after re-render
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

    const wasAtBottom = msgContainer.scrollTop + msgContainer.clientHeight >= msgContainer.scrollHeight - 20;

    const div = document.createElement('div');
    div.innerHTML = this.renderChatMsgHtml(msg);
    const child = div.firstElementChild;
    if (child) msgContainer.appendChild(child);

    if (wasAtBottom) {
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
