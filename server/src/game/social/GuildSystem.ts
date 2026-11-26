import { GUILD_INVITE_TTL_MS, MIN_GUILD_LEVEL } from '@idle-party-rpg/shared';
import type { GuildInfo, GuildInviteInfo, GuildMemberEntry } from '@idle-party-rpg/shared';
import type { GuildStore, GuildData, GuildInvite } from './GuildStore.js';
import { hasTextDirectionControls } from './textDirection.js';

let guildIdCounter = 0;

function generateGuildId(): string {
  return `guild_${Date.now()}_${++guildIdCounter}`;
}

export const NOT_IN_A_GUILD = 'You are not in a guild';
export const ALREADY_IN_A_GUILD = 'You are already in a guild';
/** One answer for a block either way and for a player with no character, so a refusal doesn't reveal a block. */
export const GUILD_INVITE_REFUSED = 'That player can\'t be invited.';
export const GUILD_INVITE_NOT_FOUND = 'That invite is no longer open.';

/**
 * GuildSystem manages guild creation, membership, invites and queries.
 * Uses GuildStore for persistence.
 */
export class GuildSystem {
  constructor(private store: GuildStore, private now: () => number = () => Date.now()) {}

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

    if (hasTextDirectionControls(name)) {
      return 'Guild name has characters that can\'t be used';
    }

    // Check if player already in a guild
    if (this.store.findByMember(leaderUsername)) {
      return ALREADY_IN_A_GUILD;
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
    this.clearInvitesFor(leaderUsername);
    return info;
  }

  /** `blocked` is whether either player has blocked the other. */
  inviteToGuild(inviterUsername: string, targetUsername: string, blocked: boolean): GuildData | string {
    const guild = this.store.findByMember(inviterUsername);
    if (!guild) return NOT_IN_A_GUILD;
    if (this.store.findByMember(targetUsername)) return 'They are already in a guild.';
    if (blocked) return GUILD_INVITE_REFUSED;
    const invites = this.openInvites(guild);
    if (invites.some(invite => invite.username === targetUsername)) return 'They already have an invite to your guild.';

    guild.invites = [...invites, { username: targetUsername, inviterUsername, createdAt: this.now() }];
    return guild;
  }

  /** Joins the guild that invited `username` and closes their other guild invites. */
  acceptInvite(username: string, guildId: string): GuildData | string {
    if (this.store.findByMember(username)) return ALREADY_IN_A_GUILD;
    const guild = this.store.get(guildId);
    if (!guild || !this.findInvite(username, guildId)) return GUILD_INVITE_NOT_FOUND;

    guild.members.push({
      username,
      joinedAt: this.now(),
      role: 'member',
    });
    this.clearInvitesFor(username);
    return guild;
  }

  declineInvite(username: string, guildId: string): true | string {
    const guild = this.store.get(guildId);
    if (!guild || !this.findInvite(username, guildId)) return GUILD_INVITE_NOT_FOUND;
    this.setInvites(guild, this.openInvites(guild).filter(invite => invite.username !== username));
    return true;
  }

  /** Leader only, and never the leader themselves. */
  kickMember(leaderUsername: string, targetUsername: string): GuildData | string {
    const guild = this.store.findByMember(leaderUsername);
    if (!guild) return NOT_IN_A_GUILD;
    if (guild.info.leaderUsername !== leaderUsername) return 'Only the guild leader can remove members.';
    if (targetUsername === leaderUsername) return 'You can\'t remove yourself. Leave the guild instead.';
    if (!guild.members.some(m => m.username === targetUsername)) return 'They aren\'t in your guild.';

    guild.members = guild.members.filter(m => m.username !== targetUsername);
    return guild;
  }

  /** Leave a guild. If leader leaves and no members remain, guild is deleted. */
  leaveGuild(username: string): true | string {
    const guild = this.store.findByMember(username);
    if (!guild) return NOT_IN_A_GUILD;

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

  findInvite(username: string, guildId: string): GuildInvite | undefined {
    const guild = this.store.get(guildId);
    return guild ? this.openInvites(guild).find(invite => invite.username === username) : undefined;
  }

  /** The guilds inviting `username`, oldest invite first. */
  getInvitesFor(username: string): GuildInviteInfo[] {
    const found: (GuildInviteInfo & { createdAt: number })[] = [];
    for (const guild of this.store.getAll()) {
      const invite = this.openInvites(guild).find(i => i.username === username);
      if (invite) found.push({ guildId: guild.info.id, guildName: guild.info.name, inviterUsername: invite.inviterUsername, createdAt: invite.createdAt });
    }
    return found
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ guildId, guildName, inviterUsername }) => ({ guildId, guildName, inviterUsername }));
  }

  /** Who has an open invite to this guild. */
  getInvitedUsernames(guildId: string): string[] {
    const guild = this.store.get(guildId);
    return guild ? this.openInvites(guild).map(invite => invite.username) : [];
  }

  /** Get guild data for a player, or null if not in a guild. */
  getPlayerGuild(username: string): GuildData | null {
    return this.store.findByMember(username) ?? null;
  }

  /** Get guild info by ID. */
  getGuild(guildId: string): GuildData | undefined {
    return this.store.get(guildId);
  }

  /** Unexpired invites; expired ones are dropped from the guild as they are found. */
  private openInvites(guild: GuildData): GuildInvite[] {
    const invites = guild.invites;
    if (!invites) return [];
    const cutoff = this.now() - GUILD_INVITE_TTL_MS;
    const open = invites.filter(invite => invite.createdAt > cutoff);
    if (open.length !== invites.length) this.setInvites(guild, open);
    return open;
  }

  private setInvites(guild: GuildData, invites: GuildInvite[]): void {
    if (invites.length > 0) guild.invites = invites;
    else delete guild.invites;
  }

  private clearInvitesFor(username: string): void {
    for (const guild of this.store.getAll()) {
      const invites = guild.invites ?? [];
      if (invites.some(invite => invite.username === username)) {
        this.setInvites(guild, invites.filter(invite => invite.username !== username));
      }
    }
  }
}
