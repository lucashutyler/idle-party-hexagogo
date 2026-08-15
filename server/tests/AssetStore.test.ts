import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// AssetStore resolves every kind's folder from process.cwd(), so the tmp-dir
// chdir must happen BEFORE the module is imported (dynamic import below).
// Mirrors DesignNotes.test.ts / SkillContentStore.test.ts.
type AssetStoreCtor = typeof import('../src/game/AssetStore.js').AssetStore;
type AssetStoreInstance = InstanceType<AssetStoreCtor>;
type AssetValidationErrorCtor = typeof import('../src/game/AssetStore.js').AssetValidationError;

let AssetStore: AssetStoreCtor;
let AssetValidationError: AssetValidationErrorCtor;
let inspectPng: typeof import('../src/game/AssetStore.js').inspectPng;
let MAX_ASSET_BYTES: number;

let tmpDir: string;
let originalCwd: string;

/**
 * Ids that must never reach the filesystem. Every one of these is either
 * rejected by `ASSET_ID_PATTERN` (path separators, a leading dot, stray
 * percent-escapes) or by the explicit no-`..` rule.
 */
const TRAVERSAL_IDS = [
  '../../world',
  '../x',
  '..%2Fx',
  'a/b',
  'a\\b',
  '\\',
  '.hidden',
  'nested..name',
];

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-store-'));
  process.chdir(tmpDir);
  ({ AssetStore, AssetValidationError, inspectPng, MAX_ASSET_BYTES } = await import('../src/game/AssetStore.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

/**
 * A structurally real PNG: the 8-byte signature followed by a complete IHDR
 * chunk (length, type, 13 bytes of header data, CRC). Nothing in the upload
 * path verifies the CRC or decodes pixels, so the trailing padding stands in
 * for the image body when a test needs a specific byte size.
 */
function makePng(width: number, height: number, padBytes = 0): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);  // bit depth
  ihdr.writeUInt8(6, 17);  // color type: RGBA
  // Offsets 18/19/20 (compression, filter, interlace) and the CRC stay zero.
  return Buffer.concat([signature, ihdr, Buffer.alloc(padBytes, 0x5a)]);
}

function makeStore(): AssetStoreInstance {
  return new AssetStore();
}

describe('inspectPng', () => {
  it('reads the width and height out of a valid PNG header', () => {
    expect(inspectPng(makePng(64, 64))).toEqual({ width: 64, height: 64 });
    expect(inspectPng(makePng(320, 180))).toEqual({ width: 320, height: 180 });
  });

  it('rejects a file that is not a PNG at all', () => {
    const notAPng = Buffer.from('this is a plain text file masquerading as artwork', 'utf-8');
    expect(() => inspectPng(notAPng)).toThrow(AssetValidationError);
    expect(() => inspectPng(notAPng)).toThrow(/PNG signature/);
  });

  it('rejects a buffer truncated before the header ends', () => {
    expect(() => inspectPng(makePng(64, 64).subarray(0, 20))).toThrow(AssetValidationError);
    expect(() => inspectPng(makePng(64, 64).subarray(0, 20))).toThrow(/too small/);
  });

  it('rejects a buffer with a good signature but no IHDR chunk', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const noIhdr = Buffer.concat([signature, Buffer.alloc(16, 0)]);
    expect(() => inspectPng(noIhdr)).toThrow(AssetValidationError);
    expect(() => inspectPng(noIhdr)).toThrow(/IHDR/);
  });

  it('rejects a header declaring zero width or zero height', () => {
    expect(() => inspectPng(makePng(0, 64))).toThrow(/zero width or height/);
    expect(() => inspectPng(makePng(64, 0))).toThrow(/zero width or height/);
  });
});

