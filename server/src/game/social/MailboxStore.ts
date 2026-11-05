import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import type { MailboxEntry } from '@idle-party-rpg/shared';

/** Recipient's exact username → their pending gifts. A Map because `__proto__` is a legal username. */
export type Mailboxes = Map<string, MailboxEntry[]>;

export interface MailboxStore {
  load(): Promise<Mailboxes>;
  save(mailboxes: Mailboxes): Promise<void>;
}

/** Its own folder, because a file directly in data/ would share a path with the player of that name. */
const MAILBOX_DIR = path.resolve('data', 'mailboxes');

export class JsonMailboxStore implements MailboxStore {
  private readonly dir: string;
  private readonly file: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dir: string = MAILBOX_DIR) {
    this.dir = dir;
    this.file = path.join(dir, 'entries.json');
  }

  async load(): Promise<Mailboxes> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw err;
    }
    try {
      const rows = JSON.parse(raw) as { username: string; entries: MailboxEntry[] }[];
      if (!rows.every(row => typeof row?.username === 'string' && Array.isArray(row.entries))) {
        throw new Error('A row is not a mailbox');
      }
      return new Map(rows.map(row => [row.username, row.entries]));
    } catch (err) {
      // Starting empty would overwrite this file on the next save, so it is kept for recovery.
      const aside = `${this.file}.unreadable-${Date.now()}`;
      await rename(this.file, aside);
      console.error(`[MailboxStore] Moved an unreadable file to ${aside}:`, err);
      return new Map();
    }
  }

  /** Writes run one at a time, because they share a temp file. A failed write doesn't stop the next one. */
  save(mailboxes: Mailboxes): Promise<void> {
    const rows = Array.from(mailboxes, ([username, entries]) => ({ username, entries }));
    const json = JSON.stringify(rows, null, 2);
    this.writeQueue = this.writeQueue.then(() => this.write(json), () => this.write(json));
    return this.writeQueue;
  }

  private async write(json: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, json, 'utf-8');
    await rename(tmp, this.file);
  }
}
