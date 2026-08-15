import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MANAGED_ASSET_KINDS, DEFERRED_ASSET_KINDS } from '@idle-party-rpg/shared';

// ContentStore/VersionStore/AssetStore all resolve their data dirs from
// process.cwd() at module load or call time, so the tmp-dir chdir must happen
// BEFORE any of them are imported. Mirrors McpTools.test.ts.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type ContentStoreInstance = InstanceType<ContentStoreCtor>;
type VersionStoreCtor = typeof import('../src/game/VersionStore.js').VersionStore;
type DraftEditorCtor = typeof import('../src/game/DraftEditor.js').DraftEditor;
type AssetStoreCtor = typeof import('../src/game/AssetStore.js').AssetStore;
type AssetStoreInstance = InstanceType<AssetStoreCtor>;
type McpToolDeps = import('../src/mcp/tools/McpToolDeps.js').McpToolDeps;

let ContentStore: ContentStoreCtor;
let VersionStore: VersionStoreCtor;
let DraftEditor: DraftEditorCtor;
let AssetStore: AssetStoreCtor;
let listAssetKinds: typeof import('../src/mcp/tools/assetTools.js').listAssetKinds;
let getAssetCoverage: typeof import('../src/mcp/tools/assetTools.js').getAssetCoverage;
let listAssets: typeof import('../src/mcp/tools/assetTools.js').listAssets;
let upsertAsset: typeof import('../src/mcp/tools/assetTools.js').upsertAsset;
let deleteAsset: typeof import('../src/mcp/tools/assetTools.js').deleteAsset;

