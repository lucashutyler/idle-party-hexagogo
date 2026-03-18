import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

export interface Account {
  email: string;
  username: string | null;
  verified: boolean;
  createdAt: string;
  lastActiveAt: string | null;
}

interface AccountsData {
  [email: string]: Account;
}

const DATA_DIR = path.resolve('data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

export class AccountStore {
  private accounts: AccountsData = {};

  async load(): Promise<void> {
    if (!existsSync(ACCOUNTS_FILE)) {
      this.accounts = {};
      return;
    }
    try {
      const raw = await readFile(ACCOUNTS_FILE, 'utf-8');
      this.accounts = JSON.parse(raw);
      console.log(`[AccountStore] Loaded ${Object.keys(this.accounts).length} accounts`);
    } catch (err) {
      console.error('[AccountStore] Failed to load accounts:', err);
      this.accounts = {};
    }
  }

  async save(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = ACCOUNTS_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(this.accounts, null, 2), 'utf-8');
    await rename(tmp, ACCOUNTS_FILE);
  }

  findByEmail(email: string): Account | null {
    return this.accounts[email.toLowerCase()] ?? null;
  }

  getAllAccounts(): Account[] {
    return Object.values(this.accounts);
  }

  getAllUsernames(): string[] {
    return Object.values(this.accounts)
      .map(a => a.username)
      .filter((u): u is string => u !== null);
  }

  findByUsername(username: string): Account | null {
    const lower = username.toLowerCase();
    for (const account of Object.values(this.accounts)) {
      if (account.username?.toLowerCase() === lower) return account;
    }
    return null;
  }

  async createAccount(email: string): Promise<Account> {
    const key = email.toLowerCase();
    if (this.accounts[key]) {
      return this.accounts[key];
    }
    const account: Account = {
      email: key,
      username: null,
      verified: false,
      createdAt: new Date().toISOString(),
      lastActiveAt: null,
    };
    this.accounts[key] = account;
    await this.save();
    console.log(`[AccountStore] Created account for "${key}"`);
    return account;
  }

  async setVerified(email: string): Promise<void> {
    const account = this.accounts[email.toLowerCase()];
    if (!account) return;
    account.verified = true;
    await this.save();
  }

  async setUsername(email: string, username: string): Promise<{ success: boolean; error?: string }> {
    const account = this.accounts[email.toLowerCase()];
    if (!account) return { success: false, error: 'Account not found' };

    // Check uniqueness (case-insensitive)
    const existing = this.findByUsername(username);
    if (existing && existing.email !== email.toLowerCase()) {
      return { success: false, error: 'Username is already taken' };
    }

    account.username = username;
    await this.save();
    console.log(`[AccountStore] Set username "${username}" for "${email}"`);
    return { success: true };
  }

  getOldUsername(email: string): string | null {
    return this.accounts[email.toLowerCase()]?.username ?? null;
  }

  async updateLastActive(username: string): Promise<void> {
    const account = this.findByUsername(username);
    if (!account) return;
    account.lastActiveAt = new Date().toISOString();
    await this.save();
  }
}
