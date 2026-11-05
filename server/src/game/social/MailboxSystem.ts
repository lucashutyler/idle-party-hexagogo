import { randomUUID } from 'crypto';
import type { MailboxEntry } from '@idle-party-rpg/shared';

/** `boxes`, plus any entry of `earlier` it no longer holds. */
export function mailboxesWithEntriesFrom(
  earlier: ReadonlyMap<string, MailboxEntry[]>,
  boxes: ReadonlyMap<string, MailboxEntry[]>,
): Map<string, MailboxEntry[]> {
  const union = new Map(boxes);
  for (const [username, entries] of earlier) {
    const current = union.get(username) ?? [];
    const known = new Set(current.map(entry => entry.id));
    const missing = entries.filter(entry => !known.has(entry.id));
    if (missing.length > 0) union.set(username, [...current, ...missing]);
  }
  return union;
}

/**
 * MailboxSystem manages per-player gift mailboxes.
 *
 * Each entry is a single (item, quantity) pair from a sender. Entries are NOT
 * grouped or merged — multiple gifts of the same item produce multiple entries.
 * This intentionally allows a player to "hold" more than MAX_STACK of an item
 * by leaving copies in their mailbox; accepting a gift still has to fit in the
 * 99-stack inventory cap.
 *
 * Pure stateful logic. PlayerManager wires inventory mutations + persistence.
 */
export class MailboxSystem {
  private boxes = new Map<string, MailboxEntry[]>();
  private removed = new Map<string, MailboxEntry[]>();

  /** Restore every mailbox at startup. */
  restore(boxes: ReadonlyMap<string, MailboxEntry[]>): void {
    this.boxes = new Map(Array.from(boxes, ([username, entries]) => [username, [...entries]]));
  }

  /** Every mailbox with its entries, for saving. */
  snapshot(): Map<string, MailboxEntry[]> {
    return new Map(Array.from(this.boxes, ([username, entries]) => [username, [...entries]]));
  }

  /** Takes in entries from an old save file, skipping any it already holds. True if any were new. */
  mergeEntries(username: string, entries: MailboxEntry[]): boolean {
    const known = new Set(this.getMailbox(username).map(entry => entry.id));
    const added = entries.filter(entry => !known.has(entry.id));
    if (added.length === 0) return false;
    this.boxes.set(username, [...this.getMailbox(username), ...added]);
    return true;
  }

  /** Moves a mailbox to a player's new name. True if there was anything to move. */
  rename(oldUsername: string, newUsername: string): boolean {
    const entries = this.boxes.get(oldUsername);
    if (!entries) return false;
    this.boxes.delete(oldUsername);
    this.boxes.set(newUsername, [...this.getMailbox(newUsername), ...entries]);
    return true;
  }

  getMailbox(username: string): MailboxEntry[] {
    return this.boxes.get(username) ?? [];
  }

  hasEntries(username: string): boolean {
    return (this.boxes.get(username)?.length ?? 0) > 0;
  }

  /** Append a gift entry to a player's mailbox. */
  addEntry(
    toUsername: string,
    fromUsername: string,
    itemId: string,
    quantity: number,
    options?: { returned?: boolean },
  ): MailboxEntry {
    const entry: MailboxEntry = {
      id: `gift_${randomUUID()}`,
      fromUsername,
      itemId,
      quantity,
      sentAt: Date.now(),
      ...(options?.returned ? { returned: true } : {}),
    };
    let list = this.boxes.get(toUsername);
    if (!list) {
      list = [];
      this.boxes.set(toUsername, list);
    }
    list.push(entry);
    return entry;
  }

  /** Look up a single entry by ID, returning the owner and entry. */
  findEntry(toUsername: string, entryId: string): MailboxEntry | null {
    const list = this.boxes.get(toUsername);
    if (!list) return null;
    return list.find(e => e.id === entryId) ?? null;
  }

  /** Remove an entry. Returns the removed entry, or null if not found. */
  removeEntry(toUsername: string, entryId: string): MailboxEntry | null {
    const list = this.boxes.get(toUsername);
    if (!list) return null;
    const idx = list.findIndex(e => e.id === entryId);
    if (idx < 0) return null;
    const [entry] = list.splice(idx, 1);
    if (list.length === 0) this.boxes.delete(toUsername);
    this.removed.set(toUsername, [...(this.removed.get(toUsername) ?? []), entry]);
    return entry;
  }

  /** Entries removed since the last call. A save keeps these until the players' files have caught up. */
  takeRemoved(): Map<string, MailboxEntry[]> {
    const removed = this.removed;
    this.removed = new Map();
    return removed;
  }

  /** All current usernames with mailbox entries. */
  getAllUsernames(): string[] {
    return Array.from(this.boxes.keys());
  }
}
