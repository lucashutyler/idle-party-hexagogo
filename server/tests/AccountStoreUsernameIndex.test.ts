import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../src/auth/AccountStore.js';

const files = new Map<string, string>();

vi.mock('fs', () => ({ existsSync: (path: string) => files.has(path) }));
vi.mock('fs/promises', () => ({
  mkdir: async () => {},
  readFile: async (path: string) => files.get(path),
  writeFile: async (path: string, content: string) => {
    files.set(path, content);
  },
  rename: async (from: string, to: string) => {
    files.set(to, files.get(from)!);
    files.delete(from);
  },
}));

const { AccountStore } = await import('../src/auth/AccountStore.js');
const { resolve, join } = await import('path');

const ACCOUNTS_FILE = join(resolve('data'), 'accounts.json');

function savedAccount(email: string, username: string | null): Account {
  return { email, username, verified: true, createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: null };
}

function writeAccountsFile(...accounts: Account[]): void {
  files.set(ACCOUNTS_FILE, JSON.stringify(Object.fromEntries(accounts.map(a => [a.email, a]))));
}

async function storeWith(...accounts: Account[]): Promise<InstanceType<typeof AccountStore>> {
  writeAccountsFile(...accounts);
  const store = new AccountStore();
  await store.load();
  return store;
}

function scanFor(store: InstanceType<typeof AccountStore>, username: string): Account | null {
  const lower = username.toLowerCase();
  return store.getAllAccounts().find(a => a.username?.toLowerCase() === lower) ?? null;
}

