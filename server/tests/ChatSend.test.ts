import { describe, it, expect, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';
import { HexGrid, HexTile, MIN_GUILD_LEVEL, isBlockedUser, offsetToCube } from '@idle-party-rpg/shared';
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
  const store = createFakeStore();
  const pm = new PlayerManager(
    wrapGrids(createFakeGrid()),
    createFakeContentStore(),
    new GuildStore(),
    createFakeAccountStore(accounts),
    store,
  );
  const sockets = new Map<string, WebSocket>();
  for (const username of usernames) {
    const ws = createFakeWs();
    sockets.set(username, ws);
    const session = await pm.login(ws, username);
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
  const rename = (oldUsername: string, newUsername: string) => {
    accounts[accounts.indexOf(oldUsername)] = newUsername;
    return pm.renamePlayer(oldUsername, newUsername);
  };
  return { pm, store, sockets, notify, historyOf, block, addFarPlayer, joinParty, rename };
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

describe('isTradeBlocked', () => {
  it.each(['constructor', '__proto__', 'toString'])('does not treat a player named %s as blocked', async (name) => {
    const named = await setup(name, 'bob');
    expect(named.pm.isTradeBlocked(name, 'bob')).toBe(false);
    expect(named.pm.isTradeBlocked('bob', name)).toBe(false);
  });

  it('refuses when either side has blocked the other', async () => {
    const t = await setup('alice', 'bob');
    t.block('bob', 'alice', 'all');
    expect(t.pm.isTradeBlocked('alice', 'bob')).toBe(true);
    expect(t.pm.isTradeBlocked('bob', 'alice')).toBe(true);
  });
});

describe('a block across a rename', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  const blocksOf = (username: string) => t.pm.getSessionByUsername(username)!.getBlockedUsers();
  const statesSentTo = (username: string) => vi.mocked(t.sockets.get(username)!.send).mock.calls
    .map(([payload]) => JSON.parse(payload as string))
    .filter(message => message.type === 'state');

  beforeEach(async () => {
    t = await setup('alice', 'bob', 'carol');
  });

  it.each<BlockLevel>(['dm', 'all'])('moves a %s block to the new name', (level) => {
    t.block('bob', 'alice', level);
    t.rename('alice', 'alicia');
    expect(blocksOf('bob')).toEqual({ alicia: level });
  });

  it.each<BlockLevel>(['dm', 'all'])('keeps a %s-blocked sender quiet under the new name, and still delivers', (level) => {
    t.block('bob', 'alice', level);
    t.rename('alice', 'alicia');

    expect(t.pm.sendPlayerChat('alicia', 'dm', 'bob', 'hello')).toBeNull();

    expect(t.notify).not.toHaveBeenCalled();
    expect(t.historyOf('bob')).toMatchObject([{ senderUsername: 'alicia', text: 'hello' }]);
  });

  it.each<BlockLevel>(['dm', 'all'])('keeps refusing trades with a %s-blocked player under the new name', (level) => {
    t.block('bob', 'alice', level);
    t.rename('alice', 'alicia');

    expect(t.pm.isTradeBlocked('alicia', 'bob')).toBe(true);
    expect(t.pm.isTradeBlocked('bob', 'alicia')).toBe(true);
    expect(t.pm.isTradeBlocked('alicia', 'carol')).toBe(false);
  });

  it('leaves the other names on the list alone', () => {
    t.pm.getSessionByUsername('bob')!.setBlockedUsers({ alice: 'dm', carol: 'all' });
    t.rename('alice', 'alicia');
    expect(blocksOf('bob')).toEqual({ alicia: 'dm', carol: 'all' });
  });

  it('keeps the blocks the renamed player made', () => {
    t.block('alice', 'carol', 'all');
    t.rename('alice', 'alicia');
    expect(blocksOf('alicia')).toEqual({ carol: 'all' });
    expect(t.pm.isTradeBlocked('alicia', 'carol')).toBe(true);
  });

  it('does not block whoever takes the old name next', () => {
    t.block('bob', 'alice', 'all');
    t.rename('alice', 'alicia');
    t.addFarPlayer('alice');

    expect(t.pm.isTradeBlocked('alice', 'bob')).toBe(false);
    t.pm.sendPlayerChat('alice', 'dm', 'bob', 'hello');
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('moves the block even when the renamed player has no session', () => {
    t.block('bob', 'absent', 'all');
    expect(t.pm.renamePlayer('absent', 'present')).toBe(false);
    expect(blocksOf('bob')).toEqual({ present: 'all' });
  });

  it.each(['__proto__', 'constructor'])('survives a rename to %s, through a save and load', (name) => {
    t.block('bob', 'alice', 'all');
    t.rename('alice', name);

    expect(t.pm.isTradeBlocked(name, 'bob')).toBe(true);
    t.pm.sendPlayerChat(name, 'dm', 'bob', 'hello');
    expect(t.notify).not.toHaveBeenCalled();

    const saved = t.pm.getAllSaveData().find(data => data.username === 'bob')!;
    expect(isBlockedUser(name, JSON.parse(JSON.stringify(saved)).blockedUsers)).toBe(true);
  });

  it('moves what the blocked player said earlier in the blocker\'s history, so it stays hidden', () => {
    t.block('bob', 'alice', 'all');
    t.pm.sendPlayerChat('alice', 'global', '', 'in public');
    t.pm.sendPlayerChat('alice', 'dm', 'bob', 'in private');
    t.pm.sendPlayerChat('bob', 'dm', 'alice', 'my reply');

    t.rename('alice', 'alicia');

    expect(t.historyOf('bob')).toMatchObject([
      { senderUsername: 'alicia', channelId: '', text: 'in public' },
      { senderUsername: 'alicia', channelId: 'bob', text: 'in private' },
      { senderUsername: 'bob', channelId: 'alicia', text: 'my reply' },
    ]);
  });

  it('leaves the same messages alone in the history of players without the block', () => {
    t.block('bob', 'alice', 'all');
    t.pm.sendPlayerChat('alice', 'global', '', 'in public');

    t.rename('alice', 'alicia');

    expect(t.historyOf('carol')).toMatchObject([{ senderUsername: 'alice', text: 'in public' }]);
  });

  it('leaves the history alone when nobody blocked the player', () => {
    t.pm.sendPlayerChat('alice', 'dm', 'bob', 'hello');
    t.rename('alice', 'alicia');
    expect(t.historyOf('bob')).toMatchObject([{ senderUsername: 'alice' }]);
  });

  it('saves each blocker straight away, online or not', () => {
    t.addFarPlayer('dave');
    t.block('bob', 'alice', 'all');
    t.block('dave', 'alice', 'dm');

    t.rename('alice', 'alicia');

    expect(t.store.saveAll).toHaveBeenCalledTimes(1);
    const [saved] = vi.mocked(t.store.saveAll).mock.calls[0];
    expect(saved.map(data => [data.username, data.blockedUsers])).toEqual([
      ['bob', { alicia: 'all' }],
      ['dave', { alicia: 'dm' }],
    ]);
  });

  it('saves nothing when nobody blocked the player', () => {
    t.rename('alice', 'alicia');
    expect(t.store.saveAll).not.toHaveBeenCalled();
  });

  it('logs a failed save instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(t.store.saveAll).mockRejectedValueOnce(new Error('disk full'));
    t.block('bob', 'alice', 'all');

    expect(t.rename('alice', 'alicia')).toBe(true);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    error.mockRestore();
  });

  it('pushes fresh state to online blockers, and only them', () => {
    t.block('bob', 'alice', 'all');
    vi.mocked(t.sockets.get('bob')!.send).mockClear();
    vi.mocked(t.sockets.get('carol')!.send).mockClear();

    t.rename('alice', 'alicia');

    expect(statesSentTo('bob').map(state => state.social.blockedUsers)).toEqual([{ alicia: 'all' }]);
    expect(statesSentTo('carol')).toEqual([]);
  });
});
