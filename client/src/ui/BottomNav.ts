import type { GameClient } from '../network/GameClient';

export type NavMode = 'screen' | 'overlay' | 'submenu';

export interface NavSubmenuItem {
  id: string;
  label: string;
  /** Optional badge predicate keyed off game state (returns true when this row should show a dot). */
  badge?: 'friend-requests' | 'party-invites';
}

export interface NavTabConfig {
  id: string;
  label: string;
  icon: string;
  /**
   * - `screen` (default): switches the active screen.
   * - `overlay`: toggles a UI overlay without changing the active screen (Chat).
   * - `submenu`: opens a fly-out submenu above the tab. Each submenu item can
   *   route to a screen (with optional sub-tab id) via `onSubmenuPick`.
   */
  mode?: NavMode;
  /** Submenu items shown when this tab is clicked (only when mode === 'submenu'). */
  submenu?: NavSubmenuItem[];
}

/**
 * Bottom nav with restyled buttons (depth/shadow), proper active indication,
 * support for overlay tabs (Chat pop-out), and fly-out submenus (Social).
 */
export class BottomNav {
  private container: HTMLElement;
  private tabButtons = new Map<string, HTMLElement>();
  private activeId: string;
  private overlayActiveIds = new Set<string>();
  private chatHasUnread = false;
  private openSubmenuTabId: string | null = null;
  private submenuEl: HTMLElement | null = null;
  /** Latest social state — used to drive submenu badges. */
  private hasFriendRequests = false;
  private hasPartyInvites = false;

  constructor(
    tabs: NavTabConfig[],
    defaultTab: string,
    /** Fires whenever a screen tab is clicked. `wasActive` is true when the
     *  user re-clicked the already-active tab (e.g. for "tap Map again to
     *  recenter on player"). */
    private onTabChange: (tabId: string, wasActive: boolean) => void,
    gameClient: GameClient,
    private onOverlayToggle?: (tabId: string, currentlyActive: boolean) => void,
    private onSubmenuPick?: (tabId: string, itemId: string) => void,
  ) {
    this.activeId = defaultTab;
    this.container = document.getElementById('bottom-nav')!;
    this.container.innerHTML = '';

    for (const tab of tabs) {
      const button = document.createElement('button');
      const mode: NavMode = tab.mode ?? 'screen';
      button.className = `nav-tab nav-tab-${mode}${tab.id === defaultTab ? ' active' : ''}`;
      button.dataset.screen = tab.id;
      button.dataset.mode = mode;

      button.innerHTML = `
        <span class="nav-tab-bg"></span>
        <span class="nav-icon">${tab.icon}</span>
        <span class="nav-label">${tab.label}</span>
        <span class="nav-badge"></span>
        <span class="nav-active-bar"></span>
      `;

      button.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleClick(tab);
      });

