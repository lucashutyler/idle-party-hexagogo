import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import type { ContentStore } from '../src/game/ContentStore.js';
import WebSocket from 'ws';

// --- Minimal fakes (matching BanSystem.test.ts patterns) ---

function createFakeGrid(): HexGrid {
  const grid = new HexGrid();
  const startCoord = offsetToCube({ col: 0, row: 0 });
  grid.addTile(new HexTile(startCoord, 'town', 'hatchetmill', 'tile-start'));
  const otherCoord = offsetToCube({ col: 1, row: 0 });
  grid.addTile(new HexTile(otherCoord, 'forest', 'darkwood', 'tile-other'));
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
      id: 'hatchetmill',
      name: 'Hatchet Mill',
      encounterTable: [{ encounterId: 'auto_goblin', weight: 1 }],
    }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({
      auto_goblin: { id: 'auto_goblin', name: 'Goblins', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }], roomMax: 9 },
    }),
    getTileById: () => undefined,
    getAllShops: () => ({}),
    getShop: () => undefined,
    getWorld: () => ({ tiles: [], startTile: { col: 0, row: 0 } }),
    getAllSets: () => ({}),
  } as unknown as ContentStore;
}

function createFakeAccountStore(accounts: Record<string, Account>): AccountStore {
  return {
    findByUsername: (username: string) => {
      for (const acct of Object.values(accounts)) {
        if (acct.username === username) return acct;
      }
      return null;
    },
    getAllUsernames: () => Object.values(accounts).map(a => a.username).filter(Boolean) as string[],
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

function createFakeGuildStore(): GuildStore {
  return new GuildStore();
}

function createFakeWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

function activeAccounts(...usernames: string[]): Record<string, Account> {
  const accounts: Record<string, Account> = {};
  for (const u of usernames) {
    accounts[`${u}@test.com`] = {
      email: `${u}@test.com`,
      username: u,
      verified: true,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
  }
  return accounts;
}

// --- Tests ---

describe('PlayerSession — new player detection', () => {
  let grid: HexGrid;
  let content: ContentStore;

  beforeEach(() => {
    grid = createFakeGrid();
    content = createFakeContentStore();
  });

  it('new session has no character (isNewPlayer = true)', () => {
    const session = new PlayerSession('alice', grid, content);
    expect(session.isNewPlayer()).toBe(true);
    expect(session.hasCharacter()).toBe(false);
    expect(session.getClassName()).toBeNull();
  });

  it('selecting a class creates the character', () => {
    const session = new PlayerSession('alice', grid, content);
    expect(session.setClass('Knight')).toBe(true);
    expect(session.isNewPlayer()).toBe(false);
    expect(session.hasCharacter()).toBe(true);
    expect(session.getClassName()).toBe('Knight');
  });

  it('isNewPlayer is unaffected by battle count', () => {
    const session = new PlayerSession('alice', grid, content);
    for (let i = 0; i < 50; i++) session.incrementBattleCount();
    expect(session.isNewPlayer()).toBe(true);
  });

  it('forceSetClass on characterless session creates character (no welcome)', () => {
    const session = new PlayerSession('alice', grid, content);
    expect(session.isNewPlayer()).toBe(true);
    session.forceSetClass('Mage');
    // Character now exists — admin created it
    expect(session.hasCharacter()).toBe(true);
    expect(session.getClassName()).toBe('Mage');
    // isNewPlayer returns false because character exists
    expect(session.isNewPlayer()).toBe(false);
  });

  it('setClass only works once (first class selection)', () => {
    const session = new PlayerSession('alice', grid, content);
    expect(session.setClass('Knight')).toBe(true);
    expect(session.setClass('Mage')).toBe(false);
    expect(session.getClassName()).toBe('Knight');
  });

  it('restored player with a real class has a character', () => {
    const saveData: PlayerSaveData = {
      username: 'alice',
      battleCount: 30,
      combatLog: [],
      unlockedKeys: ['tile-start'],
      position: { col: 0, row: 0 },
      target: null,
      movementQueue: [],
      character: { className: 'Archer', level: 5, xp: 1000 },
    };
    const session = PlayerSession.fromSaveData(saveData, grid, content);
    expect(session.isNewPlayer()).toBe(false);
    expect(session.hasCharacter()).toBe(true);
    expect(session.getClassName()).toBe('Archer');
  });

  it('restored player with legacy Adventurer class has no character', () => {
    const saveData: PlayerSaveData = {
      username: 'alice',
      battleCount: 0,
      combatLog: [],
      unlockedKeys: ['tile-start'],
      position: { col: 0, row: 0 },
      target: null,
      movementQueue: [],
      character: { className: 'Adventurer', level: 1, xp: 0 },
    };
    const session = PlayerSession.fromSaveData(saveData, grid, content);
    expect(session.isNewPlayer()).toBe(true);
    expect(session.hasCharacter()).toBe(false);
    expect(session.getClassName()).toBeNull();
  });

  it('restored player with no character field has no character', () => {
    const saveData: PlayerSaveData = {
      username: 'alice',
      battleCount: 0,
      combatLog: [],
      unlockedKeys: ['tile-start'],
      position: { col: 0, row: 0 },
      target: null,
      movementQueue: [],
    };
    const session = PlayerSession.fromSaveData(saveData, grid, content);
    expect(session.isNewPlayer()).toBe(true);
    expect(session.hasCharacter()).toBe(false);
  });

  it('masterReset preserves the chosen class', () => {
    const session = new PlayerSession('alice', grid, content);
    session.setClass('Priest');
    expect(session.getClassName()).toBe('Priest');

    const startTile = grid.getTile(offsetToCube({ col: 0, row: 0 }))!;
    session.resetForMasterReset(startTile);
    expect(session.hasCharacter()).toBe(true);
    expect(session.getClassName()).toBe('Priest');
    expect(session.getLevel()).toBe(1);
  });

  it('getState returns null character when no class selected', () => {
    const session = new PlayerSession('alice', grid, content);
    const state = session.getState([]);
    expect(state.character).toBeNull();
  });

  it('getState returns character data after class selection', () => {
    const session = new PlayerSession('alice', grid, content);
    session.setClass('Bard');
    const state = session.getState([]);
    expect(state.character).not.toBeNull();
    expect(state.character!.className).toBe('Bard');
  });
});

describe('Welcome message broadcast', () => {
  let grid: HexGrid;
  let content: ContentStore;
  let guildStore: GuildStore;
  let store: GameStateStore;

  beforeEach(() => {
    grid = createFakeGrid();
    content = createFakeContentStore();
    guildStore = createFakeGuildStore();
    store = createFakeStore();
  });

  it('broadcastWelcome sends a server chat message to all sessions with characters', async () => {
    const accounts = activeAccounts('alice', 'bob');
    const accountStore = createFakeAccountStore(accounts);
    const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

    pm.restoreFromSaveData([{
      username: 'bob',
      battleCount: 10,
      combatLog: [],
      unlockedKeys: ['tile-start'],
      position: { col: 0, row: 0 },
      target: null,
      movementQueue: [],
      character: { className: 'Knight', level: 5, xp: 1000 },
    }]);

    const aliceWs = createFakeWs();
    await pm.login(aliceWs, 'alice');

    const bobWs = createFakeWs();
    await pm.login(bobWs, 'bob');

    // Alice picks a class
    const aliceSession = pm.getSessionByUsername('alice')!;
    expect(aliceSession.isNewPlayer()).toBe(true);

    pm.broadcastWelcome('alice', 'Archer');

    // Bob should receive the welcome chat message
    const bobSendCalls = (bobWs.send as ReturnType<typeof vi.fn>).mock.calls;
    const welcomeMsg = bobSendCalls.find((call: unknown[]) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.type === 'chat_message' && parsed.message.text.includes('Welcome');
    });
    expect(welcomeMsg).toBeDefined();
    const parsed = JSON.parse(welcomeMsg![0] as string);
    expect(parsed.message.text).toContain('Archer');
    expect(parsed.message.text).toContain('alice');
  });

  it('characterless players do not receive broadcast messages', async () => {
    const accounts = activeAccounts('alice', 'bob');
    const accountStore = createFakeAccountStore(accounts);
    const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

    // Both alice and bob connect as new (no character)
    const aliceWs = createFakeWs();
    await pm.login(aliceWs, 'alice');
    const bobWs = createFakeWs();
    await pm.login(bobWs, 'bob');

    // Broadcast a server message — neither should receive it
    pm.broadcastServerMessage('Test message');

    const aliceCalls = (aliceWs.send as ReturnType<typeof vi.fn>).mock.calls;
    const aliceChat = aliceCalls.find((call: unknown[]) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.type === 'chat_message' && parsed.message.text === 'Test message';
    });
    expect(aliceChat).toBeUndefined();
  });

  it('banned player session is not restored — cannot receive welcome', async () => {
    const accounts: Record<string, Account> = {
      ...activeAccounts('bob'),
      'alice@test.com': {
        email: 'alice@test.com',
        username: 'alice',
        verified: true,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        deactivated: true,
      },
    };
    const accountStore = createFakeAccountStore(accounts);
    const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

    pm.restoreFromSaveData([
      {
        username: 'bob',
        battleCount: 10,
        combatLog: [],
        unlockedKeys: ['tile-start'],
        position: { col: 0, row: 0 },
        target: null,
        movementQueue: [],
        character: { className: 'Knight', level: 5, xp: 1000 },
      },
      {
        username: 'alice',
        battleCount: 0,
        combatLog: [],
        unlockedKeys: ['tile-start'],
        position: { col: 0, row: 0 },
        target: null,
        movementQueue: [],
        character: { className: 'Knight', level: 3, xp: 500 },
      },
    ]);

    // Alice banned — session should not exist
    expect(pm.getSessionByUsername('alice')).toBeUndefined();
    expect(pm.getSessionByUsername('bob')).toBeDefined();
  });

  it('admin forceSetClass does NOT trigger a welcome message', async () => {
    const accounts = activeAccounts('alice', 'bob');
    const accountStore = createFakeAccountStore(accounts);
    const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

    pm.restoreFromSaveData([{
      username: 'alice',
      battleCount: 50,
      combatLog: [],
      unlockedKeys: ['tile-start'],
      position: { col: 0, row: 0 },
      target: null,
      movementQueue: [],
      character: { className: 'Knight', level: 10, xp: 5000 },
    }]);

    const aliceWs = createFakeWs();
    await pm.login(aliceWs, 'alice');
    const bobWs = createFakeWs();
    await pm.login(bobWs, 'bob');

    const aliceSession = pm.getSessionByUsername('alice')!;
    aliceSession.forceSetClass('Mage');

    // isNewPlayer should be false (restored with real class)
    expect(aliceSession.isNewPlayer()).toBe(false);

    // No welcome message should have been sent to Bob
    const bobSendCalls = (bobWs.send as ReturnType<typeof vi.fn>).mock.calls;
    const welcomeMsg = bobSendCalls.find((call: unknown[]) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.type === 'chat_message' && parsed.message.text.includes('Welcome');
    });
    expect(welcomeMsg).toBeUndefined();
  });
});

