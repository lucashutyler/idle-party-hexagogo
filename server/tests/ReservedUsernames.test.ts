import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../src/auth/AccountStore.js';
import { isReservedUsername, isStoreFileName } from '../src/auth/reservedUsernames.js';
import { JsonFileStore } from '../src/game/JsonFileStore.js';
import type { PlayerSaveData } from '../src/game/GameStateStore.js';

const SERVER_SRC = resolve(__dirname, '../src');
const JSON_FILE_LITERAL = /['"`]([A-Za-z0-9_-]+)\.json['"`]/g;
/** VersionStore's file is in data/versions/, so a player can have this name. */
const NOT_DIRECTLY_IN_DATA = new Set(['manifest']);

function jsonFileNamesInSource(): string[] {
  const names = new Set<string>();
  const files = readdirSync(SERVER_SRC, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts'));
  for (const file of files) {
    for (const match of readFileSync(join(SERVER_SRC, file), 'utf8').matchAll(JSON_FILE_LITERAL)) names.add(match[1]);
  }
  return [...names];
}

function saveFor(username: string): PlayerSaveData {
  return { username, position: { col: 0, row: 0 } } as unknown as PlayerSaveData;
}

describe('isReservedUsername', () => {
  it.each(['accounts', 'world', 'items', 'api-tokens', 'invite-list', 'skill-slots', 'tile-types'])('reserves the store file name %s', (name) => {
    expect(isReservedUsername(name)).toBe(true);
    expect(isReservedUsername(name.toUpperCase())).toBe(true);
  });

  it.each(['Server', 'server', 'undefined', '__proto__', 'constructor', 'Constructor', 'toString', 'valueOf', 'hasOwnProperty'])('reserves %s', (name) => {
    expect(isReservedUsername(name)).toBe(true);
  });

  it.each(['alice', 'Knight_42', 'bot_001', 'Worlds', 'accounts2', 'item', 'Serverus', 'my-items', 'manifest'])('leaves %s free', (name) => {
    expect(isReservedUsername(name)).toBe(false);
  });

  it('covers every file the server source keeps directly in data/', () => {
    const names = jsonFileNamesInSource();
    expect(names).toContain('accounts');
    expect(names.filter(name => !isStoreFileName(name) && !NOT_DIRECTLY_IN_DATA.has(name))).toEqual([]);
  });

  it('holds only names that are files directly in data/', () => {
    expect(isStoreFileName('manifest')).toBe(false);
    expect(isStoreFileName('Server')).toBe(false);
  });
});

describe('AccountStore.setUsername', () => {
  let accounts: AccountStore;

  beforeEach(async () => {
    accounts = new AccountStore();
    vi.spyOn(accounts as unknown as { save(): Promise<void> }, 'save').mockResolvedValue();
    await accounts.createAccount('a@example.test');
  });

  it('refuses a reserved name on a first pick and on a rename', async () => {
    expect((await accounts.setUsername('a@example.test', 'Accounts')).success).toBe(false);
    expect(accounts.findByEmail('a@example.test')?.username).toBeNull();

    expect((await accounts.setUsername('a@example.test', 'alice')).success).toBe(true);
    expect((await accounts.setUsername('a@example.test', 'world')).success).toBe(false);
    expect(accounts.findByEmail('a@example.test')?.username).toBe('alice');
  });

  it('still takes an ordinary name', async () => {
    expect(await accounts.setUsername('a@example.test', 'Regular_Name-1')).toEqual({ success: true });
  });
});

describe('JsonFileStore beside store files', () => {
  let dir: string;
  let store: JsonFileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reserved-usernames-'));
    store = new JsonFileStore(dir);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('never writes a player over a store file', async () => {
    const accountsFile = join(dir, 'accounts.json');
    await writeFile(accountsFile, '{"a@example.test":{"username":"alice"}}');

    await store.save(saveFor('accounts'));
    await store.saveAll([saveFor('trades'), saveFor('alice')]);

    expect(await readFile(accountsFile, 'utf8')).toBe('{"a@example.test":{"username":"alice"}}');
    expect((await readdir(dir)).sort()).toEqual(['accounts.json', 'alice.json']);
  });

  it('does not read a store file back as a player', async () => {
    await writeFile(join(dir, 'accounts.json'), JSON.stringify(saveFor('accounts')));
    await store.save(saveFor('alice'));

    expect((await store.loadAll()).map(save => save.username)).toEqual(['alice']);
    expect(await store.load('accounts')).toBeNull();
  });

  it('keeps saving an existing player whose name only differs by case or has no file behind it', async () => {
    await store.save(saveFor('Items'));
    await store.save(saveFor('Server'));
    await store.save(saveFor('manifest'));

    expect((await store.loadAll()).map(save => save.username).sort()).toEqual(['Items', 'Server', 'manifest']);
  });
});
