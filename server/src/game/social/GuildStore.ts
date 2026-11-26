import path from 'path';
import type { GuildInfo, GuildMemberEntry } from '@idle-party-rpg/shared';
import { UnreadableDataFileError, isDamagedDataFileError, isJsonObject, moveAside, readJsonFile, writeJsonFileAtomic } from '../JsonFiles.js';

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

  /** A damaged file is moved aside and the store starts empty, so the next save can't write over it. A failed read throws. */
  async load(): Promise<void> {
    let saved: GuildData[] | undefined;
    try {
      saved = await readGuilds();
    } catch (err) {
      if (!isDamagedDataFileError(err)) throw err;
      const aside = await moveAside(GUILD_FILE);
      console.error(`[GuildStore] Moved an unreadable file to ${aside}; starting with no guilds:`, err.cause);
      return;
    }
    if (!saved) return;
    for (const g of saved) {
      this.guilds.set(g.info.id, g);
    }
    console.log(`[GuildStore] Loaded ${this.guilds.size} guilds`);
  }

  async save(): Promise<void> {
    await writeJsonFileAtomic(GUILD_FILE, Array.from(this.guilds.values()), { space: 2 });
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

async function readGuilds(): Promise<GuildData[] | undefined> {
  const value = await readJsonFile<unknown>(GUILD_FILE);
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isGuild)) {
    throw new UnreadableDataFileError(GUILD_FILE, new Error('it holds something other than a list of guilds'));
  }
  return value;
}

function isGuild(value: unknown): value is GuildData {
  return isJsonObject(value) && isJsonObject(value.info) && typeof value.info.id === 'string' && Array.isArray(value.members);
}