describe('AssetStore write/stat round-trip', () => {
  it('writes a square PNG and reads it back with the right dimensions and byte count', async () => {
    const store = makeStore();
    const png = makePng(96, 96, 200);

    const written = await store.write('monster', 'goblin_scout', png);
    expect(written.id).toBe('goblin_scout');
    expect(written.kind).toBe('monster');
    expect(written.width).toBe(96);
    expect(written.height).toBe(96);
    expect(written.bytes).toBe(png.length);

    const stored = await store.stat('monster', 'goblin_scout');
    expect(stored).not.toBeNull();
    expect(stored?.width).toBe(96);
    expect(stored?.height).toBe(96);
    expect(await store.has('monster', 'goblin_scout')).toBe(true);

    // The bytes on disk are the bytes handed in, untouched.
    const onDisk = await fs.readFile(path.join(tmpDir, 'data', 'monster-artwork', 'goblin_scout.png'));
    expect(onDisk.equals(png)).toBe(true);
  });

  it('stamps the public url with a cache-busting version query', async () => {
    const store = makeStore();
    const info = await store.write('item', 'rusty_sword', makePng(32, 32));
    expect(info.url).toMatch(/^\/item-artwork\/rusty_sword\.png\?v=\d+$/);
    expect(info.url).toContain('?v=');
    expect((await store.stat('item', 'rusty_sword'))?.url).toContain('?v=');
  });

  it('reports an ISO updatedAt timestamp', async () => {
    const store = makeStore();
    const info = await store.write('item', 'rusty_sword', makePng(32, 32));
    expect(Number.isNaN(Date.parse(info.updatedAt))).toBe(false);
  });

  it('replaces existing artwork for the same id rather than adding a second file', async () => {
    const store = makeStore();
    await store.write('item', 'rusty_sword', makePng(32, 32));
    const replaced = await store.write('item', 'rusty_sword', makePng(64, 64));
    expect(replaced.width).toBe(64);
    expect(await store.listIds('item')).toEqual(['rusty_sword']);
  });

  it('returns null from stat for an id that was never written', async () => {
    const store = makeStore();
    expect(await store.stat('monster', 'never_uploaded')).toBeNull();
    expect(await store.has('monster', 'never_uploaded')).toBe(false);
  });
});

describe('AssetStore shape validation', () => {
  it('rejects a non-square upload for a square-only kind', async () => {
    const store = makeStore();
    await expect(store.write('monster', 'wide_goblin', makePng(64, 32))).rejects.toThrow(AssetValidationError);
    await expect(store.write('monster', 'wide_goblin', makePng(64, 32))).rejects.toThrow(/must be square. Got 64x32/);
    expect(await store.has('monster', 'wide_goblin')).toBe(false);
  });

  it('accepts a non-square upload for a kind whose shape is any', async () => {
    const store = makeStore();
    const backdrop = await store.write('combat-bg', 'hatchetmill', makePng(1024, 384));
    expect(backdrop.width).toBe(1024);
    expect(backdrop.height).toBe(384);

    const logo = await store.write('logo', 'idle-party', makePng(600, 200));
    expect(logo.width).toBe(600);
    expect(logo.height).toBe(200);
  });
});

describe('AssetStore payload validation', () => {
  it('rejects an empty buffer', async () => {
    const store = makeStore();
    await expect(store.write('item', 'nothing', Buffer.alloc(0))).rejects.toThrow(AssetValidationError);
    await expect(store.write('item', 'nothing', Buffer.alloc(0))).rejects.toThrow(/empty/);
  });

  it('rejects an image larger than the 512 KB ceiling', async () => {
    const store = makeStore();
    const huge = makePng(64, 64, MAX_ASSET_BYTES);
    expect(huge.length).toBeGreaterThan(MAX_ASSET_BYTES);
    await expect(store.write('item', 'too_big', huge)).rejects.toThrow(AssetValidationError);
    await expect(store.write('item', 'too_big', huge)).rejects.toThrow(/the limit is 512 KB/);
    expect(await store.has('item', 'too_big')).toBe(false);
  });

  it('accepts an image right at the 512 KB ceiling', async () => {
    const store = makeStore();
    const png = makePng(64, 64);
    const atLimit = Buffer.concat([png, Buffer.alloc(MAX_ASSET_BYTES - png.length, 0x5a)]);
    expect(atLimit.length).toBe(MAX_ASSET_BYTES);
    const info = await store.write('item', 'exactly_at_limit', atLimit);
    expect(info.bytes).toBe(MAX_ASSET_BYTES);
  });

  it('rejects bytes that are not a PNG even when the id and kind are fine', async () => {
    const store = makeStore();
    const junk = Buffer.from('GIF89a — wrong format entirely, padded out past the header length', 'utf-8');
    await expect(store.write('item', 'not_a_png', junk)).rejects.toThrow(/PNG signature/);
    expect(await store.has('item', 'not_a_png')).toBe(false);
  });
});

