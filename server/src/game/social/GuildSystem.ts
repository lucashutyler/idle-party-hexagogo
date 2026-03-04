import type { GuildInfo, GuildMemberEntry } from '@idle-party-rpg/shared';
import type { GuildStore, GuildData } from './GuildStore.js';

const MIN_GUILD_LEVEL = 20;

let guildIdCounter = 0;

function generateGuildId(): string {
  return `guild_${Date.now()}_${++guildIdCounter}`;
}

/**
 * GuildSystem manages guild creation, membership, and queries.
 * Uses GuildStore for persistence.
 */
export class GuildSystem {
  constructor(private store: GuildStore) {}

  /** Create a guild. Returns the new guild or an error string. */
  createGuild(
    leaderUsername: string,
    name: string,
    leaderLevel: number,
  ): GuildInfo | string {
    if (leaderLevel < MIN_GUILD_LEVEL) {
      return `Must be level ${MIN_GUILD_LEVEL}+ to create a guild`;
    }

    if (!name || name.length < 2 || name.length > 20) {
      return 'Guild name must be 2-20 characters';
    }

    // Check if player already in a guild
    if (this.store.findByMember(leaderUsername)) {
      return 'You are already in a guild';
    }

    // Check name uniqueness
    for (const g of this.store.getAll()) {
      if (g.info.name.toLowerCase() === name.toLowerCase()) {
        return 'A guild with that name already exists';
      }
    }

    const id = generateGuildId();
    const info: GuildInfo = {
      id,
      name,
      leaderUsername,
      createdAt: Date.now(),
    };
    const members: GuildMemberEntry[] = [{
      username: leaderUsername,
      joinedAt: Date.now(),
      role: 'leader',
    }];

    this.store.set(id, { info, members });
    return info;
  }

  /** Join an existing guild. Returns true on success or error string. */
  joinGuild(username: string, guildId: string): true | string {
    if (this.store.findByMember(username)) {
      return 'You are already in a guild';
    }

    const guild = this.store.get(guildId);
    if (!guild) return 'Guild not found';

    guild.members.push({
      username,
      joinedAt: Date.now(),
      role: 'member',
    });
    return true;
  }

  /** Leave a guild. If leader leaves and no members remain, guild is deleted. */
  leaveGuild(username: string): true | string {
    const guild = this.store.findByMember(username);
    if (!guild) return 'You are not in a guild';

    guild.members = guild.members.filter(m => m.username !== username);

    if (guild.members.length === 0) {
      // Delete empty guild
      this.store.delete(guild.info.id);
    } else if (guild.info.leaderUsername === username) {
      // Transfer leadership to first remaining member
      const newLeader = guild.members[0];
      newLeader.role = 'leader';
      guild.info.leaderUsername = newLeader.username;
    }

    return true;
  }

  /** Get guild data for a player, or null if not in a guild. */
  getPlayerGuild(username: string): GuildData | null {
    return this.store.findByMember(username) ?? null;
  }

  /** Get guild info by ID. */
  getGuild(guildId: string): GuildData | undefined {
    return this.store.get(guildId);
  }
}
