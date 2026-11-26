import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUILD_INVITE_TTL_MS, MIN_GUILD_LEVEL } from '@idle-party-rpg/shared';
import type { GuildInfo } from '@idle-party-rpg/shared';
import { GuildStore } from '../src/game/social/GuildStore.js';
import { GUILD_INVITE_NOT_FOUND, GUILD_INVITE_REFUSED, GuildSystem } from '../src/game/social/GuildSystem.js';
import { GUILD_INVITE_LIMIT_REFUSAL } from '../src/game/social/ChatRateLimiter.js';
import type { PlayerManager } from '../src/game/PlayerManager.js';
import { enterAsKnight, itemRulesContent, itemRulesManager } from './itemRulesFixture.js';

function created(result: GuildInfo | string): GuildInfo {
  if (typeof result === 'string') throw new Error(result);
  return result;
}

describe('GuildSystem', () => {
  let now: number;
  let guilds: GuildSystem;
  let lanterns: GuildInfo;
  let ravens: GuildInfo;
  const members = (guild: GuildInfo) => guilds.getGuild(guild.id)!.members.map(m => m.username);

  beforeEach(() => {
    now = 1_000_000;
    guilds = new GuildSystem(new GuildStore(), () => now);
    lanterns = created(guilds.createGuild('Testy', 'Lanterns', MIN_GUILD_LEVEL));
    ravens = created(guilds.createGuild('Quill', 'Ravens', MIN_GUILD_LEVEL));
  });

  describe('createGuild', () => {
    it('starts from level 5', () => {
      expect(MIN_GUILD_LEVEL).toBe(5);
      expect(guilds.createGuild('Mira', 'Too Soon', 4)).toBe('Must be level 5+ to create a guild');
      expect(typeof guilds.createGuild('Mira', 'Just Right', 5)).not.toBe('string');
    });

    it.each(['‮snretnaL', 'Lan⁦terns', '‪‬'])('refuses a name with text direction controls: %j', (name) => {
      expect(guilds.createGuild('Mira', name, MIN_GUILD_LEVEL)).toBe('Guild name has characters that can\'t be used');
      expect(guilds.getPlayerGuild('Mira')).toBeNull();
    });

    it('keeps a name with a zero-width joiner', () => {
      expect(typeof guilds.createGuild('Mira', 'Fox‍Hall', MIN_GUILD_LEVEL)).not.toBe('string');
    });

    it('closes the founder\'s invites', () => {
      guilds.inviteToGuild('Testy', 'Mira', false);
      guilds.createGuild('Mira', 'Own Guild', MIN_GUILD_LEVEL);
      expect(guilds.getInvitedUsernames(lanterns.id)).toEqual([]);
    });
  });

  describe('inviteToGuild', () => {
    it('records an invite without adding the target', () => {
      expect(typeof guilds.inviteToGuild('Testy', 'Mira', false)).not.toBe('string');

      expect(members(lanterns)).toEqual(['Testy']);
      expect(guilds.getPlayerGuild('Mira')).toBeNull();
      expect(guilds.getInvitesFor('Mira')).toEqual([{ guildId: lanterns.id, guildName: 'Lanterns', inviterUsername: 'Testy' }]);
      expect(guilds.getInvitedUsernames(lanterns.id)).toEqual(['Mira']);
    });

    it('refuses an inviter with no guild', () => {
      expect(guilds.inviteToGuild('Oskar', 'Mira', false)).toBe('You are not in a guild');
    });

    it('refuses a target already in a guild', () => {
      expect(guilds.inviteToGuild('Testy', 'Quill', false)).toBe('They are already in a guild.');
      expect(guilds.inviteToGuild('Testy', 'Testy', false)).toBe('They are already in a guild.');
    });

    it('refuses a second invite to the same guild', () => {
      guilds.inviteToGuild('Testy', 'Mira', false);
      expect(guilds.inviteToGuild('Testy', 'Mira', false)).toBe('They already have an invite to your guild.');
    });

    it('refuses across a block', () => {
      expect(guilds.inviteToGuild('Testy', 'Mira', true)).toBe(GUILD_INVITE_REFUSED);
      expect(guilds.getInvitesFor('Mira')).toEqual([]);
    });

    it('lets two guilds invite the same player', () => {
      guilds.inviteToGuild('Testy', 'Mira', false);
      now += 1;
      guilds.inviteToGuild('Quill', 'Mira', false);

      expect(guilds.getInvitesFor('Mira').map(i => i.guildName)).toEqual(['Lanterns', 'Ravens']);
    });
  });

  describe('acceptInvite', () => {
    it('adds the player as a member and closes their other invites', () => {
      guilds.inviteToGuild('Testy', 'Mira', false);
      guilds.inviteToGuild('Quill', 'Mira', false);

      expect(typeof guilds.acceptInvite('Mira', lanterns.id)).not.toBe('string');

      expect(members(lanterns)).toEqual(['Testy', 'Mira']);
      expect(guilds.getGuild(lanterns.id)!.members[1]).toMatchObject({ username: 'Mira', role: 'member' });
      expect(guilds.getInvitesFor('Mira')).toEqual([]);
      expect(guilds.getInvitedUsernames(ravens.id)).toEqual([]);
      expect(guilds.getGuild(lanterns.id)!.invites).toBeUndefined();
    });

    it('refuses a guild that sent no invite', () => {
      expect(guilds.acceptInvite('Mira', lanterns.id)).toBe(GUILD_INVITE_NOT_FOUND);
      expect(guilds.acceptInvite('Mira', 'no_such_guild')).toBe(GUILD_INVITE_NOT_FOUND);
      expect(members(lanterns)).toEqual(['Testy']);
    });

    it('refuses a player who is already in a guild', () => {
      guilds.inviteToGuild('Testy', 'Mira', false);
      guilds.inviteToGuild('Quill', 'Mira', false);
      guilds.acceptInvite('Mira', lanterns.id);

      expect(guilds.acceptInvite('Mira', ravens.id)).toBe('You are already in a guild');
      expect(members(ravens)).toEqual(['Quill']);
    });

    it('refuses an invite older than seven days', () => {
      guilds.inviteToGuild('Testy', 'Mira', false);
      now += GUILD_INVITE_TTL_MS;

      expect(guilds.getInvitesFor('Mira')).toEqual([]);
      expect(guilds.acceptInvite('Mira', lanterns.id)).toBe(GUILD_INVITE_NOT_FOUND);
      expect(guilds.getGuild(lanterns.id)!.invites).toBeUndefined();
    });

    it('accepts an invite just inside seven days', () => {
      guilds.inviteToGuild('Testy', 'Mira', false);
      now += GUILD_INVITE_TTL_MS - 1;

      expect(typeof guilds.acceptInvite('Mira', lanterns.id)).not.toBe('string');
    });
  });

  describe('declineInvite', () => {
    it('removes the invite and adds no one', () => {
      guilds.inviteToGuild('Testy', 'Mira', false);

      expect(guilds.declineInvite('Mira', lanterns.id)).toBe(true);

      expect(guilds.getInvitesFor('Mira')).toEqual([]);
      expect(members(lanterns)).toEqual(['Testy']);
      expect(guilds.declineInvite('Mira', lanterns.id)).toBe(GUILD_INVITE_NOT_FOUND);
    });

    it('allows a new invite after a decline', () => {
      guilds.inviteToGuild('Testy', 'Mira', false);
      guilds.declineInvite('Mira', lanterns.id);

      expect(typeof guilds.inviteToGuild('Testy', 'Mira', false)).not.toBe('string');
    });
  });

  describe('kickMember', () => {
    beforeEach(() => {
      for (const name of ['Mira', 'Oskar']) {
        guilds.inviteToGuild('Testy', name, false);
        guilds.acceptInvite(name, lanterns.id);
      }
    });

    it('lets the leader remove a member', () => {
      expect(typeof guilds.kickMember('Testy', 'Mira')).not.toBe('string');
      expect(members(lanterns)).toEqual(['Testy', 'Oskar']);
      expect(guilds.getPlayerGuild('Mira')).toBeNull();
    });

    it('refuses anyone but the leader', () => {
      expect(guilds.kickMember('Mira', 'Oskar')).toBe('Only the guild leader can remove members.');
      expect(guilds.kickMember('Nobody', 'Mira')).toBe('You are not in a guild');
      expect(members(lanterns)).toEqual(['Testy', 'Mira', 'Oskar']);
    });

    it('refuses the leader removing themselves', () => {
      expect(guilds.kickMember('Testy', 'Testy')).toBe('You can\'t remove yourself. Leave the guild instead.');
      expect(members(lanterns)).toEqual(['Testy', 'Mira', 'Oskar']);
    });

    it('refuses someone outside the guild', () => {
      expect(guilds.kickMember('Testy', 'Quill')).toBe('They aren\'t in your guild.');
      expect(members(ravens)).toEqual(['Quill']);
    });

    it('needs a new invite to come back', () => {
      guilds.kickMember('Testy', 'Mira');
      expect(guilds.acceptInvite('Mira', lanterns.id)).toBe(GUILD_INVITE_NOT_FOUND);
    });
  });

  describe('an invite whose inviter is no longer in the guild', () => {
    beforeEach(() => {
      guilds.inviteToGuild('Testy', 'Oskar', false);
      guilds.acceptInvite('Oskar', lanterns.id);
      guilds.inviteToGuild('Oskar', 'Mira', false);
      guilds.inviteToGuild('Testy', 'Wren', false);
    });

    it('closes when the leader removes the inviter', () => {
      guilds.kickMember('Testy', 'Oskar');

      expect(guilds.getInvitesFor('Mira')).toEqual([]);
      expect(guilds.getInvitedUsernames(lanterns.id)).toEqual(['Wren']);
      expect(guilds.acceptInvite('Mira', lanterns.id)).toBe(GUILD_INVITE_NOT_FOUND);
      expect(members(lanterns)).toEqual(['Testy']);
    });

    it('closes when the inviter leaves', () => {
      guilds.leaveGuild('Oskar');

      expect(guilds.acceptInvite('Mira', lanterns.id)).toBe(GUILD_INVITE_NOT_FOUND);
      expect(typeof guilds.acceptInvite('Wren', lanterns.id)).not.toBe('string');
    });

    it('closes when a leader who sent it leaves, and the new leader can invite again', () => {
      guilds.leaveGuild('Testy');

      expect(guilds.getGuild(lanterns.id)!.info.leaderUsername).toBe('Oskar');
      expect(guilds.getInvitesFor('Wren')).toEqual([]);
      expect(typeof guilds.inviteToGuild('Oskar', 'Wren', false)).not.toBe('string');
      expect(typeof guilds.acceptInvite('Wren', lanterns.id)).not.toBe('string');
    });

    it('lets the player be invited again by someone still in the guild', () => {
      guilds.kickMember('Testy', 'Oskar');

      expect(typeof guilds.inviteToGuild('Testy', 'Mira', false)).not.toBe('string');
      expect(guilds.getInvitesFor('Mira')).toEqual([{ guildId: lanterns.id, guildName: 'Lanterns', inviterUsername: 'Testy' }]);
    });
  });

  it('keeps an old guild\'s members as they were', () => {
    const store = new GuildStore();
    store.set('g_old', {
      info: { id: 'g_old', name: 'Old Hall', leaderUsername: 'Testy', createdAt: 1 },
      members: [{ username: 'Testy', joinedAt: 1, role: 'leader' }, { username: 'Mira', joinedAt: 2, role: 'member' }],
    });
    const system = new GuildSystem(store, () => now);

    expect(system.getInvitesFor('Oskar')).toEqual([]);
    expect(system.getPlayerGuild('Mira')?.info.name).toBe('Old Hall');
    expect(typeof system.inviteToGuild('Mira', 'Oskar', false)).not.toBe('string');
    expect(store.get('g_old')!.members.map(m => m.username)).toEqual(['Testy', 'Mira']);
  });
});

