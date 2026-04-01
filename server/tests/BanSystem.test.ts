import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import type { ContentStore } from '../src/game/ContentStore.js';

// --- Minimal fakes ---

function createFakeGrid(): HexGrid {
  const grid = new HexGrid();
  // Add a start tile and a second tile
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

function createFakeStore(): GameStateStore & { saved: PlayerSaveData[] } {
  const saved: PlayerSaveData[] = [];
  return {
    saved,
    save: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn(async (data: PlayerSaveData[]) => { saved.push(...data); }),
    load: vi.fn().mockResolvedValue(null),
    loadAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function createFakeGuildStore(): GuildStore {
  return new GuildStore();
}

// --- Tests ---

describe('Ban System', () => {
  let grid: HexGrid;
  let content: ContentStore;
  let guildStore: GuildStore;

  beforeEach(() => {
    grid = createFakeGrid();
    content = createFakeContentStore();
    guildStore = createFakeGuildStore();
  });

  describe('restoreFromSaveData', () => {
    it('skips deactivated (banned) accounts during restore', () => {
      const accounts: Record<string, Account> = {
        'alice@test.com': {
          email: 'alice@test.com',
          username: 'alice',
          verified: true,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          deactivated: true,
        },
        'bob@test.com': {
          email: 'bob@test.com',
          username: 'bob',
          verified: true,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      };

      const accountStore = createFakeAccountStore(accounts);
      const store = createFakeStore();
      const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

      const saves: PlayerSaveData[] = [
        {
          username: 'alice',
          battleCount: 50,
          combatLog: [],
          unlockedKeys: ['tile-start'],
          position: { col: 0, row: 0 },
          target: null,
          movementQueue: [],
          character: { className: 'Knight', level: 10, xp: 5000 },
        },
        {
          username: 'bob',
          battleCount: 30,
          combatLog: [],
          unlockedKeys: ['tile-start'],
          position: { col: 0, row: 0 },
          target: null,
          movementQueue: [],
          character: { className: 'Archer', level: 5, xp: 1000 },
        },
      ];

      pm.restoreFromSaveData(saves);

      // Bob should be restored, Alice should not
      expect(pm.getSessionByUsername('bob')).toBeDefined();
      expect(pm.getSessionByUsername('alice')).toBeUndefined();
      expect(pm.sessionCount).toBe(1);
    });

    it('does not include deactivated accounts in otherPlayers', () => {
      const accounts: Record<string, Account> = {
        'alice@test.com': {
          email: 'alice@test.com',
          username: 'alice',
          verified: true,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          deactivated: true,
        },
        'bob@test.com': {
          email: 'bob@test.com',
          username: 'bob',
          verified: true,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      };

      const accountStore = createFakeAccountStore(accounts);
      const store = createFakeStore();
      const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

      const saves: PlayerSaveData[] = [
        {
          username: 'bob',
          battleCount: 30,
          combatLog: [],
          unlockedKeys: ['tile-start'],
          position: { col: 0, row: 0 },
          target: null,
          movementQueue: [],
          character: { className: 'Archer', level: 5, xp: 1000 },
        },
      ];

      pm.restoreFromSaveData(saves);

      const others = pm.getOtherPlayers('bob');
      expect(others).toHaveLength(0);
      // Alice is banned so should not appear
      expect(others.find(p => p.username === 'alice')).toBeUndefined();
    });
  });

  describe('restoreFromSaveData after unban', () => {
    it('restores an unbanned player normally — keeps position and party across server restarts', () => {
      // Alice was previously banned but has since been reactivated
      const accounts: Record<string, Account> = {
        'alice@test.com': {
          email: 'alice@test.com',
          username: 'alice',
          verified: true,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          deactivated: false, // explicitly unbanned
        },
        'bob@test.com': {
          email: 'bob@test.com',
          username: 'bob',
          verified: true,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      };

      const accountStore = createFakeAccountStore(accounts);
      const store = createFakeStore();
      const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

      // Simulate save data from after Alice was unbanned and played —
      // she's at a non-start position (col:1, row:0) in a party with Bob
      const partyId = 'party-abc';
      const saves: PlayerSaveData[] = [
        {
          username: 'alice',
          battleCount: 60,
          combatLog: [],
          unlockedKeys: ['tile-start', 'tile-other'],
          position: { col: 1, row: 0 },
          target: null,
          movementQueue: [],
          character: { className: 'Knight', level: 12, xp: 8000 },
          partyId,
          partyRole: 'member',
          partyGridPosition: 1,
        },
        {
          username: 'bob',
          battleCount: 40,
          combatLog: [],
          unlockedKeys: ['tile-start', 'tile-other'],
          position: { col: 1, row: 0 },
          target: null,
          movementQueue: [],
          character: { className: 'Archer', level: 8, xp: 3000 },
          partyId,
          partyRole: 'owner',
          partyGridPosition: 4,
        },
      ];

      pm.restoreFromSaveData(saves);

      // Both should be restored
      const aliceSession = pm.getSessionByUsername('alice');
      const bobSession = pm.getSessionByUsername('bob');
      expect(aliceSession).toBeDefined();
      expect(bobSession).toBeDefined();
      expect(pm.sessionCount).toBe(2);

      // Alice should be at her saved position (col:1, row:0), NOT the start tile
      const alicePos = aliceSession!.getPosition();
      expect(alicePos.col).toBe(1);
      expect(alicePos.row).toBe(0);

      // Alice's character data should be preserved
      expect(aliceSession!.getLevel()).toBe(12);
      expect(aliceSession!.getClassName()).toBe('Knight');

      // Both should be in the same party
      expect(aliceSession!.getPartyId()).toBe(bobSession!.getPartyId());
    });

    it('does not reset an unbanned player on a second server restart', () => {
      // Simulate: Alice was banned, unbanned, played, server restarted once
      // (first restart restored her fine), then server restarts AGAIN.
      // She should still be at her position, not reset to start.
      const accounts: Record<string, Account> = {
        'alice@test.com': {
          email: 'alice@test.com',
          username: 'alice',
          verified: true,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          deactivated: false,
        },
      };

      const accountStore = createFakeAccountStore(accounts);
      const store = createFakeStore();

      // First restart — restore Alice at non-start position
      const pm1 = new PlayerManager(grid, content, guildStore, accountStore, store);
      pm1.restoreFromSaveData([{
        username: 'alice',
        battleCount: 70,
        combatLog: [],
        unlockedKeys: ['tile-start', 'tile-other'],
        position: { col: 1, row: 0 },
        target: null,
        movementQueue: [],
        character: { className: 'Knight', level: 15, xp: 20000 },
      }]);

      const session1 = pm1.getSessionByUsername('alice')!;
      expect(session1.getPosition()).toEqual({ col: 1, row: 0 });
      expect(session1.getLevel()).toBe(15);

      // Collect save data as if the server is shutting down
      const saveData = pm1.getAllSaveData();
      expect(saveData).toHaveLength(1);
      expect(saveData[0].position).toEqual({ col: 1, row: 0 });

      // Second restart — restore from the save data produced above
      const pm2 = new PlayerManager(grid, content, guildStore, accountStore, store);
      pm2.restoreFromSaveData(saveData);

      const session2 = pm2.getSessionByUsername('alice')!;
      expect(session2).toBeDefined();
      // Position should still be (1,0), NOT reset to start (0,0)
      expect(session2.getPosition()).toEqual({ col: 1, row: 0 });
      expect(session2.getLevel()).toBe(15);
      expect(session2.getClassName()).toBe('Knight');
    });
  });

  describe('banPlayer', () => {
    it('removes session and saves state on ban', async () => {
      const accounts: Record<string, Account> = {
        'alice@test.com': {
          email: 'alice@test.com',
          username: 'alice',
          verified: true,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      };

      const accountStore = createFakeAccountStore(accounts);
      const store = createFakeStore();
      const pm = new PlayerManager(grid, content, guildStore, accountStore, store);

      // Restore alice's session
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

      expect(pm.getSessionByUsername('alice')).toBeDefined();
      expect(pm.sessionCount).toBe(1);

      // Ban alice
      await pm.banPlayer('alice');

      // Session should be removed
      expect(pm.getSessionByUsername('alice')).toBeUndefined();
      expect(pm.sessionCount).toBe(0);

      // State should have been saved
      expect(store.saved.length).toBe(1);
      expect(store.saved[0].username).toBe('alice');
    });
  });
});
