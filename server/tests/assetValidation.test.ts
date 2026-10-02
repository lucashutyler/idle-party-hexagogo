import { describe, it, expect } from 'vitest';
// The assets CLI is plain ESM under tools/ rather than a workspace, but its
// rules mirror AssetStore.write closely enough that they are worth pinning:
// if the server tightens a rule and the CLI does not follow, uploads start
// failing only at the server, which is exactly what the CLI exists to avoid.
import {
  readPngSize,
  validateAsset,
  parseAssetPath,
  MAX_ASSET_BYTES,
} from '../../tools/assetValidation.mjs';
import { MAX_ASSET_BYTES as SERVER_MAX } from '../src/game/AssetStore';

/** Minimal but structurally valid PNG header: signature + IHDR width/height. */
function pngHeader(width: number, height: number, padTo = 24): Buffer {
  const buf = Buffer.alloc(Math.max(padTo, 24));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('assets CLI validation', () => {
  it('agrees with the server on the size limit', () => {
    // The whole point of local validation is matching the server. If someone
    // changes MAX_ASSET_BYTES on one side only, this fails instead of the
    // uploads doing so.
    expect(MAX_ASSET_BYTES).toBe(SERVER_MAX);
  });

  describe('readPngSize', () => {
    it('reads dimensions from the IHDR chunk', () => {
      expect(readPngSize(pngHeader(256, 128))).toEqual({ width: 256, height: 128 });
    });

    it('rejects a buffer without the PNG signature', () => {
      expect(readPngSize(Buffer.alloc(64))).toBeNull();
    });

    it('rejects a buffer too short to hold an IHDR', () => {
      expect(readPngSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    });

    it('rejects an empty buffer without throwing', () => {
      expect(readPngSize(Buffer.alloc(0))).toBeNull();
    });
  });

  describe('validateAsset', () => {
    it('passes a square PNG for a square kind', () => {
      const { problems, size } = validateAsset(pngHeader(256, 256), { shape: 'square' });
      expect(problems).toEqual([]);
      expect(size).toEqual({ width: 256, height: 256 });
    });

    it('rejects a non-square PNG for a square kind, naming the dimensions', () => {
      const { problems } = validateAsset(pngHeader(508, 501), { shape: 'square' });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('508x501');
    });

    it('allows a non-square PNG when the kind takes any shape', () => {
      expect(validateAsset(pngHeader(1920, 1080), { shape: 'any' }).problems).toEqual([]);
    });

    it('defaults to the permissive shape when none is given', () => {
      expect(validateAsset(pngHeader(300, 200)).problems).toEqual([]);
    });

    it('rejects a file over the size limit', () => {
      const big = pngHeader(256, 256, MAX_ASSET_BYTES + 1024);
      const { problems } = validateAsset(big, { shape: 'square' });
      expect(problems.some((p: string) => p.includes('exceeds'))).toBe(true);
    });

    it('accepts a file exactly at the limit', () => {
      const exact = pngHeader(256, 256, MAX_ASSET_BYTES);
      expect(validateAsset(exact, { shape: 'square' }).problems).toEqual([]);
    });

    it('reports an empty file rather than calling it a bad PNG', () => {
      expect(validateAsset(Buffer.alloc(0)).problems).toEqual(['file is empty']);
    });

    it('reports a non-PNG once and stops', () => {
      expect(validateAsset(Buffer.from('not a png at all, really')).problems).toEqual(['not a valid PNG']);
    });

    it('collects every problem at once so one run lists them all', () => {
      const big = pngHeader(500, 400, MAX_ASSET_BYTES + 1024);
      expect(validateAsset(big, { shape: 'square' }).problems).toHaveLength(2);
    });
  });

  describe('parseAssetPath', () => {
    it('splits kind and id', () => {
      expect(parseAssetPath('nav-icon/map.png')).toEqual({ kind: 'nav-icon', id: 'map' });
    });

    it('keeps underscores and dashes in ids', () => {
      expect(parseAssetPath('item/rusty_dagger.png')).toEqual({ kind: 'item', id: 'rusty_dagger' });
    });

    it('accepts backslash separators', () => {
      expect(parseAssetPath('item\\rusty_dagger.png')).toEqual({ kind: 'item', id: 'rusty_dagger' });
    });

    it('is case-insensitive about the extension', () => {
      expect(parseAssetPath('item/thing.PNG')).toEqual({ kind: 'item', id: 'thing' });
    });

    it('ignores files at the wrong depth', () => {
      expect(parseAssetPath('loose.png')).toBeNull();
      expect(parseAssetPath('a/b/c.png')).toBeNull();
    });

    it('ignores non-PNG files', () => {
      expect(parseAssetPath('item/notes.txt')).toBeNull();
    });
  });
});
