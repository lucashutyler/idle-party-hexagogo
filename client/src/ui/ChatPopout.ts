import type { GameClient } from '../network/GameClient';
import type { ChatMessage, ChatChannelType, ServerStateMessage } from '@idle-party-rpg/shared';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';

const STORAGE_KEY_GEOMETRY = 'chatPopoutGeometry';
const STORAGE_KEY_FILTERS = 'chatPopoutFilters';
const STORAGE_KEY_MOBILE_LAYOUT = 'chatPopoutMobileLayout';
/** Browser-level memory of whether chat was open last time. */
const STORAGE_KEY_OPEN = 'chatPopoutOpen';
/** Desktop maximize toggle — true means the chat is full-screen. */
const STORAGE_KEY_DESKTOP_MAX = 'chatPopoutDesktopMax';

const DEFAULT_FILTERS: Record<ChatChannelType, boolean> = {
  global: true,
  zone: true,
  tile: true,
  party: true,
  guild: true,
  dm: true,
  server: true,
};

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

type MobileLayout = 'full' | 'sheet';

const CHANNEL_LABELS: Record<ChatChannelType, string> = {
  global: 'Global',
  zone: 'Zone',
  tile: 'Room',
  party: 'Party',
  guild: 'Guild',
  dm: 'DM',
  server: 'Server',
};

const CHANNEL_COLORS: Record<ChatChannelType, string> = {
  global: '#e8e8e8',
  zone: '#a4d2ff',
  tile: '#ffd58a',
  party: '#9eff9e',
  guild: '#d39bff',
  dm: '#ff9eee',
  server: '#888',
};

/**
 * Floating, draggable, resizable chat window — overlays whichever screen is
 * active. Mobile gets a non-draggable full-screen / bottom-sheet variant
 * (toggled via a layout button).
 */
export class ChatPopout {
  private root: HTMLElement;
  private window!: HTMLElement;
  private timelineEl!: HTMLElement;
  private filtersEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private channelSelect!: HTMLSelectElement;
  private dmInput!: HTMLInputElement;

  private gameClient: GameClient;
  private isOpen = false;
  private messages: ChatMessage[] = [];
  private filters: Record<ChatChannelType, boolean>;
  private mobileLayout: MobileLayout;
  private desktopMaximized = false;
  private syncedOnce = false;

  /** Toggle handler invoked when chat is closed (so the nav can clear active state). */
  private onClose?: () => void;
  /** Callback the bottom nav uses to update its unread badge. */
  private onUnreadChange?: (hasUnread: boolean) => void;
  private hasUnread = false;

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.filters = this.loadFilters();
    this.mobileLayout = (localStorage.getItem(STORAGE_KEY_MOBILE_LAYOUT) as MobileLayout) ?? 'sheet';
    this.desktopMaximized = localStorage.getItem(STORAGE_KEY_DESKTOP_MAX) === '1';

    this.root = document.getElementById('chat-popout-root')!;
    this.buildDOM();

