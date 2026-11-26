import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { TradeState } from '@idle-party-rpg/shared';
import type { GuildData } from '../src/game/social/GuildStore.js';
import type { PlayerSaveData } from '../src/game/GameStateStore.js';

// The guild and trade stores resolve data/ from process.cwd() at module load, so the chdir comes before the dynamic import.
type GuildStoreCtor = typeof import('../src/game/social/GuildStore.js').GuildStore;
type TradeStoreCtor = typeof import('../src/game/social/TradeStore.js').TradeStore;
type JsonFileStoreCtor = typeof import('../src/game/JsonFileStore.js').JsonFileStore;

let GuildStore: GuildStoreCtor;
let TradeStore: TradeStoreCtor;
let JsonFileStore: JsonFileStoreCtor;
let tmpDir: string;
let dataDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'social-durability-'));
  dataDir = path.join(tmpDir, 'data');
  process.chdir(tmpDir);
  ({ GuildStore } = await import('../src/game/social/GuildStore.js'));
  ({ TradeStore } = await import('../src/game/social/TradeStore.js'));
  ({ JsonFileStore } = await import('../src/game/JsonFileStore.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });
});

const GUILD: GuildData = {
  info: { id: 'g1', name: 'Guild', leaderUsername: 'alice', createdAt: 1 } as unknown as GuildData['info'],
  members: [{ username: 'alice', role: 'leader' } as unknown as GuildData['members'][number]],
};
const TRADE = { id: 't1', status: 'pending', nonce: 'n', initiator: { username: 'alice', items: [], gold: 0 } } as unknown as TradeState;

async function asideFiles(name: string): Promise<string[]> {
  return (await fs.readdir(dataDir)).filter(file => file.startsWith(`${name}.unreadable-`));
}

