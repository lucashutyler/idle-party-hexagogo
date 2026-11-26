import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { HexGrid, HexTile, MIN_GUILD_LEVEL, chatBucket, isBlockedUser, offsetToCube } from '@idle-party-rpg/shared';
import type { BlockLevel, ChatChannelType, ChatMessage } from '@idle-party-rpg/shared';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import { CHAT_SEND_LIMIT_REFUSAL } from '../src/game/social/ChatRateLimiter.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
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
    getAllZones: () => ({ [START_ZONE]: { id: START_ZONE, displayName: 'Start Zone', levelRange: [1, 5] } }),
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
    const mayInvite = (a: string, b: string) => pm.invitePolicy(a, b);
    const mayJoin = (u: string, id: string) => pm.joinPolicy(u, id);
    const ownerParty = partyId(owner)!;
    const memberOldParty = partyId(member);
    expect(pm.parties.inviteToParty(owner, member, partyId, mayInvite)).toBe(true);
    expect(typeof pm.parties.acceptInvite(member, ownerParty, partyId, setPartyId, mayJoin)).not.toBe('string');
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
    withOutsider.pm.guilds.inviteToGuild('alice', 'bob', false);
    withOutsider.pm.guilds.acceptInvite('bob', guild.id);

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

describe('blockUser', () => {
  it('blocks a player whose name is a prototype key, and keeps other blocks', async () => {
    const t = await setup('alice', 'bob');
    const bob = t.pm.getSessionByUsername('bob')!;

    bob.blockUser('carol', 'dm');
    bob.blockUser('__proto__', 'all');
    bob.blockUser('carol', 'all');

    expect(Object.entries(bob.getBlockedUsers()).sort()).toEqual([['__proto__', 'all'], ['carol', 'all']]);
    expect(JSON.parse(JSON.stringify(bob.getBlockedUsers()))).toEqual(bob.getBlockedUsers());
  });
});

describe('the zone in a state push', () => {
  it('is the value zone chat accepts', async () => {
    const t = await setup('alice', 'bob');
    const zone = t.pm.getSessionByUsername('alice')!.getState([]).zone;

    expect(zone).toBeTruthy();
    expect(t.pm.sendPlayerChat('alice', 'zone', zone, 'hello')).toBeNull();
  });
});

/** Only `Date` is faked, so the login timers still run as usual. */
function fakeClock(): { advance(ms: number): void } {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
  return { advance: (ms: number) => vi.setSystemTime(Date.now() + ms) };
}

const inBucket = (messages: readonly ChatMessage[], bucket: 'dm' | 'group' | 'public') =>
  messages.filter(m => chatBucket(m.channelType) === bucket);

let lineId = 0;
function storedLine(channelType: ChatChannelType, over: Partial<ChatMessage> = {}): ChatMessage {
  lineId++;
  return { id: `line${lineId}`, channelType, channelId: '', senderUsername: 'alice', text: `line ${lineId}`, timestamp: lineId, ...over };
}

describe('chat history per channel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a bystander\'s DMs through 1,200 global lines from one sender', async () => {
    const clock = fakeClock();
    const t = await setup('alice', 'bob', 'carol');
    expect(t.pm.sendPlayerChat('carol', 'dm', 'bob', 'first')).toBeNull();
    clock.advance(1_000);
    expect(t.pm.sendPlayerChat('carol', 'dm', 'bob', 'second')).toBeNull();

    for (let i = 0; i < 1_200; i++) {
      clock.advance(3_100);
      expect(t.pm.sendPlayerChat('alice', 'global', '', `shout ${i}`)).toBeNull();
    }

    const history = t.historyOf('bob');
    expect(inBucket(history, 'dm').map(m => m.text)).toEqual(['first', 'second']);
    expect(inBucket(history, 'public')).toHaveLength(500);
    expect(history[history.length - 1].text).toBe('shout 1199');
    expect(inBucket(history, 'public')[0].text).toBe('shout 700');
  });

  it('sends the newest DMs and group lines in a full sync, however much public chat came after', async () => {
    const t = await setup('alice', 'bob');
    const dms = Array.from({ length: 120 }, () => storedLine('dm', { channelId: 'bob' }));
    const party = Array.from({ length: 60 }, () => storedLine('party'));
    const publicLines = Array.from({ length: 300 }, () => storedLine('global'));
    for (const message of [...dms, ...party, ...publicLines]) t.pm.sendChatToPlayer('bob', message);

    const { messages, full } = t.pm.syncChatForPlayer('bob');

    expect(full).toBe(true);
    expect(inBucket(messages, 'dm')).toEqual(dms.slice(-100));
    expect(inBucket(messages, 'group')).toEqual(party.slice(-50));
    expect(inBucket(messages, 'public')).toEqual(publicLines.slice(-200));
    expect(messages.map(m => m.timestamp)).toEqual([...messages.map(m => m.timestamp)].sort((a, b) => a - b));
  });

  it('counts a DM among the newest 200 only once', async () => {
    const t = await setup('alice', 'bob');
    const lines = [storedLine('global'), storedLine('dm', { channelId: 'bob' }), storedLine('global')];
    for (const message of lines) t.pm.sendChatToPlayer('bob', message);

    expect(t.pm.syncChatForPlayer('bob').messages).toEqual(lines);
  });

  it('sends the same latest batch for a stale sinceId, marked as not full', async () => {
    const t = await setup('alice', 'bob');
    const dm = storedLine('dm', { channelId: 'bob' });
    const publicLines = Array.from({ length: 300 }, () => storedLine('global'));
    for (const message of [dm, ...publicLines]) t.pm.sendChatToPlayer('bob', message);

    const stale = t.pm.syncChatForPlayer('bob', 'gone');

    expect(stale.full).toBe(false);
    expect(stale.messages).toEqual([dm, ...publicLines.slice(-200)]);
  });

  it('sends everything after a known sinceId, as before', async () => {
    const t = await setup('alice', 'bob');
    const lines = [storedLine('global'), storedLine('dm', { channelId: 'bob' }), storedLine('party'), storedLine('global')];
    for (const message of lines) t.pm.sendChatToPlayer('bob', message);

    expect(t.pm.syncChatForPlayer('bob', lines[0].id)).toEqual({ messages: lines.slice(1), full: true });
    expect(t.pm.syncChatForPlayer('bob', lines[3].id)).toEqual({ messages: [], full: true });
  });
});

