import type { ChatMessage, ChatChannelType, BlockLevel } from '@idle-party-rpg/shared';

const STORAGE_KEY = 'chat_messages';
const MAX_MESSAGES = 2000;

/**
 * localStorage-backed chat message store.
 * Provides O(1) dedup, client-side filtering, and debounced persistence.
 */
export class ChatLocalStore {
  private messages: ChatMessage[] = [];
  private messageIndex = new Map<string, boolean>();
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.load();
  }

  /** Load from localStorage. */
  private load(): void {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        this.messages = JSON.parse(raw);
        this.rebuildIndex();
      } catch {
        this.messages = [];
      }
    }
  }

  /** Persist to localStorage. */
  save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.messages));
  }

  /** Get the latest message ID for sync. Skips old msg_ format IDs. */
  getLatestId(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const id = this.messages[i].id;
      if (!id.startsWith('msg_')) return id;
    }
    return undefined;
  }

  /** Add a single live message. Returns true if it was new. */
  addMessage(msg: ChatMessage): boolean {
    if (this.messageIndex.has(msg.id)) return false;
    this.messages.push(msg);
    this.messageIndex.set(msg.id, true);
    this.trim();
    this.scheduleSave();
    return true;
  }

  /** Merge a batch of messages from sync_chat response. */
  mergeSyncBatch(messages: ChatMessage[], full: boolean): void {
    if (!full && messages.length > 0) {
      // Server couldn't find our sinceId — our cache is stale.
      // Replace with server's batch (it's the authoritative latest).
      this.messages = [];
      this.messageIndex.clear();
    }

    for (const msg of messages) {
      if (!this.messageIndex.has(msg.id)) {
        this.messages.push(msg);
        this.messageIndex.set(msg.id, true);
      }
    }

    this.messages.sort((a, b) => a.timestamp - b.timestamp);
    this.rebuildIndex();
    this.trim();
    this.save();
  }

  /** Get messages filtered by channel type and blocked users. */
  getFiltered(filters: Set<ChatChannelType>, blockedUsers?: Record<string, BlockLevel>): ChatMessage[] {
    return this.messages.filter(m => {
      if (!filters.has(m.channelType)) return false;
      if (blockedUsers && m.senderUsername in blockedUsers) {
        const level = blockedUsers[m.senderUsername];
        if (level === 'all') return false;
        if (level === 'dm' && m.channelType === 'dm') return false;
      }
      return true;
    });
  }

  /** Get all messages unfiltered. */
  getAll(): ChatMessage[] {
    return this.messages;
  }

  /** Clear all stored messages (e.g. on logout). */
  clear(): void {
    this.messages = [];
    this.messageIndex.clear();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    localStorage.removeItem(STORAGE_KEY);
  }

  private trim(): void {
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
      this.rebuildIndex();
    }
  }

  private rebuildIndex(): void {
    this.messageIndex.clear();
    for (const m of this.messages) {
      this.messageIndex.set(m.id, true);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 1000);
  }
}
