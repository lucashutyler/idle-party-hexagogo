import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

vi.mock('fs', () => ({ existsSync: (path: string) => files.has(path) }));
vi.mock('fs/promises', () => ({
  mkdir: async () => {},
  readFile: async (path: string) => files.get(path),
  writeFile: async (path: string, content: string) => {
    await tick();
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

function accountsFile(): string {
  return [...files.keys()].find(path => path.endsWith('accounts.json'))!;
}

describe('AccountStore file handling', () => {
  beforeEach(() => {
    files.clear();
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('survives many writes at once and keeps them all', async () => {
    const accounts = new AccountStore();
    const emails = Array.from({ length: 8 }, (_, i) => `p${i}@example.test`);

    await Promise.all(emails.map(email => accounts.createAccount(email)));

    expect(Object.keys(JSON.parse(files.get(accountsFile())!)).sort()).toEqual(emails.sort());
  });

  it('keeps writing after one write fails', async () => {
    const accounts = new AccountStore();
    await accounts.createAccount('first@example.test');
    const writes = accounts as unknown as { writeNow(): Promise<void> };
    vi.spyOn(writes, 'writeNow').mockImplementationOnce(() => Promise.reject(new Error('disk full')));

    const failed = accounts.save();
    const next = accounts.createAccount('second@example.test');

    await expect(failed).rejects.toThrow('disk full');
    await next;
    expect(Object.keys(JSON.parse(files.get(accountsFile())!))).toContain('second@example.test');
  });

  it('names an account that holds a store file name when loading, and changes nothing', async () => {
    const first = new AccountStore();
    await first.createAccount('held@example.test');
    await first.createAccount('case@example.test');
    await first.createAccount('fine@example.test');
    const data = JSON.parse(files.get(accountsFile())!);
    data['held@example.test'].username = 'world';
    data['case@example.test'].username = 'World';
    data['fine@example.test'].username = 'Server';
    const onDisk = JSON.stringify(data);
    files.set(accountsFile(), onDisk);

    const reloaded = new AccountStore();
    const save = vi.spyOn(reloaded, 'save');
    await reloaded.load();

    const logged = vi.mocked(console.error).mock.calls.map(call => String(call[0]));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('held@example.test');
    expect(reloaded.findByEmail('held@example.test')?.username).toBe('world');
    expect(save).not.toHaveBeenCalled();
    expect(files.get(accountsFile())).toBe(onDisk);
  });

  it('lets such an account move to an allowed name', async () => {
    const first = new AccountStore();
    await first.createAccount('held@example.test');
    const data = JSON.parse(files.get(accountsFile())!);
    data['held@example.test'].username = 'world';
    files.set(accountsFile(), JSON.stringify(data));

    const reloaded = new AccountStore();
    await reloaded.load();

    expect(await reloaded.setUsername('held@example.test', 'Fresh_Name')).toEqual({ success: true });
  });

  it('loads a file holding something other than accounts without throwing', async () => {
    const first = new AccountStore();
    await first.createAccount('a@example.test');
    files.set(accountsFile(), JSON.stringify({ username: 'accounts', target: null, position: { col: 0, row: 0 } }));

    await expect(new AccountStore().load()).resolves.toBeUndefined();
  });
});