describe('chat history save and restore', () => {
  function saveWith(chatHistory: unknown): PlayerSaveData {
    return {
      username: 'dana',
      battleCount: 0,
      combatLog: [],
      unlockedKeys: ['tile-start'],
      position: { col: 0, row: 0 },
      target: null,
      movementQueue: [],
      character: { className: 'Knight', level: 5, xp: 1000 },
      chatHistory,
    } as unknown as PlayerSaveData;
  }

  it('restores an old save with 1,000 public lines to the newest 500, keeping every DM', async () => {
    const t = await setup('alice');
    const dms = Array.from({ length: 5 }, () => storedLine('dm', { channelId: 'dana' }));
    const publicLines = Array.from({ length: 1_000 }, () => storedLine('zone'));
    const old = [dms[0], ...publicLines.slice(0, 400), ...dms.slice(1), ...publicLines.slice(400)];

    t.pm.restoreFromSaveData([saveWith(old)]);

    const history = t.historyOf('dana');
    expect(inBucket(history, 'dm')).toEqual(dms);
    expect(inBucket(history, 'public')).toEqual(publicLines.slice(-500));
    expect(history).toEqual(old.filter(m => chatBucket(m.channelType) === 'dm' || publicLines.slice(-500).includes(m)));
  });

  it('saves what it restored, no more than an older build keeps', async () => {
    const t = await setup('alice');
    const old = [...Array.from({ length: 900 }, () => storedLine('global')), ...Array.from({ length: 100 }, () => storedLine('dm', { channelId: 'dana' }))];
    t.pm.restoreFromSaveData([saveWith(old)]);

    const saved = t.pm.getAllSaveData().find(data => data.username === 'dana')!;

    expect(saved.chatHistory).toEqual(t.historyOf('dana'));
    expect(saved.chatHistory!.length).toBeLessThanOrEqual(1_000);
    expect(saved.chatHistory!.slice(-100)).toEqual(old.slice(-100));
  });

  it('keeps a save that already fits exactly as it was', async () => {
    const t = await setup('alice');
    const old = [storedLine('global'), storedLine('dm', { channelId: 'dana' }), storedLine('guild')];

    t.pm.restoreFromSaveData([saveWith(old)]);

    expect(t.historyOf('dana')).toEqual(old);
  });

  it.each([
    ['no chat history', undefined],
    ['a history that is not a list', 'nonsense'],
    ['a history with a damaged entry', [null, storedLine('global')]],
  ])('restores a save with %s', async (_label, chatHistory) => {
    const t = await setup('alice');

    t.pm.restoreFromSaveData([saveWith(chatHistory)]);

    expect(t.historyOf('dana').every(m => m !== null)).toBe(true);
    t.pm.sendChatToPlayer('dana', storedLine('dm', { channelId: 'dana' }));
    expect(inBucket(t.historyOf('dana'), 'dm')).toHaveLength(1);
  });

  it('trims each bucket on its own as new lines arrive after a restore', async () => {
    const t = await setup('alice');
    const dms = Array.from({ length: 300 }, () => storedLine('dm', { channelId: 'dana' }));
    t.pm.restoreFromSaveData([saveWith(dms)]);

    const newest = storedLine('dm', { channelId: 'dana' });
    t.pm.sendChatToPlayer('dana', storedLine('global'));
    t.pm.sendChatToPlayer('dana', newest);

    const history = t.historyOf('dana');
    expect(inBucket(history, 'dm')).toEqual([...dms.slice(1), newest]);
    expect(inBucket(history, 'public')).toHaveLength(1);
  });
});

