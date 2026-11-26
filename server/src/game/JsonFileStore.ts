import { readdir, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { GameStateStore, PlayerSaveData } from './GameStateStore.js';
import { isStoreFileName } from '../auth/reservedUsernames.js';
import { isDamagedDataFileError, moveAside, readJsonFile, writeJsonFileAtomic } from './JsonFiles.js';

const SAVE_DIR = 'data';
/** Saves written before the save pass yields to the event loop, so fight timers aren't held up by the whole pass. */
export const SAVE_CHUNK_SIZE = 25;
const SAVE_FILE_SUFFIX = '.json';

/**
 * Persists player state as individual JSON files on disk.
 * One file per player: data/<username>.json, as one-line JSON.
 *
 * Each write goes to a temp file that is renamed over the save, so a kill
 * mid-write leaves the old save whole.
 */
export class JsonFileStore implements GameStateStore {
  private dir: string;

  constructor(baseDir?: string) {
    this.dir = baseDir ?? SAVE_DIR;
  }

  async save(data: PlayerSaveData): Promise<void> {
    if (isStoreFileName(data.username)) {
      console.error(`[JsonFileStore] Refusing to save player "${data.username}" over a store file`);
      return;
    }
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(data.username), data);
  }

  /** Writes every save even when some fail, then rejects with the first failure. */
  async saveAll(data: PlayerSaveData[]): Promise<void> {
    await this.ensureDir();
    let firstFailure: { error: unknown } | undefined;
    for (let start = 0; start < data.length; start += SAVE_CHUNK_SIZE) {
      if (start > 0) await new Promise<void>(resolve => setImmediate(resolve));
      const results = await Promise.allSettled(data.slice(start, start + SAVE_CHUNK_SIZE).map(d => this.save(d)));
      for (const result of results) {
        if (result.status === 'rejected' && !firstFailure) firstFailure = { error: result.reason };
      }
    }
    if (firstFailure) throw firstFailure.error;
  }

  /** A damaged save is moved aside, so the fresh player that replaces it can't write over it. A failed read throws. */
  async load(username: string): Promise<PlayerSaveData | null> {
    if (isStoreFileName(username)) return null;
    const path = this.filePath(username);
    try {
      return await readJsonFile<PlayerSaveData>(path) ?? null;
    } catch (err) {
      if (!isDamagedDataFileError(err)) throw err;
      try {
        const aside = await moveAside(path);
        console.error(`[JsonFileStore] Moved the unreadable save for "${username}" to ${aside}:`, err.cause);
      } catch (moveErr) {
        console.error(`[JsonFileStore] The save for "${username}" is unreadable and could not be moved aside:`, err.cause, moveErr);
      }
      return null;
    }
  }

  async loadAll(): Promise<PlayerSaveData[]> {
    await this.ensureDir();
    const files = await readdir(this.dir);
    const results: PlayerSaveData[] = [];

    for (const file of files) {
      if (!file.endsWith(SAVE_FILE_SUFFIX)) continue;
      const data = await this.load(file.slice(0, -SAVE_FILE_SUFFIX.length));
      if (data) {
        results.push(data);
      }
    }

    return results;
  }

  async delete(username: string): Promise<void> {
    const path = this.filePath(username);
    if (existsSync(path)) {
      await unlink(path);
    }
  }

  private filePath(username: string): string {
    return join(this.dir, `${username}${SAVE_FILE_SUFFIX}`);
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) {
      await mkdir(this.dir, { recursive: true });
    }
  }
}
