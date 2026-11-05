import type { ChatChannelType, ChatMessage, ServerErrorCode, ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { chatFocusTracker } from '../network/ChatFocusTracker';
import { artworkUrl, placeholderInitials, renderTrackedImg } from './assets';
import {
  buildDmThreads,
  CHANNEL_LABELS,
  chatMembership,
  chatPreview,
  ChatLog,
  CHAT_ROW_CAP,
  canonicalUsername,
  DEFAULT_CHAT_FILTERS,
  escapeChatHtml,
  FILTER_CHANNELS,
  formatChatTime,
  isBlockedMessage,
  isSameChatDay,
  isShownInView,
  renderChatRow,
  renderChatRows,
  renderDaySeparator,
  resolveSendTarget,
  sameUser,
  sendableChannels,
} from './chatModel';
import type { ChatAudience, ChatFilters, ChatMembership, ChatPreview, ChatRowOptions, ChatTab, ChatView } from './chatModel';
import { wireVerticalSwipe } from './ChatStrip';
import { countText } from './countText';
import { bringToFront, registerDismiss, release, setRaised, suspendDismiss } from './ModalStack';
import { deferWhilePressed, setHtml } from './render';

const STORAGE_KEY_FILTERS = 'chatPopoutFilters';
const STORAGE_KEY_MOBILE_LAYOUT = 'chatPopoutMobileLayout';
const STORAGE_KEY_OPEN = 'chatPopoutOpen';
const STORAGE_KEY_LAST_SEEN = 'chatLastSeenAt';

const DESKTOP_COLUMN_QUERY = '(min-width: 860px)';
const SHORT_LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 500px)';
const DOCKED_COLUMN_QUERY = `${DESKTOP_COLUMN_QUERY}, ${SHORT_LANDSCAPE_QUERY}`;
const COARSE_POINTER_QUERY = '(pointer: coarse)';
const FINE_POINTER_QUERY = '(pointer: fine)';

const PREVIEW_MIN_INTERVAL_MS = 1000;
const STATUS_VISIBLE_MS = 6000;
const AT_BOTTOM_SLOP_PX = 24;
/** A send still unanswered after this long is forgotten, so a lost reply can't pair a later refusal with it. */
const SEND_REPLY_WINDOW_MS = 30_000;
/** Long enough for a tap on a button to land before the layout snaps back from typing. */
const TYPING_EXIT_DELAY_MS = 150;
const KEYBOARD_SHOWN_MIN_SHRINK_PX = 120;
const KEYBOARD_GONE_MAX_SHRINK_PX = 60;

const ICON_FILTER = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1.5 2.5h13a.5.5 0 0 1 .4.8L10 9.2v4.3a.5.5 0 0 1-.8.4l-3-2a.5.5 0 0 1-.2-.4V9.2L1.1 3.3a.5.5 0 0 1 .4-.8z"/></svg>';
const ICON_EXPAND = '<svg class="chat-icon-expand" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 7.5 8 3l5 4.5M3 13l5-4.5 5 4.5"/></svg>';
const ICON_COLLAPSE = '<svg class="chat-icon-collapse" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 3l5 4.5L13 3M3 8.5 8 13l5-4.5"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M10 3 5 8l5 5"/></svg>';

type MobileLayout = 'full' | 'sheet';
type ChatLayout = MobileLayout | 'column';

const TABS: readonly { id: ChatTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'party', label: 'Party' },
  { id: 'guild', label: 'Guild' },
  { id: 'dm', label: 'DMs' },
];

