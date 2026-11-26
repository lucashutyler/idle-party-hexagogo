import { vi } from 'vitest';
import WebSocket from 'ws';
import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import type {
  DungeonDefinition,
  ItemDefinition,
  MonsterDefinition,
  QuestDefinition,
  RecipeDefinition,
  ShopDefinition,
} from '@idle-party-rpg/shared';
import { PlayerManager } from '../src/game/PlayerManager.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
import type { Account, AccountStore } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import { fakeSkillContent, fakeWorldMeta, wrapGrids } from './testGrids.js';

export interface ItemRulesContentParts {
  items?: Record<string, ItemDefinition>;
  quests?: Record<string, QuestDefinition>;
  monsters?: Record<string, MonsterDefinition>;
  shops?: Record<string, ShopDefinition>;
  recipes?: Record<string, RecipeDefinition>;
  dungeons?: Record<string, DungeonDefinition>;
  /** Quests some NPC offers; every quest when absent. */
  npcQuestIds?: string[];
}

/** A content store over plain records; bump `contentEpoch` after editing one. */
export function itemRulesContent(parts: ItemRulesContentParts = {}): ContentStore & { contentEpoch: number } {
  const items = parts.items ?? {};
  const quests = parts.quests ?? {};
  const monsters = parts.monsters ?? {};
  const shops = parts.shops ?? {};
  const recipes = parts.recipes ?? {};
  const dungeons = parts.dungeons ?? {};
  const npcQuestIds = parts.npcQuestIds ?? Object.keys(quests);
  return {
    contentEpoch: 1,
    getStartTile: () => ({ col: 0, row: 0 }),
    getWorld: () => ({ tiles: [], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getItem: (id: string) => items[id],
    getAllItems: () => items,
    getMonster: (id: string) => monsters[id],
    getAllMonsters: () => monsters,
    getZone: () => undefined,
    getAllZones: () => ({}),
    getAllEncounters: () => ({}),
    getTileById: () => undefined,
    getShop: (id: string) => shops[id],
    getAllShops: () => shops,
    getAllSets: () => ({}),
    getRecipe: (id: string) => recipes[id],
    getAllRecipes: () => recipes,
    getAllDungeons: () => dungeons,
    getNpc: () => undefined,
    getAllNpcs: () => ({}),
    getNpcQuestIds: () => npcQuestIds,
    getQuestRevision: () => 0,
    getQuest: (id: string) => quests[id],
    getAllQuests: () => quests,
    getQuestCatalog: () => quests,
    ...fakeSkillContent(),
  } as unknown as ContentStore & { contentEpoch: number };
}

function fakeAccounts(usernames: string[]): AccountStore {
  const accounts = Object.fromEntries(usernames.map(username => [username, { username } as Account]));
  return {
    findByUsername: (name: string) => accounts[name] ?? null,
    getAllUsernames: () => usernames,
    updateLastActive: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
}

function memoryPlayerStore(): GameStateStore {
  const saves = new Map<string, PlayerSaveData>();
  return {
    save: async (data: PlayerSaveData) => { saves.set(data.username, data); },
    saveAll: async (all: PlayerSaveData[]) => { for (const data of all) saves.set(data.username, data); },
    load: async (username: string) => saves.get(username) ?? null,
    loadAll: async () => [...saves.values()],
    delete: async (username: string) => { saves.delete(username); },
  };
}

export function fakeWs(): WebSocket {
  return { readyState: WebSocket.OPEN, send: vi.fn(), on: vi.fn(), close: vi.fn(), bufferedAmount: 0 } as unknown as WebSocket;
}

export function itemRulesManager(content: ContentStore, usernames: string[]): PlayerManager {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'town', 'start', 'tile-start'));
  return new PlayerManager(wrapGrids(grid), content, new GuildStore(), fakeAccounts(usernames), memoryPlayerStore());
}

/** Log a Knight in with the given bag. */
export async function enterAsKnight(pm: PlayerManager, username: string, inventory: Record<string, number> = {}): Promise<PlayerSession> {
  const session = await pm.login(fakeWs(), username);
  session.setClass('Knight');
  for (const [itemId, count] of Object.entries(inventory)) session.addToInventory(itemId, count);
  return session;
}
