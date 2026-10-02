/**
 * Pure validation helpers shared by the assets CLI.
 *
 * Split out from assets-cli.mjs so the rules can be tested without a running
 * server or a network round trip. These deliberately mirror the server's own
 * checks in AssetStore.write — the point is to fail locally, in milliseconds,
 * with the whole list of problems, rather than discovering them one rejected
 * upload at a time.
 *
 * If the server's rules change, these should follow. They are a fast path, not
 * the authority: the server still validates every upload.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Matches MAX_ASSET_BYTES in server/src/game/AssetStore.ts. */
export const MAX_ASSET_BYTES = 512 * 1024;

/**
 * Width and height from the PNG IHDR chunk, or null if the buffer is not a
 * PNG. Layout: 8-byte signature, 4-byte chunk length, 4-byte "IHDR", then
 * width at offset 16 and height at offset 20 — the same offsets the server
 * reads.
 */
export function readPngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Every reason this buffer would be rejected, as human-readable strings.
 * Empty array means it should upload cleanly.
 *
 * `shape` comes from the server's own kind registry rather than a local copy,
 * so a new kind or a changed shape needs no update here.
 */
export function validateAsset(buf, { shape = 'any' } = {}) {
  const problems = [];

  if (!buf || buf.length === 0) {
    problems.push('file is empty');
    return { problems, size: null };
  }

  const size = readPngSize(buf);
  if (!size) {
    problems.push('not a valid PNG');
    return { problems, size: null };
  }

  if (buf.length > MAX_ASSET_BYTES) {
    problems.push(`${Math.ceil(buf.length / 1024)} KB exceeds the ${MAX_ASSET_BYTES / 1024} KB limit`);
  }
  if (shape === 'square' && size.width !== size.height) {
    problems.push(`must be square, is ${size.width}x${size.height}`);
  }
  return { problems, size };
}

/**
 * Turn `<dir>/<kind>/<id>.png` into { kind, id }. Returns null for anything
 * that is not a PNG two levels deep, so stray files and nested folders are
 * skipped rather than guessed at.
 */
export function parseAssetPath(relativePath) {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.length !== 2) return null;
  const [kind, file] = parts;
  if (!/\.png$/i.test(file)) return null;
  const id = file.replace(/\.png$/i, '');
  if (!kind || !id) return null;
  return { kind, id };
}