function matches(query: string): boolean {
  return window.matchMedia?.(query).matches ?? false;
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

/**
 * Chat, docked in the shell rather than floating: a sheet or full panel on phones, a column on desktop.
 * See docs/architecture/client.md.
 */
export class ChatPopout {
  private root: HTMLElement;
  private window!: HTMLElement;
  private tabsRow!: HTMLElement;
  private filterToggle!: HTMLElement;
  private filterPop!: HTMLElement;
  private layoutBtn!: HTMLElement;
  private threadBar!: HTMLElement;
  private threadName!: HTMLButtonElement;
  private threadsEl!: HTMLElement;
  private timelineEl!: HTMLElement;
  private newPill!: HTMLElement;
  private statusEl!: HTMLElement;
  private composerEl!: HTMLElement;
  private channelSelect!: HTMLSelectElement;
  private dmInput!: HTMLInputElement;
  private inputEl!: HTMLInputElement;

  /** Held: a query list nothing references can be collected, and its change listener with it. */
  private columnQuery: MediaQueryList | undefined = window.matchMedia?.(DOCKED_COLUMN_QUERY);
  private gameClient: GameClient;
  private isOpen = false;
  private log = new ChatLog();
  private filters: ChatFilters;
  private mobileLayout: MobileLayout;
  private syncedOnce = false;
  private preferencesRestored = false;

  private tab: ChatTab = 'all';
  private thread: string | null = null;
  private allChannel: ChatChannelType = 'global';
  private membership: ChatMembership = { inParty: false, guildId: null };
  private blockedKey = '{}';

  private lastSeenAt: number;
  private seedLastSeenFromBacklog: boolean;
  private threadBaseline: number;
  private threadSeenAt = new Map<string, number>();
  private unreadTabs = new Set<ChatTab>();

  private timelineStale = true;
  private unrenderedRows: ChatMessage[] = [];
  private pendingRows = 0;
  private rowCount = 0;
  private lastRowTimestamp: number | null = null;
  private following = true;
  private scrollQueued = false;

  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPreviewAt = 0;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  /** Sends awaiting an echo or a refusal, oldest first. The server answers in send order. */
  private pendingSends: { text: string; target: string; at: number }[] = [];

  private typing = false;
  private typingExitTimer: ReturnType<typeof setTimeout> | undefined;
  private typingBaseHeight = 0;
  private keyboardSeen = false;

  private onClose?: () => void;
  private onUnreadChange?: (count: number) => void;
  private onPreviewChange?: (preview: ChatPreview) => void;
  private onUserClick?: (username: string, anchor: HTMLElement) => void;
  private unreadCount = 0;

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.filters = this.loadFilters();
    this.mobileLayout = readStorage(STORAGE_KEY_MOBILE_LAYOUT) === 'full' ? 'full' : 'sheet';

    const storedSeen = Number(readStorage(STORAGE_KEY_LAST_SEEN));
    this.seedLastSeenFromBacklog = !storedSeen;
    this.lastSeenAt = storedSeen || Date.now();
    if (!storedSeen) writeStorage(STORAGE_KEY_LAST_SEEN, String(this.lastSeenAt));
    this.threadBaseline = this.lastSeenAt;

    this.root = document.getElementById('chat-popout-root')!;
    this.buildDOM();

    gameClient.onChat((msg) => this.ingest([msg], false));
    gameClient.onSyncChat((messages) => this.ingest(messages, true));
    gameClient.subscribe((state) => this.handleState(state), { replay: true });
    gameClient.onResume(() => gameClient.sendSyncChat(this.log.latestId()));
    gameClient.onConnection((connected) => {
      this.pendingSends = [];
      if (connected) gameClient.sendSyncChat(this.log.latestId());
    });
    gameClient.onServerError((message, code) => this.handleServerError(message, code));
  }

  setOnClose(cb: () => void): void { this.onClose = cb; }

  /** Replays the current count on registration. */
  setOnUnreadChange(cb: (count: number) => void): void {
    this.onUnreadChange = cb;
    cb(this.unreadCount);
  }

  /** Replays the current preview on registration. Fires at most once a second. */
  setOnPreviewChange(cb: (preview: ChatPreview) => void): void {
    this.onPreviewChange = cb;
    this.paintPreview();
  }

  setOnUserClick(cb: (username: string, anchor: HTMLElement) => void): void {
    this.onUserClick = cb;
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.window.style.display = '';
    document.body.dataset.chatOpen = '1';
    this.applyLayout();
    this.refreshTabDots();
    this.markViewSeen();
    this.markAllSeen();
    if (this.timelineStale) this.rebuildView();
    this.gameClient.sendSyncChat(this.log.latestId());
    writeStorage(STORAGE_KEY_OPEN, '1');
    this.following = true;
    this.queueScrollToBottom();
    if (this.currentLayout() === 'column' && matches(FINE_POINTER_QUERY)) {
      this.inputEl.focus({ preventScroll: true });
    }
    this.reportChatFocus();
    this.paintPreview();
  }

  /** Open the panel on the DM thread with `username`. */
  openDm(username: string): void {
    this.open();
    this.showThread(username);
  }

  close(): void {
    if (!this.isOpen) return;
    this.exitTyping();
    this.setFilterPopOpen(false);
    this.markAllSeen();
    this.isOpen = false;
    this.window.style.display = 'none';
    release(this.root);
    delete document.body.dataset.chatOpen;
    delete document.body.dataset.chatLayout;
    writeStorage(STORAGE_KEY_OPEN, '0');
    this.onClose?.();
    this.reportChatFocus();
    this.paintPreview();
  }

  /** Whether chat should open at boot: remembered, and on the docked column open unless closed before. */
  wasOpen(): boolean {
    const stored = readStorage(STORAGE_KEY_OPEN);
    return stored === '1' || (stored === null && !!this.columnQuery?.matches);
  }

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  isVisible(): boolean { return this.isOpen; }

  /** The column as a phone in landscape shows it. The sheet and full layouts are on ModalStack, and the desktop column stays. */
  isLandscapeColumn(): boolean {
    return this.isOpen && this.currentLayout() === 'column' && matches(SHORT_LANDSCAPE_QUERY);
  }

  /** Closes a chat that covers the whole screen, so that what a navigation brings up can be seen. */
  closeIfCovering(): void {
    if (this.isOpen && (this.typing || this.currentLayout() === 'full')) this.close();
  }

  private buildDOM(): void {
    const tabs = TABS.map(tab => `
      <button type="button" class="chat-tab" role="tab" data-tab="${tab.id}" aria-selected="false">${tab.label}<span class="chat-tab-dot"></span></button>
    `).join('');
    const filters = FILTER_CHANNELS.map(ch => `
      <button type="button" class="chat-filter" data-ch="${ch}" aria-pressed="false"><span class="chat-filter-dot"></span>${CHANNEL_LABELS[ch]}</button>
    `).join('');

    this.root.innerHTML = `
      <section class="chat-popout" aria-label="Chat" style="display:none">
        <div class="chat-tabs-row">
          <div class="chat-tabs" role="tablist" aria-label="Chat views">${tabs}</div>
          <button type="button" class="chat-icon-btn chat-filter-toggle" aria-label="Filter channels" aria-expanded="false" title="Filter channels">${ICON_FILTER}<span class="chat-filter-mark"></span></button>
          <button type="button" class="chat-icon-btn chat-popout-layout-btn" aria-label="Expand chat" title="Expand">${ICON_EXPAND}${ICON_COLLAPSE}</button>
          <button type="button" class="chat-icon-btn chat-popout-close" aria-label="Close chat" title="Close">${ICON_CLOSE}</button>
        </div>
        <div class="chat-filter-pop" hidden>${filters}</div>
        <div class="chat-popout-body">
          <div class="chat-thread-bar" hidden>
            <button type="button" class="chat-thread-back" aria-label="All conversations">${ICON_BACK}</button>
            <button type="button" class="chat-thread-name"></button>
          </div>
          <div class="chat-threads" hidden></div>
          <div class="chat-popout-timeline" role="log" aria-label="Chat messages"></div>
          <button type="button" class="chat-new-pill" hidden></button>
          <div class="chat-status" role="status" hidden></div>
        </div>
        <div class="chat-popout-composer">
          <select class="chat-popout-channel" aria-label="Send to"></select>
          <input class="chat-popout-dm-target" type="text" placeholder="To…" aria-label="Who to message" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="display:none" />
          <input class="chat-popout-input" type="text" placeholder="Message…" aria-label="Message" maxlength="500" enterkeyhint="send" autocomplete="off" />
          <button type="button" class="chat-popout-send">Send</button>
        </div>
      </section>
    `;

    this.window = this.root.querySelector('.chat-popout')!;
    this.tabsRow = this.window.querySelector('.chat-tabs-row')!;
    this.filterToggle = this.window.querySelector('.chat-filter-toggle')!;
    this.filterPop = this.window.querySelector('.chat-filter-pop')!;
    this.layoutBtn = this.window.querySelector('.chat-popout-layout-btn')!;
    this.threadBar = this.window.querySelector('.chat-thread-bar')!;
    this.threadName = this.window.querySelector('.chat-thread-name')!;
    this.threadsEl = this.window.querySelector('.chat-threads')!;
    this.timelineEl = this.window.querySelector('.chat-popout-timeline')!;
    this.newPill = this.window.querySelector('.chat-new-pill')!;
    this.statusEl = this.window.querySelector('.chat-status')!;
    this.composerEl = this.window.querySelector('.chat-popout-composer')!;
    this.channelSelect = this.window.querySelector('.chat-popout-channel')!;
    this.dmInput = this.window.querySelector('.chat-popout-dm-target')!;
    this.inputEl = this.window.querySelector('.chat-popout-input')!;

    this.syncTabs();
    this.syncChannelOptions();
    this.syncFilterChips();
    this.syncComposer();

    this.wireHeader();
    this.wireFilters();
    this.wireThreads();
    this.wireTimeline();
    this.wireComposer();
    this.wireKeyboard();
    this.columnQuery?.addEventListener?.('change', () => this.applyLayout());
  }

  private wireHeader(): void {
    this.window.querySelector('.chat-tabs')!.addEventListener('click', (e) => {
      const tab = (e.target as Element).closest<HTMLElement>('[data-tab]')?.dataset.tab as ChatTab | undefined;
      if (tab) this.setTab(tab);
    });
    this.window.querySelector('.chat-popout-close')!.addEventListener('click', () => this.close());
    this.layoutBtn.addEventListener('click', () => this.setMobileLayout(this.mobileLayout === 'full' ? 'sheet' : 'full'));
    wireVerticalSwipe(this.tabsRow, {
      onSwipeDown: () => this.close(),
      onSwipeUp: () => {
        if (this.currentLayout() === 'sheet') this.setMobileLayout('full');
      },
    });
  }

  private setMobileLayout(layout: MobileLayout): void {
    this.mobileLayout = layout;
    writeStorage(STORAGE_KEY_MOBILE_LAYOUT, layout);
    this.applyLayout(true);
  }

  private currentLayout(): ChatLayout {
    return this.columnQuery?.matches ? 'column' : this.mobileLayout;
  }

  private applyLayout(promote = false): void {
    if (!this.isOpen) return;
    const layout = this.currentLayout();
    document.body.dataset.chatLayout = layout;
    const expanded = layout === 'full';
    this.layoutBtn.setAttribute('aria-label', expanded ? 'Shrink chat' : 'Expand chat');
    this.layoutBtn.title = expanded ? 'Shrink' : 'Expand';
    this.syncStack(promote);
  }

  /**
   * Only `full` and typing need a z-index, and a flow item with one would trap the sheet under the nav.
   * `promote` is for when the player just acted on chat: anything else keeps its place, so a popup opened since stays on top.
   */
  private syncStack(promote = false): void {
    if (!this.isOpen) return;
    const layout = this.currentLayout();
    const raised = this.typing || layout === 'full';
    if (promote && raised) bringToFront(this.root, () => this.close(), { holdFocus: false });
    else if (layout === 'column' && !this.typing) suspendDismiss(this.root);
    else registerDismiss(this.root, () => this.close());
    setRaised(this.root, raised);
  }

  private wireFilters(): void {
    this.filterToggle.addEventListener('click', () => this.setFilterPopOpen(this.filterPop.hidden));
    this.filterPop.addEventListener('click', (e) => {
      const chip = (e.target as Element).closest<HTMLElement>('.chat-filter');
      const channel = chip?.dataset.ch as ChatChannelType | undefined;
      if (!channel) return;
      this.filters[channel] = !this.filters[channel];
      writeStorage(STORAGE_KEY_FILTERS, JSON.stringify(this.filters));
      this.syncFilterChips();
      this.rebuildView();
      this.paintPreview();
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.filterPop.hidden) return;
      const target = e.target as Element;
      if (!this.filterPop.contains(target) && !this.filterToggle.contains(target)) this.setFilterPopOpen(false);
    }, true);
  }

  private setFilterPopOpen(open: boolean): void {
    if (open === !this.filterPop.hidden) return;
    this.filterPop.hidden = !open;
    this.filterToggle.setAttribute('aria-expanded', String(open));
    if (open) registerDismiss(this.filterPop, () => this.setFilterPopOpen(false));
    else release(this.filterPop);
  }

  private syncFilterChips(): void {
    let anyOff = false;
    for (const chip of this.filterPop.querySelectorAll<HTMLElement>('.chat-filter')) {
      const on = this.filters[chip.dataset.ch as ChatChannelType] !== false;
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', String(on));
      anyOff ||= !on;
    }
    this.filterToggle.classList.toggle('has-filters-off', anyOff);
  }

  private setTab(tab: ChatTab): void {
    if (tab === this.tab && (tab !== 'dm' || !this.thread)) return;
    this.tab = tab;
    this.thread = null;
    this.setFilterPopOpen(false);
    this.enterView();
  }

  private showThread(username: string): void {
    const canonical = canonicalUsername(username, this.gameClient.lastState?.social?.allPlayers);
    if (!canonical) return;
    this.tab = 'dm';
    this.thread = canonical;
    this.dmInput.value = canonical;
    this.enterView();
  }

  private enterView(): void {
    this.prepareView();
    this.rebuildView();
  }

  /** For a state push or server reply, which can land while a row is held down. */
  private enterViewDeferred(): void {
    this.prepareView();
    this.invalidateView();
  }

  private prepareView(): void {
    this.syncTabs();
    this.syncComposer();
    this.following = true;
    this.clearStatus();
    this.markViewSeen();
    this.reportChatFocus();
  }

  private currentView(): ChatView {
    return { tab: this.tab, thread: this.thread };
  }

  private audience(): ChatAudience {
    const state = this.gameClient.lastState;
    return { me: state?.username, blocked: state?.social?.blockedUsers ?? {}, filters: this.filters };
  }

  private syncTabs(): void {
    for (const button of this.window.querySelectorAll<HTMLElement>('.chat-tab')) {
      const id = button.dataset.tab as ChatTab;
      const selected = id === this.tab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.classList.toggle('has-unread', this.unreadTabs.has(id));
      if (id === 'party') button.hidden = !this.membership.inParty;
      if (id === 'guild') button.hidden = !this.membership.guildId;
    }
  }

  private syncChannelOptions(): void {
    const channels = sendableChannels(this.membership);
    this.channelSelect.innerHTML = channels
      .map(ch => `<option value="${ch}">${CHANNEL_LABELS[ch]}</option>`)
      .join('');
    if (!channels.includes(this.allChannel)) this.allChannel = 'global';
  }

  private syncComposer(): void {
    const onAll = this.tab === 'all';
    const locked = this.tab === 'party' || this.tab === 'guild';
    const channel = locked ? this.tab as ChatChannelType : onAll ? this.allChannel : 'dm';
    this.channelSelect.style.display = this.tab === 'dm' ? 'none' : '';
    this.channelSelect.disabled = locked;
    this.channelSelect.value = channel;
    this.channelSelect.dataset.ch = channel;
    const needsTarget = (onAll && channel === 'dm') || (this.tab === 'dm' && !this.thread);
    this.dmInput.style.display = needsTarget ? '' : 'none';
    this.inputEl.placeholder = this.thread ? `Message ${this.thread}…` : 'Message…';
  }

  private currentChannel(): ChatChannelType {
    if (this.tab === 'party' || this.tab === 'guild') return this.tab;
    return this.tab === 'dm' ? 'dm' : this.allChannel;
  }

  private wireThreads(): void {
    this.threadsEl.addEventListener('click', (e) => {
      const username = (e.target as Element).closest<HTMLElement>('.chat-thread')?.dataset.thread;
      if (username) this.showThread(username);
    });
    this.window.querySelector('.chat-thread-back')!.addEventListener('click', () => {
      this.thread = null;
      this.enterView();
    });
    this.threadName.addEventListener('click', () => {
      if (this.thread) this.onUserClick?.(this.thread, this.threadName);
    });
  }

  private renderThreadList(): void {
    const threads = buildDmThreads(this.log.messages, this.audience(), key => this.threadSeen(key));
    const players = this.gameClient.lastState?.social?.allPlayers;
    const me = this.gameClient.lastState?.username;
    const html = threads.map(thread => {
      const className = players?.find(p => p.username === thread.username)?.className;
      const art = className ? renderTrackedImg(artworkUrl('class', className), { className: 'chat-thread-art', alt: '' }) : '';
      const lastLine = `${thread.last.senderUsername === me ? 'You: ' : ''}${thread.last.text}`;
      const name = escapeChatHtml(thread.username);
      return `
        <button type="button" class="chat-thread${thread.unread ? ' has-unread' : ''}" data-thread="${name}">
          <span class="chat-thread-avatar">${art}<span class="chat-thread-initials">${escapeChatHtml(placeholderInitials(thread.username))}</span></span>
          <span class="chat-thread-main">
            <span class="chat-thread-who">${name}</span>
            <span class="chat-thread-last">${escapeChatHtml(lastLine)}</span>
          </span>
          <span class="chat-thread-time">${formatChatTime(thread.last.timestamp)}</span>
          <span class="chat-thread-dot"></span>
        </button>
      `;
    }).join('');
    setHtml(this.threadsEl, html || '<div class="ui-empty chat-empty">No conversations yet. Choose a player\'s name to message them, or type a name below.</div>');
  }

  private threadSeen(key: string): number {
    return this.threadSeenAt.get(key) ?? this.threadBaseline;
  }

  private syncDmDot(): void {
    const unread = buildDmThreads(this.log.messages, this.audience(), key => this.threadSeen(key)).some(t => t.unread);
    if (unread) this.unreadTabs.add('dm');
    else this.unreadTabs.delete('dm');
    this.syncTabs();
  }

  private wireTimeline(): void {
    this.timelineEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const senderBtn = target.closest<HTMLElement>('.chat-msg-sender-btn');
      if (senderBtn) {
        const username = senderBtn.dataset.user;
        if (username) this.onUserClick?.(username, senderBtn);
        return;
      }
      const tagBtn = target.closest<HTMLElement>('.chat-msg-tag-btn');
      const channel = tagBtn?.dataset.channel as ChatChannelType | undefined;
      if (channel) this.selectSendChannel(channel, tagBtn?.dataset.channelId ?? '', tagBtn?.dataset.sender ?? '');
    });
    this.timelineEl.addEventListener('scroll', () => {
      const el = this.timelineEl;
      this.following = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLOP_PX;
      if (this.following && this.pendingRows > 0) this.queueTimelinePaint();
    }, { passive: true });
    this.newPill.addEventListener('click', () => {
      this.following = true;
      this.flushRows();
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        if (this.following) this.timelineEl.scrollTop = this.timelineEl.scrollHeight;
      }).observe(this.timelineEl);
    }
  }

  private selectSendChannel(channel: ChatChannelType, channelId: string, sender: string): void {
    if (channel === 'server') return;
    if (channel === 'dm') {
      const me = this.gameClient.lastState?.username;
      const partner = sender && me && sender === me ? channelId : sender;
      if (partner) this.showThread(partner);
    } else if (sendableChannels(this.membership).includes(channel)) {
      this.allChannel = channel;
      this.syncComposer();
      this.persistPreferences();
    }
    this.inputEl.focus();
  }

  private wireComposer(): void {
    const send = this.composerEl.querySelector('.chat-popout-send')!;
    // Keeps the keyboard up: the tap must not take focus from the input.
    send.addEventListener('mousedown', (e) => e.preventDefault());
    send.addEventListener('click', () => {
      this.send();
      if (!matches(COARSE_POINTER_QUERY)) this.inputEl.focus();
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) this.send();
    });
    this.inputEl.addEventListener('input', () => this.clearStatus());
    this.channelSelect.addEventListener('change', () => {
      if (this.tab !== 'all') return;
      this.allChannel = this.channelSelect.value as ChatChannelType;
      this.syncComposer();
      this.persistPreferences();
    });
    this.dmInput.addEventListener('change', () => {
      if (this.tab === 'all') this.persistPreferences();
    });
  }

  private persistPreferences(): void {
    this.gameClient.sendSetChatPreferences(this.allChannel, this.dmInput.value.trim());
  }

  private send(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const channel = this.currentChannel();
    const dmTarget = this.thread ?? this.dmInput.value;
    const target = resolveSendTarget(channel, dmTarget, this.gameClient.lastState);
    if (!target.ok) {
      this.showStatus(target.reason);
      return;
    }
    if (!this.gameClient.sendChat(channel, target.channelId, text)) {
      this.showStatus('Not connected. Your message wasn\'t sent.');
      return;
    }
    this.pendingSends.push({ text, target: channel === 'dm' ? target.channelId : '', at: Date.now() });
    this.inputEl.value = '';
    this.clearStatus();
    if (this.tab === 'dm' && !this.thread) this.showThread(target.channelId);
  }

  /** A refused send comes back as an error rather than an echo, so the text is put back for another try. */
  private handleServerError(message: string, code: ServerErrorCode | undefined): void {
    if (code !== 'chat_refused') return;
    const now = Date.now();
    this.pendingSends = this.pendingSends.filter(pending => now - pending.at <= SEND_REPLY_WINDOW_MS);
    const sent = this.pendingSends.shift();
    if (!sent) return;
    const typed = this.inputEl.value;
    this.inputEl.value = typed ? `${sent.text} ${typed}` : sent.text;
    if (!sent.target) {
      this.showStatus(message);
      return;
    }
    if (this.tab === 'dm' && this.thread && sameUser(this.thread, sent.target)) {
      this.thread = null;
      this.enterViewDeferred();
    }
    this.showStatus(`No player is called "${sent.target}".`);
  }

  private showStatus(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.hidden = false;
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.clearStatus(), STATUS_VISIBLE_MS);
  }

  private clearStatus(): void {
    clearTimeout(this.statusTimer);
    this.statusEl.hidden = true;
  }

  private wireKeyboard(): void {
    this.composerEl.addEventListener('focusin', (e) => {
      clearTimeout(this.typingExitTimer);
      if (e.target instanceof HTMLInputElement) this.enterTyping();
    });
    this.composerEl.addEventListener('focusout', () => {
      clearTimeout(this.typingExitTimer);
      this.typingExitTimer = setTimeout(() => {
        if (!this.composerEl.contains(document.activeElement)) this.exitTyping();
      }, TYPING_EXIT_DELAY_MS);
    });
    window.visualViewport?.addEventListener('resize', () => this.watchKeyboard());
    window.addEventListener('orientationchange', () => this.leaveComposer());
  }

  private enterTyping(): void {
    if (this.typing || !this.isOpen || !matches(COARSE_POINTER_QUERY)) return;
    this.typing = true;
    this.keyboardSeen = false;
    this.typingBaseHeight = window.visualViewport?.height ?? 0;
    const screen = document.getElementById('screen-container');
    if (screen) screen.style.height = `${screen.offsetHeight}px`;
    document.body.dataset.chatTyping = '1';
    this.syncStack();
  }

  private exitTyping(): void {
    clearTimeout(this.typingExitTimer);
    if (!this.typing) return;
    this.typing = false;
    delete document.body.dataset.chatTyping;
    document.getElementById('screen-container')?.style.removeProperty('height');
    this.syncStack();
  }

  /** Android can hide the keyboard and leave the input focused, which no focus event reports. */
  private watchKeyboard(): void {
    const height = window.visualViewport?.height;
    if (!this.typing || height === undefined) return;
    this.typingBaseHeight = Math.max(this.typingBaseHeight, height);
    const shrink = this.typingBaseHeight - height;
    if (shrink >= KEYBOARD_SHOWN_MIN_SHRINK_PX) this.keyboardSeen = true;
    else if (this.keyboardSeen && shrink <= KEYBOARD_GONE_MAX_SHRINK_PX) this.leaveComposer();
  }

  private leaveComposer(): void {
    if (!this.typing) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.exitTyping();
  }

  private handleState(state: ServerStateMessage): void {
    if (!this.syncedOnce) {
      this.syncedOnce = true;
      this.gameClient.sendSyncChat(this.log.latestId());
    }
    if (!state.social) return;
    this.syncMembership(state);
    this.restorePreferences(state);

    const blockedKey = JSON.stringify(state.social.blockedUsers ?? {});
    if (blockedKey !== this.blockedKey) {
      this.blockedKey = blockedKey;
      this.invalidateView();
      this.schedulePreview();
    }
  }

  private syncMembership(state: ServerStateMessage): void {
    const next = chatMembership(state);
    if (next.inParty === this.membership.inParty && next.guildId === this.membership.guildId) return;
    this.membership = next;
    deferWhilePressed(this.composerEl, () => {
      this.syncChannelOptions();
      this.syncComposer();
    });
    if ((this.tab === 'party' && !next.inParty) || (this.tab === 'guild' && !next.guildId)) {
      this.tab = 'all';
      this.enterViewDeferred();
    } else {
      this.syncTabs();
    }
  }

  private restorePreferences(state: ServerStateMessage): void {
    if (this.preferencesRestored) return;
    this.preferencesRestored = true;
    const preferences = state.social?.chatPreferences;
    if (!preferences) return;
    if (preferences.dmTarget) this.dmInput.value = preferences.dmTarget;
    if (sendableChannels(this.membership).includes(preferences.sendChannel)) {
      this.allChannel = preferences.sendChannel;
    }
    this.syncComposer();
  }

  private ingest(incoming: readonly ChatMessage[], fromSync: boolean): void {
    const { added, inOrder } = this.log.add(incoming);
    if (fromSync && this.seedLastSeenFromBacklog) this.seedLastSeen();
    if (added.length === 0) return;
    const me = this.gameClient.lastState?.username;

    if (this.isOpen) {
      this.noteUnreadTabs(added);
      this.clearViewedTabDots();
      this.markThreadSeen();
      this.markAllSeen();
      if (added.some(m => m.channelType === 'dm')) this.syncDmDot();
      else this.syncTabs();
      if (!inOrder) {
        this.timelineStale = true;
      } else {
        const audience = this.audience();
        const view = this.currentView();
        const rows = added.filter(m => isShownInView(m, view, audience));
        if (rows.some(m => m.senderUsername === me)) this.following = true;
        this.holdRows(rows);
      }
      this.queueTimelinePaint();
      if (this.tab === 'dm' && !this.thread && added.some(m => m.channelType === 'dm')) {
        deferWhilePressed(this.threadsEl, () => this.renderThreadList());
      }
    } else {
      this.timelineStale = true;
    }
    for (const message of added) {
      if (message.senderUsername !== me) continue;
      const echoed = this.pendingSends.findIndex(pending => pending.text === message.text);
      if (echoed >= 0) this.pendingSends.splice(echoed, 1);
    }
    this.schedulePreview();
  }

  /** Past the cap only a count is kept: the log still has the messages, and returning to the bottom rebuilds from it. */
  private holdRows(rows: readonly ChatMessage[]): void {
    this.pendingRows += rows.length;
    if (this.pendingRows > CHAT_ROW_CAP) this.unrenderedRows = [];
    else this.unrenderedRows.push(...rows);
  }

  /** First run: the server's clock, not this device's, decides what counts as already read. */
  private seedLastSeen(): void {
    this.seedLastSeenFromBacklog = false;
    const newest = this.log.newestTimestamp();
    if (!newest) return;
    this.lastSeenAt = newest;
    this.threadBaseline = newest;
    writeStorage(STORAGE_KEY_LAST_SEEN, String(newest));
  }

  private markAllSeen(): void {
    const newest = this.log.newestTimestamp();
    if (newest <= this.lastSeenAt) return;
    this.lastSeenAt = newest;
    writeStorage(STORAGE_KEY_LAST_SEEN, String(newest));
  }

  private markViewSeen(): void {
    this.clearViewedTabDots();
    this.markThreadSeen();
    this.syncDmDot();
  }

  /** The All tab shows party and guild lines too, but a DM stays unread until its own thread is opened. */
  private clearViewedTabDots(): void {
    if (this.tab === 'dm') return;
    this.unreadTabs.delete(this.tab);
    if (this.tab === 'all') {
      this.unreadTabs.delete('party');
      this.unreadTabs.delete('guild');
    }
  }

  private markThreadSeen(): void {
    if (this.tab === 'dm' && this.thread) this.threadSeenAt.set(this.thread.toLowerCase(), this.log.newestTimestamp());
  }

  /** Tab dots for what came in while chat was closed, before the last-seen time moves past it. */
  private refreshTabDots(): void {
    this.noteUnreadTabs(this.log.messages.filter(m => m.timestamp > this.lastSeenAt));
  }

  private noteUnreadTabs(messages: readonly ChatMessage[]): void {
    const audience = this.audience();
    for (const message of messages) {
      if (message.senderUsername === audience.me || isBlockedMessage(message, audience.blocked)) continue;
      if (message.channelType === 'server') continue;
      if (message.channelType === 'party' || message.channelType === 'guild') this.unreadTabs.add(message.channelType);
      if (this.filters[message.channelType] !== false) this.unreadTabs.add('all');
    }
  }

  private invalidateView(): void {
    this.timelineStale = true;
    if (this.isOpen) this.queueTimelinePaint();
  }

  /** One paint for both cases: only the latest deferred paint per root survives a press, and a rebuild must not be lost. */
  private queueTimelinePaint(): void {
    deferWhilePressed(this.timelineEl, () => {
      if (this.timelineStale) this.rebuildView();
      else this.flushRows();
    });
  }

  private rebuildView(): void {
    const listing = this.tab === 'dm' && !this.thread;
    this.threadsEl.hidden = !listing;
    this.timelineEl.hidden = listing;
    this.threadBar.hidden = !(this.tab === 'dm' && this.thread);
    this.threadName.textContent = this.thread ?? '';
    this.unrenderedRows = [];
    this.pendingRows = 0;
    this.syncNewPill();
    if (listing) {
      this.renderThreadList();
      this.timelineStale = false;
      return;
    }
    const audience = this.audience();
    const view = this.currentView();
    const visible = this.log.messages.filter(m => isShownInView(m, view, audience));
    const { html, rows, lastTimestamp } = renderChatRows(visible, this.rowOptions());
    this.rowCount = rows;
    this.lastRowTimestamp = lastTimestamp;
    // Rows are appended afterwards, so setHtml's memory of the last write would be wrong here.
    this.timelineEl.innerHTML = rows > 0 ? html : `<div class="ui-empty chat-empty">${this.emptyText()}</div>`;
    this.timelineStale = false;
    if (this.following) this.queueScrollToBottom();
  }

  private rowOptions(): ChatRowOptions {
    return { me: this.gameClient.lastState?.username, showChannel: this.tab === 'all' };
  }

  private emptyText(): string {
    if (this.tab === 'party') return 'No party messages yet.';
    if (this.tab === 'guild') return 'No guild messages yet.';
    if (this.tab === 'dm') return `No messages with ${escapeChatHtml(this.thread ?? '')} yet. Say hello.`;
    const anyOn = FILTER_CHANNELS.some(ch => this.filters[ch] !== false);
    return anyOn ? 'No messages yet.' : 'Every channel is filtered out. Use the filter button to turn some back on.';
  }

  private flushRows(): void {
    if (!this.isOpen || this.pendingRows === 0 || !this.following) {
      this.syncNewPill();
      return;
    }
    if (this.rowCount === 0 || this.pendingRows >= CHAT_ROW_CAP) {
      this.rebuildView();
      return;
    }
    const rows = this.unrenderedRows;
    this.unrenderedRows = [];
    this.pendingRows = 0;
    this.syncNewPill();
    const options = this.rowOptions();
    let html = '';
    for (const message of rows) {
      if (this.lastRowTimestamp === null || !isSameChatDay(this.lastRowTimestamp, message.timestamp)) {
        html += renderDaySeparator(message.timestamp);
      }
      html += renderChatRow(message, options);
      this.lastRowTimestamp = message.timestamp;
    }
    this.timelineEl.insertAdjacentHTML('beforeend', html);
    this.rowCount += rows.length;
    while (this.rowCount > CHAT_ROW_CAP) {
      const first = this.timelineEl.firstElementChild;
      if (!first) break;
      if (first.classList.contains('chat-msg')) this.rowCount--;
      first.remove();
    }
    this.queueScrollToBottom();
  }

  private syncNewPill(): void {
    const count = this.pendingRows;
    this.newPill.hidden = count === 0;
    if (count > 0) this.newPill.textContent = `↓ ${countText(count)} new`;
  }

  private queueScrollToBottom(): void {
    if (this.scrollQueued) return;
    this.scrollQueued = true;
    requestAnimationFrame(() => {
      this.scrollQueued = false;
      if (this.following) this.timelineEl.scrollTop = this.timelineEl.scrollHeight;
    });
  }

  private schedulePreview(): void {
    if (this.isOpen || this.previewTimer !== undefined) return;
    const wait = PREVIEW_MIN_INTERVAL_MS - (Date.now() - this.lastPreviewAt);
    if (wait <= 0) {
      this.paintPreview();
      return;
    }
    this.previewTimer = setTimeout(() => this.paintPreview(), wait);
  }

  private paintPreview(): void {
    clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    this.lastPreviewAt = Date.now();
    const preview = chatPreview(this.log.messages, this.lastSeenAt, this.audience());
    const count = this.isOpen ? 0 : preview.count;
    if (count !== this.unreadCount) {
      this.unreadCount = count;
      this.onUnreadChange?.(count);
    }
    this.onPreviewChange?.({ count, message: preview.message });
  }

  /** The server suppresses DM notifications for this thread, so it must be the one really on screen. */
  private reportChatFocus(): void {
    if (this.isOpen && this.tab === 'dm' && this.thread) {
      chatFocusTracker.setActiveThread('dm', this.thread);
    } else {
      chatFocusTracker.clearActiveThread();
    }
  }

  private loadFilters(): ChatFilters {
    try {
      const raw = readStorage(STORAGE_KEY_FILTERS);
      if (raw) return { ...DEFAULT_CHAT_FILTERS, ...JSON.parse(raw) };
    } catch { /* corrupt value */ }
    return { ...DEFAULT_CHAT_FILTERS };
  }
}
