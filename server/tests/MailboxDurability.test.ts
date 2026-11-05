import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import type { MailboxEntry } from '@idle-party-rpg/shared';
import { GIFT_NOT_FOUND, PlayerManager } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import { JsonMailboxStore } from '../src/game/social/MailboxStore.js';
import type { MailboxStore, Mailboxes } from '../src/game/social/MailboxStore.js';
import { MailboxSystem, mailboxesWithEntriesFrom } from '../src/game/social/MailboxSystem.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
import type { Account, AccountStore } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import { fakeSkillContent, fakeWorldMeta, wrapGrids } from './testGrids.js';

function fakeContent(): ContentStore {
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: (id: string) => (id === 'gem' ? { id: 'gem', name: 'Gem' } : null),
    getAllMonsters: () => ({}),
    getAllItems: () => ({}),
    getZone: () => ({ id: 'start', name: 'Start', encounterTable: [{ encounterId: 'auto', weight: 1 }] }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({
      auto: { id: 'auto', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 },
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

function fakeAccounts(accounts: Record<string, Partial<Account>>): AccountStore {
  return {
    findByUsername: (name: string) => accounts[Object.keys(accounts).find(key => key.toLowerCase() === name.toLowerCase()) ?? ''] ?? null,
    getAllUsernames: () => Object.keys(accounts),
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    setDeactivated: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
}

function memoryPlayerStore(): GameStateStore & { saves: Map<string, PlayerSaveData> } {
  const saves = new Map<string, PlayerSaveData>();
  return {
    saves,
    save: async (data: PlayerSaveData) => { saves.set(data.username, data); },
    saveAll: async (all: PlayerSaveData[]) => { for (const data of all) saves.set(data.username, data); },
    load: async (username: string) => saves.get(username) ?? null,
    loadAll: async () => [...saves.values()],
    delete: async (username: string) => { saves.delete(username); },
  };
}

function fakeWs(): WebSocket {
  return { readyState: WebSocket.OPEN, send: vi.fn(), on: vi.fn(), close: vi.fn(), bufferedAmount: 0 } as unknown as WebSocket;
}

const OLD_GIFT: MailboxEntry = { id: 'gift_old', fromUsername: 'giver', itemId: 'gem', quantity: 1, sentAt: 1 };

describe('gift durability', () => {
  let dir: string;
  let mailboxStore: JsonMailboxStore;
  let playerStore: ReturnType<typeof memoryPlayerStore>;
  const accounts = {
    giver: { username: 'giver' },
    Taker: { username: 'Taker' },
    banned: { username: 'banned', deactivated: true },
  } as Record<string, Partial<Account>>;

  function newManager(store: MailboxStore = mailboxStore): PlayerManager {
    const grid = new HexGrid();
    grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'town', 'start', 'tile-start'));
    return new PlayerManager(wrapGrids(grid), fakeContent(), new GuildStore(), fakeAccounts(accounts), playerStore, store);
  }

  /** A fresh server over the same files, as a kill would leave them. */
  async function restart(): Promise<PlayerManager> {
    const pm = newManager();
    pm.mailboxes.restore(await mailboxStore.load());
    pm.restoreFromSaveData([...playerStore.saves.values()]);
    await pm.saveMailboxes();
    return pm;
  }

  async function enter(pm: PlayerManager, username: string, gems = 0) {
    const session = await pm.login(fakeWs(), username);
    session.setClass('Knight');
    (pm as unknown as { ensureParty(name: string): void }).ensureParty(username);
    if (gems > 0) session.addToInventory('gem', gems);
    return session;
  }

  const savedGems = (username: string) => playerStore.saves.get(username)?.character?.inventory?.gem ?? 0;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mailbox-'));
    mailboxStore = new JsonMailboxStore(dir);
    playerStore = memoryPlayerStore();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps a gift to an account with no session across a restart', async () => {
    const pm = newManager();
    await enter(pm, 'giver', 3);

    expect(pm.sendGift('giver', 'Taker', 'gem', 2)).toBeNull();
    await pm.saveAll(playerStore);

    const after = await restart();
    expect(after.mailboxes.getMailbox('Taker')).toMatchObject([{ fromUsername: 'giver', itemId: 'gem', quantity: 2 }]);
    expect(savedGems('giver')).toBe(1);
  });

  it('saves mailboxes even with no player in memory', async () => {
    const pm = newManager();
    pm.mailboxes.addEntry('Taker', 'giver', 'gem', 2);

    await pm.saveAll(playerStore);

    expect((await mailboxStore.load()).get('Taker')).toHaveLength(1);
  });

  it('rolls a gift back whole if the server dies before the next save', async () => {
    const pm = newManager();
    await enter(pm, 'giver', 3);
    await pm.saveAll(playerStore);

    pm.sendGift('giver', 'Taker', 'gem', 2);

    const after = await restart();
    expect(after.mailboxes.getMailbox('Taker')).toEqual([]);
    expect(savedGems('giver')).toBe(3);
  });

  it('rolls an accept back whole if the server dies before the next save', async () => {
    const pm = newManager();
    await enter(pm, 'giver', 3);
    await enter(pm, 'Taker');
    pm.sendGift('giver', 'Taker', 'gem', 2);
    await pm.saveAll(playerStore);

    pm.acceptGift('Taker', pm.mailboxes.getMailbox('Taker')[0].id);

    const after = await restart();
    expect(after.mailboxes.getMailbox('Taker')).toHaveLength(1);
    expect(savedGems('Taker')).toBe(0);
  });

  it('writes nothing for a gift action until the next save', async () => {
    const save = vi.spyOn(mailboxStore, 'save');
    const playerSave = vi.spyOn(playerStore, 'save');
    const pm = newManager();
    await enter(pm, 'giver', 3);
    await enter(pm, 'Taker');

    pm.sendGift('giver', 'Taker', 'gem', 1);
    pm.denyGift('Taker', pm.mailboxes.getMailbox('Taker')[0].id);

    expect(save).not.toHaveBeenCalled();
    expect(playerSave).not.toHaveBeenCalled();
  });

  describe('a kill partway through a save', () => {
    /** A store that records each state written, so a test can look at what a kill at that point would leave. */
    function recording() {
      const writes: string[] = [];
      const store: MailboxStore = {
        load: async () => new Map(),
        save: async (boxes) => { writes.push(`mailbox:${(boxes.get('Taker') ?? []).map(entry => entry.quantity).join(',')}`); },
      };
      const saveAll = playerStore.saveAll;
      playerStore.saveAll = async (all) => {
        writes.push(`players:giver=${all.find(p => p.username === 'giver')?.character?.inventory?.gem ?? 0},Taker=${all.find(p => p.username === 'Taker')?.character?.inventory?.gem ?? 0}`);
        await saveAll(all);
      };
      return { writes, store };
    }

    it('has a new gift on disk before the sender loses the item', async () => {
      const { writes, store } = recording();
      const pm = newManager(store);
      await enter(pm, 'giver', 3);
      await pm.saveAll(playerStore);
      writes.length = 0;

      pm.sendGift('giver', 'Taker', 'gem', 2);
      await pm.saveAll(playerStore);

      expect(writes[0]).toBe('mailbox:2');
      expect(writes[1]).toContain('giver=1');
    });

    it('keeps an accepted gift on disk until the player file holds the item', async () => {
      const { writes, store } = recording();
      const pm = newManager(store);
      await enter(pm, 'giver', 3);
      await enter(pm, 'Taker');
      pm.sendGift('giver', 'Taker', 'gem', 2);
      await pm.saveAll(playerStore);
      writes.length = 0;

      pm.acceptGift('Taker', pm.mailboxes.getMailbox('Taker')[0].id);
      await pm.saveAll(playerStore);

      expect(writes).toEqual(['mailbox:2', 'players:giver=1,Taker=2', 'mailbox:']);
    });

    it('keeps a gift sent and accepted between saves on disk until the player files hold it', async () => {
      const { writes, store } = recording();
      const pm = newManager(store);
      await enter(pm, 'giver', 3);
      await enter(pm, 'Taker');
      await pm.saveAll(playerStore);
      writes.length = 0;

      pm.sendGift('giver', 'Taker', 'gem', 2);
      pm.acceptGift('Taker', pm.mailboxes.getMailbox('Taker')[0].id);
      await pm.saveAll(playerStore);

      expect(writes).toEqual(['mailbox:2', 'players:giver=1,Taker=2', 'mailbox:']);
    });

    it('keeps the entry until it is gone from a later save if the player write fails', async () => {
      const { writes, store } = recording();
      const pm = newManager(store);
      await enter(pm, 'giver', 3);
      await enter(pm, 'Taker');
      pm.sendGift('giver', 'Taker', 'gem', 2);
      await pm.saveAll(playerStore);
      pm.acceptGift('Taker', pm.mailboxes.getMailbox('Taker')[0].id);
      writes.length = 0;

      const saveAll = playerStore.saveAll;
      playerStore.saveAll = async () => { throw new Error('disk full'); };
      await expect(pm.saveAll(playerStore)).rejects.toThrow('disk full');
      expect(writes).toEqual(['mailbox:2']);

      playerStore.saveAll = saveAll;
      writes.length = 0;
      await pm.saveAll(playerStore);
      expect(writes.at(0)).toBe('mailbox:2');
      expect(writes.at(-1)).toBe('mailbox:');
    });
  });

  it('runs overlapping saves one at a time, so an older mailbox file is not written last', async () => {
    const order: string[] = [];
    let finishFirst = () => {};
    const firstWrite = new Promise<void>(resolve => { finishFirst = resolve; });
    let writes = 0;
    const slow: MailboxStore = {
      load: async () => new Map(),
      save: async (boxes) => {
        const n = ++writes;
        if (n === 1) await firstWrite;
        order.push(`${n}:${boxes.get('Taker')?.length ?? 0}`);
      },
    };
    const pm = newManager(slow);
    await enter(pm, 'giver', 3);

    const first = pm.saveAll(playerStore);
    await new Promise(resolve => setImmediate(resolve));
    pm.sendGift('giver', 'Taker', 'gem', 1);
    const second = pm.saveAll(playerStore);
    finishFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['1:0', '2:0', '3:1', '4:1']);
  });

  it('keeps saving the players when the mailbox file can\'t be written, and tries again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const saved: Mailboxes[] = [];
    const flaky: MailboxStore = {
      load: async () => new Map(),
      save: async (boxes) => {
        if (fail) throw new Error('disk full');
        saved.push(boxes);
      },
    };
    const pm = newManager(flaky);
    await enter(pm, 'giver', 3);
    pm.sendGift('giver', 'Taker', 'gem', 1);

    await pm.saveAll(playerStore);
    expect(savedGems('giver')).toBe(2);
    expect(error).toHaveBeenCalled();

    fail = false;
    await pm.saveAll(playerStore);
    expect(saved.at(-1)?.get('Taker')).toHaveLength(1);
  });

  it('keeps gifts sent while the recipient was away when they log in holding an old saved mailbox', async () => {
    const seed = newManager();
    await enter(seed, 'Taker');
    await seed.saveAll(playerStore);
    playerStore.saves.set('Taker', { ...playerStore.saves.get('Taker')!, mailbox: [OLD_GIFT] });

    const pm = newManager();
    await enter(pm, 'giver', 3);
    pm.sendGift('giver', 'Taker', 'gem', 2);
    await pm.login(fakeWs(), 'Taker');

    const ids = pm.mailboxes.getMailbox('Taker').map(entry => entry.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('gift_old');

    await pm.saveAll(playerStore);
    expect((await mailboxStore.load()).get('Taker')).toHaveLength(2);
    expect(playerStore.saves.get('Taker')?.mailbox).toBeUndefined();
  });

  it('takes in an old save only once', () => {
    const mailboxes = new MailboxSystem();

    expect(mailboxes.mergeEntries('Taker', [OLD_GIFT])).toBe(true);
    expect(mailboxes.mergeEntries('Taker', [OLD_GIFT])).toBe(false);
    expect(mailboxes.getMailbox('Taker')).toHaveLength(1);
  });

  it('takes in old saves at startup, ready to write before any player save drops them', async () => {
    const seed = newManager();
    await enter(seed, 'Taker');
    await seed.saveAll(playerStore);
    playerStore.saves.set('Taker', { ...playerStore.saves.get('Taker')!, mailbox: [OLD_GIFT] });

    const pm = newManager();
    pm.restoreFromSaveData([...playerStore.saves.values()]);
    await pm.saveMailboxes();

    expect((await mailboxStore.load()).get('Taker')?.map(entry => entry.id)).toEqual(['gift_old']);
    expect(playerStore.saves.get('Taker')?.mailbox).toEqual([OLD_GIFT]);
    await pm.saveAll(playerStore);
    expect(playerStore.saves.get('Taker')?.mailbox).toBeUndefined();
    expect((await mailboxStore.load()).get('Taker')?.map(entry => entry.id)).toEqual(['gift_old']);
  });

  it('does not bring an accepted gift back after a restart', async () => {
    const pm = newManager();
    await enter(pm, 'giver', 3);
    const taker = await enter(pm, 'Taker');
    pm.sendGift('giver', 'Taker', 'gem', 2);
    const [entry] = pm.mailboxes.getMailbox('Taker');

    expect(pm.acceptGift('Taker', entry.id)).toBeNull();
    await pm.saveAll(playerStore);

    expect(taker.getInventoryCount('gem')).toBe(2);
    expect(savedGems('Taker')).toBe(2);
    expect((await restart()).mailboxes.getMailbox('Taker')).toEqual([]);
  });

  it('keeps a gift in the mailbox when it does not fit', async () => {
    const pm = newManager();
    await enter(pm, 'giver', 3);
    await enter(pm, 'Taker', 99);
    pm.sendGift('giver', 'Taker', 'gem', 2);
    const [entry] = pm.mailboxes.getMailbox('Taker');

    expect(pm.acceptGift('Taker', entry.id)).toContain('Inventory full');

    expect(pm.mailboxes.getMailbox('Taker')).toHaveLength(1);
  });

  it('keeps a declined gift returned to a sender with no session across a restart', async () => {
    const first = newManager();
    await enter(first, 'giver', 3);
    first.sendGift('giver', 'Taker', 'gem', 2);
    await first.saveAll(playerStore);
    playerStore.saves.delete('giver');

    const pm = await restart();
    expect(pm.getSessionByUsername('giver')).toBeUndefined();
    await enter(pm, 'Taker');
    const [entry] = pm.mailboxes.getMailbox('Taker');
    expect(pm.denyGift('Taker', entry.id)).toBeNull();
    await pm.saveAll(playerStore);

    const after = await restart();
    expect(after.mailboxes.getMailbox('Taker')).toEqual([]);
    expect(after.mailboxes.getMailbox('giver')).toMatchObject([{ fromUsername: 'Taker', itemId: 'gem', quantity: 2, returned: true }]);
  });

  it('drops a returned gift that is declined again, durably', async () => {
    const pm = newManager();
    await enter(pm, 'giver', 3);
    await enter(pm, 'Taker');
    pm.sendGift('giver', 'Taker', 'gem', 1);
    pm.denyGift('Taker', pm.mailboxes.getMailbox('Taker')[0].id);
    await pm.saveAll(playerStore);

    expect(pm.denyGift('giver', pm.mailboxes.getMailbox('giver')[0].id)).toBeNull();
    await pm.saveAll(playerStore);

    const boxes = await mailboxStore.load();
    expect(boxes.get('giver')).toBeUndefined();
    expect(boxes.get('Taker')).toBeUndefined();
  });

  it('delivers to the account\'s spelling of the name, and sees through case to refuse a self-gift', async () => {
    const pm = newManager();
    const giver = await enter(pm, 'giver', 3);

    expect(pm.sendGift('giver', 'GIVER', 'gem', 1)).toBe('Cannot gift to yourself');
    expect(giver.getInventoryCount('gem')).toBe(3);

    expect(pm.sendGift('giver', 'taker', 'gem', 1)).toBeNull();
    expect(pm.mailboxes.getMailbox('Taker')).toHaveLength(1);
    expect(pm.mailboxes.getMailbox('taker')).toEqual([]);
  });

  it.each([
    ['a suspended player', 'banned', 'gem', 1, 'can\'t receive gifts'],
    ['an unknown player', 'nobody', 'gem', 1, 'not found'],
    ['a fractional quantity', 'Taker', 'gem', 1.5, 'Invalid quantity'],
    ['a zero quantity', 'Taker', 'gem', 0, 'Invalid quantity'],
    ['more than the sender holds', 'Taker', 'gem', 4, 'Not enough'],
    ['a huge quantity', 'Taker', 'gem', 1e21, 'Not enough'],
    ['a non-item named __proto__', 'Taker', '__proto__', 1, 'Not enough'],
    ['a non-item named constructor', 'Taker', 'constructor', 1, 'Not enough'],
    ['a non-item named toString', 'Taker', 'toString', 1, 'Not enough'],
  ])('refuses %s and keeps the sender\'s items', async (_label, target, itemId, quantity, reason) => {
    const pm = newManager();
    const giver = await enter(pm, 'giver', 3);

    expect(pm.sendGift('giver', target, itemId, quantity)).toContain(reason);

    expect(giver.getInventoryCount('gem')).toBe(3);
    expect(pm.mailboxes.snapshot().size).toBe(0);
  });

  it('gives the same refusal for a block in either direction as for a suspended player', async () => {
    const pm = newManager();
    const giver = await enter(pm, 'giver', 3);
    const taker = await enter(pm, 'Taker');

    taker.setBlockedUsers({ giver: 'all' });
    expect(pm.sendGift('giver', 'Taker', 'gem', 1)).toBe('That player can\'t receive gifts');

    taker.setBlockedUsers({});
    giver.setBlockedUsers({ Taker: 'all' });
    expect(pm.sendGift('giver', 'Taker', 'gem', 1)).toBe('That player can\'t receive gifts');

    expect(giver.getInventoryCount('gem')).toBe(3);
  });

  it('answers a second accept with the double-tap message', async () => {
    const pm = newManager();
    await enter(pm, 'giver', 3);
    await enter(pm, 'Taker');
    pm.sendGift('giver', 'Taker', 'gem', 1);
    const [entry] = pm.mailboxes.getMailbox('Taker');

    expect(pm.acceptGift('Taker', entry.id)).toBeNull();
    expect(pm.acceptGift('Taker', entry.id)).toBe(GIFT_NOT_FOUND);
  });

  it('saves a gift and its sender together when the sender is suspended', async () => {
    const pm = newManager();
    await enter(pm, 'giver', 3);
    pm.sendGift('giver', 'Taker', 'gem', 2);

    await pm.banPlayer('giver');

    expect(savedGems('giver')).toBe(1);
    expect((await mailboxStore.load()).get('Taker')).toHaveLength(1);
  });

  it('leaves a gift where it is when its sender no longer has an account', async () => {
    const pm = newManager();
    await enter(pm, 'Taker');
    pm.mailboxes.addEntry('Taker', 'gone_player', 'gem', 2);
    const [entry] = pm.mailboxes.getMailbox('Taker');

    expect(pm.denyGift('Taker', entry.id)).toContain('can\'t be sent back');
    expect(pm.mailboxes.getMailbox('Taker')).toHaveLength(1);
    expect(pm.mailboxes.getMailbox('gone_player')).toEqual([]);

    expect(pm.acceptGift('Taker', entry.id)).toBeNull();
  });

  it('moves a mailbox with a renamed player, even one with no session', async () => {
    const pm = newManager();
    await enter(pm, 'giver', 3);
    pm.sendGift('giver', 'Taker', 'gem', 1);

    pm.renamePlayer('Taker', 'Renamed');
    await pm.saveAll(playerStore);

    const boxes = await mailboxStore.load();
    expect(boxes.get('Renamed')).toHaveLength(1);
    expect(boxes.get('Taker')).toBeUndefined();
  });
});

