import { readFile, writeFile, rename, readdir, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { GameStateStore, PlayerSaveData } from './GameStateStore';

const SAVE_DIR = 'data';

/**
 * Persists player state as individual JSON files on disk.
 * One file per player: data/<username>.json
 *
 * Uses atomic writes (write to .tmp, then rename) to prevent
 * corruption if the process is killed mid-write.
 */
export class JsonFileStore implements GameStateStore {
  private dir: string;

  constructor(baseDir?: string) {
    this.dir = baseDir ?? SAVE_DIR;
  }

  private filePath(username: string): string {
    return join(this.dir, `${username}.json`);
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) {
      await mkdir(this.dir, { recursive: true });
    }
  }

  async save(data: PlayerSaveData): Promise<void> {
    await this.ensureDir();
    const json = JSON.stringify(data, null, 2);
    const target = this.filePath(data.username);
    const tmp = `${target}.tmp`;
    // Write to temp file, then atomically rename over the real file.
    // If the process dies mid-write, only the .tmp is corrupted.
    await writeFile(tmp, json, 'utf-8');
    await rename(tmp, target);
  }

  async saveAll(data: PlayerSaveData[]): Promise<void> {
    await this.ensureDir();
    await Promise.all(data.map(d => this.save(d)));
  }

  async load(username: string): Promise<PlayerSaveData | null> {
    const path = this.filePath(username);
    if (!existsSync(path)) return null;
    try {
      const raw = await readFile(path, 'utf-8');
      if (!raw.trim()) {
        console.warn(`[JsonFileStore] Empty save file for "${username}" — skipping`);
        return null;
      }
      return JSON.parse(raw) as PlayerSaveData;
    } catch {
      console.error(`[JsonFileStore] Failed to load save for "${username}"`);
      return null;
    }
  }

  async loadAll(): Promise<PlayerSaveData[]> {
    await this.ensureDir();
    const files = await readdir(this.dir);
    const jsonFiles = files.filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
    const results: PlayerSaveData[] = [];

    for (const file of jsonFiles) {
      const username = file.replace('.json', '');
      const data = await this.load(username);
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
}
