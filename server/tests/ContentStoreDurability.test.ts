import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { SEED_SKILLS } from '@idle-party-rpg/shared';
import type { DesignNote, NpcDefinition, QuestDefinition, SetDefinition, ShopDefinition } from '@idle-party-rpg/shared';

// ContentStore resolves its data dir from process.cwd() at module load, so the chdir comes before the dynamic import.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type ContentStoreInstance = InstanceType<ContentStoreCtor>;
type BootBackupModule = typeof import('../src/game/BootBackup.js');

let ContentStore: ContentStoreCtor;
let bootBackup: BootBackupModule;
let tmpDir: string;
let dataDir: string;
let originalCwd: string;

const CORE_FILES = ['monsters.json', 'items.json', 'zones.json', 'world.json'];
const OPTIONAL_FILES = [
  'encounters.json', 'sets.json', 'shops.json', 'henchmen.json', 'tile-types.json', 'recipes.json', 'npcs.json',
  'quests.json', 'dungeons.json', 'skills.json', 'skill-slots.json', 'design-notes.json',
];
const CONTENT_FILES = [...CORE_FILES, ...OPTIONAL_FILES];

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'content-durability-'));
  dataDir = path.join(tmpDir, 'data');
  process.chdir(tmpDir);
  ({ ContentStore } = await import('../src/game/ContentStore.js'));
  bootBackup = await import('../src/game/BootBackup.js');
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function loadedStore(): Promise<ContentStoreInstance> {
  const store = new ContentStore();
  await store.load();
  return store;
}

/** Every file directly in data/, by name; the boot backups are left out. */
async function filesOnDisk(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
    if (entry.isFile()) result[entry.name] = await fs.readFile(path.join(dataDir, entry.name), 'utf-8');
  }
  return result;
}