describe('guild invites through PlayerManager', () => {
  let pm: PlayerManager;
  let guild: GuildInfo;
  const socialOf = (username: string) => pm.getSocialState(username, false);
  const inbox = (username: string, eventKey: string) => pm.notifications.getInbox(username).filter(entry => entry.eventKey === eventKey);

  beforeEach(async () => {
    pm = itemRulesManager(itemRulesContent(), ['Testy', 'Mira', 'Oskar', 'Quill']);
    for (const name of ['Testy', 'Mira', 'Oskar', 'Quill']) await enterAsKnight(pm, name);
    guild = created(pm.guilds.createGuild('Testy', 'Lanterns', MIN_GUILD_LEVEL));
    pm.getSessionByUsername('Testy')!.setGuildId(guild.id);
  });

  it('notifies the target and lists the invite on both sides', () => {
    expect(pm.inviteToGuild('Testy', 'Mira')).toBeNull();

    expect(inbox('Mira', 'guild_invite_received')).toMatchObject([{
      category: 'guild',
      title: 'Guild invite',
      body: 'Testy invited you to join Lanterns.',
      payload: { guildId: guild.id, inviterUsername: 'Testy' },
    }]);
    expect(socialOf('Mira').guildInvites).toEqual([{ guildId: guild.id, guildName: 'Lanterns', inviterUsername: 'Testy' }]);
    expect(socialOf('Mira').guild).toBeNull();
    expect(socialOf('Testy').outgoingGuildInvites).toEqual(['Mira']);
  });

  it.each([
    ['the target blocked the inviter', 'Mira', 'Testy'],
    ['the inviter blocked the target', 'Testy', 'Mira'],
  ])('refuses when %s, in words that don\'t reveal it', (_label, blocker, blocked) => {
    pm.getSessionByUsername(blocker)!.blockUser(blocked, 'all');

    expect(pm.inviteToGuild('Testy', 'Mira')).toBe(GUILD_INVITE_REFUSED);
    expect(pm.inviteToGuild('Testy', 'Nobody')).toBe(GUILD_INVITE_REFUSED);
    expect(socialOf('Mira').guildInvites).toEqual([]);
    expect(inbox('Mira', 'guild_invite_received')).toEqual([]);
  });

  it('hides an invite once either player blocks the other, and refuses its accept', () => {
    pm.inviteToGuild('Testy', 'Mira');
    pm.getSessionByUsername('Mira')!.blockUser('Testy', 'dm');

    expect(socialOf('Mira').guildInvites).toEqual([]);
    expect(pm.acceptGuildInvite('Mira', guild.id)).toBe(GUILD_INVITE_NOT_FOUND);
    expect(pm.guilds.getPlayerGuild('Mira')).toBeNull();
  });

  it('joins on accept and sets the joiner\'s guild', () => {
    pm.inviteToGuild('Testy', 'Mira');

    expect(pm.acceptGuildInvite('Mira', guild.id)).toBeNull();

    expect(pm.getSessionByUsername('Mira')!.getGuildId()).toBe(guild.id);
    expect(socialOf('Mira').guild?.id).toBe(guild.id);
    expect(socialOf('Mira').guildInvites).toEqual([]);
    expect(socialOf('Testy').outgoingGuildInvites).toEqual([]);
  });

  it('refuses an accept with no invite', () => {
    expect(pm.acceptGuildInvite('Mira', guild.id)).toBe(GUILD_INVITE_NOT_FOUND);
    expect(pm.getSessionByUsername('Mira')!.getGuildId()).toBeNull();
  });

  it('declines without joining', () => {
    pm.inviteToGuild('Testy', 'Mira');

    expect(pm.declineGuildInvite('Mira', guild.id)).toBeNull();

    expect(socialOf('Mira').guildInvites).toEqual([]);
    expect(pm.guilds.getPlayerGuild('Mira')).toBeNull();
  });

  it('removes a kicked member, clears their guild and tells them', () => {
    pm.inviteToGuild('Testy', 'Mira');
    pm.acceptGuildInvite('Mira', guild.id);

    expect(pm.kickGuildMember('Testy', 'Mira')).toBeNull();

    expect(pm.getSessionByUsername('Mira')!.getGuildId()).toBeNull();
    expect(socialOf('Mira').guild).toBeNull();
    expect(socialOf('Testy').guildMembers.map(m => m.username)).toEqual(['Testy']);
    expect(inbox('Mira', 'guild_kicked')).toMatchObject([{
      category: 'guild',
      title: 'Removed from guild',
      body: 'You were removed from Lanterns.',
      payload: { guildId: guild.id },
    }]);
  });

  it('refuses a kick from a member who isn\'t the leader', () => {
    for (const name of ['Mira', 'Oskar']) {
      pm.inviteToGuild('Testy', name);
      pm.acceptGuildInvite(name, guild.id);
    }

    expect(pm.kickGuildMember('Mira', 'Oskar')).toBe('Only the guild leader can remove members.');
    expect(pm.getSessionByUsername('Oskar')!.getGuildId()).toBe(guild.id);
    expect(inbox('Oskar', 'guild_kicked')).toEqual([]);
  });

  it('tells a re-invited player only once in ten minutes, and still lists the new invite', () => {
    pm.inviteToGuild('Testy', 'Mira');
    pm.declineGuildInvite('Mira', guild.id);

    expect(pm.inviteToGuild('Testy', 'Mira')).toBeNull();

    expect(socialOf('Mira').guildInvites).toHaveLength(1);
    expect(inbox('Mira', 'guild_invite_received')).toHaveLength(1);
  });

  it('takes a removed member\'s invites off the target\'s list', () => {
    pm.inviteToGuild('Testy', 'Oskar');
    pm.acceptGuildInvite('Oskar', guild.id);
    pm.inviteToGuild('Oskar', 'Mira');

    pm.kickGuildMember('Testy', 'Oskar');

    expect(socialOf('Mira').guildInvites).toEqual([]);
    expect(socialOf('Testy').outgoingGuildInvites).toEqual([]);
    expect(pm.acceptGuildInvite('Mira', guild.id)).toBe(GUILD_INVITE_NOT_FOUND);
  });

  describe('invites per sender', () => {
    beforeEach(() => {
      const start = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(start);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const inviteAndDecline = () => {
      expect(pm.inviteToGuild('Testy', 'Mira')).toBeNull();
      expect(pm.declineGuildInvite('Mira', guild.id)).toBeNull();
    };

    it('refuses the 21st invite in ten minutes, and allows one once the window has passed', () => {
      for (let i = 0; i < 20; i++) inviteAndDecline();

      expect(pm.inviteToGuild('Testy', 'Oskar')).toBe(GUILD_INVITE_LIMIT_REFUSAL);
      expect(socialOf('Oskar').guildInvites).toEqual([]);
      expect(inbox('Oskar', 'guild_invite_received')).toEqual([]);

      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(pm.inviteToGuild('Testy', 'Oskar')).toBeNull();
    });

    it('counts only invites that went through', () => {
      for (let i = 0; i < 30; i++) {
        expect(pm.inviteToGuild('Testy', 'Testy')).toBe('They are already in a guild.');
        expect(pm.inviteToGuild('Testy', 'Nobody')).toBe(GUILD_INVITE_REFUSED);
      }
      for (let i = 0; i < 19; i++) inviteAndDecline();

      expect(pm.inviteToGuild('Testy', 'Oskar')).toBeNull();
    });

    it('keeps each sender apart', () => {
      expect(pm.inviteToGuild('Testy', 'Quill')).toBeNull();
      expect(pm.acceptGuildInvite('Quill', guild.id)).toBeNull();
      for (let i = 0; i < 19; i++) inviteAndDecline();
      expect(pm.inviteToGuild('Testy', 'Oskar')).toBe(GUILD_INVITE_LIMIT_REFUSAL);

      expect(pm.inviteToGuild('Quill', 'Oskar')).toBeNull();
    });
  });
});
