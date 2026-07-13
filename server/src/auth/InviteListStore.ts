import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const INVITE_LIST_FILE = path.join(DATA_DIR, 'invite-list.json');

/**
 * Persists the admin-managed invite allow list to data/invite-list.json.
 * Used alongside ADMIN_EMAILS to gate signups when INVITE_ONLY=true.
 */
export class InviteListStore {
  private emails = new Set<string>();

  async load(): Promise<void> {
    if (!existsSync(INVITE_LIST_FILE)) {
      this.emails = new Set();
      return;
    }
    try {
      const raw = await readFile(INVITE_LIST_FILE, 'utf-8');
      const arr = JSON.parse(raw) as string[];
      this.emails = new Set(Array.isArray(arr) ? arr.map(e => e.toLowerCase()) : []);
      console.log(`[InviteListStore] Loaded ${this.emails.size} invited emails`);
    } catch (err) {
      console.error('[InviteListStore] Failed to load invite list:', err);
      this.emails = new Set();
    }
  }

  private async save(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = INVITE_LIST_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(this.getAll(), null, 2), 'utf-8');
    await rename(tmp, INVITE_LIST_FILE);
  }

  getAll(): string[] {
    return Array.from(this.emails).sort();
  }

  has(email: string): boolean {
    return this.emails.has(email.toLowerCase());
  }

  async add(email: string): Promise<void> {
    this.emails.add(email.toLowerCase());
    await this.save();
  }

  async remove(email: string): Promise<void> {
    this.emails.delete(email.toLowerCase());
    await this.save();
  }
}
