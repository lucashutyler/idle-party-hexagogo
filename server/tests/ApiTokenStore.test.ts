import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// ApiTokenStore resolves data/ from process.cwd() at module load, so the tmp-dir chdir must
// happen BEFORE the module is imported (dynamic import below). Mirrors DesignNotes.test.ts.
type ApiTokenStoreCtor = typeof import('../src/auth/ApiTokenStore.js').ApiTokenStore;
type ApiTokenStoreInstance = InstanceType<ApiTokenStoreCtor>;

let ApiTokenStore: ApiTokenStoreCtor;
let hashApiToken: typeof import('../src/auth/ApiTokenStore.js').hashApiToken;
let API_TOKEN_PREFIX: string;
let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-tokens-'));
  process.chdir(tmpDir);
  ({ ApiTokenStore, hashApiToken, API_TOKEN_PREFIX } = await import('../src/auth/ApiTokenStore.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

async function loadFreshStore(): Promise<ApiTokenStoreInstance> {
  const store = new ApiTokenStore();
  await store.load();
  return store;
}

const TOKENS_FILE = () => path.join(tmpDir, 'data', 'api-tokens.json');

describe('ApiTokenStore', () => {
  it('starts empty when there is no file on disk', async () => {
    const store = await loadFreshStore();
    expect(store.listForEmail('a@example.com')).toEqual([]);
  });

  it('mints a prefixed secret, returns it once, and never stores it in the clear', async () => {
    const store = await loadFreshStore();
    const { record, token } = await store.create('A@Example.com', 'laptop', null);

    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(record.email).toBe('a@example.com');
    expect(record.tokenHash).toBe(hashApiToken(token));
    expect(record.prefix).toBe(token.slice(0, API_TOKEN_PREFIX.length + 8));

    const onDisk = await fs.readFile(TOKENS_FILE(), 'utf-8');
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(record.tokenHash);
  });

  it('generates a distinct secret every time', async () => {
    const store = await loadFreshStore();
    const a = await store.create('a@example.com', 'one', null);
    const b = await store.create('a@example.com', 'two', null);
    expect(a.token).not.toBe(b.token);
    expect(a.record.id).not.toBe(b.record.id);
  });

  it('resolves a presented secret back to its record, ignoring surrounding whitespace', async () => {
    const store = await loadFreshStore();
    const { record, token } = await store.create('a@example.com', 'laptop', null);
    expect(store.findByToken(token)?.id).toBe(record.id);
    expect(store.findByToken(`  ${token}  `)?.id).toBe(record.id);
    expect(store.findByToken('ipr_wrong')).toBeNull();
  });

  it('lists only the owner\'s tokens, newest first', async () => {
    const store = await loadFreshStore();
    await store.create('a@example.com', 'older', null);
    await new Promise(resolve => setTimeout(resolve, 5));
    await store.create('a@example.com', 'newer', null);
    await store.create('b@example.com', 'someone else', null);

    const mine = store.listForEmail('A@EXAMPLE.COM');
    expect(mine.map(t => t.label)).toEqual(['newer', 'older']);
    expect(store.listForEmail('b@example.com').map(t => t.label)).toEqual(['someone else']);
  });

  it('revokes only the owner\'s own token', async () => {
    const store = await loadFreshStore();
    const { record } = await store.create('a@example.com', 'laptop', null);

    expect(await store.revoke(record.id, 'b@example.com')).toBe(false);
    expect(store.findById(record.id)).not.toBeNull();

    expect(await store.revoke(record.id, 'A@Example.com')).toBe(true);
    expect(store.findById(record.id)).toBeNull();
    expect(await store.revoke(record.id, 'a@example.com')).toBe(false);
  });

  it('stops resolving a revoked secret', async () => {
    const store = await loadFreshStore();
    const { record, token } = await store.create('a@example.com', 'laptop', null);
    await store.revoke(record.id, 'a@example.com');
    expect(store.findByToken(token)).toBeNull();
  });

  it('round-trips through disk, keeping tokens usable after a restart', async () => {
    const first = await loadFreshStore();
    const { record, token } = await first.create('a@example.com', 'laptop', '2099-01-01T00:00:00.000Z');

    const second = await loadFreshStore();
    expect(second.findByToken(token)?.id).toBe(record.id);
    expect(second.listForEmail('a@example.com')[0]).toMatchObject({
      label: 'laptop',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  });

  it('records last use in memory without writing to disk immediately', async () => {
    const store = await loadFreshStore();
    const { record } = await store.create('a@example.com', 'laptop', null);
    const before = await fs.readFile(TOKENS_FILE(), 'utf-8');

    store.markUsed(record.id);
    expect(store.findById(record.id)?.lastUsedAt).not.toBeNull();
    expect(await fs.readFile(TOKENS_FILE(), 'utf-8')).toBe(before);
  });

  it('ignores markUsed for an unknown id', async () => {
    const store = await loadFreshStore();
    expect(() => store.markUsed('does-not-exist')).not.toThrow();
  });

  it('flushes a pending last-use on shutdown so it survives a restart', async () => {
    const first = await loadFreshStore();
    const { record } = await first.create('a@example.com', 'laptop', null);
    first.markUsed(record.id);
    await first.stopFlush();

    const second = await loadFreshStore();
    expect(second.findById(record.id)?.lastUsedAt).not.toBeNull();
  });

  it('revokes every token an email owns', async () => {
    const store = await loadFreshStore();
    await store.create('a@example.com', 'one', null);
    await store.create('a@example.com', 'two', null);
    await store.create('b@example.com', 'theirs', null);

    expect(await store.revokeAllForEmail('a@example.com')).toBe(2);
    expect(store.listForEmail('a@example.com')).toEqual([]);
    expect(store.listForEmail('b@example.com')).toHaveLength(1);
    expect(await store.revokeAllForEmail('a@example.com')).toBe(0);
  });

  it('serializes overlapping writes instead of racing on the shared .tmp path', async () => {
    // The flush timer writes on its own schedule alongside request-driven create/revoke calls, so
    // two save()s really can overlap. Unserialized, the second rename() loses the tmp file to the
    // first and rejects ENOENT — fatal from the timer's unawaited call.
    const store = await loadFreshStore();
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.create('a@example.com', `token-${i}`, null)),
    );

    expect(store.listForEmail('a@example.com')).toHaveLength(8);
    const persisted = JSON.parse(await fs.readFile(TOKENS_FILE(), 'utf-8'));
    expect(persisted).toHaveLength(8);

    // Every secret still authenticates after the concurrent burst.
    const reloaded = await loadFreshStore();
    for (const { record, token } of created) {
      expect(reloaded.findByToken(token)?.id).toBe(record.id);
    }
  });

  it('keeps the file valid when creates and revokes interleave', async () => {
    const store = await loadFreshStore();
    const seeded = await Promise.all(
      Array.from({ length: 4 }, (_, i) => store.create('a@example.com', `seed-${i}`, null)),
    );
    await Promise.all([
      ...seeded.map(s => store.revoke(s.record.id, 'a@example.com')),
      ...Array.from({ length: 4 }, (_, i) => store.create('a@example.com', `fresh-${i}`, null)),
    ]);

    const persisted = JSON.parse(await fs.readFile(TOKENS_FILE(), 'utf-8'));
    expect(persisted.map((t: { label: string }) => t.label).sort())
      .toEqual(['fresh-0', 'fresh-1', 'fresh-2', 'fresh-3']);
  });

  it('survives a corrupt file by starting empty rather than throwing', async () => {
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    await fs.writeFile(TOKENS_FILE(), 'not json at all', 'utf-8');
    const store = await loadFreshStore();
    expect(store.listForEmail('a@example.com')).toEqual([]);
  });

  it('drops malformed records instead of indexing them', async () => {
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    await fs.writeFile(TOKENS_FILE(), JSON.stringify([
      { id: 'good', email: 'a@example.com', label: 'ok', tokenHash: hashApiToken('ipr_ok'), prefix: 'ipr_ok', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: null, lastUsedAt: null },
      { email: 'a@example.com', label: 'no id' },
      { id: 'no-hash', email: 'a@example.com', label: 'no hash' },
    ]), 'utf-8');

    const store = await loadFreshStore();
    expect(store.listForEmail('a@example.com').map(t => t.id)).toEqual(['good']);
    expect(store.findByToken('ipr_ok')?.id).toBe('good');
  });
});
