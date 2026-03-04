import fs from 'fs/promises';
import path from 'path';
import type { GuildInfo, GuildMemberEntry } from '@idle-party-rpg/shared';

export interface GuildData {
  info: GuildInfo;
  members: GuildMemberEntry[];
}

const GUILD_FILE = path.resolve('data', 'guilds.json');

/**
 * Persists guild data to data/guilds.json.
 * Shared state — not per-player.
 */
export class GuildStore {
  private guilds = new Map<string, GuildData>();

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(GUILD_FILE, 'utf-8');
      const arr: GuildData[] = JSON.parse(raw);
      for (const g of arr) {
        this.guilds.set(g.info.id, g);
      }
      console.log(`[GuildStore] Loaded ${this.guilds.size} guilds`);
    } catch {
      // File doesn't exist yet — that's fine
    }
  }

  async save(): Promise<void> {
    const arr = Array.from(this.guilds.values());
    await fs.mkdir(path.dirname(GUILD_FILE), { recursive: true });
    await fs.writeFile(GUILD_FILE, JSON.stringify(arr, null, 2));
  }

  get(id: string): GuildData | undefined {
    return this.guilds.get(id);
  }

  set(id: string, data: GuildData): void {
    this.guilds.set(id, data);
  }

  delete(id: string): void {
    this.guilds.delete(id);
  }

  getAll(): GuildData[] {
    return Array.from(this.guilds.values());
  }

  /** Find the guild a player belongs to. */
  findByMember(username: string): GuildData | undefined {
    for (const g of this.guilds.values()) {
      if (g.members.some(m => m.username === username)) {
        return g;
      }
    }
    return undefined;
  }
}