describe('mailboxesWithEntriesFrom', () => {
  const entry = (id: string): MailboxEntry => ({ id, fromUsername: 'a', itemId: 'gem', quantity: 1, sentAt: 1 });

  it('holds what either side holds, once', () => {
    const union = mailboxesWithEntriesFrom(
      new Map([['alice', [entry('1'), entry('2')]], ['bob', [entry('3')]]]),
      new Map([['alice', [entry('2'), entry('4')]]]),
    );

    expect(union.get('alice')?.map(e => e.id).sort()).toEqual(['1', '2', '4']);
    expect(union.get('bob')?.map(e => e.id)).toEqual(['3']);
  });
});

describe('JsonMailboxStore', () => {
  let dir: string;
  const entry = (id: string): MailboxEntry => ({ id, fromUsername: 'a', itemId: 'gem', quantity: 1, sentAt: 1 });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mailbox-store-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('starts empty with no file', async () => {
    expect((await new JsonMailboxStore(dir).load()).size).toBe(0);
  });

  it('round-trips, including a recipient whose name is a prototype key', async () => {
    const store = new JsonMailboxStore(dir);
    await store.save(new Map([['alice', [entry('1')]], ['__proto__', [entry('2')]]]));

    const loaded = await new JsonMailboxStore(dir).load();

    expect(loaded.get('alice')).toEqual([entry('1')]);
    expect(loaded.get('__proto__')).toEqual([entry('2')]);
  });

  it('survives many saves at once and ends on the last', async () => {
    const store = new JsonMailboxStore(dir);

    await Promise.all(Array.from({ length: 12 }, (_, i) => store.save(new Map([['alice', [entry(`${i}`)]]]))));

    expect((await new JsonMailboxStore(dir).load()).get('alice')).toEqual([entry('11')]);
    expect(await readdir(dir)).toEqual(['entries.json']);
  });

  it('keeps writing after a failed write', async () => {
    const store = new JsonMailboxStore(join(dir, 'file-in-the-way'));
    await writeFile(join(dir, 'file-in-the-way'), 'not a folder');
    await expect(store.save(new Map())).rejects.toThrow();
    await rm(join(dir, 'file-in-the-way'));

    await store.save(new Map([['alice', [entry('1')]]]));

    expect((await store.load()).get('alice')).toEqual([entry('1')]);
  });

  it('keeps an unreadable file rather than starting over on top of it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeFile(join(dir, 'entries.json'), '{ not json');
    const store = new JsonMailboxStore(dir);

    expect((await store.load()).size).toBe(0);
    await store.save(new Map([['alice', [entry('1')]]]));

    const aside = (await readdir(dir)).find(name => name.startsWith('entries.json.unreadable-'));
    expect(aside).toBeDefined();
    expect(await readFile(join(dir, aside!), 'utf-8')).toBe('{ not json');
  });

  it.each(['{"alice": []}', '[1]', '[null]', '[{"username":"alice"}]', '[{"entries":[]}]'])('keeps a file of the wrong shape: %s', async (content) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeFile(join(dir, 'entries.json'), content);

    expect((await new JsonMailboxStore(dir).load()).size).toBe(0);

    expect((await readdir(dir)).some(name => name.startsWith('entries.json.unreadable-'))).toBe(true);
  });
});