      this.container.appendChild(button);
      this.tabButtons.set(tab.id, button);
    }

    // Outside-click closes any open submenu.
    document.addEventListener('click', () => this.closeSubmenu());

    this.wireStatusIndicators(gameClient);
  }

  private handleClick(tab: NavTabConfig): void {
    const mode: NavMode = tab.mode ?? 'screen';

    if (mode === 'submenu') {
      // Re-clicking the same tab toggles the submenu closed.
      if (this.openSubmenuTabId === tab.id) {
        this.closeSubmenu();
        return;
      }
      this.closeSubmenu();
      this.openSubmenu(tab);
      return;
    }

    this.closeSubmenu();

    if (mode === 'overlay') {
      const wasActive = this.overlayActiveIds.has(tab.id);
      const button = this.tabButtons.get(tab.id);
      if (wasActive) {
        this.overlayActiveIds.delete(tab.id);
        button?.classList.remove('overlay-active');
      } else {
        this.overlayActiveIds.add(tab.id);
        button?.classList.add('overlay-active');
        if (tab.id === 'chat') {
          this.chatHasUnread = false;
          this.updateChatBadge();
        }
      }
      this.onOverlayToggle?.(tab.id, !wasActive);
      return;
    }

    // Re-clicking the active tab still fires onTabChange — the App can
    // interpret a re-click (e.g. recenter the map on the player) instead
    // of swallowing the event silently.
    const wasActive = this.activeId === tab.id;
    this.setActive(tab.id);
    sessionStorage.setItem('activeScreen', tab.id);
    this.onTabChange(tab.id, wasActive);
  }

  setActive(id: string): void {
    if (this.activeId === id) return;
    const prev = this.tabButtons.get(this.activeId);
    if (prev) prev.classList.remove('active');
    const next = this.tabButtons.get(id);
    if (next) next.classList.add('active');
    this.activeId = id;
  }

  /** External: mark an overlay (Chat) as opened/closed (e.g. when user closes it from the popout itself). */
  setOverlayActive(id: string, active: boolean): void {
    const button = this.tabButtons.get(id);
    if (!button) return;
    if (active) {
      this.overlayActiveIds.add(id);
      button.classList.add('overlay-active');
    } else {
      this.overlayActiveIds.delete(id);
      button.classList.remove('overlay-active');
    }
  }

  /** External: update chat unread state (driven by ChatPopout). */
  setChatUnread(hasUnread: boolean): void {
    this.chatHasUnread = hasUnread;
    this.updateChatBadge();
  }

  // ── Submenu fly-out ────────────────────────────────────────

  private openSubmenu(tab: NavTabConfig): void {
    if (!tab.submenu || tab.submenu.length === 0) return;
    const button = this.tabButtons.get(tab.id);
    if (!button) return;

    this.openSubmenuTabId = tab.id;
    button.classList.add('submenu-open');

    const fly = document.createElement('div');
    fly.className = 'nav-submenu';
    fly.addEventListener('click', (e) => e.stopPropagation());

    for (const item of tab.submenu) {
      const row = document.createElement('button');
      row.className = 'nav-submenu-item';
      row.dataset.item = item.id;
      const showBadge =
        (item.badge === 'friend-requests' && this.hasFriendRequests) ||
        (item.badge === 'party-invites' && this.hasPartyInvites);
      row.innerHTML = `<span class="nav-submenu-label">${item.label}</span>${showBadge ? '<span class="nav-submenu-badge"></span>' : ''}`;
      row.addEventListener('click', () => {
        this.closeSubmenu();
        this.onSubmenuPick?.(tab.id, item.id);
      });
      fly.appendChild(row);
    }

    document.body.appendChild(fly);
    this.submenuEl = fly;

    // Position the fly-out above the button, horizontally centered, then nudge into viewport.
    requestAnimationFrame(() => {
      const btnRect = button.getBoundingClientRect();
      const flyRect = fly.getBoundingClientRect();
      const margin = 8;
      let left = btnRect.left + btnRect.width / 2 - flyRect.width / 2;
      left = Math.max(margin, Math.min(window.innerWidth - flyRect.width - margin, left));
      const top = btnRect.top - flyRect.height - 6;
      fly.style.left = `${left}px`;
      fly.style.top = `${Math.max(margin, top)}px`;
      fly.classList.add('nav-submenu-shown');
    });
  }

  private closeSubmenu(): void {
    if (this.submenuEl) {
      this.submenuEl.remove();
      this.submenuEl = null;
    }
    if (this.openSubmenuTabId) {
      this.tabButtons.get(this.openSubmenuTabId)?.classList.remove('submenu-open');
      this.openSubmenuTabId = null;
    }
  }

  private updateChatBadge(): void {
    const tab = this.tabButtons.get('chat');
    if (!tab) return;
    const badge = tab.querySelector('.nav-badge');
    if (!badge) return;
    badge.classList.toggle('visible', this.chatHasUnread);
  }

  private wireStatusIndicators(gameClient: GameClient): void {
    let lastVisual = '';

    gameClient.subscribe((state) => {
      const combatTab = this.tabButtons.get('combat');
      const mapTab = this.tabButtons.get('map');
      const visual = state.battle.visual;

      if (combatTab) {
        combatTab.classList.remove('fighting-pulse', 'victory-flash', 'defeat-flash');
        if (visual === 'fighting') {
          combatTab.classList.add('fighting-pulse');
        } else if (visual === 'victory' && lastVisual === 'fighting') {
          combatTab.classList.add('victory-flash');
        } else if (visual === 'defeat' && lastVisual === 'fighting') {
          combatTab.classList.add('defeat-flash');
        }
      }

      if (mapTab) {
        const isMoving = state.party.path.length > 0;
        mapTab.classList.toggle('has-path', isMoving);
      }

      const social = state.social;
      this.hasFriendRequests = (social?.incomingFriendRequests?.length ?? 0) > 0;
      this.hasPartyInvites = (social?.pendingInvites?.length ?? 0) > 0;

      const socialTab = this.tabButtons.get('social');
      if (socialTab) {
        const badge = socialTab.querySelector('.nav-badge');
        if (badge) badge.classList.toggle('visible', this.hasFriendRequests || this.hasPartyInvites);
      }

      // Items badge: gifts in mailbox or trades needing attention
      const itemsTab = this.tabButtons.get('items');
      if (itemsTab && social) {
        const selfUsername = state.username ?? '';
        const hasMailbox = (social.mailbox?.length ?? 0) > 0;
        const tradeNeedsAction = (social.proposedTrades ?? []).some(t =>
          t.lastUpdatedBy && t.lastUpdatedBy !== selfUsername,
        );
        const badge = itemsTab.querySelector('.nav-badge');
        if (badge) badge.classList.toggle('visible', hasMailbox || tradeNeedsAction);
      }

      lastVisual = visual;
    });
  }
}