describe('AssetStore id validation', () => {
  it.each(TRAVERSAL_IDS)('refuses to write to the escaping id "%s"', async (id) => {
    const store = makeStore();
    await expect(store.write('monster', id, makePng(32, 32))).rejects.toThrow(AssetValidationError);
  });

  it.each(TRAVERSAL_IDS)('refuses to remove the escaping id "%s"', async (id) => {
    const store = makeStore();
    await expect(store.remove('monster', id)).rejects.toThrow(AssetValidationError);
  });

  it.each(TRAVERSAL_IDS)('returns null instead of throwing when statting the escaping id "%s"', async (id) => {
    const store = makeStore();
    expect(await store.stat('monster', id)).toBeNull();
    expect(await store.has('monster', id)).toBe(false);
  });

  it('never creates a file outside the kind folder when a traversing id is attempted', async () => {
    const store = makeStore();
    for (const id of TRAVERSAL_IDS) {
      await store.write('monster', id, makePng(32, 32)).catch(() => undefined);
    }
    expect(await store.listIds('monster')).toEqual([]);
    // Nothing climbed out of data/ either.
    const dataEntries = await fs.readdir(path.join(tmpDir, 'data')).catch(() => []);
    expect(dataEntries.filter(name => name.endsWith('.png'))).toEqual([]);
  });

  it('accepts the id shapes real content actually uses', async () => {
    const store = makeStore();
    // Room-override composite, mixed-case class name, and a spaced icon id.
    await expect(store.write('combat-bg', 'hatchetmill-3-7', makePng(800, 400))).resolves.toBeTruthy();
    await expect(store.write('class', 'Knight', makePng(128, 128))).resolves.toBeTruthy();
    await expect(store.write('nav-icon', 'social', makePng(64, 64))).resolves.toBeTruthy();
  });
});

describe('AssetStore remove', () => {
  it('reports false when there was nothing to delete and true after a write', async () => {
    const store = makeStore();
    expect(await store.remove('monster', 'ghost')).toBe(false);

    await store.write('monster', 'ghost', makePng(48, 48));
    expect(await store.remove('monster', 'ghost')).toBe(true);
    expect(await store.has('monster', 'ghost')).toBe(false);
    expect(await store.remove('monster', 'ghost')).toBe(false);
  });
});

describe('AssetStore listing', () => {
  it('returns an empty list for a kind whose folder does not exist yet', async () => {
    const store = makeStore();
    expect(await store.listIds('parchment')).toEqual([]);
    expect(await store.list('parchment')).toEqual([]);
  });

  it('lists only the ids written for that kind, sorted, with full info', async () => {
    const store = makeStore();
    await store.write('monster', 'zombie', makePng(32, 32));
    await store.write('monster', 'archer', makePng(48, 48));
    await store.write('item', 'rusty_sword', makePng(16, 16));

    expect((await store.listIds('monster')).sort()).toEqual(['archer', 'zombie']);

    const infos = await store.list('monster');
    expect(infos.map(i => i.id)).toEqual(['archer', 'zombie']);
    expect(infos.map(i => i.width)).toEqual([48, 32]);
    expect(infos.every(i => i.kind === 'monster')).toBe(true);
    expect(await store.listIds('item')).toEqual(['rusty_sword']);
  });

  it('skips non-PNG clutter sitting in a kind folder', async () => {
    const store = makeStore();
    await store.write('monster', 'zombie', makePng(32, 32));
    await fs.writeFile(path.join(tmpDir, 'data', 'monster-artwork', 'notes.txt'), 'ignore me');

    expect(await store.listIds('monster')).toEqual(['zombie']);
  });

  it('drops entries whose file is not a readable PNG from list()', async () => {
    const store = makeStore();
    await store.write('monster', 'zombie', makePng(32, 32));
    await fs.writeFile(path.join(tmpDir, 'data', 'monster-artwork', 'corrupt.png'), 'not really a png');

    expect((await store.listIds('monster')).sort()).toEqual(['corrupt', 'zombie']);
    expect((await store.list('monster')).map(i => i.id)).toEqual(['zombie']);
  });
});
