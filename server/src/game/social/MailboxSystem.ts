import { randomUUID } from 'crypto';
import type { MailboxEntry } from '@idle-party-rpg/shared';

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

  /** Restore mailbox contents at startup. */
  setMailbox(username: string, entries: MailboxEntry[]): void {
    if (entries.length === 0) {
      this.boxes.delete(username);
      return;
    }
    this.boxes.set(username, [...entries]);
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
    return entry;
  }

  /** All current usernames with mailbox entries. */
  getAllUsernames(): string[] {
    return Array.from(this.boxes.keys());
  }
}
