import fs from 'fs/promises';
import path from 'path';
import { ASSET_KIND_INFO, isValidAssetId, canonicalAssetId, assetPublicPath } from '@idle-party-rpg/shared';
import type { AssetKind } from '@idle-party-rpg/shared';

/**
 * Swappable store for the game's imagery, satisfying the data-folder rule in
 * `docs/architecture/persistence.md`: artwork used to be written with raw
 * `fs.writeFile` calls straight out of the admin routes, which was the one
 * `data/` consumer with no store behind it.
 *
 * Every path is resolved from the process working directory, exactly like
 * `ContentStore` and `VersionStore`, so dev (cwd = `server/`) and production
 * (cwd = the deploy root) keep their own art without a hard-coded repo path.
 */

/** The 8 bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Upload ceiling, matching the multer limit the admin routes have always used. */
export const MAX_ASSET_BYTES = 512 * 1024;

export interface AssetFileInfo {
  id: string;
  kind: AssetKind;
  /** Public URL including a cache-busting version stamp. */
  url: string;
  bytes: number;
  width: number;
  height: number;
  /** ISO timestamp of the file's last write. */
  updatedAt: string;
}

/** Thrown for caller mistakes — routes map this to 400, MCP tools to an `error` field. */
export class AssetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetValidationError';
  }
}

export interface PngHeader {
  width: number;
  height: number;
}

/**
 * Verify the bytes really are a PNG and pull the dimensions out of the IHDR
 * chunk. The old upload path trusted the client-declared multipart mime type
 * and then read offsets 16/20 regardless, so any file at all could be stored
 * as `.png` and any two garbage words could pass the square check.
 *
 * PNG layout: 8-byte signature, then the IHDR chunk as 4 bytes length,
 * the literal `IHDR`, 4 bytes width, 4 bytes height.
 */
export function inspectPng(buf: Buffer): PngHeader {
  if (buf.length < 24) throw new AssetValidationError('Not a valid PNG file — too small to contain a header.');
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new AssetValidationError('Not a valid PNG file — missing the PNG signature.');
  }
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new AssetValidationError('Not a valid PNG file — missing the IHDR header chunk.');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) throw new AssetValidationError('Not a valid PNG file — zero width or height.');
  return { width, height };
}

export class AssetStore {
  /** Absolute path of a kind's folder. Resolved per call so tests can chdir. */
  private dirFor(kind: AssetKind): string {
    return path.resolve(ASSET_KIND_INFO[kind].dir);
  }

  /**
   * Resolve an id to its on-disk path, refusing anything that escapes the
   * kind's folder. The pattern check rejects separators and `..` runs up front;
   * the containment assertion is the belt-and-braces second gate, because this
   * id now arrives from bearer-token MCP clients and not just from an admin
   * clicking a modal.
   */
  private fileFor(kind: AssetKind, id: string): string {
    if (!isValidAssetId(id)) {
      throw new AssetValidationError(`Invalid asset id "${id}" — letters, numbers, spaces, dots, dashes, and underscores only.`);
    }
    const canonical = canonicalAssetId(kind, id);
    const dir = this.dirFor(kind);
    const file = path.resolve(dir, `${canonical}.png`);
    if (file !== path.join(dir, `${canonical}.png`) || !file.startsWith(dir + path.sep)) {
      throw new AssetValidationError(`Invalid asset id "${id}" — resolves outside the ${kind} folder.`);
    }
    return file;
  }

  private urlFor(kind: AssetKind, id: string, version: number): string {
    return `${assetPublicPath(kind, id)}?v=${Math.floor(version)}`;
  }

  /**
   * Ids present in a kind's folder. Cheap — a single readdir, no per-file stat.
   * This is what the coverage report joins against.
   */
  async listIds(kind: AssetKind): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dirFor(kind), { withFileTypes: true });
      return entries
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.png'))
        .map(e => e.name.slice(0, -'.png'.length));
    } catch {
      // A kind with no folder yet simply has no art.
      return [];
    }
  }

  /** Full info for every asset of a kind, sorted by id. */
  async list(kind: AssetKind): Promise<AssetFileInfo[]> {
    const ids = await this.listIds(kind);
    const infos = await Promise.all(ids.sort().map(id => this.stat(kind, id)));
    return infos.filter((info): info is AssetFileInfo => info !== null);
  }

  /** Info for one asset, or null when it doesn't exist. */
  async stat(kind: AssetKind, id: string): Promise<AssetFileInfo | null> {
    let file: string;
    try {
      file = this.fileFor(kind, id);
    } catch {
      // An unreadable id can't name an existing file.
      return null;
    }
    try {
      const stats = await fs.stat(file);
      if (!stats.isFile()) return null;
      // Only the 24-byte header is needed for dimensions — never read the body.
      const handle = await fs.open(file, 'r');
      try {
        const header = Buffer.alloc(24);
        const { bytesRead } = await handle.read(header, 0, 24, 0);
        const { width, height } = inspectPng(header.subarray(0, bytesRead));
        return {
          // Report the spelling the file is actually stored under, which for
          // lowercase-folded kinds may differ from what the caller passed.
          id: canonicalAssetId(kind, id),
          kind,
          url: this.urlFor(kind, id, stats.mtimeMs),
          bytes: stats.size,
          width,
          height,
          updatedAt: new Date(stats.mtimeMs).toISOString(),
        };
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  /** True when a kind's folder holds art for this id. */
  async has(kind: AssetKind, id: string): Promise<boolean> {
    return (await this.stat(kind, id)) !== null;
  }

  /**
   * Validate and store a PNG, replacing any existing art for the id.
   * Throws `AssetValidationError` for anything the caller can fix.
   */
  async write(kind: AssetKind, id: string, png: Buffer): Promise<AssetFileInfo> {
    const file = this.fileFor(kind, id);
    if (png.length === 0) throw new AssetValidationError('Uploaded file is empty.');
    if (png.length > MAX_ASSET_BYTES) {
      throw new AssetValidationError(`Image is ${Math.ceil(png.length / 1024)} KB — the limit is ${MAX_ASSET_BYTES / 1024} KB.`);
    }
    const { width, height } = inspectPng(png);
    if (ASSET_KIND_INFO[kind].shape === 'square' && width !== height) {
      throw new AssetValidationError(`${ASSET_KIND_INFO[kind].label} art must be square. Got ${width}x${height}.`);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, png);
    const info = await this.stat(kind, id);
    // stat() only returns null if the write vanished underneath us.
    if (!info) throw new Error(`Failed to read back ${kind} artwork "${id}" after writing it.`);
    return info;
  }

  /** Delete art for an id. Returns whether a file was actually removed. */
  async remove(kind: AssetKind, id: string): Promise<boolean> {
    const file = this.fileFor(kind, id);
    try {
      await fs.unlink(file);
      return true;
    } catch {
      return false;
    }
  }
}