    gameClient.onChat((msg) => this.handleChatMessage(msg));
    // Sync responses are *always* merged, never replaced. The server's `full`
    // flag means "your sync is consistent" (i.e. your sinceId was honored), not
    // "this is the entire chat history" — so a successful incremental response
    // arrives with `full: true` and only the new messages. Replacing on
    // `full: true` was wiping chat on tab resume.
    gameClient.onSyncChat((messages) => {
      let added = false;
      for (const m of messages) {
        if (!this.messages.find(x => x.id === m.id)) {
          this.messages.push(m);
          added = true;
        }
      }
      if (added) {
        this.messages.sort((a, b) => a.timestamp - b.timestamp);
        this.renderTimeline();
      }
    });
    gameClient.subscribe((_state: ServerStateMessage) => {
      // First state: ask server for the chat backlog (no sinceId → last batch).
      if (!this.syncedOnce) {
        this.syncedOnce = true;
        gameClient.sendSyncChat();
      }
    });
    // On tab resume, fetch any messages we missed while the tab was hidden.
    // Pass the latest-known message ID so the server can do an incremental sync.
    gameClient.onResume(() => {
      const latestId = this.getLatestId();
      gameClient.sendSyncChat(latestId);
    });
  }

  setOnClose(cb: () => void): void { this.onClose = cb; }
  setOnUnreadChange(cb: (hasUnread: boolean) => void): void {
    this.onUnreadChange = cb;
    cb(this.hasUnread);
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.window.style.display = '';
    this.applyMobileLayout();
    this.applyDesktopMaximized();
    this.hasUnread = false;
    this.onUnreadChange?.(false);
    bringToFront(this.window);
    document.body.dataset.chatOpen = '1';
    // Re-render: messages may have been pushed into this.messages while
    // chat was closed (handleChatMessage skips renderTimeline when !isOpen),
    // so the DOM is stale. Always rebuild on open so the user sees them.
    this.renderTimeline();
    // Also pull anything that arrived server-side while we were away.
    this.gameClient.sendSyncChat(this.getLatestId());
    this.persistOpenState();
    requestAnimationFrame(() => {
      this.timelineEl.scrollTop = this.timelineEl.scrollHeight;
      this.inputEl.focus();
    });
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.window.style.display = 'none';
    release(this.window);
    delete document.body.dataset.chatOpen;
    this.persistOpenState();
    this.onClose?.();
  }

  /** True if chat was open last session — caller may call open() during boot. */
  wasOpen(): boolean {
    try { return localStorage.getItem(STORAGE_KEY_OPEN) === '1'; } catch { return false; }
  }

  private persistOpenState(): void {
    try {
      if (this.isOpen) localStorage.setItem(STORAGE_KEY_OPEN, '1');
      else localStorage.removeItem(STORAGE_KEY_OPEN);
    } catch { /* ignore */ }
  }

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  isVisible(): boolean { return this.isOpen; }

  // ── DOM construction ──────────────────────────────────────────────────

  private buildDOM(): void {
    this.root.innerHTML = `
      <div class="chat-popout" role="dialog" aria-label="Chat" style="display:none">
        <div class="chat-popout-header">
          <span class="chat-popout-title">Chat</span>
          <div class="chat-popout-header-actions">
            <button class="chat-popout-layout-btn" title="Toggle layout">⇅</button>
            <button class="chat-popout-close" title="Close">×</button>
          </div>
        </div>
        <div class="chat-popout-filters"></div>
        <div class="chat-popout-body">
          <div class="chat-popout-timeline"></div>
        </div>
        <div class="chat-popout-composer">
          <select class="chat-popout-channel">
            <option value="global">Global</option>
            <option value="zone">Zone</option>
            <option value="tile">Room</option>
            <option value="party">Party</option>
            <option value="guild">Guild</option>
            <option value="dm">DM</option>
          </select>
          <input class="chat-popout-dm-target" type="text" placeholder="DM to..." style="display:none" />
          <input class="chat-popout-input" type="text" placeholder="Type a message..." maxlength="500" />
          <button class="chat-popout-send">Send</button>
        </div>
        <div class="chat-popout-resize"></div>
      </div>
    `;

    this.window = this.root.querySelector('.chat-popout')!;
    this.timelineEl = this.window.querySelector('.chat-popout-timeline')!;
    this.filtersEl = this.window.querySelector('.chat-popout-filters')!;
    this.inputEl = this.window.querySelector('.chat-popout-input')! as HTMLInputElement;
    this.channelSelect = this.window.querySelector('.chat-popout-channel')! as HTMLSelectElement;
    this.dmInput = this.window.querySelector('.chat-popout-dm-target')! as HTMLInputElement;

    this.renderFilters();
    this.applyGeometry(this.loadGeometry());

    this.wireDrag();
    this.wireResize();
    this.wireClose();
    this.wireSend();
    this.wireChannelChange();
    this.wireLayoutToggle();

    // Refocus to top of stack on any pointer interaction with the window.
    wireFocusOnInteract(this.window);

    window.addEventListener('resize', () => {
      this.applyMobileLayout();
      this.constrainToViewport();
    });
  }

  private wireClose(): void {
    this.window.querySelector('.chat-popout-close')!.addEventListener('click', () => this.close());
  }

  private wireLayoutToggle(): void {
    this.window.querySelector('.chat-popout-layout-btn')!.addEventListener('click', () => {
      if (this.isMobile()) {
        // Mobile: cycle full <-> bottom sheet.
        this.mobileLayout = this.mobileLayout === 'full' ? 'sheet' : 'full';
        localStorage.setItem(STORAGE_KEY_MOBILE_LAYOUT, this.mobileLayout);
        this.applyMobileLayout();
        return;
      }
      // Desktop: toggle maximized full-screen.
      this.desktopMaximized = !this.desktopMaximized;
      try { localStorage.setItem(STORAGE_KEY_DESKTOP_MAX, this.desktopMaximized ? '1' : '0'); } catch { /* ignore */ }
      this.applyDesktopMaximized();
    });
  }

  private applyDesktopMaximized(): void {
    if (this.isMobile()) {
      this.window.classList.remove('chat-popout-desktop-max');
      return;
    }
    this.window.classList.toggle('chat-popout-desktop-max', this.desktopMaximized);
    if (!this.desktopMaximized) {
      // Restore the saved geometry when un-maximizing.
      this.applyGeometry(this.loadGeometry());
      this.constrainToViewport();
    } else {
      // Clear inline geometry so the maximized CSS rule wins.
      this.window.style.left = '';
      this.window.style.top = '';
      this.window.style.right = '';
      this.window.style.bottom = '';
      this.window.style.width = '';
      this.window.style.height = '';
    }
  }

  private wireSend(): void {
    const send = () => {
      const text = this.inputEl.value.trim();
      if (!text) return;
      const channel = this.channelSelect.value as ChatChannelType;
      let channelId = '';
      if (channel === 'dm') {
        channelId = this.dmInput.value.trim();
        if (!channelId) return;
      }
      this.gameClient.sendChat(channel, channelId, text);
      this.inputEl.value = '';
    };

    this.window.querySelector('.chat-popout-send')!.addEventListener('click', send);
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
  }

  private wireChannelChange(): void {
    this.channelSelect.addEventListener('change', () => {
      const showDm = this.channelSelect.value === 'dm';
      this.dmInput.style.display = showDm ? '' : 'none';
    });
  }

  private wireDrag(): void {
    const header = this.window.querySelector('.chat-popout-header')! as HTMLElement;
    let startX = 0, startY = 0, startL = 0, startT = 0;
    let dragging = false;

    header.addEventListener('pointerdown', (e) => {
      if (this.isMobile()) return;
      if (this.desktopMaximized) return;
      if ((e.target as HTMLElement).closest('button')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.window.getBoundingClientRect();
      startL = rect.left;
      startT = rect.top;
      header.setPointerCapture(e.pointerId);
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Live-clamp during drag so the window never visually slides behind
      // the nav / xp bar. The pointerup handler also calls constrainToViewport
      // as a final safety net.
      const margin = 8;
      const vw = window.innerWidth;
      const bottom = this.getBottomBoundary();
      const w = this.window.offsetWidth;
      const h = this.window.offsetHeight;
      const maxLeft = vw - w - margin;
      const maxTop = bottom - h - margin;
      const left = Math.max(margin, Math.min(maxLeft, startL + dx));
      const top = Math.max(margin, Math.min(maxTop, startT + dy));
      this.window.style.left = `${left}px`;
      this.window.style.top = `${top}px`;
      this.window.style.right = 'auto';
      this.window.style.bottom = 'auto';
    });

    header.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.constrainToViewport();
      this.saveGeometry();
    });
  }

  private wireResize(): void {
    const handle = this.window.querySelector('.chat-popout-resize')! as HTMLElement;
    let startX = 0, startY = 0, startW = 0, startH = 0;
    let resizing = false;

    handle.addEventListener('pointerdown', (e) => {
      if (this.isMobile()) return;
      if (this.desktopMaximized) return;
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this.window.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const margin = 8;
      const rect = this.window.getBoundingClientRect();
      const maxW = window.innerWidth - rect.left - margin;
      const maxH = this.getBottomBoundary() - rect.top - margin;
      const w = Math.max(280, Math.min(maxW, startW + (e.clientX - startX)));
      const h = Math.max(200, Math.min(maxH, startH + (e.clientY - startY)));
      this.window.style.width = `${w}px`;
      this.window.style.height = `${h}px`;
    });

    handle.addEventListener('pointerup', (e) => {
      if (!resizing) return;
      resizing = false;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.constrainToViewport();
      this.saveGeometry();
    });
  }

  /**
   * Bottom of the usable area for the chat window — above the persistent
   * XP bar and bottom nav. We measure live so the constraint is correct
   * even if the user has resized the window or those elements are hidden.
   */
  private getBottomBoundary(): number {
    const nav = document.getElementById('bottom-nav');
    const xpbar = document.getElementById('persistent-xp-bar');
    const navH = nav && nav.offsetHeight > 0 ? nav.offsetHeight : 0;
    const xpH = xpbar && xpbar.offsetHeight > 0 ? xpbar.offsetHeight : 0;
    return window.innerHeight - navH - xpH;
  }

  private constrainToViewport(): void {
    if (this.isMobile()) return;
    const rect = this.window.getBoundingClientRect();
    const vw = window.innerWidth;
    const bottom = this.getBottomBoundary();
    const margin = 8;
    let left = rect.left;
    let top = rect.top;
    let width = Math.min(rect.width, vw - 2 * margin);
    let height = Math.min(rect.height, bottom - 2 * margin);
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    if (left + width > vw - margin) left = vw - width - margin;
    if (top + height > bottom - margin) top = bottom - height - margin;
    this.window.style.left = `${left}px`;
    this.window.style.top = `${top}px`;
    this.window.style.width = `${width}px`;
    this.window.style.height = `${height}px`;
    this.window.style.right = 'auto';
    this.window.style.bottom = 'auto';
  }

  private isMobile(): boolean {
    return window.innerWidth < 768;
  }

  private applyMobileLayout(): void {
    if (!this.isMobile()) {
      this.window.classList.remove('chat-popout-mobile-full', 'chat-popout-mobile-sheet');
      return;
    }
    this.window.classList.toggle('chat-popout-mobile-full', this.mobileLayout === 'full');
    this.window.classList.toggle('chat-popout-mobile-sheet', this.mobileLayout === 'sheet');
    this.window.style.left = '';
    this.window.style.top = '';
    this.window.style.right = '';
    this.window.style.bottom = '';
    this.window.style.width = '';
    this.window.style.height = '';
  }

  private renderFilters(): void {
    const channels: ChatChannelType[] = ['global', 'zone', 'tile', 'party', 'guild', 'dm', 'server'];
    this.filtersEl.innerHTML = channels.map(ch => `
      <button class="chat-filter ${this.filters[ch] ? 'active' : ''}" data-ch="${ch}" style="--ch-color:${CHANNEL_COLORS[ch]}">
        ${CHANNEL_LABELS[ch]}
      </button>
    `).join('');
    for (const btn of this.filtersEl.querySelectorAll('.chat-filter')) {
      btn.addEventListener('click', () => {
        const ch = btn.getAttribute('data-ch') as ChatChannelType;
        this.filters[ch] = !this.filters[ch];
        this.saveFilters();
        btn.classList.toggle('active', this.filters[ch]);
        this.renderTimeline();
      });
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────

  private handleChatMessage(msg: ChatMessage): void {
    if (!this.messages.find(m => m.id === msg.id)) {
      this.messages.push(msg);
    }
    if (this.isOpen) {
      this.renderTimeline();
    } else {
      this.hasUnread = true;
      this.onUnreadChange?.(true);
    }
  }

  private getLatestId(): string | undefined {
    if (this.messages.length === 0) return undefined;
    return this.messages[this.messages.length - 1].id;
  }

  private renderTimeline(): void {
    const visible = this.messages.filter(m => this.filters[m.channelType] !== false);
    const html = visible.map(m => this.formatMessage(m)).join('');
    this.timelineEl.innerHTML = html;
    requestAnimationFrame(() => {
      this.timelineEl.scrollTop = this.timelineEl.scrollHeight;
    });
  }

  private formatMessage(msg: ChatMessage): string {
    const time = this.formatTime(msg.timestamp);
    const color = CHANNEL_COLORS[msg.channelType] ?? '#e8e8e8';
    const tag = CHANNEL_LABELS[msg.channelType] ?? msg.channelType;
    const sender = this.escapeHtml(msg.senderUsername || 'Server');
    const text = this.escapeHtml(msg.text);
    return `
      <div class="chat-msg" style="--ch-color:${color}">
        <span class="chat-msg-time">${time}</span>
        <span class="chat-msg-tag">[${tag}]</span>
        <span class="chat-msg-sender">${sender}:</span>
        <span class="chat-msg-text">${text}</span>
      </div>
    `;
  }

  private formatTime(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Persistence ───────────────────────────────────────────────────────

  private loadGeometry(): Geometry {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_GEOMETRY);
      if (raw) return JSON.parse(raw) as Geometry;
    } catch { /* ignore */ }
    return { x: window.innerWidth - 380, y: 80, width: 360, height: 440 };
  }

  private saveGeometry(): void {
    if (this.isMobile()) return;
    const rect = this.window.getBoundingClientRect();
    const geom: Geometry = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    localStorage.setItem(STORAGE_KEY_GEOMETRY, JSON.stringify(geom));
  }

  private applyGeometry(g: Geometry): void {
    if (this.isMobile()) return;
    this.window.style.left = `${g.x}px`;
    this.window.style.top = `${g.y}px`;
    this.window.style.width = `${g.width}px`;
    this.window.style.height = `${g.height}px`;
    this.window.style.right = 'auto';
    this.window.style.bottom = 'auto';
  }

  private loadFilters(): Record<ChatChannelType, boolean> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_FILTERS);
      if (raw) return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULT_FILTERS };
  }

  private saveFilters(): void {
    localStorage.setItem(STORAGE_KEY_FILTERS, JSON.stringify(this.filters));
  }
}
