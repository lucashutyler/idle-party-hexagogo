import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, ClientSocialState, ChatMessage, ChatChannelType, PlayerListEntry } from '@idle-party-rpg/shared';
import { MAX_PARTY_SIZE, CLASS_ICONS, UNKNOWN_CLASS_ICON, SERVER_ICON } from '@idle-party-rpg/shared';
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

  // Grid drag-to-reposition state
  private gridDragging = false;
  private gridDragSourcePos: number | null = null;
  private gridDragGhost: HTMLElement | null = null;
  private gridDragHoverCell: HTMLElement | null = null;
  private gridAnimating = false;

  // Structural change detection keys — only re-render when these change
  private lastRenderedUsersKey = '';
  private lastRenderedGuildKey = '';
  private lastRenderedPartyKey = '';

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
    this.wireTabBarDelegation();
    this.renderTabBar();
  }

  /** Delegated click handler on tabBar — survives innerHTML replacements. */
  private wireTabBarDelegation(): void {
    this.tabBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.social-tab-btn') as HTMLElement | null;
      if (!btn) return;
      const tab = btn.getAttribute('data-tab') as SubTab;
      if (!tab) return;
      this.activeTab = tab;
      sessionStorage.setItem('socialSubTab', this.activeTab);
      if (this.activeTab === 'chat') this.hasUnread = false;
      // Invalidate all keys so panels render fresh on switch
      this.lastRenderedUsersKey = '';
      this.lastRenderedGuildKey = '';
      this.lastRenderedPartyKey = '';
      this.renderTabBar();
      this.renderPanel();
    });
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
        // Clicking own name on a DM you sent → start DM with the recipient
        const dmTarget = nameEl.getAttribute('data-dm-target');
        if (username && dmTarget) {
          this.startDm(dmTarget);
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

      // Users panel — filter buttons
      if (btn.matches('.social-filter-btn')) {
        this.filterBy = btn.getAttribute('data-filter') as typeof this.filterBy;
        this.renderUserRows();
        for (const b of this.panelContainer.querySelectorAll('.social-filter-btn')) {
          b.classList.toggle('active', b.getAttribute('data-filter') === this.filterBy);
        }
        return;
      }

      // Users panel — sort button
      if (btn.matches('.social-sort-btn')) {
        this.sortBy = this.sortBy === 'name' ? 'status' : 'name';
        btn.textContent = this.sortBy === 'name' ? '\u25B2 A-Z' : '\u25BC Status';
        this.renderUserRows();
        return;
      }

      // Users panel — friend request accept/decline
      if (btn.matches('[data-action="accept_friend_request"]')) {
        const uname = btn.getAttribute('data-username');
        if (uname) this.gameClient.sendAcceptFriendRequest(uname);
        return;
      }
      if (btn.matches('[data-action="decline_friend_request"]')) {
        const uname = btn.getAttribute('data-username');
        if (uname) this.gameClient.sendDeclineFriendRequest(uname);
        return;
      }

      // Chat panel — filter toggles
      if (btn.matches('.chat-filter-btn')) {
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
        return;
      }

      // Chat panel — send button
      if (btn.matches('.social-chat-send-btn')) {
        this.doChatSend();
        return;
      }
    });

    // Grid cell clicks for party position
    this.panelContainer.addEventListener('click', (e) => {
      if (this.gridDragging) return;
      const target = e.target as HTMLElement;
      const cell = target.closest('.social-party-cell') as HTMLElement | null;
      if (!cell) return;
      const pos = parseInt(cell.getAttribute('data-pos')!, 10);
      if (isNaN(pos)) return;

      if (cell.classList.contains('occupied')) {
        // Occupied by another player → flash red
        const selfUsername = this.lastState?.username;
        const party = this.lastSocial?.party;
        if (!party) return;
        const occupant = party.members.find(m => m.gridPosition === pos);
        if (occupant && occupant.username !== selfUsername) {
          this.flashGridCell(cell);
        }
      } else {
        // Empty cell → animate self to that position
        this.animateGridMove(pos);
        this.gameClient.sendSetPartyGridPosition(pos);
      }
    });

    // Delegated input handler for search + chat inputs
    this.panelContainer.addEventListener('input', (e) => {
      const target = e.target as HTMLElement;
      if (target.matches('.social-search:not(.social-chat-input):not(.social-chat-dm-target):not(.social-guild-name-input)')) {
        this.searchQuery = (target as HTMLInputElement).value;
        this.renderUserRows();
      }
      if (target.matches('.social-chat-dm-target')) {
        this.chatDmTarget = (target as HTMLInputElement).value.trim();
        this.updateChatDmState();
        this.gameClient.sendSetChatPreferences(this.chatSendChannel, this.chatDmTarget);
      }
    });

    // Delegated change handler for chat channel select
    this.panelContainer.addEventListener('change', (e) => {
      const target = e.target as HTMLElement;
      if (target.matches('.chat-send-select')) {
        this.chatSendChannel = (target as HTMLSelectElement).value as ChatChannelType;
        this.updateChatDmState();
        this.gameClient.sendSetChatPreferences(this.chatSendChannel, this.chatDmTarget);
        if (this.chatSendChannel === 'dm') {
          const dmInput = this.panelContainer.querySelector('.social-chat-dm-target') as HTMLInputElement | null;
          dmInput?.focus();
        }
      }
    });

    // Delegated keydown handler for chat input Enter
    this.panelContainer.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.matches('.social-chat-input') && (e as KeyboardEvent).key === 'Enter') {
        this.doChatSend();
      }
    });

    // Delegated click for channel tag switching in chat messages
    this.panelContainer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const switchChannel = target.closest('[data-switch-channel]')?.getAttribute('data-switch-channel') as ChatChannelType | null;
      if (switchChannel) {
        const social = this.lastSocial;
        let disabled = false;
        if (switchChannel === 'party') disabled = (social?.party?.members.length ?? 0) <= 1;
        if (switchChannel === 'guild') disabled = !social?.guild;
        if (disabled) return;
        this.chatSendChannel = switchChannel;
        const selectEl = this.panelContainer.querySelector('.chat-send-select') as HTMLSelectElement | null;
        if (selectEl) selectEl.value = switchChannel;
        this.updateChatDmState();
        this.gameClient.sendSetChatPreferences(this.chatSendChannel, this.chatDmTarget);
        const chatInput = this.panelContainer.querySelector('.social-chat-input') as HTMLInputElement | null;
        chatInput?.focus();
      }
    });

    // Grid drag handlers
    this.panelContainer.addEventListener('mousedown', (e) => this.onGridDragStart(e));
    this.panelContainer.addEventListener('touchstart', (e) => this.onGridDragStart(e), { passive: false });
    document.addEventListener('mousemove', (e) => this.onGridDragMove(e));
    document.addEventListener('touchmove', (e) => this.onGridDragMove(e), { passive: false });
    document.addEventListener('mouseup', (e) => this.onGridDragEnd(e));
    document.addEventListener('touchend', (e) => this.onGridDragEnd(e));
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
    // Click handlers are delegated via wireTabBarDelegation() — no per-button wiring needed.
  }

  /** Lightweight badge-only update — toggles badge spans without touching innerHTML. */
  private updateTabBadges(): void {
    const social = this.lastSocial;
    const friendRequests = (social?.incomingFriendRequests?.length ?? 0) > 0;
    const partyInvites = (social?.pendingInvites?.length ?? 0) > 0;
    const chatUnread = this.hasUnread && this.activeTab !== 'chat';

    for (const btn of this.tabBar.querySelectorAll('.social-tab-btn')) {
      const tab = btn.getAttribute('data-tab');
      const needsBadge =
        (tab === 'users' && friendRequests) ||
        (tab === 'party' && partyInvites) ||
        (tab === 'chat' && chatUnread);
      const badge = btn.querySelector('.social-tab-badge');
      if (needsBadge && !badge) {
        const span = document.createElement('span');
        span.className = 'social-tab-badge';
        btn.appendChild(span);
      } else if (!needsBadge && badge) {
        badge.remove();
      }
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

    // Lightweight badge update — never rebuilds tab bar DOM
    this.updateTabBadges();

    // Skip party panel updates while grid animation or drag is in progress
    if (this.activeTab === 'party' && (this.gridAnimating || this.gridDragging)) return;

    // Per-tab targeted updates — only touch specific elements that changed
    switch (this.activeTab) {
      case 'users': this.updateUsersPanel(); break;
      case 'guild': this.updateGuildPanel(); break;
      case 'party': this.updatePartyPanel(); break;
      case 'chat': break; // Chat uses incremental appendChatMessage — no tick rebuild needed
    }
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

  /** Send a chat message from the current input state. */
  private doChatSend(): void {
    const chatInput = this.panelContainer.querySelector('.social-chat-input') as HTMLInputElement | null;
    const sendBtn = this.panelContainer.querySelector('.social-chat-send-btn') as HTMLButtonElement | null;
    if (!chatInput || chatInput.disabled || sendBtn?.disabled) return;
    const text = chatInput.value.trim();
    if (!text) return;
    const channelId = this.resolveChatChannelId(this.chatSendChannel);
    if (!channelId) return;
    this.gameClient.sendChat(this.chatSendChannel, channelId, text);
    chatInput.value = '';
    chatInput.focus();
  }

  /** Update DM-related input state (show/hide target input, enable/disable send). */
  private updateChatDmState(): void {
    const dmInput = this.panelContainer.querySelector('.social-chat-dm-target') as HTMLInputElement | null;
    const chatInput = this.panelContainer.querySelector('.social-chat-input') as HTMLInputElement | null;
    const sendBtn = this.panelContainer.querySelector('.social-chat-send-btn') as HTMLButtonElement | null;
    if (!dmInput || !chatInput || !sendBtn) return;
    const isDm = this.chatSendChannel === 'dm';
    dmInput.style.display = isDm ? 'block' : 'none';
    if (isDm && !this.chatDmTarget) {
      chatInput.disabled = true;
      sendBtn.disabled = true;
      chatInput.placeholder = 'Enter a username above first';
    } else {
      chatInput.disabled = false;
      sendBtn.disabled = false;
      chatInput.placeholder = 'Type a message...';
    }
  }

  // ── Targeted per-tab tick updates (no innerHTML rebuilds) ──

  /** Update status dots + structural changes on Users panel. */
  private updateUsersPanel(): void {
    const social = this.lastSocial;
    if (!social) return;

    const onlineSet = new Set(social.onlinePlayers ?? []);

    // Update status dots on existing rows
    for (const row of this.panelContainer.querySelectorAll('.social-user-row[data-username]')) {
      const username = row.getAttribute('data-username')!;
      const dot = row.querySelector('.social-status-dot');
      if (dot) {
        const isOnline = onlineSet.has(username);
        dot.classList.toggle('online', isOnline);
        dot.classList.toggle('offline', !isOnline);
      }
    }

    // Detect structural changes that require a row rebuild
    const incoming = social.incomingFriendRequests ?? [];
    const key = JSON.stringify({
      players: (social.allPlayers ?? []).map(p => p.username),
      friends: social.friends ?? [],
      inReq: incoming.map(r => r.fromUsername),
      outReq: (social.outgoingFriendRequests ?? []).map(r => r.toUsername),
      blocked: Object.keys(social.blockedUsers ?? {}),
    });
    if (key !== this.lastRenderedUsersKey) {
      this.lastRenderedUsersKey = key;
      // Rebuild friend requests section + user rows, but keep toolbar intact
      this.renderUserRows();
      this.renderFriendRequests();
    }
  }

  /** Update status dots + structural changes on Guild panel. */
  private updateGuildPanel(): void {
    const social = this.lastSocial;
    if (!social) return;

    const onlineSet = new Set(social.onlinePlayers ?? []);

    // Update status dots on existing rows
    for (const row of this.panelContainer.querySelectorAll('.social-user-row[data-username]')) {
      const username = row.getAttribute('data-username')!;
      const dot = row.querySelector('.social-status-dot');
      if (dot) {
        const isOnline = onlineSet.has(username);
        dot.classList.toggle('online', isOnline);
        dot.classList.toggle('offline', !isOnline);
      }
    }

    // Detect structural changes
    const members = social.guildMembers ?? [];
    const key = JSON.stringify({
      guildId: social.guild?.id ?? null,
      leader: social.guild?.leaderUsername ?? null,
      members: members.map(m => `${m.username}:${m.role}`),
    });
    if (key !== this.lastRenderedGuildKey) {
      this.lastRenderedGuildKey = key;
      this.renderGuildPanel();
    }
  }

  /** Update status dots + structural changes on Party panel. */
  private updatePartyPanel(): void {
    const social = this.lastSocial;
    if (!social) return;

    const onlineSet = new Set(social.onlinePlayers ?? []);

    // Update status dots on existing rows and grid cells
    for (const row of this.panelContainer.querySelectorAll('[data-username]')) {
      const username = row.getAttribute('data-username')!;
      const dot = row.querySelector('.social-status-dot');
      if (dot) {
        const isOnline = onlineSet.has(username);
        dot.classList.toggle('online', isOnline);
        dot.classList.toggle('offline', !isOnline);
      }
    }

    // Detect structural changes
    const party = social.party;
    const pendingInvites = social.pendingInvites ?? [];
    const outgoing = social.outgoingPartyInvites ?? [];
    const sameTile = (this.lastState?.otherPlayers ?? [])
      .filter(p => p.col === this.lastState?.party.col && p.row === this.lastState?.party.row)
      .map(p => p.username).sort();
    const key = JSON.stringify({
      partyId: party?.id ?? null,
      members: (party?.members ?? []).map(m => `${m.username}:${m.role}:${m.gridPosition}`),
      pending: pendingInvites.map(i => `${i.partyId}:${i.inviterUsername}`),
      outgoing,
      sameTile,
    });
    if (key !== this.lastRenderedPartyKey) {
      this.lastRenderedPartyKey = key;
      this.renderPartyPanel();
    }
  }

  // ── Class icon helper ────────────────────────────────────────

  private classIcon(className?: string): string {
    if (!className) return UNKNOWN_CLASS_ICON;
    return CLASS_ICONS[className] ?? UNKNOWN_CLASS_ICON;
  }

  // ── User Popup Menu ──────────────────────────────────────────

  showUserPopup(username: string, anchor: HTMLElement): void {
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

    // Build header with relationship labels
    const isFriend = friends.has(username);
    const isGuildMember = guildMembers.has(username);
    const isPartyMember = partyMembers.has(username);
    const isBlocked = username in blocked;
    const labels: string[] = [];
    if (isFriend) labels.push('Friend');
    if (isGuildMember) labels.push('Guild');
    if (isPartyMember) labels.push('Party');
    const labelHtml = labels.length > 0
      ? ` <span class="user-popup-labels">${labels.join(' · ')}</span>`
      : '';

    const items: string[] = [];

    // Chat
    items.push(`<button class="user-popup-item" data-popup-action="chat">Chat</button>`);

    // Guild invite — only show if not already in guild
    if (social.guild && !isGuildMember) {
      items.push(`<button class="user-popup-item" data-popup-action="guild_invite">Invite to Guild</button>`);
    }

    // Friend — only show if not already friends
    if (!isFriend) {
      if (incomingFrom.has(username)) {
        items.push(`<button class="user-popup-item" data-popup-action="accept_friend">Accept Friend</button>`);
        items.push(`<button class="user-popup-item" data-popup-action="decline_friend">Decline Friend</button>`);
      } else if (outgoingTo.has(username)) {
        items.push(`<button class="user-popup-item" data-popup-action="revoke_friend">Revoke Request</button>`);
      } else {
        items.push(`<button class="user-popup-item" data-popup-action="add_friend">Add Friend</button>`);
      }
    }

    // Party invite — only show if not already in party
    if (!isPartyMember) {
      if (!sameRoom) {
        items.push(`<button class="user-popup-item disabled" disabled title="You must be in the same room to invite a player to your party">Invite to Party</button>`);
      } else {
        items.push(`<button class="user-popup-item" data-popup-action="party_invite">Invite to Party</button>`);
      }
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
      <div class="user-popup-header">${this.classIcon(this.getPlayerClassName(username))} ${this.escapeHtml(username)}${labelHtml}</div>
      ${items.join('')}
    `;

    // Position near anchor using fixed positioning (viewport-relative)
    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 4}px`;

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

    // Overlay to dismiss on outside click (fixed, covers viewport)
    const overlay = document.createElement('div');
    overlay.className = 'user-popup-overlay';
    overlay.addEventListener('click', () => this.dismissPopup());

    document.body.appendChild(overlay);
    document.body.appendChild(popup);
    this.popupOverlay = overlay;

    // Adjust if popup goes off-screen
    requestAnimationFrame(() => {
      const popupRect = popup.getBoundingClientRect();
      if (popupRect.right > window.innerWidth) {
        popup.style.left = `${Math.max(0, rect.right - popupRect.width)}px`;
      }
      if (popupRect.bottom > window.innerHeight) {
        popup.style.top = `${rect.top - popupRect.height - 4}px`;
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
      <div class="social-group-header social-friend-requests-header">Friend Requests (${incoming.length})</div>
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
    // All click/input handlers are delegated via wireDelegatedClicks() — no per-element wiring needed.
  }

  /** Update just the friend requests section without rebuilding the whole panel. */
  private renderFriendRequests(): void {
    const social = this.lastSocial;
    if (!social) return;
    const incoming = social.incomingFriendRequests ?? [];
    const onlineSet = new Set(social.onlinePlayers ?? []);

    // Remove existing friend request elements
    this.panelContainer.querySelector('.social-friend-requests-header')?.remove();
    this.panelContainer.querySelector('.social-friend-requests')?.remove();

    if (incoming.length > 0) {
      const toolbar = this.panelContainer.querySelector('.social-users-toolbar');
      if (toolbar) {
        const headerEl = document.createElement('div');
        headerEl.className = 'social-group-header social-friend-requests-header';
        headerEl.textContent = `Friend Requests (${incoming.length})`;
        toolbar.after(headerEl);

        const requestsEl = document.createElement('div');
        requestsEl.className = 'social-friend-requests';
        requestsEl.innerHTML = incoming.map(r => `
          <div class="social-user-row" data-username="${this.escapeHtml(r.fromUsername)}">
            <span class="social-status-dot ${onlineSet.has(r.fromUsername) ? 'online' : 'offline'}"></span>
            <span class="social-user-name-clickable" data-username="${this.escapeHtml(r.fromUsername)}">${this.classIcon(this.getPlayerClassName(r.fromUsername))} ${this.escapeHtml(r.fromUsername)}</span>
            <div class="social-user-actions">
              <button class="social-action-btn add-friend" data-action="accept_friend_request" data-username="${this.escapeHtml(r.fromUsername)}">Accept</button>
              <button class="social-action-btn remove-friend" data-action="decline_friend_request" data-username="${this.escapeHtml(r.fromUsername)}">Decline</button>
            </div>
          </div>
        `).join('');
        headerEl.after(requestsEl);
      }
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

  private static formatDateFull(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  private renderChatMsgHtml(msg: ChatMessage): string {
    const ch = SocialScreen.CHAT_CHANNELS.find(c => c.type === msg.channelType);
    const tag = ch?.tag ?? '?';
    const selfName = this.lastState?.username ?? '';
    const isSelfDm = msg.channelType === 'dm' && msg.senderUsername === selfName;
    const dmTo = isSelfDm
      ? ` <span class="chat-dm-to">to ${this.escapeHtml(msg.channelId)}</span>` : '';
    const dmTargetAttr = isSelfDm ? ` data-dm-target="${this.escapeHtml(msg.channelId)}"` : '';
    const time = SocialScreen.formatTimestamp(msg.timestamp);
    const dateFull = SocialScreen.formatDateFull(msg.timestamp);
    return `<div class="social-chat-msg">
      <span class="chat-timestamp" title="${dateFull}">${time}</span>
      <span class="chat-tag chat-color-${msg.channelType} chat-clickable" data-switch-channel="${msg.channelType}">[${tag}]</span>
      <span class="social-chat-sender chat-color-${msg.channelType} social-user-name-clickable" data-username="${this.escapeHtml(msg.senderUsername)}"${dmTargetAttr}>${msg.senderUsername === 'Server' ? SERVER_ICON : this.classIcon(this.getPlayerClassName(msg.senderUsername))} ${this.escapeHtml(msg.senderUsername)}${dmTo}</span>
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
          <input class="social-search social-chat-dm-target" type="text" placeholder="Username..." value="${this.escapeHtml(this.chatDmTarget)}" style="display:${this.chatSendChannel === 'dm' ? 'block' : 'none'}" />
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

    // Initialize DM input state
    this.updateChatDmState();

    // Restore focus to message input after re-render (e.g. after startDm)
    if (this.chatFocusAfterRender) {
      this.chatFocusAfterRender = false;
      const chatInput = this.panelContainer.querySelector('.social-chat-input') as HTMLInputElement | null;
      chatInput?.focus();
    }
    // All click/input/change/keydown handlers are delegated via wireDelegatedClicks() — no per-element wiring needed.
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

  // ── Party grid repositioning ──────────────────────────────

  /** Flash a party grid cell red to indicate it's occupied. */
  private flashGridCell(cell: HTMLElement): void {
    cell.classList.remove('grid-flash-red');
    void cell.offsetWidth;
    cell.classList.add('grid-flash-red');
    cell.addEventListener('animationend', () => {
      cell.classList.remove('grid-flash-red');
    }, { once: true });
  }

  /** Animate the current player's cell tilting and sliding toward targetPos. */
  private animateGridMove(targetPos: number): void {
    const party = this.lastSocial?.party;
    const selfUsername = this.lastState?.username;
    if (!party || !selfUsername) return;
    const self = party.members.find(m => m.username === selfUsername);
    if (!self || self.gridPosition === undefined) return;

    const srcPos = self.gridPosition as number;
    const grid = this.panelContainer.querySelector('.social-party-grid');
    if (!grid) return;
    const sourceCell = grid.querySelector(`.social-party-cell[data-pos="${srcPos}"]`) as HTMLElement | null;
    const targetCell = grid.querySelector(`.social-party-cell[data-pos="${targetPos}"]`) as HTMLElement | null;
    if (!sourceCell || !targetCell) return;

    // Use actual bounding rects for precise pixel offset
    const srcRect = sourceCell.getBoundingClientRect();
    const dstRect = targetCell.getBoundingClientRect();
    const dx = dstRect.left - srcRect.left;
    const dy = dstRect.top - srcRect.top;

    const srcCol = srcPos % 3;
    const dstCol = targetPos % 3;
    const srcRow = Math.floor(srcPos / 3);
    const dstRow = Math.floor(targetPos / 3);
    const tiltDeg = (dstCol - srcCol) * 8 + (dstRow - srcRow) * 4;

    sourceCell.style.setProperty('--tilt', `${tiltDeg}deg`);
    sourceCell.style.setProperty('--move-x', `${dx}px`);
    sourceCell.style.setProperty('--move-y', `${dy}px`);

    this.gridAnimating = true;
    void sourceCell.offsetWidth;
    sourceCell.classList.add('grid-move-anim');

    sourceCell.addEventListener('animationend', () => {
      sourceCell.classList.remove('grid-move-anim');
      sourceCell.style.removeProperty('--tilt');
      sourceCell.style.removeProperty('--move-x');
      sourceCell.style.removeProperty('--move-y');
      // Optimistic UI: swap cell contents so player appears at new position immediately
      const srcHtml = sourceCell.innerHTML;
      const srcOccupied = sourceCell.classList.contains('occupied');
      sourceCell.innerHTML = targetCell.innerHTML;
      sourceCell.classList.toggle('occupied', targetCell.classList.contains('occupied'));
      targetCell.innerHTML = srcHtml;
      targetCell.classList.toggle('occupied', srcOccupied);
      this.gridAnimating = false;
    }, { once: true });
  }

  private onGridDragStart(e: MouseEvent | TouchEvent): void {
    const target = (e.target as HTMLElement).closest('.social-party-cell.occupied[data-pos]') as HTMLElement | null;
    if (!target) return;

    const pos = parseInt(target.getAttribute('data-pos')!, 10);
    const party = this.lastSocial?.party;
    const selfUsername = this.lastState?.username;
    if (!party || !selfUsername) return;

    const member = party.members.find(m => m.gridPosition === pos);
    if (!member || member.username !== selfUsername) return; // can only drag self

    e.preventDefault();
    this.gridDragging = true;
    this.gridDragSourcePos = pos;

    // Create ghost
    const ghost = document.createElement('div');
    ghost.className = 'party-drag-ghost';
    ghost.textContent = `${this.classIcon(this.getPlayerClassName(selfUsername))} ${selfUsername}`;
    document.body.appendChild(ghost);
    this.gridDragGhost = ghost;

    const { clientX, clientY } = this.getPointerXY(e);
    ghost.style.left = `${clientX - 20}px`;
    ghost.style.top = `${clientY - 16}px`;
  }

  private onGridDragMove(e: MouseEvent | TouchEvent): void {
    if (!this.gridDragging || !this.gridDragGhost) return;
    e.preventDefault();
    const { clientX, clientY } = this.getPointerXY(e);
    this.gridDragGhost.style.left = `${clientX - 20}px`;
    this.gridDragGhost.style.top = `${clientY - 16}px`;

    // Update hover throb on cells under cursor
    const elUnder = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const cell = elUnder?.closest('.social-party-cell[data-pos]') as HTMLElement | null;
    const validCell = cell && cell !== this.gridDragHoverCell
      && parseInt(cell.getAttribute('data-pos')!, 10) !== this.gridDragSourcePos
      ? cell : (cell && parseInt(cell.getAttribute('data-pos')!, 10) === this.gridDragSourcePos ? null : cell);

    if (validCell !== this.gridDragHoverCell) {
      // Remove old hover
      if (this.gridDragHoverCell) {
        this.gridDragHoverCell.classList.remove('drag-hover-green', 'drag-hover-red');
        this.gridDragHoverCell = null;
      }
      // Add new hover if valid target (not source)
      if (validCell) {
        const pos = parseInt(validCell.getAttribute('data-pos')!, 10);
        if (!isNaN(pos) && pos !== this.gridDragSourcePos) {
          this.gridDragHoverCell = validCell;
          validCell.classList.add(validCell.classList.contains('occupied') ? 'drag-hover-red' : 'drag-hover-green');
        }
      }
    }
  }

  private onGridDragEnd(e: MouseEvent | TouchEvent): void {
    if (!this.gridDragging) return;
    this.gridDragging = false;

    // Remove ghost
    if (this.gridDragGhost) {
      this.gridDragGhost.remove();
      this.gridDragGhost = null;
    }

    // Clear hover throb
    if (this.gridDragHoverCell) {
      this.gridDragHoverCell.classList.remove('drag-hover-green', 'drag-hover-red');
      this.gridDragHoverCell = null;
    }

    // Determine drop target
    const { clientX, clientY } = this.getPointerXY(e);
    const dropEl = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!dropEl) { this.gridDragSourcePos = null; return; }

    const cell = dropEl.closest('.social-party-cell[data-pos]') as HTMLElement | null;
    if (!cell) { this.gridDragSourcePos = null; return; }

    const pos = parseInt(cell.getAttribute('data-pos')!, 10);
    if (isNaN(pos) || pos === this.gridDragSourcePos) { this.gridDragSourcePos = null; return; }

    if (cell.classList.contains('occupied')) {
      // Dropped on another player → flash red
      this.flashGridCell(cell);
    } else {
      // Dropped on empty cell → animate then move
      this.animateGridMove(pos);
      this.gameClient.sendSetPartyGridPosition(pos);
    }

    this.gridDragSourcePos = null;
  }

  private getPointerXY(e: MouseEvent | TouchEvent): { clientX: number; clientY: number } {
    if ('touches' in e) {
      const t = e.changedTouches?.[0] ?? e.touches?.[0];
      return t ? { clientX: t.clientX, clientY: t.clientY } : { clientX: 0, clientY: 0 };
    }
    return { clientX: (e as MouseEvent).clientX, clientY: (e as MouseEvent).clientY };
  }
}
