import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let failNextWrite = false;

vi.mock('fs', () => ({ existsSync: (path: string) => files.has(path) }));
vi.mock('fs/promises', () => ({
  mkdir: async () => {},
  readFile: async (path: string) => files.get(path),
  writeFile: async (path: string, content: string) => {
    await tick();
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('disk error');
    }
    files.set(path, content);
  },
  rename: async (from: string, to: string) => {
    await tick();
    const content = files.get(from);
    if (content === undefined) throw Object.assign(new Error(`ENOENT: rename ${from}`), { code: 'ENOENT' });
    files.delete(from);
    files.set(to, content);
  },
}));

const { AccountStore } = await import('../src/auth/AccountStore.js');

function savedEmails(): string[] {
  const file = [...files.keys()].find(path => path.endsWith('accounts.json'))!;
  return Object.keys(JSON.parse(files.get(file)!)).sort();
}

describe('AccountStore writes', () => {
  beforeEach(() => {
    files.clear();
    failNextWrite = false;
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('survives many writes at once and keeps them all', async () => {
    const accounts = new AccountStore();
    const emails = Array.from({ length: 8 }, (_, i) => `p${i}@example.test`);

    await Promise.all(emails.map(email => accounts.createAccount(email)));

    expect(savedEmails()).toEqual(emails.sort());
  });

  it('reports a failed write to its caller and still runs the next one', async () => {
    const accounts = new AccountStore();
    await accounts.createAccount('first@example.test');

    failNextWrite = true;
    const failed = accounts.createAccount('second@example.test');
    const after = accounts.createAccount('third@example.test');

    await expect(failed).rejects.toThrow('disk error');
    await expect(after).resolves.toMatchObject({ email: 'third@example.test' });
    expect(savedEmails()).toEqual(['first@example.test', 'second@example.test', 'third@example.test']);
  });
});
