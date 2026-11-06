import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, ClientSocialState, PlayerListEntry, PlayerProfileMessage, TradeOfferItem, TradeState, ItemDefinition, SetDefinition, HiredHenchman, OtherPlayerState } from '@idle-party-rpg/shared';
import { MAX_PARTY_SIZE, MIN_GUILD_LEVEL, CLASS_GLYPHS, classIconHtml, getItemEffectText, listUnequippedEntries, getEquippedItemIds, isBlockedUser } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import type { WorldCache } from '../network/WorldCache';
import { RARITY_COLORS, RARITY_ORDER, renderItemIcon, renderEmptySlotIcon } from '../ui/ItemIcon';
import { renderItemPopupContent } from '../ui/ItemPopup';
import { confirmDialog } from '../ui/ConfirmDialog';
import type { ConfirmDialogOptions } from '../ui/ConfirmDialog';
import { bringToFront, release, wireFocusOnInteract } from '../ui/ModalStack';
import { renderAssetImg } from '../ui/assets';
import { showMapToast } from '../ui/MapToast';
import { classAttackSkill, renderSkillCardMeta } from '../ui/SkillCardChip';
import { partyGridCell } from '../ui/partyGridLayout';
import { deferWhilePressed, setHtml } from '../ui/render';
import { renderSegments, wireSegments } from '../ui/Segments';

type SubTab = 'party' | 'guild' | 'friends' | 'ranks';

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'party', label: 'Party' },
  { id: 'guild', label: 'Guild' },
  { id: 'friends', label: 'Friends' },
  { id: 'ranks', label: 'Ranks' },
];

const LEGACY_SUB_TABS: Record<string, SubTab> = { users: 'friends', friend_requests: 'friends' };

const SHEET_QUERY = '(max-width: 767px), (max-height: 520px)';
const SEARCH_DEBOUNCE_MS = 120;
const FRIEND_SEARCH_LIMIT = 30;
const GRID_MOVE_MS = 200;
const GRID_RESYNC_MS = 1500;
const POPUP_MARGIN = 8;
const RANK_ROWS_STEP = 100;
const RANK_GROW_MARGIN_PX = 600;

