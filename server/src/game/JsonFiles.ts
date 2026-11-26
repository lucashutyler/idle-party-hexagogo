import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import path from 'path';

export interface AtomicWriteOptions {
  /** Flush the file to disk before it replaces the old one. */
  fsync?: boolean;
}

export interface JsonWriteOptions extends AtomicWriteOptions {
  space?: number;
}

/** A data file that exists but can't be used: a read error, an empty file, JSON that doesn't parse, or the wrong kind of value. */
export class UnreadableDataFileError extends Error {
  readonly file: string;
  readonly cause: unknown;
  /** The read itself failed (permissions, too many open files…), so the bytes on disk may be fine. */
  readonly readFailed: boolean;

  constructor(file: string, cause: unknown, readFailed = false) {
    super(`${file} is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'UnreadableDataFileError';
    this.file = file;
    this.cause = cause;
    this.readFailed = readFailed;
  }
}

/** Damaged bytes on disk, as opposed to a read that failed: the case where moving the file aside and starting fresh is safe. */
export function isDamagedDataFileError(err: unknown): err is UnreadableDataFileError {
  return err instanceof UnreadableDataFileError && !err.readFailed;
}

const UTF8_BOM = '\uFEFF';
let tempFileSeq = 0;

/** Write to a temp file beside `file`, then rename it over `file`, so a reader or a crash never sees half a file. */
export async function writeFileAtomic(file: string, text: string, options: AtomicWriteOptions = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tempFileSeq}.tmp`;
  try {
    if (options.fsync) {
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(text, 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await writeFile(tmp, text, 'utf-8');
    }
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function writeJsonFileAtomic(file: string, value: unknown, options: JsonWriteOptions = {}): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, options.space), options);
}

/** `undefined` when the file doesn't exist; throws {@link UnreadableDataFileError} for anything else that isn't JSON. */
export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if (isMissingFileError(err)) return undefined;
    throw new UnreadableDataFileError(file, err, true);
  }
  if (raw.startsWith(UTF8_BOM)) raw = raw.slice(UTF8_BOM.length);
  if (raw.trim() === '') throw new UnreadableDataFileError(file, new Error('the file is empty'));
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new UnreadableDataFileError(file, err);
  }
}

/** Rename `file` to `<file>.unreadable-<ms>` and return the new path, so a fresh start can't write over it. */
export async function moveAside(file: string): Promise<string> {
  const aside = `${file}.unreadable-${Date.now()}`;
  await rename(file, aside);
  return aside;
}

/** False only when nothing is at `file`; a check that fails any other way counts as something there. */
export async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    return !isMissingFileError(err);
  }
}

export function isMissingFileError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A path as an operator would type it from the server's folder. */
export function displayPath(file: string): string {
  return path.relative(process.cwd(), file) || file;
}