async function tempFiles(): Promise<string[]> {
  return (await fs.readdir(dataDir)).filter(name => name.endsWith('.tmp'));
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

function loggedErrors(): string[] {
  return vi.mocked(console.error).mock.calls.map(call => String(call[0]));
}

function monsterLike(store: ContentStoreInstance, id: string) {
  const [template] = Object.values(store.getAllMonsters());
  return { ...template, id, name: `Monster ${id}` };
}

describe('ContentStore refuses to load around a damaged file', () => {
  it.each(['world.json', 'quests.json'])('rejects a half-written %s, naming it, and changes nothing on disk', async (name) => {
    await loadedStore();
    const file = path.join(dataDir, name);
    const full = await fs.readFile(file, 'utf-8');
    await fs.writeFile(file, full.slice(0, Math.ceil(full.length / 2)));
    const before = await filesOnDisk();

    await expect(new ContentStore().load()).rejects.toThrow(name);

    expect(await filesOnDisk()).toEqual(before);
    expect(loggedErrors().some(line => line.includes(`${name} is unreadable. Refusing to start`))).toBe(true);
  });

  it.each([
    ['an empty core file', 'items.json', ''],
    ['an empty optional file', 'skills.json', ''],
    ['a file of blanks', 'zones.json', ' \n\t'],
    ['a file of zero bytes from a crash', 'world.json', '\0\0\0\0'],
    ['a core list file holding an object', 'monsters.json', '{"goblin":{}}'],
    ['an optional list file holding null', 'tile-types.json', 'null'],
    ['a world without a list of tiles', 'world.json', '{"startTile":{"col":0,"row":0}}'],
  ])('rejects %s', async (_label, name, content) => {
    await loadedStore();
    await fs.writeFile(path.join(dataDir, name), content);
    const before = await filesOnDisk();

    await expect(new ContentStore().load()).rejects.toThrow(name);

    expect(await filesOnDisk()).toEqual(before);
  });

  it('rejects a missing core file while the others exist', async () => {
    await loadedStore();
    await fs.rm(path.join(dataDir, 'zones.json'));
    const before = await filesOnDisk();

    await expect(new ContentStore().load()).rejects.toThrow('zones.json');

    expect(await filesOnDisk()).toEqual(before);
  });

  it('rejects a read error other than a missing file', async () => {
    await loadedStore();
    await fs.rm(path.join(dataDir, 'npcs.json'));
    await fs.mkdir(path.join(dataDir, 'npcs.json'));

    await expect(new ContentStore().load()).rejects.toThrow('npcs.json');
  });
});

describe('ContentStore loads what it can read', () => {
  it('seeds defaults when no data files exist', async () => {
    const store = await loadedStore();

    expect(Object.keys(store.getAllMonsters()).length).toBeGreaterThan(0);
    expect(store.getWorld().tiles.length).toBeGreaterThan(0);
    for (const name of CONTENT_FILES) {
      await expect(fs.readFile(path.join(dataDir, name), 'utf-8').then(JSON.parse)).resolves.toBeDefined();
    }
  });

  it('seeds again when all four core files are gone', async () => {
    await loadedStore();
    for (const name of CORE_FILES) await fs.rm(path.join(dataDir, name));

    const store = await loadedStore();

    expect(store.getWorld().tiles.length).toBeGreaterThan(0);
  });

  it('loads an absent optional file as before: seeded where it always was, otherwise empty', async () => {
    const first = await loadedStore();
    await first.addOrUpdateQuest({ id: 'q1', name: 'Q', description: 'D', scope: 'solo', objectives: [], rewards: [] } as QuestDefinition);
    for (const name of ['skills.json', 'skill-slots.json', 'tile-types.json', 'quests.json', 'design-notes.json']) {
      await fs.rm(path.join(dataDir, name));
    }

    const store = await loadedStore();

    expect(Object.keys(store.getAllSkills()).length).toBe(Object.keys(SEED_SKILLS).length);
    expect(Object.keys(store.getAllSkillSlotSchedules()).length).toBeGreaterThan(0);
    expect(Object.keys(store.getAllTileTypes()).length).toBeGreaterThan(0);
    expect(store.getAllQuests()).toEqual({});
    expect(store.getAllDesignNotes()).toEqual({});
    expect(JSON.parse(await fs.readFile(path.join(dataDir, 'skills.json'), 'utf-8')).length).toBe(Object.keys(SEED_SKILLS).length);
  });

  it('loads back every file it wrote, with content of every kind', async () => {
    const store = await loadedStore();
    const [item] = Object.values(store.getAllItems());
    await store.addOrUpdateMonster(monsterLike(store, 'extra_monster'));
    await store.addOrUpdateSet({ id: 'set1', name: 'Set', itemIds: [item.id], breakpoints: [{ piecesRequired: 1, bonuses: { bonusHp: 5 } }] } as SetDefinition);
    await store.addOrUpdateShop({ id: 'shop1', name: 'Shop', inventory: [{ itemId: item.id, price: 3 }] } as ShopDefinition);
    await store.addOrUpdateNpc({ id: 'npc1', name: 'Npc', emoji: '🙂', greeting: 'Hi', questIds: ['q1'] } as NpcDefinition);
    await store.addOrUpdateQuest({ id: 'q1', name: 'Q', description: 'D', scope: 'solo', objectives: [], rewards: [{ kind: 'gold', amount: 1 }] } as unknown as QuestDefinition);
    await store.addOrUpdateDesignNote({ id: 'n1', title: 'T', body: 'B', author: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as DesignNote);
    await store.addOrUpdateMap({ id: 'second_map', name: 'Second', startTile: { col: 0, row: 0 } });

    const reloaded = await loadedStore();

    expect(reloaded.toSnapshot()).toEqual(store.toSnapshot());
    expect(await tempFiles()).toEqual([]);
  });

  it('loads parseable content it did not expect: odd entries are skipped, old shapes migrate', async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const write = (name: string, value: unknown) => fs.writeFile(path.join(dataDir, name), JSON.stringify(value));
    await write('monsters.json', [null, 7, { id: 'm1', name: 'M', unknownField: true }]);
    await write('items.json', [{ id: 'i1', name: 'Old', equipSlot: 'mainhand', twoHanded: true }]);
    await write('zones.json', [
      { id: 'z_old', displayName: 'Old', levelRange: [1, 2], encounterTable: [{ monsterId: 'm1', weight: 1, minCount: 1, maxCount: 2 }] },
      { id: 'z_odd', displayName: 'Odd', levelRange: [1, 2], encounterTable: [null] },
      { id: 'z_none', displayName: 'None', levelRange: [1, 2] },
    ]);
    await write('world.json', { startTile: { col: 0, row: 0 }, tiles: [null, { col: 0, row: 0, type: 'plains', zone: 'z_old', name: 'Legacy room' }] });
    await write('quests.json', []);

    const store = await loadedStore();

    expect(Object.keys(store.getAllMonsters())).toEqual(['m1']);
    expect(store.getItem('i1')?.equipSlot).toBe('twohanded');
    expect(store.getZone('z_old')?.encounterTable).toEqual([{ encounterId: 'auto_m1', weight: 1 }]);
    expect(store.getWorld().tiles).toHaveLength(1);
    expect(store.getWorld().tiles[0].mapId).toBeDefined();
    expect(store.getWorld().tiles[0].id).toBeTruthy();
  });

  it('loads a core list that is empty without seeding over it', async () => {
    await loadedStore();
    await fs.writeFile(path.join(dataDir, 'monsters.json'), '[]');

    const store = await loadedStore();

    expect(store.getAllMonsters()).toEqual({});
  });

  it('loads a file that starts with a byte order mark', async () => {
    await loadedStore();
    const file = path.join(dataDir, 'npcs.json');
    await fs.writeFile(file, `﻿${await fs.readFile(file, 'utf-8')}`);

    await expect(loadedStore()).resolves.toBeDefined();
  });
});

describe('ContentStore writes', () => {
  it('leaves every file whole and no temp file after ten overlapping saves', async () => {
    const store = await loadedStore();

    await Promise.all(Array.from({ length: 10 }, (_, i) => store.addOrUpdateMonster(monsterLike(store, `overlap_${i}`))));

    for (const name of CONTENT_FILES) {
      await expect(fs.readFile(path.join(dataDir, name), 'utf-8').then(JSON.parse)).resolves.toBeDefined();
    }
    expect(await tempFiles()).toEqual([]);
    const reloaded = await loadedStore();
    for (let i = 0; i < 10; i++) expect(reloaded.getMonster(`overlap_${i}`)).toBeDefined();
  });

  it('writes nothing from persistIfDirty when every change is on disk', async () => {
    const store = await loadedStore();
    await store.addOrUpdateMonster(monsterLike(store, 'saved'));
    await fs.rm(path.join(dataDir, 'monsters.json'));

    await store.persistIfDirty();

    expect(await exists(path.join(dataDir, 'monsters.json'))).toBe(false);
  });

  it('writes again from persistIfDirty after a failed write, then stops', async () => {
    const store = await loadedStore();
    const items = path.join(dataDir, 'items.json');
    await fs.rm(items);
    await fs.mkdir(path.join(items, 'in-the-way'), { recursive: true });

    await expect(store.addOrUpdateMonster(monsterLike(store, 'retried'))).rejects.toThrow();
    expect(await tempFiles()).toEqual([]);

    await fs.rm(items, { recursive: true });
    await store.persistIfDirty();

    expect(JSON.parse(await fs.readFile(items, 'utf-8'))).toEqual(Object.values(store.getAllItems()));
    expect(JSON.parse(await fs.readFile(path.join(dataDir, 'monsters.json'), 'utf-8')).some((m: { id: string }) => m.id === 'retried')).toBe(true);

    await fs.rm(items);
    await store.persistIfDirty();
    expect(await exists(items)).toBe(false);
  });

  it('counts a later save as covering an earlier one that failed', async () => {
    const store = await loadedStore();
    const items = path.join(dataDir, 'items.json');
    await fs.rm(items);
    await fs.mkdir(path.join(items, 'in-the-way'), { recursive: true });
    const failed = store.addOrUpdateMonster(monsterLike(store, 'first'));
    await expect(failed).rejects.toThrow();
    await fs.rm(items, { recursive: true });

    await store.addOrUpdateMonster(monsterLike(store, 'second'));
    await fs.rm(items);
    await store.persistIfDirty();

    expect(await exists(items)).toBe(false);
    const reloadedMonsters = JSON.parse(await fs.readFile(path.join(dataDir, 'monsters.json'), 'utf-8')) as { id: string }[];
    expect(reloadedMonsters.map(m => m.id)).toEqual(expect.arrayContaining(['first', 'second']));
  });
});

describe('boot backups', () => {
  const backupsDir = () => path.join(dataDir, 'boot-backups');
  const backupNames = async () => (await fs.readdir(backupsDir()).catch(() => [] as string[])).sort();

  it('makes none on a fresh install, then copies the files the next boot reads', async () => {
    await loadedStore();
    expect(await backupNames()).toEqual([]);
    const before = await filesOnDisk();

    await loadedStore();

    const [name] = await backupNames();
    for (const file of CONTENT_FILES) {
      expect(await fs.readFile(path.join(backupsDir(), name, file), 'utf-8')).toBe(before[file]);
    }
  });

  it('copies the version manifest, the accounts file and a damaged file byte for byte before refusing', async () => {
    await loadedStore();
    const damaged = Buffer.from('[{"id": "goblin", "na');
    const manifest = Buffer.from('{"versions":[],"activeVersionId":null}');
    const accounts = Buffer.from('{"a@example.test":{"email":"a@example.test","username":"alice"}}');
    await fs.writeFile(path.join(dataDir, 'monsters.json'), damaged);
    await fs.mkdir(path.join(dataDir, 'versions'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'versions', 'manifest.json'), manifest);
    await fs.writeFile(path.join(dataDir, 'accounts.json'), accounts);

    await expect(new ContentStore().load()).rejects.toThrow('monsters.json');

    const [name] = await backupNames();
    const backup = path.join(backupsDir(), name);
    expect(await fs.readFile(path.join(backup, 'monsters.json'))).toEqual(damaged);
    expect(await fs.readFile(path.join(backup, 'versions', 'manifest.json'))).toEqual(manifest);
    expect(await fs.readFile(path.join(backup, 'accounts.json'))).toEqual(accounts);
  });

  it('makes one backup however many times a boot fails on the same files', async () => {
    await loadedStore();
    await fs.writeFile(path.join(dataDir, 'world.json'), '{"tiles": [');

    for (let i = 0; i < 3; i++) await expect(new ContentStore().load()).rejects.toThrow();

    expect(await backupNames()).toHaveLength(1);
  });

  it('keeps the newest ten and leaves folders it did not make', async () => {
    const file = path.join(dataDir, 'monsters.json');
    await fs.mkdir(path.join(backupsDir(), 'kept-by-hand'), { recursive: true });
    const made: string[] = [];
    for (let i = 0; i < 12; i++) {
      await fs.writeFile(file, `[${i}]`);
      const target = await bootBackup.backUpDataFiles(dataDir, [file], new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
      made.push(path.basename(target!));
    }

    expect(await backupNames()).toEqual([...made.slice(2), 'kept-by-hand'].sort());
    expect(await fs.readFile(path.join(backupsDir(), made[11], 'monsters.json'), 'utf-8')).toBe('[11]');
  });

  it('names a backup by its time in a form every filesystem takes', () => {
    expect(bootBackup.bootBackupName(new Date('2026-03-04T05:06:07.089Z'))).toBe('2026-03-04T05-06-07-089Z');
  });

  it('lets the boot go on when the backup cannot be written', async () => {
    await loadedStore();
    await fs.writeFile(backupsDir(), 'a file where the folder goes');

    await expect(loadedStore()).resolves.toBeDefined();

    expect(loggedErrors().some(line => line.includes('[BootBackup]'))).toBe(true);
  });
});