let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-asset-tools-'));
  process.chdir(tmpDir);
  ({ ContentStore } = await import('../src/game/ContentStore.js'));
  ({ VersionStore } = await import('../src/game/VersionStore.js'));
  ({ DraftEditor } = await import('../src/game/DraftEditor.js'));
  ({ AssetStore } = await import('../src/game/AssetStore.js'));
  ({ listAssetKinds, getAssetCoverage, listAssets, upsertAsset, deleteAsset } =
    await import('../src/mcp/tools/assetTools.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

/** Same minimal-but-real PNG builder AssetStore.test.ts uses. */
function makePng(width: number, height: number, padBytes = 0): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([signature, ihdr, Buffer.alloc(padBytes, 0x5a)]);
}

function pngBase64(width: number, height: number, padBytes = 0): string {
  return makePng(width, height, padBytes).toString('base64');
}

async function setupDeps(): Promise<{ deps: McpToolDeps; contentStore: ContentStoreInstance; assetStore: AssetStoreInstance }> {
  const contentStore = new ContentStore();
  await contentStore.load();
  const versionStore = new VersionStore();
  await versionStore.load();
  const draftEditor = new DraftEditor(versionStore, () => contentStore);
  const assetStore = new AssetStore();
  const deps: McpToolDeps = {
    contentStore: () => contentStore,
    versionStore: () => versionStore,
    draftEditor,
    assetStore,
    callerLabel: 'test-label',
  };
  return { deps, contentStore, assetStore };
}

/** Every logic function returns failures as data — this is the shape assertion. */
function errorOf(result: unknown): string | undefined {
  return (result as { error?: string }).error;
}

describe('listAssetKinds', () => {
  it('returns every managed kind with its mount, id format, shape, and url template, plus the deferred list', async () => {
    const result = await listAssetKinds();
    expect(errorOf(result)).toBeUndefined();
    if ('error' in result) throw new Error('unreachable');

    expect(Object.keys(result.kinds).length).toBe(MANAGED_ASSET_KINDS.length);
    expect(Object.keys(result.kinds).sort()).toEqual([...MANAGED_ASSET_KINDS].sort());
    expect(result.maxBytes).toBe(512 * 1024);

    // Deferred kinds are reported separately rather than silently dropped, so a
    // caller can tell "not supported yet" apart from "does not exist".
    expect(result.deferred.map(d => d.kind).sort()).toEqual([...DEFERRED_ASSET_KINDS].sort());
    for (const entry of result.deferred) {
      expect(Object.keys(result.kinds)).not.toContain(entry.kind);
      expect(entry.reason.length).toBeGreaterThan(0);
    }

    for (const kind of MANAGED_ASSET_KINDS) {
      const info = result.kinds[kind];
      expect(info.kind).toBe(kind);
      expect(info.mount.startsWith('/')).toBe(true);
      expect(info.urlTemplate).toBe(`${info.mount}/{id}.png`);
      expect(info.idFormat.length).toBeGreaterThan(0);
      expect(['square', 'any']).toContain(info.shape);
      expect(Array.isArray(info.fallbacks)).toBe(true);
    }
  });

  it('reports the monster name-slug fallback and the combat backdrop zone fallback', async () => {
    const result = await listAssetKinds();
    if ('error' in result) throw new Error('unreachable');
    expect(result.kinds.monster.fallbacks).toEqual([{ kind: 'monster', idFrom: 'nameSlug' }]);
    expect(result.kinds['combat-bg'].fallbacks).toEqual([{ kind: 'zone', idFrom: 'zoneId' }]);
    expect(result.kinds['combat-bg'].shape).toBe('any');
  });
});

describe('upsertAsset', () => {
  it('writes a valid base64 PNG to live artwork and credits the caller token label', async () => {
    const { deps, assetStore } = await setupDeps();
    const result = await upsertAsset(deps, { kind: 'monster', id: 'goblin_scout', pngBase64: pngBase64(128, 128) });

    expect(errorOf(result)).toBeUndefined();
    if (result.error !== undefined) throw new Error(result.error);
    expect(result.success).toBe(true);
    expect(result.uploadedBy).toBe('test-label');
    expect(result.asset.id).toBe('goblin_scout');
    expect(result.asset.width).toBe(128);
    expect(result.asset.height).toBe(128);
    expect(result.asset.url).toContain('/monster-artwork/goblin_scout.png?v=');

    // It really landed on disk, not just in the return value.
    expect(await assetStore.has('monster', 'goblin_scout')).toBe(true);
  });

  it('tolerates base64 that an encoder wrapped in newlines', async () => {
    const { deps } = await setupDeps();
    const wrapped = (pngBase64(64, 64, 4000).match(/.{1,76}/g) ?? []).join('\n');
    const result = await upsertAsset(deps, { kind: 'monster', id: 'wrapped_goblin', pngBase64: wrapped });
    expect(errorOf(result)).toBeUndefined();
    if (result.error !== undefined) throw new Error(result.error);
    expect(result.asset.width).toBe(64);
  });

  it('returns an error object rather than throwing when the payload carries a data: URI prefix', async () => {
    const { deps, assetStore } = await setupDeps();
    const result = await upsertAsset(deps, {
      kind: 'monster',
      id: 'data_uri',
      pngBase64: `data:image/png;base64,${pngBase64(64, 64)}`,
    });
    expect(errorOf(result)).toContain('data: URI prefix');
    expect(await assetStore.has('monster', 'data_uri')).toBe(false);
  });

  it('returns an error object rather than throwing for non-base64 junk', async () => {
    const { deps } = await setupDeps();
    const result = await upsertAsset(deps, { kind: 'monster', id: 'junk', pngBase64: '!!! this is not base64 !!!' });
    expect(errorOf(result)).toContain('not valid base64');
  });

  it('returns an error object when the payload decodes to zero bytes', async () => {
    const { deps } = await setupDeps();
    const result = await upsertAsset(deps, { kind: 'monster', id: 'empty', pngBase64: '' });
    expect(errorOf(result)).toContain('zero bytes');
  });

  it('returns an error object when valid base64 decodes to something that is not a PNG', async () => {
    const { deps, assetStore } = await setupDeps();
    const notAPng = Buffer.from('a perfectly encodable string that is nonetheless not an image', 'utf-8').toString('base64');
    const result = await upsertAsset(deps, { kind: 'monster', id: 'text_file', pngBase64: notAPng });
    expect(errorOf(result)).toContain('PNG');
    expect(await assetStore.has('monster', 'text_file')).toBe(false);
  });

  it('returns an error object for a non-square image on a square-only kind', async () => {
    const { deps } = await setupDeps();
    const result = await upsertAsset(deps, { kind: 'monster', id: 'wide_goblin', pngBase64: pngBase64(128, 64) });
    expect(errorOf(result)).toContain('must be square');
  });

  it('accepts a non-square image on a kind whose shape is any', async () => {
    const { deps } = await setupDeps();
    const result = await upsertAsset(deps, { kind: 'combat-bg', id: 'hatchetmill', pngBase64: pngBase64(1024, 384) });
    expect(errorOf(result)).toBeUndefined();
    if (result.error !== undefined) throw new Error(result.error);
    expect(result.asset.height).toBe(384);
  });

  it('returns an error object rather than throwing for an id that would escape the folder', async () => {
    const { deps } = await setupDeps();
    for (const id of ['../../world', 'a/b', '.hidden', 'nested..name']) {
      const result = await upsertAsset(deps, { kind: 'monster', id, pngBase64: pngBase64(64, 64) });
      expect(errorOf(result)).toContain('Invalid asset id');
    }
    expect(await deps.assetStore.listIds('monster')).toEqual([]);
  });

  it('returns an error object rather than throwing when the payload exceeds the size ceiling', async () => {
    const { deps } = await setupDeps();
    const result = await upsertAsset(deps, { kind: 'monster', id: 'huge', pngBase64: pngBase64(64, 64, 512 * 1024) });
    expect(errorOf(result)).toContain('the limit is 512 KB');
  });

  it('replaces artwork already stored under the same id', async () => {
    const { deps } = await setupDeps();
    await upsertAsset(deps, { kind: 'item', id: 'rusty_sword', pngBase64: pngBase64(32, 32) });
    const replaced = await upsertAsset(deps, { kind: 'item', id: 'rusty_sword', pngBase64: pngBase64(96, 96) });
    if (replaced.error !== undefined) throw new Error(replaced.error);
    expect(replaced.asset.width).toBe(96);
    expect(await deps.assetStore.listIds('item')).toEqual(['rusty_sword']);
  });
});

describe('deleteAsset', () => {
  it('reports removed true for artwork that existed and false for artwork that did not', async () => {
    const { deps } = await setupDeps();
    const missing = await deleteAsset(deps, { kind: 'monster', id: 'never_uploaded' });
    expect(errorOf(missing)).toBeUndefined();
    expect(missing).toEqual({ success: true, removed: false });

    await upsertAsset(deps, { kind: 'monster', id: 'goblin_scout', pngBase64: pngBase64(64, 64) });
    const removed = await deleteAsset(deps, { kind: 'monster', id: 'goblin_scout' });
    expect(removed).toEqual({ success: true, removed: true });
    expect(await deps.assetStore.has('monster', 'goblin_scout')).toBe(false);
  });

  it('returns an error object rather than throwing for an id that would escape the folder', async () => {
    const { deps } = await setupDeps();
    const result = await deleteAsset(deps, { kind: 'monster', id: '../../world' });
    expect(errorOf(result)).toContain('Invalid asset id');
  });
});

describe('listAssets', () => {
  it('returns exactly the artwork written for the requested kind', async () => {
    const { deps } = await setupDeps();
    await upsertAsset(deps, { kind: 'monster', id: 'zombie', pngBase64: pngBase64(32, 32) });
    await upsertAsset(deps, { kind: 'monster', id: 'archer', pngBase64: pngBase64(48, 48) });
    await upsertAsset(deps, { kind: 'item', id: 'rusty_sword', pngBase64: pngBase64(16, 16) });

    const monsters = await listAssets(deps, { kind: 'monster' });
    expect(errorOf(monsters)).toBeUndefined();
    if (monsters.error !== undefined) throw new Error(monsters.error);
    expect(monsters.kind).toBe('monster');
    expect(monsters.count).toBe(2);
    expect(monsters.assets.map(a => a.id)).toEqual(['archer', 'zombie']);
    expect(monsters.assets.map(a => a.width)).toEqual([48, 32]);

    const items = await listAssets(deps, { kind: 'item' });
    if (items.error !== undefined) throw new Error(items.error);
    expect(items.assets.map(a => a.id)).toEqual(['rusty_sword']);
  });

  it('returns an empty list for a kind with no artwork yet', async () => {
    const { deps } = await setupDeps();
    const result = await listAssets(deps, { kind: 'parchment' });
    expect(errorOf(result)).toBeUndefined();
    if (result.error !== undefined) throw new Error(result.error);
    expect(result.count).toBe(0);
    expect(result.assets).toEqual([]);
  });
});

describe('getAssetCoverage', () => {
  it('returns a full report across every managed kind by default', async () => {
    const { deps } = await setupDeps();
    const result = await getAssetCoverage(deps, {});
    expect(errorOf(result)).toBeUndefined();
    if (!('summary' in result)) throw new Error('unreachable');

    expect(result.kinds.length).toBe(MANAGED_ASSET_KINDS.length);
    expect(result.summary.kinds).toBe(MANAGED_ASSET_KINDS.length);
    expect(result.kinds.map(k => k.kind)).not.toContain('shop');
    expect(result.summary.required).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
  });

  it('reflects an upload made through upsertAsset in the very next coverage report', async () => {
    const { deps, contentStore } = await setupDeps();
    const monsterId = Object.keys(contentStore.getAllMonsters())[0];

    const before = await getAssetCoverage(deps, { kind: 'monster' });
    if (!('kinds' in before)) throw new Error('unreachable');
    expect(before.kinds[0].present).toBe(0);

    await upsertAsset(deps, { kind: 'monster', id: monsterId, pngBase64: pngBase64(64, 64) });

    const after = await getAssetCoverage(deps, { kind: 'monster' });
    if (!('kinds' in after)) throw new Error('unreachable');
    expect(after.kinds.length).toBe(1);
    expect(after.kinds[0].present).toBe(1);
    expect(after.kinds[0].missing).toBe(after.kinds[0].required - 1);
  });

  it('honors includeEntries, missingOnly, and the limit cap', async () => {
    const { deps, contentStore } = await setupDeps();
    const monsterIds = Object.keys(contentStore.getAllMonsters());
    await upsertAsset(deps, { kind: 'monster', id: monsterIds[0], pngBase64: pngBase64(64, 64) });

    const plain = await getAssetCoverage(deps, { kind: 'monster' });
    if (!('kinds' in plain)) throw new Error('unreachable');
    expect(plain.kinds[0].entries).toBeUndefined();

    const detailed = await getAssetCoverage(deps, { kind: 'monster', includeEntries: true, missingOnly: true });
    if (!('kinds' in detailed)) throw new Error('unreachable');
    const entries = detailed.kinds[0].entries ?? [];
    expect(entries.every(e => e.hasOwnAsset === false)).toBe(true);
    expect(entries.map(e => e.id)).not.toContain(monsterIds[0]);

    const capped = await getAssetCoverage(deps, { kind: 'monster', includeEntries: true, limit: 1 });
    if (!('kinds' in capped)) throw new Error('unreachable');
    expect(capped.kinds[0].entries?.length).toBe(1);
    expect(capped.kinds[0].required).toBe(monsterIds.length);
  });
});