describe('AccountStore username lookups', () => {
  beforeEach(() => {
    files.clear();
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('load', () => {
    it('finds accounts from the file, in any case', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Alice'), savedAccount('b@example.test', 'bob'));

      expect(store.findByUsername('Alice')?.email).toBe('a@example.test');
      expect(store.findByUsername('ALICE')?.email).toBe('a@example.test');
      expect(store.findByUsername('alice')?.email).toBe('a@example.test');
      expect(store.findByUsername('BOB')?.email).toBe('b@example.test');
      expect(store.findByUsername('carol')).toBeNull();
    });

    it('has nothing to find before load', () => {
      expect(new AccountStore().findByUsername('alice')).toBeNull();
    });

    it('skips accounts with no username yet', async () => {
      const store = await storeWith(savedAccount('a@example.test', null));

      expect(store.findByUsername('')).toBeNull();
      expect(store.findByUsername('null')).toBeNull();
      expect(store.findByUsername('undefined')).toBeNull();
    });

    it('reflects the file again on a second load', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Alice'));

      writeAccountsFile(savedAccount('b@example.test', 'Bob'));
      await store.load();

      expect(store.findByUsername('alice')).toBeNull();
      expect(store.findByUsername('bob')?.email).toBe('b@example.test');
    });

    it('forgets everyone when the file is gone', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Alice'));

      files.clear();
      await store.load();

      expect(store.findByUsername('alice')).toBeNull();
    });

    it('forgets everyone when the file cannot be read', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Alice'));

      files.set(ACCOUNTS_FILE, '{ not json');
      await store.load();

      expect(store.findByUsername('alice')).toBeNull();
    });
  });

  describe('createAccount and setUsername', () => {
    it('finds a new account only once it has a name', async () => {
      const store = new AccountStore();
      await store.load();

      const account = await store.createAccount('New@Example.test');
      expect(store.findByUsername('newcomer')).toBeNull();

      expect(await store.setUsername('new@example.test', 'Newcomer')).toEqual({ success: true });
      expect(store.findByUsername('NEWCOMER')).toBe(account);
    });

    it('does not resolve the old name after a rename', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Alice'));

      await store.setUsername('a@example.test', 'Alicia');

      expect(store.findByUsername('alice')).toBeNull();
      expect(store.findByUsername('alicia')?.email).toBe('a@example.test');
    });

    it('lets a renamed-away name be taken by someone else', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Alice'), savedAccount('b@example.test', 'Bob'));

      await store.setUsername('a@example.test', 'Alicia');

      expect(await store.setUsername('b@example.test', 'alice')).toEqual({ success: true });
      expect(store.findByUsername('ALICE')?.email).toBe('b@example.test');
      expect(store.findByUsername('bob')).toBeNull();
    });

    it('follows a change of case only', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Alice'));

      expect(await store.setUsername('a@example.test', 'ALICE')).toEqual({ success: true });

      expect(store.findByUsername('alice')?.username).toBe('ALICE');
    });

    it('refuses a taken name in any case and changes nothing', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Alice'), savedAccount('b@example.test', 'Bob'));

      expect(await store.setUsername('b@example.test', 'ALICE')).toEqual({ success: false, error: 'Username is already taken' });

      expect(store.findByUsername('alice')?.email).toBe('a@example.test');
      expect(store.findByUsername('bob')?.email).toBe('b@example.test');
    });

    it('saves names to the file in the same shape as before', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Alice'));

      await store.setUsername('a@example.test', 'Alicia');

      expect(JSON.parse(files.get(ACCOUNTS_FILE)!)).toEqual({ 'a@example.test': savedAccount('a@example.test', 'Alicia') });
    });
  });

  it('returns the live account, so later changes show through', async () => {
    const store = await storeWith(savedAccount('a@example.test', 'Alice'));

    await store.setDeactivated('a@example.test', true);

    expect(store.findByUsername('alice')).toBe(store.findByEmail('a@example.test'));
    expect(store.findByUsername('alice')?.deactivated).toBe(true);
  });

  it('does not mistake built-in object names for accounts', async () => {
    const store = await storeWith(savedAccount('a@example.test', 'Alice'));

    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(store.findByUsername(name)).toBeNull();
    }
  });

  it('can hold an account named after a built-in', async () => {
    const store = await storeWith(savedAccount('a@example.test', 'Constructor'));

    expect(store.findByUsername('constructor')?.email).toBe('a@example.test');
  });

  it('does not walk the accounts to answer a lookup', async () => {
    const store = await storeWith(savedAccount('a@example.test', 'Alice'), savedAccount('b@example.test', 'Bob'));
    const walks = [
      vi.spyOn(Object, 'values'),
      vi.spyOn(Object, 'keys'),
      vi.spyOn(Object, 'entries'),
    ];

    store.findByUsername('alice');
    store.findByUsername('nobody');

    for (const walk of walks) expect(walk).not.toHaveBeenCalled();
  });

  describe('a file that repeats a name', () => {
    it('resolves to the earliest account', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Twin'), savedAccount('b@example.test', 'TWIN'));

      expect(store.findByUsername('twin')?.email).toBe('a@example.test');
    });

    it('hands the name to the next holder when the first renames', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Twin'), savedAccount('b@example.test', 'TWIN'));

      await store.setUsername('a@example.test', 'Alice');

      expect(store.findByUsername('twin')?.email).toBe('b@example.test');
    });

    it('keeps the name with the first holder when the second renames', async () => {
      const store = await storeWith(savedAccount('a@example.test', 'Twin'), savedAccount('b@example.test', 'TWIN'));

      expect(await store.setUsername('b@example.test', 'Bob')).toEqual({ success: true });

      expect(store.findByUsername('twin')?.email).toBe('a@example.test');
    });
  });

  it('answers exactly as a walk over the accounts would, through random changes', async () => {
    let seed = 1234567;
    const random = (limit: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % limit;
    };
    const names = ['Alice', 'ALICE', 'bob', 'Bob', 'carol', 'Dave', 'dave', 'erin', 'constructor'];
    const emails = Array.from({ length: 6 }, (_, i) => `p${i}@example.test`);
    const store = await storeWith(savedAccount(emails[0], 'Alice'), savedAccount(emails[1], 'ALICE'));

    for (let step = 0; step < 500; step++) {
      const email = emails[random(emails.length)];
      const action = random(10);
      if (action === 0) await store.createAccount(email);
      else if (action === 1) await store.load();
      else await store.setUsername(email, names[random(names.length)]);

      for (const name of [...names, 'nobody']) {
        expect(store.findByUsername(name)).toBe(scanFor(store, name));
      }
    }
  });
});
