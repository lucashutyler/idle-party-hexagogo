import { describe, it, expect, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';
import { HexGrid, HexTile, MIN_GUILD_LEVEL, offsetToCube } from '@idle-party-rpg/shared';
import type { BlockLevel, ChatMessage } from '@idle-party-rpg/shared';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';

const START_ZONE = 'start_zone';
const FAR_ZONE = 'far_zone';

function createFakeGrid(): HexGrid {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'town', START_ZONE, 'tile-start'));
  grid.addTile(new HexTile(offsetToCube({ col: 1, row: 0 }), 'forest', FAR_ZONE, 'tile-other'));
  return grid;
}

function createFakeContentStore(): ContentStore {
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: () => null,
    getAllMonsters: () => ({}),
    getAllItems: () => ({}),
    getZone: () => ({
      id: START_ZONE,
      name: 'Start Zone',
      encounterTable: [{ encounterId: 'auto_goblin', weight: 1 }],
    }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({
      auto_goblin: { id: 'auto_goblin', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 },
    }),
    getTileById: () => undefined,
    getAllShops: () => ({}),
    getShop: () => undefined,
    getWorld: () => ({ tiles: [], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpcQuestIds: () => [],
    getQuestRevision: () => 0,
    getQuestCatalog() { return this.getAllQuests(); },
    getNpc: () => undefined,
    getAllQuests: () => ({}),
    getQuest: () => undefined,
    ...fakeSkillContent(),
  } as unknown as ContentStore;
}

/** Matches names in any case, as the real store does. */
function createFakeAccountStore(usernames: string[]): AccountStore {
  return {
    findByUsername: (username: string) => {
      const match = usernames.find(u => u.toLowerCase() === username.toLowerCase());
      return match ? { email: `${match}@test.com`, username: match } : null;
    },
    getAllUsernames: () => usernames,
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    setDeactivated: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
}

function createFakeStore(): GameStateStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    loadAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function createFakeWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

async function setup(...usernames: string[]) {
  const accounts = [...usernames];
  const pm = new PlayerManager(
    wrapGrids(createFakeGrid()),
    createFakeContentStore(),
    new GuildStore(),
    createFakeAccountStore(accounts),
    createFakeStore(),
  );
  for (const username of usernames) {
    const session = await pm.login(createFakeWs(), username);
    session.setClass('Knight');
    pm.applyClassChange(username);
  }
  const notify = vi.spyOn(pm.notify, 'notify').mockImplementation(() => {});
  const historyOf = (username: string): ChatMessage[] => pm.getSessionByUsername(username)!.getChatHistory();
  const block = (username: string, target: string, level: BlockLevel) =>
    pm.getSessionByUsername(username)!.setBlockedUsers({ [target]: level });
  const addFarPlayer = (username: string) => {
    accounts.push(username);
    pm.restoreFromSaveData([{
      username,
      battleCount: 0,
      combatLog: [],
      unlockedKeys: ['tile-other'],
      position: { col: 1, row: 0 },
      target: null,
      movementQueue: [],
      character: { className: 'Knight', level: 5, xp: 1000 },
    }]);
  };
  const joinParty = (member: string, owner: string) => {
    const partyId = (u: string) => pm.getSessionByUsername(u)?.getPartyId() ?? null;
    const setPartyId = (u: string, id: string | null) => { pm.getSessionByUsername(u)?.setPartyId(id); };
    const sameRoom = (a: string, b: string) => pm.areSameTile(a, b);
    const ownerParty = partyId(owner)!;
    const memberOldParty = partyId(member);
    expect(pm.parties.inviteToParty(owner, member, partyId, sameRoom)).toBe(true);
    expect(typeof pm.parties.acceptInvite(member, ownerParty, partyId, setPartyId, sameRoom)).not.toBe('string');
    pm.handlePartyJoin(member, ownerParty, memberOldParty);
  };
  return { pm, notify, historyOf, block, addFarPlayer, joinParty };
}

describe('sendPlayerChat channel validation', () => {
  let t: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    t = await setup('alice', 'bob');
  });

  function expectRefused(channelType: unknown, channelId: unknown, reason: string): void {
    expect(t.pm.sendPlayerChat('alice', channelType, channelId, 'hello')).toBe(reason);
    expect(t.historyOf('alice')).toEqual([]);
    expect(t.historyOf('bob')).toEqual([]);
  }

  it.each(['dm', 'zone', 'guild', 'party', 'tile', 'global'])('refuses a %s channelId that is not a string', (channelType) => {
    for (const bad of [42, null, undefined, true, {}, ['bob']]) {
      expectRefused(channelType, bad, 'Invalid channel');
    }
  });

  it.each(['party', 'tile', 'global'])('refuses a %s send that names a channel', (channelType) => {
    expectRefused(channelType, 'anything', 'Invalid channel');
  });

  it.each(['server', 'nonsense', null, ['dm']])('refuses channel type %s', (channelType) => {
    expectRefused(channelType, '', 'Invalid channel type');
  });

  it('refuses a DM to a name with no account', () => {
    expectRefused('dm', 'nobody', 'User not found');
    expectRefused('dm', '', 'User not found');
  });

  it('refuses a zone the sender is not in', () => {
    expectRefused('zone', FAR_ZONE, 'You aren\'t in that zone');
    expectRefused('zone', '', 'You aren\'t in that zone');
  });

  it('refuses a guild the sender is not in', () => {
    const guild = t.pm.guilds.createGuild('bob', 'Others', MIN_GUILD_LEVEL);
    if (typeof guild === 'string') throw new Error(guild);

    expectRefused('guild', guild.id, 'You aren\'t in that guild');
    expectRefused('guild', 'no_such_guild', 'You aren\'t in that guild');
    expectRefused('guild', '', 'You aren\'t in that guild');
  });

  it.each(['party', 'tile', 'global'])('echoes a %s send with an empty channelId to the sender', (channelType) => {
    expect(t.pm.sendPlayerChat('alice', channelType, '', 'hello')).toBeNull();
    expect(t.historyOf('alice')).toMatchObject([{ channelType, channelId: '', text: 'hello' }]);
  });

  it('delivers a global send to everyone, wherever they are', () => {
    t.addFarPlayer('carol');
    t.pm.sendPlayerChat('alice', 'global', '', 'hello');
    expect(t.historyOf('bob')).toMatchObject([{ text: 'hello' }]);
    expect(t.historyOf('carol')).toMatchObject([{ text: 'hello' }]);
  });

  it('delivers a room send only to players in that room', () => {
    t.addFarPlayer('carol');
    t.pm.sendPlayerChat('alice', 'tile', '', 'hello');
    expect(t.historyOf('bob')).toMatchObject([{ channelType: 'tile', text: 'hello' }]);
    expect(t.historyOf('carol')).toEqual([]);
  });

  it('delivers a send to the zone the sender is in, and only that zone', () => {
    t.addFarPlayer('carol');

    expect(t.pm.sendPlayerChat('alice', 'zone', START_ZONE, 'near')).toBeNull();
    expect(t.pm.sendPlayerChat('carol', 'zone', FAR_ZONE, 'far')).toBeNull();

    expect(t.historyOf('bob')).toMatchObject([{ channelType: 'zone', channelId: START_ZONE, text: 'near' }]);
    expect(t.historyOf('carol').map(m => m.text)).toEqual(['far']);
  });

  it('delivers a party send to the other members only', async () => {
    const withOutsider = await setup('alice', 'bob', 'carol');
    withOutsider.joinParty('bob', 'alice');

    expect(withOutsider.pm.sendPlayerChat('alice', 'party', '', 'hello')).toBeNull();

    expect(withOutsider.historyOf('bob')).toMatchObject([{ channelType: 'party', text: 'hello' }]);
    expect(withOutsider.historyOf('carol')).toEqual([]);
  });

  it('delivers a guild send to the other members only', async () => {
    const withOutsider = await setup('alice', 'bob', 'carol');
    const guild = withOutsider.pm.guilds.createGuild('alice', 'Testers', MIN_GUILD_LEVEL);
    if (typeof guild === 'string') throw new Error(guild);
    withOutsider.pm.guilds.joinGuild('bob', guild.id);

    expect(withOutsider.pm.sendPlayerChat('alice', 'guild', guild.id, 'hello')).toBeNull();
    expect(withOutsider.historyOf('bob')).toMatchObject([{ channelType: 'guild', channelId: guild.id, text: 'hello' }]);
    expect(withOutsider.historyOf('carol')).toEqual([]);
  });

  it('delivers a DM spelled in another case, under the account\'s own spelling', () => {
    expect(t.pm.sendPlayerChat('alice', 'dm', 'BOB', 'hello')).toBeNull();
    expect(t.historyOf('bob')).toMatchObject([{ channelType: 'dm', channelId: 'bob', text: 'hello' }]);
    expect(t.historyOf('alice')).toMatchObject([{ channelId: 'bob' }]);
    expect(t.notify).toHaveBeenCalledWith('bob', 'dm_received', expect.anything());
  });
});

describe('sendPlayerChat dm_received notification', () => {
  let t: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    t = await setup('alice', 'bob');
  });

  it('notifies the recipient when the sender is not blocked', () => {
    t.pm.sendPlayerChat('alice', 'dm', 'bob', 'hello');
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith('bob', 'dm_received', {
      title: 'Message from alice',
      body: 'hello',
      payload: { fromUsername: 'alice' },
    });
  });

  it.each<BlockLevel>(['dm', 'all'])('stays quiet when the recipient blocked the sender at level %s, and still delivers', (level) => {
    t.block('bob', 'alice', level);

    expect(t.pm.sendPlayerChat('alice', 'dm', 'bob', 'hello')).toBeNull();

    expect(t.notify).not.toHaveBeenCalled();
    expect(t.historyOf('bob')).toMatchObject([{ senderUsername: 'alice', text: 'hello' }]);
  });

  it('stays quiet when a blocked sender spells the recipient in another case', () => {
    t.block('bob', 'alice', 'all');
    t.pm.sendPlayerChat('alice', 'dm', 'BoB', 'hello');
    expect(t.notify).not.toHaveBeenCalled();
  });

  it('still notifies when only the sender has blocked the recipient', () => {
    t.block('alice', 'bob', 'all');
    t.pm.sendPlayerChat('alice', 'dm', 'bob', 'hello');
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('notifies again once the sender is unblocked', () => {
    t.block('bob', 'alice', 'all');
    t.pm.getSessionByUsername('bob')!.setBlockedUsers({});
    t.pm.sendPlayerChat('alice', 'dm', 'bob', 'hello');
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('does not treat a name found on Object.prototype as blocked', async () => {
    const named = await setup('constructor', 'bob');
    named.pm.sendPlayerChat('constructor', 'dm', 'bob', 'hello');
    expect(named.notify).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while the recipient has that thread on screen', () => {
    t.pm.getSessionByUsername('bob')!.setChatFocus({ channelType: 'dm', channelId: 'alice' });
    t.pm.sendPlayerChat('alice', 'dm', 'bob', 'hello');
    expect(t.notify).not.toHaveBeenCalled();
  });

  it('does not notify for a refused send', () => {
    t.pm.sendPlayerChat('alice', 'dm', 'nobody', 'hello');
    expect(t.notify).not.toHaveBeenCalled();
  });
});
