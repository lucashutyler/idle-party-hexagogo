import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// VersionStore resolves data/versions from process.cwd() at module load, so the chdir comes before the dynamic import.
type VersionStoreModule = typeof import('../src/game/VersionStore.js');
type ContentSnapshot = import('../src/game/VersionStore.js').ContentSnapshot;

let VersionStore: VersionStoreModule['VersionStore'];
let tmpDir: string;
let versionsDir: string;
let manifestFile: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'version-durability-'));
  versionsDir = path.join(tmpDir, 'data', 'versions');
  manifestFile = path.join(versionsDir, 'manifest.json');
  process.chdir(tmpDir);
  ({ VersionStore } = await import('../src/game/VersionStore.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

function snapshot(name: string): ContentSnapshot {
  return {
    monsters: [{ id: name } as ContentSnapshot['monsters'][number]],
    items: [],
    zones: [],
    world: { startTile: { col: 0, row: 0 }, maps: [{ id: 'overworld', name: 'Overworld', startTile: { col: 0, row: 0 } }], defaultMapId: 'overworld', tiles: [] },
  };
}

async function storeWithVersions(): Promise<InstanceType<VersionStoreModule['VersionStore']>> {
  const store = new VersionStore();
  await store.load();
  const first = await store.createDraft('first', null, snapshot('a'));
  await store.publish(first.id);
  await store.setActive(first.id);
  return store;
}

describe('VersionStore load', () => {
  it('starts fresh with no manifest', async () => {
    const store = new VersionStore();

    await store.load();

    expect(store.getAll()).toEqual([]);
    expect(store.getActiveVersionId()).toBeNull();
  });

  it.each([
    ['a half-written manifest', (full: string) => full.slice(0, Math.ceil(full.length / 2))],
    ['an empty manifest', () => ''],
    ['a manifest without a version list', () => '{"activeVersionId": null}'],
  ])('rejects %s, naming it, and leaves it alone', async (_label, damage) => {
    await storeWithVersions();
    const damaged = damage(await fs.readFile(manifestFile, 'utf-8'));
    await fs.writeFile(manifestFile, damaged);

    await expect(new VersionStore().load()).rejects.toThrow('manifest.json');

    expect(await fs.readFile(manifestFile, 'utf-8')).toBe(damaged);
    expect(vi.mocked(console.error).mock.calls.some(call => String(call[0]).includes('manifest.json is unreadable. Refusing to start'))).toBe(true);
  });

  it('loads back what it saved', async () => {
    const saved = await storeWithVersions();

    const store = new VersionStore();
    await store.load();

    expect(store.getAll()).toEqual(saved.getAll());
    expect(store.getActiveVersionId()).toBe(saved.getActiveVersionId());
  });
});

describe('VersionStore writes', () => {
  it('writes a snapshot whole and leaves no temp file', async () => {
    const store = await storeWithVersions();
    const [version] = store.getAll();

    await store.saveSnapshot(version.id, snapshot('b'));

    expect((await fs.readdir(versionsDir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect((await store.loadSnapshot(version.id)).monsters).toEqual([{ id: 'b' }]);
  });

  it('lands overlapping manifest saves in call order', async () => {
    const store = await storeWithVersions();
    const second = await store.createDraft('second', null, snapshot('c'));
    await store.publish(second.id);
    const [first] = store.getAll();

    await Promise.all([store.setActive(second.id), store.setActive(first.id), store.save()]);

    const onDisk = JSON.parse(await fs.readFile(manifestFile, 'utf-8'));
    expect(onDisk.activeVersionId).toBe(first.id);
    expect((await fs.readdir(versionsDir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps writing after a failed write', async () => {
    const store = await storeWithVersions();
    const [version] = store.getAll();
    const snapshotFile = path.join(versionsDir, `${version.id}.json`);
    await fs.rm(snapshotFile);
    await fs.mkdir(path.join(snapshotFile, 'in-the-way'), { recursive: true });

    await expect(store.saveSnapshot(version.id, snapshot('d'))).rejects.toThrow();
    await fs.rm(snapshotFile, { recursive: true });
    await store.saveSnapshot(version.id, snapshot('e'));

    expect((await store.loadSnapshot(version.id)).monsters).toEqual([{ id: 'e' }]);
    expect((await fs.readdir(versionsDir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});