describe('chat send limits', () => {
  let clock: { advance(ms: number): void };
  let t: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    clock = fakeClock();
    t = await setup('alice', 'bob');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a 6th message inside 5 seconds, and allows it once the window has passed', () => {
    for (let i = 0; i < 5; i++) {
      expect(t.pm.sendPlayerChat('alice', 'tile', '', `line ${i}`)).toBeNull();
      clock.advance(500);
    }

    expect(t.pm.sendPlayerChat('alice', 'tile', '', 'too soon')).toBe(CHAT_SEND_LIMIT_REFUSAL);
    expect(t.historyOf('bob').map(m => m.text)).not.toContain('too soon');
    expect(t.historyOf('alice').map(m => m.text)).not.toContain('too soon');

    clock.advance(3_000);
    expect(t.pm.sendPlayerChat('alice', 'tile', '', 'later')).toBeNull();
    expect(t.historyOf('bob').map(m => m.text)).toContain('later');
  });

  it('shares one budget between DMs and global chat', () => {
    expect(t.pm.sendPlayerChat('alice', 'global', '', 'hello all')).toBeNull();
    for (let i = 0; i < 4; i++) expect(t.pm.sendPlayerChat('alice', 'dm', 'bob', `dm ${i}`)).toBeNull();

    expect(t.pm.sendPlayerChat('alice', 'dm', 'bob', 'one more')).toBe(CHAT_SEND_LIMIT_REFUSAL);
    expect(t.notify).toHaveBeenCalledTimes(4);
  });

  it('allows one global message every 3 seconds', () => {
    expect(t.pm.sendPlayerChat('alice', 'global', '', 'one')).toBeNull();
    expect(t.pm.sendPlayerChat('alice', 'global', '', 'two')).toBe(CHAT_SEND_LIMIT_REFUSAL);
    clock.advance(3_001);
    expect(t.pm.sendPlayerChat('alice', 'global', '', 'three')).toBeNull();
  });

  it('checks the channel before the limit, so a refused channel costs nothing', () => {
    for (let i = 0; i < 10; i++) expect(t.pm.sendPlayerChat('alice', 'dm', 'nobody', 'hi')).toBe('User not found');
    expect(t.pm.sendPlayerChat('alice', 'tile', '', 'still fine')).toBeNull();
  });

  it('never limits server lines', () => {
    t.joinParty('bob', 'alice');
    const partyId = t.pm.getSessionByUsername('alice')!.getPartyId()!;
    const serverLines = () => t.historyOf('alice').filter(m => m.senderUsername === 'Server').length;
    const before = serverLines();

    for (let i = 0; i < 30; i++) {
      t.pm.broadcastServerMessage(`notice ${i}`);
      t.pm.broadcastPartyEvent(partyId, 'bob', `You did ${i}`, `bob did ${i}`);
    }

    expect(serverLines() - before).toBe(60);
    expect(t.pm.sendPlayerChat('alice', 'party', '', 'still mine to say')).toBeNull();
  });
});

describe('chat text', () => {
  let t: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    t = await setup('alice', 'bob');
  });

  it('removes text direction controls before delivering', () => {
    expect(t.pm.sendPlayerChat('alice', 'tile', '', 'abc‮def⁦g⁩')).toBeNull();
    expect(t.historyOf('bob').map(m => m.text)).toEqual(['abcdefg']);
  });

  it('drops a message made only of text direction controls', () => {
    expect(t.pm.sendPlayerChat('alice', 'tile', '', '‪‫‬‭‮⁦⁧⁨⁩')).toBeNull();
    expect(t.historyOf('bob')).toEqual([]);
    expect(t.historyOf('alice')).toEqual([]);
  });

  it('keeps zero-width joiners', () => {
    t.pm.sendPlayerChat('alice', 'tile', '', 'a‍b');
    expect(t.historyOf('bob').map(m => m.text)).toEqual(['a‍b']);
  });

  it('measures the length after removing them', () => {
    expect(t.pm.sendPlayerChat('alice', 'tile', '', `${'x'.repeat(500)}‮`)).toBeNull();
    expect(t.historyOf('bob').map(m => m.text.length)).toEqual([500]);
  });

  it('leaves them out of the DM notice too', () => {
    t.pm.sendPlayerChat('alice', 'dm', 'bob', '‮hello');
    expect(t.notify).toHaveBeenCalledWith('bob', 'dm_received', expect.objectContaining({ body: 'hello' }));
  });
});
