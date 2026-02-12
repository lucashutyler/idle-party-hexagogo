import { readFile, writeFile, readdir, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { GameStateStore, PlayerSaveData } from './GameStateStore';

const SAVE_DIR = 'data';

/**
 * Persists player state as individual JSON files on disk.
 * One file per player: data/<username>.json
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
    await writeFile(this.filePath(data.username), json, 'utf-8');
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
      return JSON.parse(raw) as PlayerSaveData;
    } catch {
      console.error(`[JsonFileStore] Failed to load save for "${username}"`);
      return null;
    }
  }

  async loadAll(): Promise<PlayerSaveData[]> {
    await this.ensureDir();
    const files = await readdir(this.dir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
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