describe('Characterless player exclusion', () => {
  let grid: HexGrid;
  let content: ContentStore;
  let guildStore: GuildStore;
  let store: GameStateStore;

  beforeEach(() => {
    grid = createFakeGrid();
    content = createFakeContentStore();
    guildStore = createFakeGuildStore();
    store = createFakeStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('new player has no party before choosing class', async () => {
    const accounts = activeAccounts('alice');
    const accountStore = createFakeAccountStore(accounts);
    const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

    const ws = createFakeWs();
    const session = await pm.login(ws, 'alice');

    expect(session.hasCharacter()).toBe(false);
    expect(session.getPartyId()).toBeNull();
  });

  it('new player does not appear in otherPlayers list', async () => {
    const accounts = activeAccounts('alice', 'bob');
    const accountStore = createFakeAccountStore(accounts);
    const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

    pm.restoreFromSaveData([{
      username: 'bob',
      battleCount: 10,
      combatLog: [],
      unlockedKeys: ['tile-start'],
      position: { col: 0, row: 0 },
      target: null,
      movementQueue: [],
      character: { className: 'Knight', level: 5, xp: 1000 },
    }]);

    const aliceWs = createFakeWs();
    await pm.login(aliceWs, 'alice');

    // Alice (characterless) should not appear in Bob's otherPlayers
    const others = pm.getOtherPlayers('bob');
    expect(others.find(p => p.username === 'alice')).toBeUndefined();
  });

  it('player gets party after choosing class', async () => {
    const accounts = activeAccounts('alice');
    const accountStore = createFakeAccountStore(accounts);
    const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

    const ws = createFakeWs();
    const session = await pm.login(ws, 'alice');
    expect(session.getPartyId()).toBeNull();

    // Choose class
    session.setClass('Knight');
    pm.ensureParty('alice');

    expect(session.getPartyId()).not.toBeNull();
  });

  it('characterless player does not accumulate battle count', async () => {
    const accounts = activeAccounts('alice');
    const accountStore = createFakeAccountStore(accounts);
    const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

    const ws = createFakeWs();
    const session = await pm.login(ws, 'alice');
    expect(session.hasCharacter()).toBe(false);

    // Let time pass — no battles should run because no party exists
    vi.advanceTimersByTime(10_000);
    expect(session.isNewPlayer()).toBe(true);
  });

  it('player participates in combat after choosing a class', async () => {
    const accounts = activeAccounts('alice');
    const accountStore = createFakeAccountStore(accounts);
    const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

    const ws = createFakeWs();
    const session = await pm.login(ws, 'alice');

    session.setClass('Knight');
    pm.ensureParty('alice');
    const partyId = session.getPartyId()!;
    pm.partyBattles.restartBattle(partyId);

    vi.advanceTimersByTime(10_000);
    expect(session.isNewPlayer()).toBe(false);
    expect(session.hasCharacter()).toBe(true);
  });
});
