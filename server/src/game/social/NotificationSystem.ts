import type { NotificationEntry } from '@idle-party-rpg/shared';

/** Inbox entries are capped per-player; oldest entries are evicted first. */
const MAX_NOTIFICATIONS = 50;

/**
 * NotificationSystem manages per-player notification inboxes.
 *
 * Pure stateful logic. PlayerManager wires delivery + persistence, the same
 * way it wires MailboxSystem.
 */
export class NotificationSystem {
  private inboxes = new Map<string, NotificationEntry[]>();

  /** Restore inbox contents at startup. */
  setInbox(username: string, entries: NotificationEntry[]): void {
    if (entries.length === 0) {
      this.inboxes.delete(username);
      return;
    }
    this.inboxes.set(username, entries.slice(-MAX_NOTIFICATIONS));
  }

  getInbox(username: string): NotificationEntry[] {
    return this.inboxes.get(username) ?? [];
  }

  unreadCount(username: string): number {
    return this.getInbox(username).filter(n => n.readAt === null).length;
  }

  /** Append a notification entry, evicting the oldest if over the cap. */
  addEntry(username: string, entry: NotificationEntry): NotificationEntry {
    let list = this.inboxes.get(username);
    if (!list) {
      list = [];
      this.inboxes.set(username, list);
    }
    list.push(entry);
    if (list.length > MAX_NOTIFICATIONS) {
      list.splice(0, list.length - MAX_NOTIFICATIONS);
    }
    return entry;
  }

  markRead(username: string, id: string): boolean {
    const entry = this.inboxes.get(username)?.find(n => n.id === id);
    if (!entry || entry.readAt !== null) return false;
    entry.readAt = Date.now();
    return true;
  }

  markAllRead(username: string): void {
    const list = this.inboxes.get(username);
    if (!list) return;
    const now = Date.now();
    for (const entry of list) {
      if (entry.readAt === null) entry.readAt = now;
    }
  }

  /** Remove a single entry. Returns true if it existed and was removed. */
  removeEntry(username: string, id: string): boolean {
    const list = this.inboxes.get(username);
    if (!list) return false;
    const idx = list.findIndex(n => n.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.inboxes.delete(username);
    return true;
  }

  /** Remove every entry for a user (bulk clear). */
  clearAll(username: string): void {
    this.inboxes.delete(username);
  }

  /** All current usernames with inbox entries. */
  getAllUsernames(): string[] {
    return Array.from(this.inboxes.keys());
  }
}