describe('GuildStore', () => {
  const file = () => path.join(dataDir, 'guilds.json');

  it('loads back what it saved', async () => {
    const store = new GuildStore();
    store.set('g1', GUILD);
    await store.save();

    const loaded = new GuildStore();
    await loaded.load();

    expect(loaded.getAll()).toEqual([GUILD]);
    expect((await fs.readdir(dataDir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each([
    ['a half-written file', '[{"info": {"id": "g1"'],
    ['an empty file', ''],
    ['an object instead of a list', '{"g1": {}}'],
    ['an entry that is not a guild', '[{"info": null, "members": []}]'],
  ])('moves %s aside, starts empty, and the next save writes beside it', async (_label, content) => {
    await fs.writeFile(file(), content);
    const store = new GuildStore();

    await store.load();
    expect(store.getAll()).toEqual([]);
    store.set('g1', GUILD);
    await store.save();

    const [aside] = await asideFiles('guilds.json');
    expect(await fs.readFile(path.join(dataDir, aside), 'utf-8')).toBe(content);
    expect(JSON.parse(await fs.readFile(file(), 'utf-8'))).toEqual([GUILD]);
    expect(vi.mocked(console.error)).toHaveBeenCalled();
  });

  it('loads back the invites it saved', async () => {
    const withInvites: GuildData = { ...GUILD, invites: [{ username: 'Mira', inviterUsername: 'alice', createdAt: 5 }] };
    const store = new GuildStore();
    store.set('g1', withInvites);
    await store.save();

    const loaded = new GuildStore();
    await loaded.load();

    expect(loaded.getAll()).toEqual([withInvites]);
  });

  it('loads a file written before invites, unchanged, and saves it back without the field', async () => {
    const old = [{ info: { id: 'g1', name: 'Old Hall', leaderUsername: 'alice', createdAt: 1 }, members: [{ username: 'alice', joinedAt: 1, role: 'leader' }] }];
    await fs.writeFile(file(), JSON.stringify(old));
    const store = new GuildStore();

    await store.load();
    expect(store.getAll()).toEqual(old);
    await store.save();

    expect(JSON.parse(await fs.readFile(file(), 'utf-8'))).toEqual(old);
    expect(await asideFiles('guilds.json')).toEqual([]);
  });

  it('drops only the unreadable invites and keeps the guild', async () => {
    const good = { username: 'Mira', inviterUsername: 'alice', createdAt: 5 };
    await fs.writeFile(file(), JSON.stringify([
      { ...GUILD, invites: [good, null, { username: 7 }] },
      { ...GUILD, info: { ...GUILD.info, id: 'g2' }, invites: 'not a list' },
    ]));
    const store = new GuildStore();

    await store.load();

    expect(store.get('g1')).toEqual({ ...GUILD, invites: [good] });
    expect(store.get('g2')).toEqual({ ...GUILD, info: { ...GUILD.info, id: 'g2' } });
    expect(await asideFiles('guilds.json')).toEqual([]);
  });

  it('writes guilds with invites in the shape an older build reads: a list with info.id and members on each', async () => {
    const store = new GuildStore();
    store.set('g1', { ...GUILD, invites: [{ username: 'Mira', inviterUsername: 'alice', createdAt: 5 }] });
    await store.save();

    const written = JSON.parse(await fs.readFile(file(), 'utf-8')) as unknown[];
    expect(Array.isArray(written)).toBe(true);
    for (const guild of written as GuildData[]) {
      expect(typeof guild.info.id).toBe('string');
      expect(Array.isArray(guild.members)).toBe(true);
    }
  });

  it('starts empty with no file and moves nothing', async () => {
    const store = new GuildStore();

    await store.load();

    expect(store.getAll()).toEqual([]);
    expect(await fs.readdir(dataDir)).toEqual([]);
  });

  it('throws on a read that fails and moves nothing, since the file may be fine', async () => {
    await fs.mkdir(file());

    await expect(new GuildStore().load()).rejects.toThrow('guilds.json');

    expect(await asideFiles('guilds.json')).toEqual([]);
  });
});

describe('TradeStore', () => {
  const file = () => path.join(dataDir, 'trades.json');

  it('loads back what it saved', async () => {
    await new TradeStore().save([TRADE]);

    expect(await new TradeStore().load()).toEqual([TRADE]);
  });

  it.each([
    ['a half-written file', '[{"id": "t1", "sta'],
    ['an empty file', ''],
    ['an object instead of a list', '{"t1": {}}'],
    ['an entry that is not a trade', '[null]'],
  ])('moves %s aside, starts empty, and the next save writes beside it', async (_label, content) => {
    await fs.writeFile(file(), content);
    const store = new TradeStore();

    expect(await store.load()).toEqual([]);
    await store.save([TRADE]);

    const [aside] = await asideFiles('trades.json');
    expect(await fs.readFile(path.join(dataDir, aside), 'utf-8')).toBe(content);
    expect(JSON.parse(await fs.readFile(file(), 'utf-8'))).toEqual([TRADE]);
  });

  it('throws on a read that fails and moves nothing', async () => {
    await fs.mkdir(file());

    await expect(new TradeStore().load()).rejects.toThrow('trades.json');

    expect(await asideFiles('trades.json')).toEqual([]);
  });
});

describe('JsonFileStore unreadable saves', () => {
  const save = (username: string) => ({ username, battleCount: 3, position: { col: 1, row: 2 } }) as unknown as PlayerSaveData;

  it.each([
    ['a half-written save', '{"username": "alice", "battleCou'],
    ['an empty save', ''],
  ])('moves %s aside and reads it as no save', async (_label, content) => {
    await fs.writeFile(path.join(dataDir, 'alice.json'), content);
    const store = new JsonFileStore(dataDir);

    expect(await store.load('alice')).toBeNull();
    await store.save(save('alice'));

    const [aside] = await asideFiles('alice.json');
    expect(await fs.readFile(path.join(dataDir, aside), 'utf-8')).toBe(content);
    expect(await store.load('alice')).toEqual(save('alice'));
  });

  it('throws on a read that fails rather than start the player fresh', async () => {
    await fs.mkdir(path.join(dataDir, 'alice.json'));

    await expect(new JsonFileStore(dataDir).load('alice')).rejects.toThrow('alice.json');

    expect(await asideFiles('alice.json')).toEqual([]);
  });

  it('skips an unreadable save at boot and never reads the copy set aside', async () => {
    const store = new JsonFileStore(dataDir);
    await store.save(save('bob'));
    await fs.writeFile(path.join(dataDir, 'alice.json'), '{"username": "al');

    expect((await store.loadAll()).map(s => s.username)).toEqual(['bob']);
    expect((await store.loadAll()).map(s => s.username)).toEqual(['bob']);
    expect(await asideFiles('alice.json')).toHaveLength(1);
  });
});