function resolveSubTab(requested: string | null): SubTab | null {
  if (!requested) return null;
  if (SUB_TABS.some(t => t.id === requested)) return requested as SubTab;
  return LEGACY_SUB_TABS[requested] ?? null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

interface PlayerRowOptions {
  username: string;
  online: boolean;
  className?: string;
  /** Escaped HTML for the line under the name. */
  sub?: string;
  lead?: string;
  trail?: string;
  actions?: string;
  rowClass?: string;
}

interface PopupItemOptions {
  /** Shown under the label. On a disabled item this says why it is disabled. */
  note?: string;
  disabled?: boolean;
  danger?: boolean;
}

export class SocialScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private isActive = false;
  private activeTab: SubTab = resolveSubTab(sessionStorage.getItem('socialSubTab')) ?? 'party';
  private unsubscribe?: () => void;

  private panelContainer!: HTMLElement;
  private segmentsContainer!: HTMLElement;
  private lastSocial: ClientSocialState | null = null;
  private lastState: ServerStateMessage | null = null;
  private rankSearch = '';
  private rankRowLimit = RANK_ROWS_STEP;
  private rankRowsHtmlShown: string[] = [];
  private friendSearch = '';
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private guildNameDraft = '';
  private sortBy: 'name' | 'status' | 'level' = 'level';
  private filterBy: 'all' | 'friends' | 'guild' | 'room' | 'zone' = 'all';

  private popupOverlay: HTMLElement | null = null;
  private popupEl: HTMLElement | null = null;

  /** Wired by App.ts to open the chat popout pre-filled for a DM target. */
  private onDmRequest?: (username: string) => void;

  // Trade modal
  private tradeModalEl: HTMLElement | null = null;
  private tradeSelectedItems = new Map<string, number>(); // itemId → quantity
  /** When viewing an existing trade, the trade ID. null when proposing a new trade. */
  private tradeActiveId: string | null = null;
  /** When proposing a new trade, the target username. */
  private tradeTargetUsername: string | null = null;
  /**
   * Inventory frozen at modal-open time. The picker renders from this snapshot
   * for the modal's whole lifetime so state pushes don't disturb
   * the user's selection (issue #342). The server is the authority on whether
   * the offer is still valid at submission time.
   */
  private tradeInventorySnapshot: Record<string, number> | null = null;
  /**
   * Last-rendered trade-state fingerprint. Tick-driven updates skip the
   * innerHTML rewrite when this hasn't changed, which is the common case
   * while the user is choosing items.
   */
  private lastTradeRenderKey = '';
  /**
   * Offer version the Confirm button is currently armed against. Compared against
   * the incoming one on each paint: if it moved while Confirm was on screen, the
   * button is withheld (see `tradeAwaitingReview`) rather than silently re-armed,
   * which is what would let a partner swap items in during the read-then-click
   * window. The server rejects any confirm that does not carry the live nonce.
   */
  private tradeConfirmNonce: string | null = null;
  /** One-off warning shown in the trade modal, e.g. after a stale-nonce rejection. */
  private tradeNotice: string | null = null;
  /** True when the last paint actually put a live Confirm button on screen. */
  private tradeConfirmArmed = false;
  /** Set when the offer moved while Confirm was armed — blocks confirm until acknowledged. */
  private tradeAwaitingReview = false;
  /** State subscription that lives as long as the trade modal, not the screen. */
  private unsubTradeModal?: () => void;

  // Gift modal
  private giftModalEl: HTMLElement | null = null;
  private giftTargetUsername: string | null = null;
  private giftSelectedItems = new Map<string, number>(); // itemId → quantity

  // Grid drag-to-reposition state
  private gridDragging = false;
  private gridDragSourcePos: number | null = null;
  private gridDragGhost: HTMLElement | null = null;
  private gridDragHoverCell: HTMLElement | null = null;
  private gridAnimating = false;
  private gridMoveFinish: (() => void) | null = null;
  private gridOptimistic = false;
  private gridResyncTimer: ReturnType<typeof setTimeout> | undefined;
  private gridDragHenchmanId: string | null = null;
  private gridPickedUpHenchmanId: string | null = null;
  private canManageHenchmen = false;

  // Structural change detection keys: panels re-render only when these change.
  private lastRenderedFriendsKey = '';
  private lastRenderedRanksKey = '';
  private lastRenderedGuildKey = '';
  private lastRenderedPartyKey = '';
  private lastOnlineKey = '';
  private playerIndex = new Map<string, PlayerListEntry>();
  private playerIndexSource: PlayerListEntry[] | undefined;

  private readonly onDocumentDragMove = (e: MouseEvent | TouchEvent): void => this.onGridDragMove(e);
  private readonly onDocumentDragEnd = (e: MouseEvent | TouchEvent): void => this.onGridDragEnd(e);
  private readonly onDocumentDragCancel = (): void => this.cancelGridDrag();
  private readonly onPopupViewportResize = (): void => this.fitPopupToViewport();

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;
    this.buildDOM();

    // A confirm rejected on a stale nonce means the partner's offer moved. The
    // re-synced state repaints the new offer; this explains why nothing happened.
    this.gameClient.onServerError((message, code) => {
      if (code === 'gift_refused') showMapToast(document.body, message);
      if (code !== 'trade_nonce_mismatch' || !this.tradeModalEl) return;
      this.tradeNotice = 'That offer changed before your confirmation went through. Review the updated offer below, then confirm again.';
      deferWhilePressed(this.tradeModalEl, () => this.refreshTradeModal());
    });
  }

  onActivate(): void {
    this.isActive = true;
    this.unsubscribe = this.gameClient.subscribe(() => {
      deferWhilePressed(this.segmentsContainer, () => this.renderSegmentBar());
      deferWhilePressed(this.panelContainer, () => {
        const state = this.gameClient.lastState;
        if (this.isActive && state) this.updateFromState(state);
      });
    });
    const state = this.gameClient.lastState;
    if (state) {
      this.lastSocial = state.social ?? null;
      this.lastState = state;
      this.renderSegmentBar();
      this.renderPanel();
    }
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.searchTimer);
    clearTimeout(this.gridResyncTimer);
    this.cancelGridDrag();
    this.gridMoveFinish?.();
    this.dismissPopup();
    this.dismissTradeModal();
    this.dismissGiftModal();
    if (this.activeTab === 'ranks') {
      this.rankRowLimit = RANK_ROWS_STEP;
      setHtml(this.panelContainer, '');
    }
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="social-content">
        <div class="social-segments"></div>
        <div class="social-panel" role="tabpanel"></div>
      </div>
    `;
    this.panelContainer = this.container.querySelector('.social-panel')!;
    this.segmentsContainer = this.container.querySelector('.social-segments')!;
    wireSegments(this.segmentsContainer, (id) => this.setSubTab(id));
    this.renderSegmentBar();
    this.wireDelegatedClicks();
  }

  private renderSegmentBar(): void {
    const social = this.gameClient.lastState?.social;
    const badges: Partial<Record<SubTab, number>> = {
      party: social?.pendingInvites?.length ?? 0,
      friends: social?.incomingFriendRequests?.length ?? 0,
    };
    const items = SUB_TABS.map(t => ({ ...t, badge: badges[t.id] }));
    setHtml(this.segmentsContainer, renderSegments(items, this.activeTab));
  }

  /** Switch sub-view, from the segments or a navigation target. */
  setSubTab(requested: string): void {
    const tab = resolveSubTab(requested);
    if (!tab || this.activeTab === tab) return;
    this.cancelGridDrag();
    this.gridMoveFinish?.();
    this.activeTab = tab;
    sessionStorage.setItem('socialSubTab', this.activeTab);
    this.renderSegmentBar();
    this.lastRenderedFriendsKey = '';
    this.lastRenderedRanksKey = '';
    this.lastRenderedGuildKey = '';
    this.lastRenderedPartyKey = '';
    this.rankRowLimit = RANK_ROWS_STEP;
    if (this.isActive) {
      this.renderPanel();
      this.panelContainer.scrollTop = 0;
    }
  }

  /** Single delegated click handler on panelContainer — survives innerHTML replacements. */
  private wireDelegatedClicks(): void {
    this.panelContainer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const nameEl = target.closest('.social-user-name-clickable') as HTMLElement | null;
      if (nameEl) {
        const username = nameEl.getAttribute('data-username')
          || nameEl.closest('[data-username]')?.getAttribute('data-username');
        if (username) {
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

      if (btn.matches('.social-promote-btn') && username) { this.gameClient.sendPromotePartyLeader(username); return; }
      if (btn.matches('.social-demote-btn') && username) { this.gameClient.sendDemotePartyMember(username); return; }
      if (btn.matches('.social-transfer-btn') && username) {
        this.confirmThen({
          title: `Make ${username} the party owner?`,
          body: 'You will become a leader, and only they can give ownership back.',
          confirmLabel: 'Transfer',
          danger: true,
        }, () => this.gameClient.sendTransferPartyOwnership(username));
        return;
      }
      if (btn.matches('.social-kick-btn') && username) {
        this.confirmThen({
          title: `Kick ${username}?`,
          body: 'They will be removed from this party and carry on alone.',
          confirmLabel: 'Kick',
          danger: true,
        }, () => this.gameClient.sendKickPartyMember(username));
        return;
      }
      if (btn.matches('.social-party-leave-btn')) {
        const self = this.lastSocial?.party?.members.find(m => m.username === this.lastState?.username);
        this.confirmThen({
          title: 'Leave this party?',
          body: self?.role === 'owner'
            ? 'You will carry on alone in a new party, and ownership passes to another member.'
            : 'You will carry on alone in a new party.',
          confirmLabel: 'Leave Party',
          danger: true,
        }, () => this.gameClient.sendLeaveParty());
        return;
      }
      if (btn.matches('.social-dismiss-henchman-btn')) {
        const instanceId = btn.getAttribute('data-henchman-instance');
        if (!instanceId) return;
        const henchman = this.lastSocial?.party?.henchmen?.find(h => h.instanceId === instanceId);
        this.confirmThen({
          title: `Dismiss ${henchman?.name ?? 'this henchman'}?`,
          body: 'They will leave the party, and you would have to hire them again.',
          confirmLabel: 'Dismiss',
          danger: true,
        }, () => this.gameClient.sendDismissHenchman(instanceId));
        return;
      }
      if (btn.matches('.social-accept-invite') && partyId) { this.gameClient.sendAcceptPartyInvite(partyId); return; }
      if (btn.matches('.social-decline-invite') && partyId) { this.gameClient.sendDeclinePartyInvite(partyId); return; }
      if (btn.matches('.social-nearby-invite') && username) { this.gameClient.sendInviteParty(username); return; }

      if (btn.matches('.social-guild-leave-btn')) {
        this.confirmThen({
          title: `Leave ${this.lastSocial?.guild?.name ?? 'this guild'}?`,
          body: 'You will need an invite from a member to rejoin.',
          confirmLabel: 'Leave Guild',
          danger: true,
        }, () => this.gameClient.sendLeaveGuild());
        return;
      }
      if (btn.matches('.social-guild-create-btn')) {
        const name = this.guildNameDraft.trim();
        if (name) this.gameClient.sendCreateGuild(name);
        return;
      }

      if (btn.matches('.social-filter-btn')) {
        this.filterBy = btn.getAttribute('data-filter') as typeof this.filterBy;
        this.rankRowLimit = RANK_ROWS_STEP;
        for (const b of this.panelContainer.querySelectorAll('.social-filter-btn')) {
          const active = b.getAttribute('data-filter') === this.filterBy;
          b.classList.toggle('active', active);
          b.setAttribute('aria-pressed', String(active));
        }
        this.renderRankRows();
        return;
      }
      if (btn.matches('.social-sort-btn')) {
        this.sortBy = this.sortBy === 'level' ? 'status' : this.sortBy === 'status' ? 'name' : 'level';
        btn.textContent = SocialScreen.sortLabel(this.sortBy);
        this.rankRowLimit = RANK_ROWS_STEP;
        this.renderRankRows();
        return;
      }
      if (btn.matches('.social-rank-you')) {
        this.panelContainer.querySelector('.social-rank-row.self')?.scrollIntoView({ block: 'center' });
        return;
      }
      if (btn.matches('.social-rank-more')) {
        this.growRankRows();
        return;
      }

      const action = btn.getAttribute('data-action');
      if (!action || !username) return;
      switch (action) {
        case 'accept_friend_request': this.gameClient.sendAcceptFriendRequest(username); break;
        case 'decline_friend_request': this.gameClient.sendDeclineFriendRequest(username); break;
        case 'revoke_friend_request': this.gameClient.sendRevokeFriendRequest(username); break;
        case 'add_friend': this.gameClient.sendFriendRequest(username); break;
        case 'friend_chat': this.startDm(username); break;
        case 'unblock': this.gameClient.sendUnblockUser(username); break;
      }
    });

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
        // Empty cell → move the held henchman there, else self
        const henchmanInstanceId = this.canManageHenchmen ? this.gridPickedUpHenchmanId : null;
        this.setGridPickedUp(null);
        this.animateGridMove(pos, henchmanInstanceId);
        this.gameClient.sendSetPartyGridPosition(pos, henchmanInstanceId ?? undefined);
      }
    });

    this.panelContainer.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const cell = (e.target as HTMLElement).closest?.('.social-party-cell') as HTMLElement | null;
      if (!cell) return;
      e.preventDefault();
      const henchmanId = cell.getAttribute('data-henchman-instance');
      if (henchmanId && this.canManageHenchmen) {
        this.setGridPickedUp(henchmanId === this.gridPickedUpHenchmanId ? null : henchmanId);
        return;
      }
      cell.click();
    });

    this.panelContainer.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.matches('.social-guild-name-input')) {
        this.guildNameDraft = input.value;
        this.syncGuildCreateButton();
        return;
      }
      const kind = input.getAttribute('data-search');
      if (kind === 'ranks') this.rankSearch = input.value;
      else if (kind === 'friends') this.friendSearch = input.value;
      else return;
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        if (kind === 'ranks') {
          this.rankRowLimit = RANK_ROWS_STEP;
          this.renderRankRows();
        } else {
          this.renderFriendRows();
        }
      }, SEARCH_DEBOUNCE_MS);
    });

    // Drag starts here; the document listeners exist only for the drag's lifetime.
    this.panelContainer.addEventListener('mousedown', (e) => this.onGridDragStart(e));
    this.panelContainer.addEventListener('touchstart', (e) => this.onGridDragStart(e), { passive: false });

    this.panelContainer.addEventListener('scroll', () => {
      if (this.activeTab !== 'ranks') return;
      const el = this.panelContainer;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < RANK_GROW_MARGIN_PX) this.growRankRows();
    }, { passive: true });
  }

  private confirmThen(opts: ConfirmDialogOptions, action: () => void): void {
    void confirmDialog(opts).then((confirmed) => {
      if (confirmed) action();
    });
  }

  private updateFromState(state: ServerStateMessage): void {
    this.lastSocial = state.social ?? null;
    this.lastState = state;
    if (this.activeTab === 'party' && (this.gridAnimating || this.gridDragging)) return;

    this.syncStatusDots();
    switch (this.activeTab) {
      case 'friends': this.updateFriendsPanel(); break;
      case 'ranks': this.updateRanksPanel(); break;
      case 'guild': this.updateGuildPanel(); break;
      case 'party': this.updatePartyPanel(); break;
    }
  }

  private renderPanel(): void {
    switch (this.activeTab) {
      case 'friends': this.renderFriendsPanel(); break;
      case 'ranks': this.renderRanksPanel(); break;
      case 'guild': this.renderGuildPanel(); break;
      case 'party': this.renderPartyPanel(); break;
    }
  }

  /** The push rate is high and a ranks list can hold every account, so dots are only walked when someone came or went. */
  private syncStatusDots(): void {
    const online = this.lastSocial?.onlinePlayers ?? [];
    const key = online.join('|');
    if (key === this.lastOnlineKey) return;
    this.lastOnlineKey = key;
    const onlineSet = new Set(online);
    for (const row of this.panelContainer.querySelectorAll('[data-username]')) {
      const dot = row.querySelector('.social-status-dot');
      if (!dot) continue;
      const isOnline = onlineSet.has(row.getAttribute('data-username')!);
      dot.classList.toggle('online', isOnline);
      dot.classList.toggle('offline', !isOnline);
    }
  }

  private friendsPanelKey(social: ClientSocialState): string {
    const onlineSet = new Set(social.onlinePlayers ?? []);
    const friends = social.friends ?? [];
    return JSON.stringify({
      friends: friends.map(f => `${f}:${onlineSet.has(f) ? 1 : 0}:${this.playerEntry(f)?.level ?? ''}`),
      inReq: (social.incomingFriendRequests ?? []).map(r => r.fromUsername),
      outReq: (social.outgoingFriendRequests ?? []).map(r => r.toUsername),
      blocked: Object.keys(social.blockedUsers ?? {}),
    });
  }

  private updateFriendsPanel(): void {
    const social = this.lastSocial;
    if (!social) return;
    const key = this.friendsPanelKey(social);
    if (key === this.lastRenderedFriendsKey) return;
    this.lastRenderedFriendsKey = key;
    this.renderFriendRows();
  }

  private updateRanksPanel(): void {
    const social = this.lastSocial;
    if (!social) return;
    const key = JSON.stringify({
      players: (social.allPlayers ?? []).map(p => `${p.username}:${p.level ?? ''}`),
      friends: social.friends ?? [],
      inReq: (social.incomingFriendRequests ?? []).map(r => r.fromUsername),
      outReq: (social.outgoingFriendRequests ?? []).map(r => r.toUsername),
      blocked: Object.keys(social.blockedUsers ?? {}),
    });
    if (key === this.lastRenderedRanksKey) return;
    this.lastRenderedRanksKey = key;
    this.renderRankRows();
  }

  private guildPanelKey(social: ClientSocialState): string {
    const onlineSet = new Set(social.onlinePlayers ?? []);
    return JSON.stringify({
      guildId: social.guild?.id ?? null,
      leader: social.guild?.leaderUsername ?? null,
      members: (social.guildMembers ?? []).map(m => `${m.username}:${m.role}:${onlineSet.has(m.username) ? 1 : 0}:${this.playerEntry(m.username)?.level ?? ''}`),
      canCreate: this.selfLevel() >= MIN_GUILD_LEVEL,
    });
  }

  private updateGuildPanel(): void {
    const social = this.lastSocial;
    if (!social) return;
    if (this.guildPanelKey(social) !== this.lastRenderedGuildKey) this.renderGuildPanel();
  }

  private updatePartyPanel(): void {
    const social = this.lastSocial;
    if (!social) return;
    const party = social.party;
    const sameTile = (this.lastState?.otherPlayers ?? [])
      .filter(p => this.isInMyRoom(p))
      .map(p => p.username).sort();
    const key = JSON.stringify({
      partyId: party?.id ?? null,
      members: (party?.members ?? []).map(m => `${m.username}:${m.role}:${m.gridPosition}`),
      henchmen: (party?.henchmen ?? []).map(h => `${h.instanceId}:${h.name ?? ''}:${h.gridPosition}`),
      pending: (social.pendingInvites ?? []).map(i => `${i.partyId}:${i.inviterUsername}`),
      outgoing: social.outgoingPartyInvites ?? [],
      sameTile,
    });
    if (key !== this.lastRenderedPartyKey) {
      this.lastRenderedPartyKey = key;
      this.renderPartyPanel();
    }
  }

  // ── Same-room helper ─────────────────────────────────────────

  /** Same room means same map too; `mapId` is optional on the wire, so absent counts as ours. */
  private isInMyRoom(p: OtherPlayerState): boolean {
    const state = this.lastState;
    if (!state) return false;
    return p.col === state.party.col
      && p.row === state.party.row
      && (!p.mapId || p.mapId === state.currentMapId);
  }

  private classIcon(className?: string): string {
    return classIconHtml(className);
  }

  private playerEntry(username: string): PlayerListEntry | undefined {
    const players = this.lastSocial?.allPlayers;
    if (players !== this.playerIndexSource) {
      this.playerIndexSource = players;
      this.playerIndex = new Map((players ?? []).map(p => [p.username, p]));
    }
    return this.playerIndex.get(username);
  }

  private selfLevel(): number {
    return this.lastState?.character?.level ?? 0;
  }

  private getPlayerClassName(username: string): string | undefined {
    const other = this.lastState?.otherPlayers?.find(p => p.username === username);
    if (other?.className) return other.className;
    return this.playerEntry(username)?.className;
  }

  // ── Shared row ───────────────────────────────────────────────

  private playerSub(username: string): string {
    const entry = this.playerEntry(username);
    const parts: string[] = [];
    if (entry?.level) parts.push(`Lv ${entry.level}`);
    const className = entry?.className ?? this.getPlayerClassName(username);
    if (className) parts.push(this.escapeHtml(className));
    return parts.join(' · ');
  }

  private playerRowHtml(o: PlayerRowOptions): string {
    const name = this.escapeHtml(o.username);
    return `<div class="social-user-row${o.rowClass ? ` ${o.rowClass}` : ''}" data-username="${name}">
      ${o.lead ?? ''}
      <button type="button" class="social-user-name-clickable" data-username="${name}">
        <span class="social-user-media">${this.classIcon(o.className)}<span class="social-status-dot ${o.online ? 'online' : 'offline'}"></span></span>
        <span class="social-user-text">
          <span class="social-user-title">${name}</span>
          ${o.sub ? `<span class="social-user-sub">${o.sub}</span>` : ''}
        </span>
      </button>
      ${o.trail ?? ''}
      ${o.actions ? `<div class="social-user-actions">${o.actions}</div>` : ''}
    </div>`;
  }

  private sectionLabel(text: string, count?: number): string {
    const countHtml = count === undefined ? '' : ` <span class="social-group-count">${count}</span>`;
    return `<div class="social-group-header">${this.escapeHtml(text)}${countHtml}</div>`;
  }

  // ── User popup ───────────────────────────────────────────────

  showUserPopup(username: string, anchor: HTMLElement, tileCol?: number, tileRow?: number): void {
    this.dismissPopup();

    // Can fire from other screens while this one is inactive and its state is stale.
    const freshState = this.gameClient.lastState;
    if (freshState) {
      this.lastSocial = freshState.social ?? null;
      this.lastState = freshState;
    }

    const social = this.lastSocial;
    if (!social) return;

    const selfUsername = this.lastState?.username ?? '';
    if (username === selfUsername) {
      this.showSelfPopup(anchor);
      return;
    }

    const isFriend = (social.friends ?? []).includes(username);
    const isGuildMember = (social.guildMembers ?? []).some(m => m.username === username);
    const isPartyMember = (social.party?.members ?? []).some(m => m.username === username);
    const isBlocked = isBlockedUser(username, social.blockedUsers ?? {});
    const isOnline = (social.onlinePlayers ?? []).includes(username);

    const labels: string[] = [];
    if (isFriend) labels.push('Friend');
    if (isGuildMember) labels.push('Guild');
    if (isPartyMember) labels.push('Party');
    if (isBlocked) labels.push('Blocked');

    const existingTrade = (social.proposedTrades ?? []).some(t => {
      const a = t.initiator.username;
      const b = t.target?.username;
      return (a === selfUsername && b === username) || (a === username && b === selfUsername);
    });

    const primary = [
      this.popupItem('view_player', 'View Player'),
      this.popupItem('chat', 'Chat'),
      existingTrade
        ? this.popupItem('trade', 'Open Trade', { note: 'Already in progress' })
        : this.popupItem('trade', 'Trade'),
      this.popupItem('gift', 'Send Gift'),
    ];

    const relations: string[] = [];
    relations.push(...this.friendPopupItems(username, isFriend));
    if (!isPartyMember) relations.push(this.partyInviteItem(username, tileCol, tileRow));
    if (social.guild && !isGuildMember) relations.push(this.popupItem('guild_invite', 'Invite to Guild'));

    const safety = isBlocked
      ? this.popupItem('unblock', 'Unblock')
      : this.popupItem('block', 'Block', { danger: true });

    const entry = this.playerEntry(username);
    const header = this.popupHeader(username, this.getPlayerClassName(username), entry?.level, labels.join(' · '), isOnline);
    const popup = this.openPopup(`
      ${header}
      <div class="user-popup-body">
        <div class="user-popup-grid">${primary.join('')}</div>
        ${relations.length > 0 ? `<div class="user-popup-list">${relations.join('')}</div>` : ''}
        <div class="user-popup-list">${safety}</div>
      </div>
    `, anchor);

    popup.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest('[data-popup-action]')?.getAttribute('data-popup-action');
      if (!action) return;
      this.dismissPopup();
      this.runPopupAction(action, username);
    });
  }

  private runPopupAction(action: string, username: string): void {
    switch (action) {
      case 'view_player': this.showPlayerProfile(username); break;
      case 'chat': this.startDm(username); break;
      case 'guild_invite': this.gameClient.sendInviteGuild(username); break;
      case 'accept_friend': this.gameClient.sendAcceptFriendRequest(username); break;
      case 'decline_friend': this.gameClient.sendDeclineFriendRequest(username); break;
      case 'revoke_friend': this.gameClient.sendRevokeFriendRequest(username); break;
      case 'add_friend': this.gameClient.sendFriendRequest(username); break;
      case 'remove_friend':
        this.confirmThen({
          title: `Remove ${username} from your friends?`,
          confirmLabel: 'Remove',
          danger: true,
        }, () => this.gameClient.sendRemoveFriend(username));
        break;
      case 'party_invite': this.gameClient.sendInviteParty(username); break;
      case 'block':
        this.confirmThen({
          title: `Block ${username}?`,
          body: 'You will stop seeing their chat messages, and trades between you are refused. You can unblock them at any time.',
          confirmLabel: 'Block',
          danger: true,
        }, () => this.gameClient.sendBlockUser(username, 'all'));
        break;
      case 'unblock': this.gameClient.sendUnblockUser(username); break;
      case 'trade': this.openTradeModal(username); break;
      case 'gift': this.openGiftModal(username); break;
    }
  }

  private friendPopupItems(username: string, isFriend: boolean): string[] {
    if (isFriend) return [this.popupItem('remove_friend', 'Remove Friend')];
    const social = this.lastSocial;
    if ((social?.incomingFriendRequests ?? []).some(r => r.fromUsername === username)) {
      return [this.popupItem('accept_friend', 'Accept Friend'), this.popupItem('decline_friend', 'Decline Friend')];
    }
    if ((social?.outgoingFriendRequests ?? []).some(r => r.toUsername === username)) {
      return [this.popupItem('revoke_friend', 'Revoke Friend Request')];
    }
    return [this.popupItem('add_friend', 'Add Friend')];
  }

  private partyInviteItem(username: string, tileCol?: number, tileRow?: number): string {
    const social = this.lastSocial;
    const selfMember = social?.party?.members.find(m => m.username === this.lastState?.username);
    const seatsUsed = this.partySeatsUsed(social?.party ?? null);
    const invited = (social?.outgoingPartyInvites ?? []).includes(username);
    // A room view passes its own coordinates, which beat the player list.
    const sameRoom = tileCol !== undefined && tileRow !== undefined
      ? this.lastState?.party.col === tileCol && this.lastState?.party.row === tileRow
      : (this.lastState?.otherPlayers ?? []).some(p => p.username === username && this.isInMyRoom(p));

    if (selfMember?.role !== 'owner' && selfMember?.role !== 'leader') {
      return this.popupItem('party_invite', 'Invite to Party', { disabled: true, note: 'Only the party owner or a leader can invite' });
    }
    if (seatsUsed >= MAX_PARTY_SIZE) {
      return this.popupItem('party_invite', 'Invite to Party', { disabled: true, note: `Your party is full (${seatsUsed}/${MAX_PARTY_SIZE}). Henchmen take a seat too` });
    }
    if (invited) {
      return this.popupItem('party_invite', 'Invited to Party', { disabled: true, note: 'Waiting for their answer' });
    }
    if (!sameRoom) {
      return this.popupItem('party_invite', 'Invite to Party', { disabled: true, note: 'You must be in the same room to invite them' });
    }
    return this.popupItem('party_invite', 'Invite to Party');
  }

  private popupItem(action: string, label: string, opts: PopupItemOptions = {}): string {
    const classes = `user-popup-item${opts.disabled ? ' disabled' : ''}${opts.danger ? ' danger' : ''}`;
    const attrs = opts.disabled ? ' disabled' : ` data-popup-action="${action}"`;
    const note = opts.note ? `<span class="user-popup-note">${this.escapeHtml(opts.note)}</span>` : '';
    return `<button type="button" class="${classes}"${attrs}><span class="user-popup-item-label">${this.escapeHtml(label)}</span>${note}</button>`;
  }

  private popupHeader(username: string, className: string | undefined, level: number | undefined, labels: string, online: boolean): string {
    const meta = [
      level ? `<span class="user-popup-level">Lv ${level}</span>` : '',
      className ? `<span class="user-popup-class">${this.escapeHtml(className)}</span>` : '',
      labels ? `<span class="user-popup-labels">${this.escapeHtml(labels)}</span>` : '',
    ].filter(Boolean).join('');
    return `<div class="user-popup-header">
      <span class="user-popup-avatar">${this.classIcon(className)}<span class="social-status-dot ${online ? 'online' : 'offline'}"></span></span>
      <span class="user-popup-id">
        <span class="user-popup-name">${this.escapeHtml(username)}</span>
        ${meta ? `<span class="user-popup-meta">${meta}</span>` : ''}
      </span>
      <button type="button" class="user-popup-close" aria-label="Close">✕</button>
    </div>`;
  }

  /** A bottom sheet on phones and short screens, a menu at the anchor elsewhere. */
  private openPopup(html: string, anchor: HTMLElement, extraClass = ''): HTMLElement {
    const asSheet = window.matchMedia?.(SHEET_QUERY).matches ?? false;

    const overlay = document.createElement('div');
    overlay.className = `user-popup-overlay${asSheet ? ' user-popup-overlay-sheet' : ''}`;
    overlay.addEventListener('click', () => this.dismissPopup());

    const popup = document.createElement('div');
    popup.className = `user-popup-menu${asSheet ? ' user-popup-sheet' : ''}${extraClass ? ` ${extraClass}` : ''}`;
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');
    popup.innerHTML = html;
    popup.querySelector('.user-popup-close')?.addEventListener('click', () => this.dismissPopup());

    document.body.appendChild(overlay);
    document.body.appendChild(popup);
    this.popupOverlay = overlay;
    this.popupEl = popup;
    bringToFront(overlay);
    bringToFront(popup, () => this.dismissPopup());

    if (!asSheet) this.placePopupAtAnchor(popup, anchor);
    window.addEventListener('resize', this.onPopupViewportResize);
    return popup;
  }

  /** A rotation can leave an anchored menu off-screen, or call for the sheet instead. */
  private fitPopupToViewport(): void {
    const popup = this.popupEl;
    if (!popup) return;
    const asSheet = window.matchMedia?.(SHEET_QUERY).matches ?? false;
    if (asSheet !== popup.classList.contains('user-popup-sheet')) {
      this.dismissPopup();
      return;
    }
    if (asSheet) return;
    const rect = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(POPUP_MARGIN, Math.min(rect.left, window.innerWidth - rect.width - POPUP_MARGIN))}px`;
    popup.style.top = `${Math.max(POPUP_MARGIN, Math.min(rect.top, window.innerHeight - rect.height - POPUP_MARGIN))}px`;
  }

  private placePopupAtAnchor(popup: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const size = popup.getBoundingClientRect();
    const maxLeft = window.innerWidth - size.width - POPUP_MARGIN;
    const below = rect.bottom + 4;
    const top = below + size.height > window.innerHeight - POPUP_MARGIN ? rect.top - size.height - 4 : below;
    popup.style.left = `${Math.max(POPUP_MARGIN, Math.min(rect.left, maxLeft))}px`;
    popup.style.top = `${Math.max(POPUP_MARGIN, top)}px`;
  }

  private showSelfPopup(anchor: HTMLElement): void {
    const state = this.lastState;
    const char = state?.character;
    const flavorLines = [
      'Tis thyself, brave soul. Look not in mirrors for adventure.',
      'You gaze upon thine own visage. Stout fellow!',
      'A noble hero — and curiously vain, to click upon themself.',
      "'Tis you, dear adventurer. Onward to glory!",
      "Behold: thyself. The realm's worst raid is lucky to have you.",
      'Yon reflection is uncommonly handsome today.',
    ];
    const flavor = flavorLines[Math.floor(Math.random() * flavorLines.length)];
    this.openPopup(`
      ${this.popupHeader(state?.username ?? '', char?.className, char?.level, 'You', true)}
      <div class="user-popup-self-flavor">${this.escapeHtml(flavor)}</div>
    `, anchor, 'user-popup-self');
  }

  private dismissPopup(): void {
    window.removeEventListener('resize', this.onPopupViewportResize);
    if (this.popupEl) {
      release(this.popupEl);
      this.popupEl.remove();
      this.popupEl = null;
    }
    if (this.popupOverlay) {
      release(this.popupOverlay);
      this.popupOverlay.remove();
      this.popupOverlay = null;
    }
  }

  // ── Friends panel ────────────────────────────────────────────

  private renderFriendsPanel(): void {
    if (!this.lastSocial) {
      setHtml(this.panelContainer, '<div class="social-placeholder">Loading...</div>');
      return;
    }
    setHtml(this.panelContainer, `
      <div class="social-users-toolbar">
        <input class="social-search" type="search" data-search="friends" placeholder="Find a player..." aria-label="Find a player" autocomplete="off" value="${this.escapeHtml(this.friendSearch)}" />
      </div>
      <div class="social-friends-body"></div>
    `);
    this.lastRenderedFriendsKey = this.friendsPanelKey(this.lastSocial);
    this.renderFriendRows();
  }

  private renderFriendRows(): void {
    const body = this.panelContainer.querySelector('.social-friends-body');
    const social = this.lastSocial;
    if (!body || !social) return;
    setHtml(body, this.friendsBodyHtml(social));
  }

  private friendsBodyHtml(social: ClientSocialState): string {
    const onlineSet = new Set(social.onlinePlayers ?? []);
    const query = this.friendSearch.trim().toLowerCase();
    const matches = (name: string): boolean => !query || name.toLowerCase().includes(query);
    const list = (rows: string[]): string => `<div class="social-user-list">${rows.join('')}</div>`;
    const row = (username: string, actions: string): string => this.playerRowHtml({
      username,
      online: onlineSet.has(username),
      className: this.getPlayerClassName(username),
      sub: this.playerSub(username),
      actions,
      rowClass: 'social-inline-actions',
    });
    const action = (name: string, action: string, label: string, tone = ''): string =>
      `<button type="button" class="social-action-btn${tone ? ` ${tone}` : ''}" data-action="${action}" data-username="${this.escapeHtml(name)}">${label}</button>`;

    const friends = [...(social.friends ?? [])].filter(matches).sort((a, b) => a.localeCompare(b));
    const friendSet = new Set(social.friends ?? []);
    const incoming = (social.incomingFriendRequests ?? []).map(r => r.fromUsername).filter(matches);
    const outgoing = (social.outgoingFriendRequests ?? []).map(r => r.toUsername).filter(matches);
    const blocked = Object.keys(social.blockedUsers ?? {}).filter(matches);
    const onlineFriends = friends.filter(f => onlineSet.has(f));
    const offlineFriends = friends.filter(f => !onlineSet.has(f));
    const chat = (name: string): string => action(name, 'friend_chat', 'Chat');

    const sections: string[] = [];
    if (incoming.length > 0) {
      sections.push(this.sectionLabel('Friend requests', incoming.length) + list(incoming.map(name =>
        row(name, action(name, 'accept_friend_request', 'Accept', 'add-friend') + action(name, 'decline_friend_request', 'Decline')))));
    }
    if (onlineFriends.length > 0) {
      sections.push(this.sectionLabel('Online', onlineFriends.length) + list(onlineFriends.map(name => row(name, chat(name)))));
    }
    if (offlineFriends.length > 0) {
      sections.push(this.sectionLabel('Offline', offlineFriends.length) + list(offlineFriends.map(name => row(name, chat(name)))));
    }

    if (query) {
      const known = new Set([...friendSet, ...incoming, ...outgoing, ...blocked, this.lastState?.username ?? '']);
      const others = (social.allPlayers ?? []).filter(p => !known.has(p.username) && matches(p.username));
      const shown = others.slice(0, FRIEND_SEARCH_LIMIT);
      if (shown.length > 0) {
        const more = others.length > shown.length
          ? `<div class="social-list-note">${others.length - shown.length} more. Keep typing to narrow it down.</div>`
          : '';
        sections.push(this.sectionLabel('Players', others.length) + list(shown.map(p =>
          row(p.username, action(p.username, 'add_friend', 'Add', 'add-friend')))) + more);
      }
    }

    if (outgoing.length > 0) {
      sections.push(this.sectionLabel('Requests sent', outgoing.length) + list(outgoing.map(name =>
        row(name, action(name, 'revoke_friend_request', 'Revoke')))));
    }
    if (blocked.length > 0) {
      sections.push(this.sectionLabel('Blocked', blocked.length) + list(blocked.map(name =>
        row(name, action(name, 'unblock', 'Unblock')))));
    }

    if (sections.length > 0) return sections.join('');
    return query
      ? '<div class="ui-empty">No players match that name.</div>'
      : '<div class="ui-empty">No friends yet. Find a player above, or choose any name in the game to add them.</div>';
  }

  // ── Ranks panel ──────────────────────────────────────────────

  private getRanksData() {
    const social = this.lastSocial;
    if (!social) return null;

    const onlineSet = new Set(social.onlinePlayers ?? []);
    const friends = new Set(social.friends ?? []);
    const byLevel = [...(social.allPlayers ?? [])].sort((a, b) => {
      const diff = (b.level ?? 0) - (a.level ?? 0);
      return diff !== 0 ? diff : a.username.localeCompare(b.username);
    });
    const ranks = new Map(byLevel.map((p, i) => [p.username, i + 1]));

    let players = byLevel;
    if (this.rankSearch) {
      const q = this.rankSearch.trim().toLowerCase();
      players = players.filter(p => p.username.toLowerCase().includes(q));
    }
    players = this.applyRankFilter(players, friends, new Set((social.guildMembers ?? []).map(m => m.username)));

    if (this.sortBy === 'name') {
      players = [...players].sort((a, b) => a.username.localeCompare(b.username));
    } else if (this.sortBy === 'status') {
      players = [...players].sort((a, b) => {
        const online = Number(onlineSet.has(b.username)) - Number(onlineSet.has(a.username));
        if (online !== 0) return online;
        const friend = Number(friends.has(b.username)) - Number(friends.has(a.username));
        return friend !== 0 ? friend : a.username.localeCompare(b.username);
      });
    }

    return { players, ranks, onlineSet, friends };
  }

  private applyRankFilter(players: PlayerListEntry[], friends: Set<string>, guild: Set<string>): PlayerListEntry[] {
    const others = this.lastState?.otherPlayers ?? [];
    switch (this.filterBy) {
      case 'friends': return players.filter(p => friends.has(p.username));
      case 'guild': return players.filter(p => guild.has(p.username));
      case 'room': {
        const room = new Set(others.filter(p => this.isInMyRoom(p)).map(p => p.username));
        return players.filter(p => room.has(p.username));
      }
      case 'zone': {
        const zone = this.currentZoneId();
        const inZone = new Set(others.filter(p => p.zone === zone).map(p => p.username));
        return players.filter(p => inZone.has(p.username));
      }
      default: return players;
    }
  }

  /** `otherPlayers[].zone` holds the raw zone key, while `state.zoneName` is its display name. */
  private currentZoneId(): string | undefined {
    const state = this.lastState;
    if (!state) return undefined;
    return this.worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row)?.zone ?? state.zoneName;
  }

  private renderRanksPanel(): void {
    if (!this.lastSocial) {
      setHtml(this.panelContainer, '<div class="social-placeholder">Loading...</div>');
      return;
    }
    const filters: { id: string; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'room', label: 'Room' },
      { id: 'zone', label: 'Zone' },
      { id: 'friends', label: 'Friends' },
      { id: 'guild', label: 'Guild' },
    ];
    setHtml(this.panelContainer, `
      <div class="social-users-toolbar">
        <div class="social-toolbar-search">
          <input class="social-search" type="search" data-search="ranks" placeholder="Search..." aria-label="Search players" autocomplete="off" value="${this.escapeHtml(this.rankSearch)}" />
          <button type="button" class="social-sort-btn" title="Change the order">${SocialScreen.sortLabel(this.sortBy)}</button>
        </div>
        <div class="social-toolbar-btns">
          ${filters.map(f => `<button type="button" class="social-filter-btn${this.filterBy === f.id ? ' active' : ''}" aria-pressed="${this.filterBy === f.id}" data-filter="${f.id}">${f.label}</button>`).join('')}
        </div>
        <div class="social-rank-summary">
          <span class="social-user-count"></span>
          <button type="button" class="social-rank-you"></button>
        </div>
      </div>
      <div class="social-user-list social-rank-list"></div>
      <button type="button" class="social-action-btn social-rank-more" hidden></button>
    `);
    this.renderRankRows();
  }

  private renderRankRows(): void {
    const data = this.getRanksData();
    const list = this.panelContainer.querySelector('.social-rank-list');
    if (!data || !list) return;
    this.patchRankRows(list, this.rankRowsHtml(data.players, data.ranks, data.onlineSet, data.friends));

    const remaining = data.players.length - this.rankRowLimit;
    const more = this.panelContainer.querySelector<HTMLElement>('.social-rank-more');
    if (more) {
      more.hidden = remaining <= 0;
      more.textContent = remaining > 0 ? `Show more (${remaining.toLocaleString()} left)` : '';
    }

    const count = this.panelContainer.querySelector('.social-user-count');
    if (count) count.textContent = plural(data.players.length, 'player');

    const selfUsername = this.lastState?.username ?? '';
    const you = this.panelContainer.querySelector<HTMLElement>('.social-rank-you');
    if (you) {
      const listed = data.players.some(p => p.username === selfUsername);
      you.hidden = !listed;
      you.textContent = listed ? `You: #${data.ranks.get(selfUsername)}` : '';
    }
  }

  private growRankRows(): void {
    const total = this.getRanksData()?.players.length ?? 0;
    if (this.rankRowLimit >= total) return;
    this.rankRowLimit += RANK_ROWS_STEP;
    this.renderRankRows();
  }

  /** Writes only the rows whose markup changed: a level-up elsewhere in a long list must not rebuild it. Each entry is one element. */
  private patchRankRows(list: Element, rows: string[]): void {
    if (list.children.length !== this.rankRowsHtmlShown.length) {
      list.innerHTML = '';
      this.rankRowsHtmlShown = [];
    }
    const shown = this.rankRowsHtmlShown;
    const changed = rows.flatMap((html, i) => (html === shown[i] ? [] : [i]));
    const parsed = document.createElement('template');
    parsed.innerHTML = changed.map(i => rows[i]).join('');
    const replacements = [...parsed.content.children];
    changed.forEach((rowIndex, i) => {
      const current = list.children[rowIndex];
      if (current) current.replaceWith(replacements[i]);
      else list.appendChild(replacements[i]);
    });
    while (list.children.length > rows.length) list.lastElementChild!.remove();
    this.rankRowsHtmlShown = rows;
  }

  /** The first `rankRowLimit` players, plus the player's own row if that cuts it off. */
  private rankRowsHtml(players: PlayerListEntry[], ranks: Map<string, number>, onlineSet: Set<string>, friends: Set<string>): string[] {
    if (players.length === 0) return ['<div class="ui-empty">No players found.</div>'];
    const row = (p: PlayerListEntry): string => this.rankRowHtml(p, ranks.get(p.username) ?? 0, onlineSet, friends);
    const group = (label: string, count: number): string => `<div class="social-rank-group">${label} <span class="social-group-count">${count}</span></div>`;
    const shown = players.slice(0, this.rankRowLimit);
    const rows: string[] = [];
    const onlineCount = this.sortBy === 'status' ? players.filter(p => onlineSet.has(p.username)).length : -1;
    shown.forEach((p, i) => {
      if (i === 0 && onlineCount > 0) rows.push(group('Online', onlineCount));
      if (i === onlineCount) rows.push(group('Offline', players.length - onlineCount));
      rows.push(row(p));
    });
    const selfUsername = this.lastState?.username;
    const self = players.slice(this.rankRowLimit).find(p => p.username === selfUsername);
    if (self) rows.push(row(self));
    return rows;
  }

  private rankRowHtml(p: PlayerListEntry, rank: number, onlineSet: Set<string>, friends: Set<string>): string {
    const social = this.lastSocial;
    const isSelf = p.username === (this.lastState?.username ?? '');
    const notes: string[] = [];
    if (p.className) notes.push(this.escapeHtml(p.className));
    if (isSelf) notes.push('You');
    else if (friends.has(p.username)) notes.push('Friend');
    else if ((social?.incomingFriendRequests ?? []).some(r => r.fromUsername === p.username)) notes.push('Wants to be friends');
    else if ((social?.outgoingFriendRequests ?? []).some(r => r.toUsername === p.username)) notes.push('Request sent');
    if (isBlockedUser(p.username, social?.blockedUsers ?? {})) notes.push('Blocked');
    return this.playerRowHtml({
      username: p.username,
      online: onlineSet.has(p.username),
      className: p.className,
      sub: notes.join(' · '),
      lead: `<span class="social-rank-num${rank <= 3 ? ` social-rank-top social-rank-${rank}` : ''}">${rank}</span>`,
      trail: p.level !== undefined && p.level !== null ? `<span class="social-user-level">Lv ${p.level}</span>` : '',
      rowClass: `social-rank-row${isSelf ? ' self' : ''}`,
    });
  }

  private static sortLabel(mode: 'name' | 'status' | 'level'): string {
    if (mode === 'level') return 'Top';
    if (mode === 'status') return 'Status';
    return 'A-Z';
  }

  // ── Guild panel ──────────────────────────────────────────────

  private renderGuildPanel(): void {
    const social = this.lastSocial;
    if (!social) {
      setHtml(this.panelContainer, '<div class="social-placeholder">Loading...</div>');
      return;
    }
    this.lastRenderedGuildKey = this.guildPanelKey(social);

    const guild = social.guild;
    if (!guild) {
      setHtml(this.panelContainer, this.guildCreateHtml());
      this.syncGuildCreateButton();
      return;
    }

    const onlineSet = new Set(social.onlinePlayers ?? []);
    const members = [...(social.guildMembers ?? [])].sort((a, b) => {
      const online = Number(onlineSet.has(b.username)) - Number(onlineSet.has(a.username));
      return online !== 0 ? online : a.username.localeCompare(b.username);
    });
    const onlineCount = members.filter(m => onlineSet.has(m.username)).length;

    setHtml(this.panelContainer, `
      <div class="social-guild-info">
        <div class="social-guild-name">${this.escapeHtml(guild.name)}</div>
        <div class="social-guild-leader">Leader: ${this.escapeHtml(guild.leaderUsername)}</div>
        <div class="social-guild-leader">${plural(members.length, 'member')}, ${onlineCount} online</div>
      </div>
      ${this.sectionLabel('Members', members.length)}
      <div class="social-user-list">
        ${members.map(m => this.playerRowHtml({
          username: m.username,
          online: onlineSet.has(m.username),
          className: this.getPlayerClassName(m.username),
          sub: this.playerSub(m.username),
          trail: m.role === 'leader' ? '<span class="social-badge friend">Leader</span>' : '',
        })).join('')}
      </div>
      <div class="social-leave-row">
        <button type="button" class="social-action-btn social-leave-btn social-guild-leave-btn">Leave Guild</button>
      </div>
    `);
  }

  private guildCreateHtml(): string {
    const level = this.selfLevel();
    const note = level >= MIN_GUILD_LEVEL
      ? 'Pick a name to start your guild.'
      : `Starting a guild needs level ${MIN_GUILD_LEVEL}. You are level ${level}.`;
    return `
      <div class="social-guild-create">
        <div class="social-guild-create-title">You are not in a guild</div>
        <div class="social-guild-note">Ask any guild member to invite you, or start your own.</div>
        <div class="social-guild-form">
          <input class="social-search social-guild-name-input" type="text" placeholder="Guild name..." aria-label="Guild name" maxlength="20" autocomplete="off" value="${this.escapeHtml(this.guildNameDraft)}" />
          <button type="button" class="social-action-btn add-friend social-guild-create-btn">Create Guild</button>
        </div>
        <div class="social-guild-note social-guild-reason">${note}</div>
      </div>
    `;
  }

  private syncGuildCreateButton(): void {
    const btn = this.panelContainer.querySelector<HTMLButtonElement>('.social-guild-create-btn');
    const eligible = this.selfLevel() >= MIN_GUILD_LEVEL;
    const named = !!this.guildNameDraft.trim();
    if (btn) btn.disabled = !eligible || !named;
    const reason = this.panelContainer.querySelector<HTMLElement>('.social-guild-reason');
    if (reason) reason.hidden = eligible && named;
  }

  // ── Party panel ──────────────────────────────────────────────

  /** Members plus henchmen — a henchman takes a seat against MAX_PARTY_SIZE. */
  private partySeatsUsed(party: ClientSocialState['party']): number {
    if (!party) return 0;
    return party.members.length + (party.henchmen?.length ?? 0);
  }

  /** Authored photo when there is one, emoji when there isn't or the photo fails to load. */
  private henchmanPortrait(h: HiredHenchman): string {
    const emoji = `<span class="social-henchman-emoji"${h.artworkUrl ? ' style="display:none;"' : ''}>${this.escapeHtml(h.emoji ?? '🗡️')}</span>`;
    if (!h.artworkUrl) return emoji;
    const onerror = `this.style.display='none';this.nextElementSibling.style.display='inline';`;
    return `<img class="icon-inline icon-class" src="${this.escapeHtml(h.artworkUrl)}" alt="${this.escapeHtml(h.name ?? 'Henchman')}" onerror="${onerror}" loading="lazy" />${emoji}`;
  }

  private henchmanName(h: HiredHenchman): string {
    return this.escapeHtml(h.name ?? 'Henchman');
  }

  private partyGridHtml(party: NonNullable<ClientSocialState['party']>, onlineSet: Set<string>): string {
    const selfUsername = this.lastState?.username ?? '';
    const memberMap = new Map<number, (typeof party.members)[number]>(party.members.map(m => [m.gridPosition, m]));
    const henchmanMap = new Map<number, HiredHenchman>((party.henchmen ?? []).map(h => [h.gridPosition, h]));

    let cells = '';
    for (let i = 0; i < 9; i++) {
      const member = memberMap.get(i);
      const henchman = member ? undefined : henchmanMap.get(i);
      const cellPos = partyGridCell(i);
      const isSelf = member?.username === selfUsername;
      const occupantName = member?.username ?? (henchman ? (henchman.name ?? 'Henchman') : 'Empty spot');
      const classes = `social-party-cell${member || henchman ? ' occupied' : ''}${isSelf ? ' self' : ''}`;
      let inner = '';
      if (member) {
        const role = member.role === 'owner' ? ['👑', 'owner', 'Party owner'] : member.role === 'leader' ? ['★', 'friend', 'Party leader'] : null;
        inner = `<span class="social-status-dot ${onlineSet.has(member.username) ? 'online' : 'offline'}"></span>`
          + `<span class="social-party-cell-name">${this.classIcon(this.getPlayerClassName(member.username))}<span class="social-party-cell-label">${this.escapeHtml(member.username)}</span></span>`
          + (role ? `<span class="social-badge social-party-cell-role ${role[1]}" title="${role[2]}">${role[0]}</span>` : '');
      } else if (henchman) {
        inner = `<span class="social-party-cell-name">${this.henchmanPortrait(henchman)}<span class="social-party-cell-label">${this.henchmanName(henchman)}</span></span>`
          + '<span class="social-badge social-party-cell-role" title="Henchman — a hire, not a player">H</span>';
      }
      cells += `<div class="${classes}" role="button" tabindex="0" data-pos="${i}"`
        + (henchman ? ` data-henchman-instance="${this.escapeHtml(henchman.instanceId)}"` : '')
        + ` data-portrait-row="${cellPos.portraitRow}" data-portrait-col="${cellPos.portraitCol}"`
        + ` title="${cellPos.columnLabel}" aria-label="${cellPos.columnLabel}: ${this.escapeHtml(occupantName)}">${inner}</div>`;
    }
    return `<div class="social-party-grid">${cells}</div>`;
  }

  private memberActionsHtml(m: { username: string; role: string }, selfRole: string): string {
    const name = this.escapeHtml(m.username);
    const button = (cls: string, label: string): string =>
      `<button type="button" class="social-action-btn ${cls}" data-username="${name}">${label}</button>`;
    const actions: string[] = [];
    if (selfRole === 'owner') {
      if (m.role === 'member') actions.push(button('social-promote-btn', 'Promote'));
      if (m.role === 'leader') actions.push(button('social-demote-btn', 'Demote'));
      actions.push(button('social-transfer-btn', 'Transfer'));
      actions.push(button('remove-friend social-kick-btn', 'Kick'));
    } else if (selfRole === 'leader') {
      if (m.role === 'member') actions.push(button('social-promote-btn', 'Promote'));
      if (m.role !== 'owner') actions.push(button('remove-friend social-kick-btn', 'Kick'));
    }
    return actions.join('');
  }

  private renderPartyPanel(): void {
    const social = this.lastSocial;
    const party = social?.party;
    if (!social || !party) {
      setHtml(this.panelContainer, '<div class="social-placeholder">Loading...</div>');
      return;
    }

    const selfUsername = this.lastState?.username ?? '';
    const selfRole = party.members.find(m => m.username === selfUsername)?.role ?? 'member';
    const isLeaderOrOwner = selfRole === 'owner' || selfRole === 'leader';
    this.canManageHenchmen = isLeaderOrOwner;
    const isSolo = party.members.length === 1;
    const onlineSet = new Set(social.onlinePlayers ?? []);
    const partyMembers = new Set(party.members.map(m => m.username));
    const henchmen = party.henchmen ?? [];

    const pendingInvites = social.pendingInvites ?? [];
    const invitesHtml = pendingInvites.length > 0 ? `
      ${this.sectionLabel('Party invites', pendingInvites.length)}
      <div class="social-user-list">
        ${pendingInvites.map(inv => `
          <div class="social-user-row social-inline-actions" data-party-id="${this.escapeHtml(inv.partyId)}">
            <span class="social-user-name">${this.escapeHtml(inv.inviterUsername)}'s party</span>
            <div class="social-user-actions">
              <button type="button" class="social-action-btn add-friend social-accept-invite" data-party-id="${this.escapeHtml(inv.partyId)}">Accept</button>
              <button type="button" class="social-action-btn social-decline-invite" data-party-id="${this.escapeHtml(inv.partyId)}">Decline</button>
            </div>
          </div>
        `).join('')}
      </div>
    ` : '';

    const sameTilePlayers = (this.lastState?.otherPlayers ?? [])
      .filter(p => this.isInMyRoom(p) && !partyMembers.has(p.username))
      .map(p => p.username)
      .sort();
    const outgoingInvites = new Set(social.outgoingPartyInvites ?? []);
    const seatsUsed = this.partySeatsUsed(party);
    const partyFull = seatsUsed >= MAX_PARTY_SIZE;
    const nearbyRows = sameTilePlayers.map(p => {
      const invited = outgoingInvites.has(p);
      return this.playerRowHtml({
        username: p,
        online: true,
        className: this.getPlayerClassName(p),
        sub: this.playerSub(p),
        actions: `<button type="button" class="social-action-btn add-friend social-nearby-invite" data-username="${this.escapeHtml(p)}"${invited || partyFull ? ' disabled' : ''}>${invited ? 'Invited' : 'Invite'}</button>`,
        rowClass: 'social-inline-actions',
      });
    }).join('');
    const nearbyHtml = isLeaderOrOwner ? `
      ${this.sectionLabel('In this room', sameTilePlayers.length)}
      ${sameTilePlayers.length === 0
        ? '<div class="social-list-note">No one else is here. Walk to another player\'s room to invite them.</div>'
        : `<div class="social-user-list">${nearbyRows}</div>${partyFull ? `<div class="social-list-note">Your party is full (${seatsUsed}/${MAX_PARTY_SIZE}). Henchmen take a seat too.</div>` : ''}`}
    ` : '';

    const memberRows = party.members.map(m => this.playerRowHtml({
      username: m.username,
      online: onlineSet.has(m.username),
      className: this.getPlayerClassName(m.username),
      sub: this.playerSub(m.username),
      trail: m.role === 'owner'
        ? '<span class="social-badge owner">Owner</span>'
        : m.role === 'leader' ? '<span class="social-badge friend">Leader</span>' : '',
      actions: m.username === selfUsername ? '' : this.memberActionsHtml(m, selfRole),
      rowClass: m.username === selfUsername ? 'self' : '',
    })).join('');

    const henchmenRows = henchmen.map(h => `
      <div class="social-user-row" data-henchman-instance="${this.escapeHtml(h.instanceId)}">
        <span class="social-user-media">${this.henchmanPortrait(h)}</span>
        <span class="social-user-text">
          <span class="social-user-title">${this.henchmanName(h)}</span>
          <span class="social-user-sub">${h.level !== undefined ? `Lv ${h.level} · ` : ''}Henchman</span>
        </span>
        ${isLeaderOrOwner ? `<div class="social-user-actions"><button type="button" class="social-action-btn social-dismiss-henchman-btn" data-henchman-instance="${this.escapeHtml(h.instanceId)}">Dismiss</button></div>` : ''}
      </div>
    `).join('');

    const canMoveHenchmen = isLeaderOrOwner && henchmen.length > 0;
    const hint = `Drag yourself to an empty spot, or choose one to move there.${canMoveHenchmen ? ' Choose a henchman first to move them.' : ''}`;

    const focusedCell = (document.activeElement as Element | null)?.closest?.('.social-party-cell');
    const focusedPos = focusedCell && this.panelContainer.contains(focusedCell) ? focusedCell.getAttribute('data-pos') : null;

    if (this.gridOptimistic) {
      this.gridOptimistic = false;
      clearTimeout(this.gridResyncTimer);
      setHtml(this.panelContainer, '');
    }
    setHtml(this.panelContainer, `
      ${invitesHtml}
      <div class="social-party-layout">
        <div class="social-party-formation">
          <div class="social-party-formation-head">
            ${this.sectionLabel('Formation')}
            <div class="social-party-front-label" aria-hidden="true">
              <span class="social-party-front-label-wide">FRONT ▶</span><span class="social-party-front-label-tall">FRONT ▲</span>
            </div>
          </div>
          ${this.partyGridHtml(party, onlineSet)}
          <div class="social-list-note social-party-hint">${hint}</div>
        </div>
        <div class="social-party-roster">
          ${this.sectionLabel(`Party ${seatsUsed}/${MAX_PARTY_SIZE}`)}
          <div class="social-user-list">${memberRows}${henchmenRows}</div>
          ${nearbyHtml}
          ${!isSolo ? `
            <div class="social-leave-row">
              <button type="button" class="social-action-btn social-leave-btn social-party-leave-btn">Leave Party</button>
            </div>
          ` : ''}
        </div>
      </div>
    `);

    if (this.gridPickedUpHenchmanId && !henchmen.some(h => h.instanceId === this.gridPickedUpHenchmanId)) {
      this.gridPickedUpHenchmanId = null;
    }
    this.paintGridPickedUp();
    if (focusedPos !== null) {
      this.panelContainer.querySelector<HTMLElement>(`.social-party-cell[data-pos="${focusedPos}"]`)?.focus({ preventScroll: true });
    }
  }

  /**
   * Open the chat popout pre-filled for a DM to `username`. Also persists
   * the choice as the user's chat preferences for cross-device sync.
   */
  startDm(username: string): void {
    this.gameClient.sendSetChatPreferences('dm', username);
    this.onDmRequest?.(username);
  }

  /** Wire an external handler that opens the global chat popout to a DM. */
  setOnDmRequest(cb: (username: string) => void): void {
    this.onDmRequest = cb;
  }


  // ── Trade Modal ───────────────────────────────────────────────

  /**
   * Open the trade modal. If a trade with `targetUsername` already exists,
   * resume it; otherwise start composing a new proposal.
   */
  openTradeModal(targetUsername: string): void {
    this.refreshStateForTrade();
    const selfUsername = this.lastState?.username ?? '';
    const existing = (this.lastSocial?.proposedTrades ?? []).find(t => {
      const a = t.initiator.username;
      const b = t.target?.username;
      return (a === selfUsername && b === targetUsername) || (a === targetUsername && b === selfUsername);
    });
    if (existing) {
      this.openExistingTrade(existing.id);
      return;
    }
    this.tradeActiveId = null;
    this.tradeTargetUsername = targetUsername;
    this.tradeSelectedItems = new Map();
    this.snapshotInventoryForTrade();
    this.renderTradeModal();
  }

  /** Open the trade modal for an existing trade, identified by trade ID. */
  openExistingTrade(tradeId: string): void {
    this.refreshStateForTrade();
    this.tradeActiveId = tradeId;
    this.tradeTargetUsername = null;
    this.tradeSelectedItems = new Map();
    this.snapshotInventoryForTrade();
    this.renderTradeModal();
  }

  /**
   * Pull the latest state before opening the modal. Both entry points can fire
   * while this screen is deactivated — the Hero screen's "Proposed Trades" rows
   * call `openExistingTrade` without a screen switch — and `lastSocial` is frozen
   * at the last activation in that case. Same idiom as `showUserPopup`.
   */
  private refreshStateForTrade(): void {
    const freshState = this.gameClient.lastState;
    if (!freshState) return;
    this.lastState = freshState;
    this.lastSocial = freshState.social ?? null;
  }

  private snapshotInventoryForTrade(): void {
    this.tradeNotice = null;
    this.tradeAwaitingReview = false;
    this.tradeConfirmArmed = false;
    const inv = this.lastState?.character?.inventory ?? {};
    this.tradeInventorySnapshot = { ...inv };
    this.lastTradeRenderKey = '';
  }

  /** Steps one picker quantity, capped at what's owned; zero takes the item out. Returns whether it changed. */
  private stepQuantity(selected: Map<string, number>, itemId: string | null, delta: 1 | -1, owned: Record<string, number>): boolean {
    if (!itemId) return false;
    const next = (selected.get(itemId) ?? 0) + delta;
    if (delta > 0 && next > (owned[itemId] ?? 0)) return false;
    if (next > 0) selected.set(itemId, next);
    else selected.delete(itemId);
    return true;
  }

  /** Find the active trade for this modal in social state. */
  private getActiveTrade() {
    if (!this.tradeActiveId) return null;
    return this.lastSocial?.proposedTrades?.find(t => t.id === this.tradeActiveId) ?? null;
  }

  private renderTradeModal(): void {
    if (this.tradeModalEl) {
      release(this.tradeModalEl);
      this.tradeModalEl.remove();
      this.tradeModalEl = null;
    }
    this.unsubTradeModal?.();

    // Per-modal, not per-screen: the Hero screen opens this modal while SocialScreen is deactivated.
    this.unsubTradeModal = this.gameClient.subscribe(() => {
      if (this.tradeModalEl) deferWhilePressed(this.tradeModalEl, () => this.refreshTradeModal());
    });

    const overlay = document.createElement('div');
    overlay.className = 'trade-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'trade-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    overlay.appendChild(modal);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        // Backdrop click — close without cancelling. Trade persists asynchronously.
        this.dismissTradeModal();
        return;
      }

      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn) return;

      if (btn.matches('.trade-modal-close-btn')) {
        this.dismissTradeModal();
        return;
      }

      if (btn.matches('.trade-modal-cancel-btn')) {
        const trade = this.getActiveTrade();
        if (!trade) return;
        const tradeId = trade.id;
        const declining = trade.status !== 'countered' && trade.lastUpdatedBy !== this.lastState?.username;
        this.confirmThen({
          title: declining ? 'Decline this trade?' : 'Cancel this trade?',
          body: 'The offers on both sides are dropped.',
          confirmLabel: declining ? 'Decline Trade' : 'Cancel Trade',
          cancelLabel: 'Keep Trade',
          danger: true,
        }, () => {
          this.gameClient.sendCancelTrade(tradeId);
          if (this.tradeActiveId === tradeId) this.dismissTradeModal();
        });
        return;
      }

      if (btn.matches('.trade-modal-review-btn')) {
        // The player has now seen the new offer — arm Confirm against it.
        this.tradeAwaitingReview = false;
        this.tradeNotice = null;
        this.updateTradeModal();
        return;
      }

      if (btn.matches('.trade-modal-confirm-btn')) {
        const trade = this.getActiveTrade();
        if (!trade) return;
        this.tradeNotice = null;
        this.gameClient.sendConfirmTrade(trade.id, this.tradeConfirmNonce ?? trade.nonce);
        return;
      }

      if (btn.matches('.trade-qty-inc, .trade-qty-dec')) {
        const delta = btn.matches('.trade-qty-inc') ? 1 : -1;
        if (this.stepQuantity(this.tradeSelectedItems, btn.getAttribute('data-item-id'), delta, this.tradeInventorySnapshot ?? {})) {
          this.updateTradeModal();
        }
        return;
      }

      if (btn.matches('.trade-send-btn')) {
        const items: TradeOfferItem[] = Array.from(this.tradeSelectedItems.entries())
          .map(([itemId, quantity]) => ({ itemId, quantity }));
        if (items.length === 0) return;
        const trade = this.getActiveTrade();
        if (trade) {
          this.gameClient.sendCounterTrade(trade.id, items);
        } else if (this.tradeTargetUsername) {
          this.gameClient.sendProposeTrade(this.tradeTargetUsername, items);
        }
        // Clear local selection — server response will repaint with the new state.
        // The review gate is deliberately NOT cleared here: a counter can be
        // rejected (the picker renders from a frozen snapshot, so the server may
        // reject it) or dropped on a closed socket, and neither case repaints.
        // Clearing it optimistically would leave a stale "Review Updated Offer"
        // button that the next routine tick silently turns into a live Confirm.
        // It clears in updateTradeModal once Confirm is genuinely off screen.
        this.tradeSelectedItems = new Map();
        return;
      }
    });

    document.body.appendChild(overlay);
    this.tradeModalEl = overlay;
    bringToFront(overlay, () => this.dismissTradeModal());
    wireFocusOnInteract(overlay);
    this.updateTradeModal();
  }

  private refreshTradeModal(): void {
    if (!this.tradeModalEl) return;
    const state = this.gameClient.lastState;
    if (state) {
      this.lastState = state;
      this.lastSocial = state.social ?? null;
    }
    this.updateTradeModal();
  }

  private updateTradeModal(): void {
    const overlay = this.tradeModalEl;
    if (!overlay) return;
    const modal = overlay.querySelector('.trade-modal');
    if (!modal) return;

    const trade = this.getActiveTrade();
    const selfUsername = this.lastState?.username ?? '';
    const wasAwaitingReview = this.tradeAwaitingReview;

    // The read-then-click window. If a live Confirm button was already on screen
    // for one offer and the partner has since changed it, re-arming the button
    // with the new nonce would let them swap items in while the player is
    // reaching for Confirm — the server would see a matching nonce and swap.
    // Instead, hold Confirm back until the player acknowledges the new offer.
    const confirmOnScreen = !!trade && trade.status === 'countered' && trade.lastUpdatedBy !== selfUsername;
    if (!confirmOnScreen) {
      // Nothing to gate while Confirm is off screen — e.g. this player's own
      // counter landed. Reset so the partner's next counter starts clean.
      this.tradeAwaitingReview = false;
      this.tradeNotice = null;
    } else if (trade && this.tradeConfirmArmed
      && this.tradeConfirmNonce !== null && trade.nonce !== this.tradeConfirmNonce) {
      this.tradeAwaitingReview = true;
      this.tradeNotice = 'Their offer changed while you were looking at it. Check the new offer, then confirm.';
    }
    this.tradeConfirmArmed = confirmOnScreen && !this.tradeAwaitingReview;
    // Bind confirm to the offer version on screen right now.
    this.tradeConfirmNonce = trade?.nonce ?? null;

    // The frozen snapshot, not live state, so a tick can't move items out from under
    // the selection. The server validates the offer at submission (issue #342).
    const inventory = this.tradeInventorySnapshot ?? {};

    // Skip the re-render entirely when nothing the user can see has changed.
    // Without this, every server tick wipes innerHTML and resets scroll, focus,
    // etc., even when the active trade and the local selection are identical.
    const renderKey = this.computeTradeRenderKey(trade);
    if (renderKey === this.lastTradeRenderKey) return;
    this.lastTradeRenderKey = renderKey;

    // If a trade was being viewed but is now gone (cancelled/confirmed), close.
    if (this.tradeActiveId && !trade) {
      this.dismissTradeModal();
      return;
    }

    // If no trade and no target (somehow), close.
    if (!trade && !this.tradeTargetUsername) {
      this.dismissTradeModal();
      return;
    }

    const targetUsername = trade
      ? (trade.initiator.username === selfUsername
        ? (trade.target?.username ?? '')
        : trade.initiator.username)
      : (this.tradeTargetUsername ?? '');

    const isSelfInitiator = trade ? trade.initiator.username === selfUsername : true;
    const myOffer = trade
      ? (isSelfInitiator ? trade.initiator.items : (trade.target?.items ?? []))
      : [];
    const theirOffer = trade
      ? (isSelfInitiator ? (trade.target?.items ?? []) : trade.initiator.items)
      : [];
    const waitingOnMe = trade ? trade.lastUpdatedBy !== selfUsername : false;

    const name = this.escapeHtml(targetUsername);
    const theirLabel = `${name}'s offer`;
    const picker = this.itemPickerHtml('trade', inventory, this.tradeSelectedItems, 'No tradeable items in your inventory');
    const selItems: TradeOfferItem[] = Array.from(this.tradeSelectedItems.entries())
      .map(([itemId, quantity]) => ({ itemId, quantity }));
    const offers = (first: string, second: string, vs = true): string =>
      `<div class="trade-offers">${first}${vs ? '<div class="trade-vs">⇄</div>' : ''}${second}</div>`;
    const sendBtn = (label: string): string =>
      `<button type="button" class="social-action-btn add-friend trade-send-btn"${selItems.length > 0 ? '' : ' disabled'}>${label}${this.selectionSuffix(this.tradeSelectedItems)}</button>`;
    const cancelBtn = (label: string): string =>
      `<button type="button" class="social-action-btn trade-modal-cancel-btn">${label}</button>`;

    let body: string;
    let actions: string;
    if (!trade) {
      body = `
        ${this.offerCardHtml(selItems, 'Your offer')}
        <div class="trade-picker-label">Select items to offer</div>
        ${picker}`;
      actions = sendBtn('Send Trade');
    } else if (trade.status === 'countered' && waitingOnMe) {
      body = `
        ${offers(this.offerCardHtml(myOffer, 'Your offer'), this.offerCardHtml(theirOffer, theirLabel))}
        <div class="trade-status">${name} updated their offer. Confirm to accept, or counter with new items.</div>
        <div class="trade-picker-label">Counter with</div>
        ${picker}`;
      actions = `
        ${this.tradeAwaitingReview
          ? '<button type="button" class="social-action-btn trade-primary-btn trade-modal-review-btn">Review Updated Offer</button>'
          : '<button type="button" class="social-action-btn add-friend trade-primary-btn trade-modal-confirm-btn">Confirm Trade</button>'}
        ${sendBtn('Counter')}
        ${cancelBtn('Cancel Trade')}`;
    } else if (trade.status === 'countered') {
      body = `
        ${offers(this.offerCardHtml(myOffer, 'Your offer'), this.offerCardHtml(theirOffer, theirLabel))}
        <div class="trade-status">Waiting for ${name} to confirm or counter...</div>
        <div class="trade-picker-label">Update your offer</div>
        ${picker}`;
      actions = `${sendBtn('Update Offer')}${cancelBtn('Cancel Trade')}`;
    } else if (waitingOnMe) {
      body = `
        ${offers(this.offerCardHtml(theirOffer, `${name} offers`), this.offerCardHtml(selItems, 'Your counter'), false)}
        <div class="trade-picker-label">Select items to counter with</div>
        ${picker}`;
      actions = `${sendBtn('Send Back')}${cancelBtn('Decline')}`;
    } else {
      body = `
        ${offers(this.offerCardHtml(myOffer, 'Your offer'), this.offerCardHtml([], theirLabel), false)}
        <div class="trade-status">Waiting for ${name} to respond...</div>
        <div class="trade-picker-label">Update your offer</div>
        ${picker}`;
      actions = `${sendBtn('Update Offer')}${cancelBtn('Cancel Trade')}`;
    }

    const notice = this.tradeNotice ? `<div class="trade-notice">${this.escapeHtml(this.tradeNotice)}</div>` : '';
    this.paintSheetModal(modal, `Trade with ${name}`, 'trade-modal-close-btn', `${notice}${body}`, actions, !wasAwaitingReview && this.tradeAwaitingReview);
  }

  /** Header, scrolling body, sticky actions. A repaint keeps the body's scroll, so a quantity tap doesn't jump the list. */
  private paintSheetModal(modal: Element, titleHtml: string, closeClass: string, bodyHtml: string, actionsHtml: string, scrollToTop = false): void {
    const scrollTop = modal.querySelector('.trade-modal-body')?.scrollTop ?? 0;
    setHtml(modal, `
      <div class="trade-modal-header">
        <span class="trade-modal-title">${titleHtml}</span>
        <button type="button" class="social-modal-close ${closeClass}" aria-label="Close">✕</button>
      </div>
      <div class="trade-modal-body">${bodyHtml}</div>
      <div class="trade-actions">${actionsHtml}</div>
    `);
    const body = modal.querySelector('.trade-modal-body');
    if (body) body.scrollTop = scrollToTop ? 0 : scrollTop;
  }

  private selectionSuffix(selection: Map<string, number>): string {
    let total = 0;
    for (const quantity of selection.values()) total += quantity;
    return total > 0 ? ` (${total})` : '';
  }

  private tradeItemIcon(itemId: string, def: ItemDefinition | undefined): string {
    return def ? renderItemIcon(itemId, def, { extraClass: 'trade-item-icon' }) : '';
  }

  private offerCardHtml(items: TradeOfferItem[], labelHtml: string): string {
    if (items.length === 0) {
      return `<div class="trade-item-card trade-item-empty">
        <div class="trade-item-label">${labelHtml}</div>
        <div class="trade-item-none">Nothing yet</div>
      </div>`;
    }
    const itemDefs = this.lastState?.itemDefinitions ?? {};
    const skillDefs = this.worldCache.getSkillContent().skills;
    const rows = items.map(({ itemId, quantity }) => {
      const def = itemDefs[itemId];
      const color = def ? (RARITY_COLORS[def.rarity] ?? '#e8e8e8') : '#e8e8e8';
      const effect = def ? getItemEffectText(def, skillDefs) : '';
      return `<div class="trade-offer-row">
        ${this.tradeItemIcon(itemId, def)}
        <div class="trade-offer-text">
          <span class="trade-offer-name" style="color:${color}">${this.escapeHtml(def?.name ?? itemId)}</span>
          <span class="trade-offer-qty">×${quantity}</span>
          ${effect ? `<span class="trade-offer-effect">${this.escapeHtml(effect)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
    return `<div class="trade-item-card"><div class="trade-item-label">${labelHtml}</div>${rows}</div>`;
  }

  private itemPickerHtml(kind: 'trade' | 'gift', inventory: Record<string, number>, selection: Map<string, number>, emptyText: string): string {
    const itemDefs = this.lastState?.itemDefinitions ?? {};
    const skillDefs = this.worldCache.getSkillContent().skills;
    const ids = listUnequippedEntries(inventory).map(([id]) => id).sort((a, b) => {
      const rarity = (RARITY_ORDER[itemDefs[a]?.rarity ?? ''] ?? 99) - (RARITY_ORDER[itemDefs[b]?.rarity ?? ''] ?? 99);
      return rarity !== 0 ? rarity : (itemDefs[a]?.name ?? a).localeCompare(itemDefs[b]?.name ?? b);
    });
    if (ids.length === 0) {
      return `<div class="trade-picker-list"><div class="trade-empty">${emptyText}</div></div>`;
    }
    const rows = ids.map(id => {
      const def = itemDefs[id];
      const color = def ? (RARITY_COLORS[def.rarity] ?? '#e8e8e8') : '#e8e8e8';
      const owned = inventory[id] ?? 0;
      const selected = selection.get(id) ?? 0;
      const effect = def ? getItemEffectText(def, skillDefs) : '';
      const itemAttr = `data-item-id="${this.escapeHtml(id)}"`;
      return `<div class="trade-picker-row${selected > 0 ? ' selected' : ''}">
        ${this.tradeItemIcon(id, def)}
        <div class="trade-picker-info">
          <span class="trade-item-name" style="color:${color}">${this.escapeHtml(def?.name ?? id)}</span>
          ${effect ? `<span class="trade-item-effect-small">${this.escapeHtml(effect)}</span>` : ''}
          <span class="trade-item-count">You have ${owned}</span>
        </div>
        <div class="trade-picker-qty">
          <button type="button" class="${kind}-qty-dec" ${itemAttr} aria-label="One less"${selected === 0 ? ' disabled' : ''}>−</button>
          <span class="trade-qty-val">${selected}</span>
          <button type="button" class="${kind}-qty-inc" ${itemAttr} aria-label="One more"${selected >= owned ? ' disabled' : ''}>+</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="trade-picker-list">${rows}</div>`;
  }

  /**
   * Fingerprint of the trade state + local selection. Used to skip the
   * tick-driven re-render when nothing has actually changed.
   */
  private computeTradeRenderKey(trade: TradeState | null): string {
    const selStr = Array.from(this.tradeSelectedItems.entries())
      .map(([id, qty]) => `${id}:${qty}`)
      .sort()
      .join(',');
    const noticeStr = `${this.tradeNotice ?? ''}|${this.tradeAwaitingReview ? 'review' : ''}`;
    if (!trade) {
      return `new|${this.tradeTargetUsername ?? ''}|${selStr}|${noticeStr}`;
    }
    const offerStr = (items: TradeOfferItem[]): string =>
      items.map(i => `${i.itemId}:${i.quantity}`).sort().join(',');
    return [
      trade.id,
      trade.status,
      trade.lastUpdatedBy,
      // Rotates on every offer change, so a stale paint can never be skipped.
      trade.nonce,
      offerStr(trade.initiator.items),
      offerStr(trade.target?.items ?? []),
      selStr,
      noticeStr,
    ].join('|');
  }

  dismissTradeModal(): void {
    this.unsubTradeModal?.();
    this.unsubTradeModal = undefined;
    if (this.tradeModalEl) {
      release(this.tradeModalEl);
      this.tradeModalEl.remove();
      this.tradeModalEl = null;
    }
    this.tradeSelectedItems = new Map();
    this.tradeActiveId = null;
    this.tradeTargetUsername = null;
    this.tradeInventorySnapshot = null;
    this.lastTradeRenderKey = '';
    this.tradeConfirmNonce = null;
    this.tradeNotice = null;
    this.tradeAwaitingReview = false;
    this.tradeConfirmArmed = false;
  }

  // ── Gift Modal ────────────────────────────────────────────────

  openGiftModal(targetUsername: string): void {
    this.giftTargetUsername = targetUsername;
    this.giftSelectedItems = new Map();
    this.renderGiftModal();
  }

  private renderGiftModal(): void {
    if (this.giftModalEl) {
      this.giftModalEl.remove();
      this.giftModalEl = null;
    }
    const overlay = document.createElement('div');
    overlay.className = 'trade-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'trade-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    overlay.appendChild(modal);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { this.dismissGiftModal(); return; }
      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn) return;

      if (btn.matches('.gift-close-btn')) { this.dismissGiftModal(); return; }

      if (btn.matches('.gift-qty-inc, .gift-qty-dec')) {
        const delta = btn.matches('.gift-qty-inc') ? 1 : -1;
        if (this.stepQuantity(this.giftSelectedItems, btn.getAttribute('data-item-id'), delta, this.lastState?.character?.inventory ?? {})) {
          this.updateGiftModal();
        }
        return;
      }

      if (btn.matches('.gift-send-btn')) {
        if (!this.giftTargetUsername) return;
        const target = this.giftTargetUsername;
        // Send each item entry as its own gift so the mailbox has separate stacks.
        for (const [itemId, quantity] of this.giftSelectedItems) {
          this.gameClient.sendGift(target, itemId, quantity);
        }
        this.dismissGiftModal();
        return;
      }
    });

    document.body.appendChild(overlay);
    this.giftModalEl = overlay;
    bringToFront(overlay, () => this.dismissGiftModal());
    wireFocusOnInteract(overlay);
    this.updateGiftModal();
  }

  private updateGiftModal(): void {
    const overlay = this.giftModalEl;
    if (!overlay) return;
    const modal = overlay.querySelector('.trade-modal');
    if (!modal) return;

    const inventory = this.lastState?.character?.inventory ?? {};
    const target = this.giftTargetUsername ?? '';
    const selItems: TradeOfferItem[] = Array.from(this.giftSelectedItems.entries())
      .map(([itemId, quantity]) => ({ itemId, quantity }));

    const summary = selItems.length === 0
      ? '<div class="trade-item-card trade-item-empty"><div class="trade-item-none">No items selected</div></div>'
      : this.offerCardHtml(selItems, 'You will gift');

    this.paintSheetModal(modal, `Send gift to ${this.escapeHtml(target)}`, 'gift-close-btn', `
      <div class="trade-status">Gifts arrive in their mailbox. They can accept or decline; declined gifts return to your mailbox.</div>
      ${summary}
      <div class="trade-picker-label">Select items to gift</div>
      ${this.itemPickerHtml('gift', inventory, this.giftSelectedItems, 'No giftable items in your inventory')}
    `, `<button type="button" class="social-action-btn add-friend gift-send-btn"${selItems.length > 0 ? '' : ' disabled'}>Send Gift${this.selectionSuffix(this.giftSelectedItems)}</button>`);
  }

  dismissGiftModal(): void {
    if (this.giftModalEl) {
      release(this.giftModalEl);
      this.giftModalEl.remove();
      this.giftModalEl = null;
    }
    this.giftTargetUsername = null;
    this.giftSelectedItems = new Map();
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

  /** Pick a henchman up for tap-to-move, or put down whatever is held (null). */
  private setGridPickedUp(instanceId: string | null): void {
    this.gridPickedUpHenchmanId = instanceId;
    this.paintGridPickedUp();
  }

  private paintGridPickedUp(): void {
    for (const cell of this.panelContainer.querySelectorAll<HTMLElement>('.social-party-cell[data-henchman-instance]')) {
      const held = cell.getAttribute('data-henchman-instance') === this.gridPickedUpHenchmanId;
      cell.classList.toggle('grid-picked-up', held);
    }
  }

  /** Animate a cell tilting and sliding toward targetPos — the current player's, or a henchman's when named. */
  private animateGridMove(targetPos: number, henchmanInstanceId?: string | null): void {
    const party = this.lastSocial?.party;
    if (!party) return;
    let srcPos: number | undefined;
    if (henchmanInstanceId) {
      srcPos = (party.henchmen ?? []).find(h => h.instanceId === henchmanInstanceId)?.gridPosition;
    } else {
      const selfUsername = this.lastState?.username;
      if (!selfUsername) return;
      srcPos = party.members.find(m => m.username === selfUsername)?.gridPosition;
    }
    if (srcPos === undefined) return;

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

    const colSteps = srcRect.width > 0 ? Math.round(dx / srcRect.width) : 0;
    const rowSteps = srcRect.height > 0 ? Math.round(dy / srcRect.height) : 0;
    const tiltDeg = colSteps * 8 + rowSteps * 4;

    sourceCell.style.setProperty('--tilt', `${tiltDeg}deg`);
    sourceCell.style.setProperty('--move-x', `${dx}px`);
    sourceCell.style.setProperty('--move-y', `${dy}px`);

    this.gridAnimating = true;
    void sourceCell.offsetWidth;
    sourceCell.classList.add('grid-move-anim');

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(fallback);
      this.gridMoveFinish = null;
      sourceCell.classList.remove('grid-move-anim');
      sourceCell.style.removeProperty('--tilt');
      sourceCell.style.removeProperty('--move-x');
      sourceCell.style.removeProperty('--move-y');
      this.swapGridCells(sourceCell, targetCell);
      this.gridAnimating = false;
      this.scheduleGridResync();
    };
    // animationend never fires if the cell leaves the DOM mid-move, which would freeze the panel.
    const fallback = setTimeout(finish, GRID_MOVE_MS + 120);
    sourceCell.addEventListener('animationend', finish, { once: true });
    this.gridMoveFinish = finish;
  }

  /** Shows the move immediately, ahead of the server's answer. */
  private swapGridCells(a: HTMLElement, b: HTMLElement): void {
    const aHtml = a.innerHTML;
    const aLabel = a.getAttribute('aria-label') ?? '';
    const bLabel = b.getAttribute('aria-label') ?? '';
    const aFlags = { occupied: a.classList.contains('occupied'), self: a.classList.contains('self') };
    const aHench = a.getAttribute('data-henchman-instance');
    const bHench = b.getAttribute('data-henchman-instance');
    a.innerHTML = b.innerHTML;
    a.classList.toggle('occupied', b.classList.contains('occupied'));
    a.classList.toggle('self', b.classList.contains('self'));
    a.setAttribute('aria-label', bLabel);
    b.innerHTML = aHtml;
    b.classList.toggle('occupied', aFlags.occupied);
    b.classList.toggle('self', aFlags.self);
    b.setAttribute('aria-label', aLabel);
    if (bHench) a.setAttribute('data-henchman-instance', bHench);
    else a.removeAttribute('data-henchman-instance');
    if (aHench) b.setAttribute('data-henchman-instance', aHench);
    else b.removeAttribute('data-henchman-instance');
  }

  /** A refused move produces no state change, so nothing else would undo the optimistic swap. */
  private scheduleGridResync(): void {
    this.gridOptimistic = true;
    clearTimeout(this.gridResyncTimer);
    this.gridResyncTimer = setTimeout(() => {
      if (!this.gridOptimistic || !this.isActive || this.activeTab !== 'party' || this.gridDragging) return;
      deferWhilePressed(this.panelContainer, () => this.renderPartyPanel());
    }, GRID_RESYNC_MS);
  }

  private onGridDragStart(e: MouseEvent | TouchEvent): void {
    if (this.gridDragging || ('button' in e && e.button !== 0)) return;
    const target = (e.target as HTMLElement).closest('.social-party-cell.occupied[data-pos]') as HTMLElement | null;
    if (!target) return;

    const pos = parseInt(target.getAttribute('data-pos')!, 10);
    const party = this.lastSocial?.party;
    const selfUsername = this.lastState?.username;
    if (!party || !selfUsername) return;

    const member = party.members.find(m => m.gridPosition === pos);
    if (member && member.username !== selfUsername) return;
    const henchman = member ? undefined : (party.henchmen ?? []).find(h => h.gridPosition === pos);
    if (!member && !henchman) return;
    if (henchman && !this.canManageHenchmen) return;

    e.preventDefault();
    this.gridDragging = true;
    this.gridDragSourcePos = pos;
    this.gridDragHenchmanId = henchman?.instanceId ?? null;

    const ghost = document.createElement('div');
    ghost.className = 'party-drag-ghost';
    ghost.innerHTML = henchman
      ? `${this.henchmanPortrait(henchman)} ${this.henchmanName(henchman)}`
      : `${this.classIcon(this.getPlayerClassName(selfUsername))} ${this.escapeHtml(selfUsername)}`;
    document.body.appendChild(ghost);
    this.gridDragGhost = ghost;
    this.moveGridGhost(this.getPointerXY(e));

    document.addEventListener('mousemove', this.onDocumentDragMove);
    document.addEventListener('touchmove', this.onDocumentDragMove, { passive: false });
    document.addEventListener('mouseup', this.onDocumentDragEnd);
    document.addEventListener('touchend', this.onDocumentDragEnd);
    document.addEventListener('touchcancel', this.onDocumentDragCancel);
  }

  private moveGridGhost(point: { clientX: number; clientY: number }): void {
    if (this.gridDragGhost) this.gridDragGhost.style.transform = `translate(${point.clientX - 20}px, ${point.clientY - 16}px)`;
  }

  private onGridDragMove(e: MouseEvent | TouchEvent): void {
    if (!this.gridDragging || !this.gridDragGhost) return;
    e.preventDefault();
    const point = this.getPointerXY(e);
    this.moveGridGhost(point);

    const under = document.elementFromPoint(point.clientX, point.clientY)?.closest<HTMLElement>('.social-party-cell[data-pos]') ?? null;
    const hover = under && parseInt(under.getAttribute('data-pos')!, 10) !== this.gridDragSourcePos ? under : null;
    if (hover === this.gridDragHoverCell) return;
    this.gridDragHoverCell?.classList.remove('drag-hover-green', 'drag-hover-red');
    this.gridDragHoverCell = hover;
    hover?.classList.add(hover.classList.contains('occupied') ? 'drag-hover-red' : 'drag-hover-green');
  }

  /** Clears drag state and its document listeners. Safe to call when no drag is running. */
  private cancelGridDrag(): void {
    if (!this.gridDragging) return;
    this.gridDragging = false;
    this.gridDragHenchmanId = null;
    this.gridDragSourcePos = null;
    this.gridDragGhost?.remove();
    this.gridDragGhost = null;
    this.gridDragHoverCell?.classList.remove('drag-hover-green', 'drag-hover-red');
    this.gridDragHoverCell = null;
    document.removeEventListener('mousemove', this.onDocumentDragMove);
    document.removeEventListener('touchmove', this.onDocumentDragMove);
    document.removeEventListener('mouseup', this.onDocumentDragEnd);
    document.removeEventListener('touchend', this.onDocumentDragEnd);
    document.removeEventListener('touchcancel', this.onDocumentDragCancel);
  }

  private onGridDragEnd(e: MouseEvent | TouchEvent): void {
    if (!this.gridDragging) return;
    const draggedHenchmanId = this.gridDragHenchmanId;
    const sourcePos = this.gridDragSourcePos;
    const { clientX, clientY } = this.getPointerXY(e);
    this.cancelGridDrag();

    const cell = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.social-party-cell[data-pos]');
    if (!cell) return;
    const pos = parseInt(cell.getAttribute('data-pos')!, 10);
    if (isNaN(pos)) return;

    if (pos === sourcePos) {
      // Tap handled here, not in the click handler: onGridDragStart's preventDefault eats the synthetic touch click.
      this.setGridPickedUp(draggedHenchmanId && draggedHenchmanId !== this.gridPickedUpHenchmanId ? draggedHenchmanId : null);
    } else if (cell.classList.contains('occupied')) {
      this.flashGridCell(cell);
    } else {
      this.setGridPickedUp(null);
      this.animateGridMove(pos, draggedHenchmanId);
      this.gameClient.sendSetPartyGridPosition(pos, draggedHenchmanId ?? undefined);
    }
  }

  private getPointerXY(e: MouseEvent | TouchEvent): { clientX: number; clientY: number } {
    if ('touches' in e) {
      const t = e.changedTouches?.[0] ?? e.touches?.[0];
      return t ? { clientX: t.clientX, clientY: t.clientY } : { clientX: 0, clientY: 0 };
    }
    return { clientX: (e as MouseEvent).clientX, clientY: (e as MouseEvent).clientY };
  }

  // ── Player Profile Modal ─────────────────────────────

  private showPlayerProfile(username: string): void {
    this.gameClient.sendViewPlayer(username);

    const unsub = this.gameClient.onPlayerProfile((profile) => {
      if (profile.username !== username) return;
      unsub();
      this.renderPlayerProfileModal(profile);
    });
  }

  private renderPlayerProfileModal(profile: PlayerProfileMessage): void {
    // Dismiss any existing profile modal
    const existing = document.querySelector('.player-profile-overlay') as HTMLElement | null;
    if (existing) {
      release(existing);
      existing.remove();
    }

    const overlay = document.createElement('div');
    overlay.className = 'player-profile-overlay';

    const modal = document.createElement('div');
    modal.className = 'player-profile-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    overlay.appendChild(modal);

    const dismiss = (): void => {
      release(overlay);
      overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) dismiss();
    });

    const icon = classIconHtml(profile.className);

    // Equipment section
    // Mainhand/offhand sit at the bottom of their respective columns now —
    // no separate bottom row. A small CSS gap separates them visually.
    const LEFT_SLOTS = ['head', 'shoulders', 'chest', 'gloves', 'foot', 'mainhand'];
    const RIGHT_SLOTS = ['back', 'necklace', 'bracers', 'ring', 'relic', 'offhand'];

    const renderProfileSlot = (slot: string) => {
      const itemId = profile.equipment[slot];
      const def = itemId ? profile.itemDefinitions[itemId] : null;
      const dataAttrs: Record<string, string> = { slot, 'item-id': itemId ?? '' };
      if (def && itemId) {
        return renderItemIcon(itemId, def, {
          showSlotIcon: true,
          slotOverride: slot,
          extraClass: 'profile-slot-square',
          dataAttrs,
        });
      }
      return renderEmptySlotIcon(slot, {
        extraClass: 'profile-slot-square',
        dataAttrs,
      });
    };

    const leftSlotsHtml = LEFT_SLOTS.map(renderProfileSlot).join('');
    const rightSlotsHtml = RIGHT_SLOTS.map(renderProfileSlot).join('');

    const portraitHtml = renderAssetImg('class', profile.className, {
      label: profile.className,
      width: 360,
      height: 440,
      className: 'profile-portrait-img',
      alt: `${profile.className} portrait`,
      glyph: CLASS_GLYPHS[profile.className],
    });

    const equipHtml = `
      <div class="profile-equip-panel">
        <div class="profile-equip-col profile-equip-left">${leftSlotsHtml}</div>
        <div class="profile-equip-figure profile-portrait">${portraitHtml}</div>
        <div class="profile-equip-col profile-equip-right">${rightSlotsHtml}</div>
      </div>`;


    // Skills section — slots come from the PROFILE player's class schedule;
    // skills resolve via the cross-class catalog so any player renders.
    const skillHtml = this.worldCache.getSlotSchedule(profile.className).map((slot, i) => {
      const skillId = profile.skillLoadout.equippedSkills[i];
      const skill = skillId ? this.worldCache.getSkill(skillId) : null;
      const isUnlocked = profile.level >= slot.unlocksAtLevel;
      if (!isUnlocked) {
        return `<div class="profile-skill-slot locked">
          <span class="profile-skill-type">${slot.type}</span>
          <span class="profile-skill-name">Locked (Lv ${slot.unlocksAtLevel})</span>
        </div>`;
      }
      if (!skill) {
        return `<div class="profile-skill-slot empty">
          <span class="profile-skill-type">${slot.type}</span>
          <span class="profile-skill-name">Empty</span>
        </div>`;
      }
      return `<div class="profile-skill-slot ${skill.type}">
        <span class="profile-skill-type">${skill.type}</span>
        <span class="profile-skill-name">${this.escapeHtml(skill.name)}</span>
        ${renderSkillCardMeta(skill, profile.className)}
      </div>`;
    }).join('');
    const attack = classAttackSkill(profile.className, this.worldCache.getSkillContent().skills);
    const attackHtml = attack
      ? `<div class="profile-skill-slot attack">
        <span class="profile-skill-type">Always on</span>
        <span class="profile-skill-name">${this.escapeHtml(attack.name)}</span>
        ${renderSkillCardMeta(attack, profile.className)}
      </div>`
      : '';

    // Party members section
    const partyHtml = profile.partyMembers.length > 1
      ? profile.partyMembers.map(m => {
        const memberIcon = classIconHtml(m.className);
        const lvl = m.level ? ` Lv ${m.level}` : '';
        return `<div class="profile-party-member">${memberIcon} ${this.escapeHtml(m.username)}${lvl}</div>`;
      }).join('')
      : '<div class="profile-empty">Solo</div>';

    modal.innerHTML = `
      <div class="profile-header">
        <span class="profile-class-icon">${icon}</span>
        <span class="profile-name">${this.escapeHtml(profile.username)}</span>
        <span class="profile-level">Lv ${profile.level}</span>
        <button type="button" class="social-modal-close profile-close-btn" aria-label="Close">✕</button>
      </div>
      <div class="player-profile-body">
        <div class="profile-class">${this.escapeHtml(profile.className)}</div>
        <div class="profile-guild">${profile.guildName ? this.escapeHtml(profile.guildName) : 'No Guild'}</div>
        <div class="profile-section-label">Equipment</div>
        ${equipHtml}
        <div class="profile-section-label">Skills</div>
        <div class="profile-skills">${attackHtml}${skillHtml}</div>
        <div class="profile-section-label">Party</div>
        <div class="profile-party">${partyHtml}</div>
      </div>
    `;

    modal.querySelector('.profile-close-btn')!.addEventListener('click', dismiss);

    // Wire equipment square clicks to show read-only item popup
    const setDefs = profile.setDefinitions ?? {};
    const equippedItemIds = getEquippedItemIds(profile.equipment);
    const profileClassName = profile.className;

    for (const el of modal.querySelectorAll('.profile-slot-square')) {
      el.addEventListener('click', () => {
        const itemId = el.getAttribute('data-item-id');
        if (!itemId) return;
        const def = profile.itemDefinitions[itemId];
        if (!def) return;
        this.showProfileItemPopup(def, setDefs, equippedItemIds, profileClassName, el as HTMLElement);
      });
    }

    document.body.appendChild(overlay);
    bringToFront(overlay, dismiss);
    wireFocusOnInteract(overlay);
  }

  private showProfileItemPopup(
    def: ItemDefinition,
    setDefs: Record<string, SetDefinition>,
    equippedItemIds: Set<string>,
    profileClassName: string,
    _anchor: HTMLElement,
  ): void {
    // Remove any existing popup
    const previous = document.querySelector<HTMLElement>('.profile-item-popup-overlay');
    if (previous) {
      release(previous);
      previous.remove();
    }

    // Use the profile's item defs (sent with the profile message). Fall back to the
    // viewer's itemDefinitions only as a last resort — don't merge their item names
    // into another player's profile.
    const profileMsg = this.gameClient.lastState;
    const itemDefs = profileMsg?.itemDefinitions ?? {};
    const popupContent = renderItemPopupContent(def, {
      itemDefs,
      setDefs,
      ownedItemIds: equippedItemIds,
      equippedItemIds,
      className: profileClassName,
      skills: this.worldCache.getSkillContent().skills,
      actionsHtml: '<button class="profile-item-close-btn">Close</button>',
    });

    const overlay = document.createElement('div');
    overlay.className = 'profile-item-popup-overlay item-popup-overlay';
    overlay.innerHTML = `<div class="item-popup">${popupContent}</div>`;

    const dismiss = () => { release(overlay); overlay.remove(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
    overlay.querySelector('.profile-item-close-btn')!.addEventListener('click', dismiss);

    document.body.appendChild(overlay);
    bringToFront(overlay, dismiss);
    wireFocusOnInteract(overlay);
  }
}
