import { vi } from 'vitest';
import { offsetToCube, xpForNextLevel } from '@idle-party-rpg/shared';
import type { QuestDefinition, RoomEntryRequirements, TileTypeDefinition, WorldData, WorldTileDefinition, ZoneDefinition } from '@idle-party-rpg/shared';
import WebSocket from 'ws';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { WorldGrids } from '../src/game/WorldGrids.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';
import { fakeSkillContent } from './testGrids.js';

/**
 * A corridor on the main map, home → lane → bend → camp → ridge → summit, with no other way through,
 * and a one-room isle on a second map. Everyone starts at home; `placeParty` moves a party anywhere.
 */
export const MAIN_MAP = 'overworld';
export const ISLE_MAP = 'isle_map';
const ZONE_ID = 'test_vale';

export const ROOM = {
  home: 'room-home',
  lane: 'room-lane',
  bend: 'room-bend',
  camp: 'room-camp',
  ridge: 'room-ridge',
  summit: 'room-summit',
  isle: 'room-isle',
} as const;
export type RoomKey = keyof typeof ROOM;

const POS: Record<RoomKey, { col: number; row: number }> = {
  home: { col: 0, row: 2 },
  lane: { col: 1, row: 2 },
  bend: { col: 2, row: 2 },
  camp: { col: 3, row: 2 },
  ridge: { col: 4, row: 2 },
  summit: { col: 5, row: 2 },
  isle: { col: 0, row: 0 },
};

export const SEAL_QUEST: QuestDefinition = {
  id: 'q_test_seal',
  name: 'Break the Seal',
  description: 'A test quest.',
  scope: 'party_shared',
  objectives: [{ kind: 'visit', tileId: ROOM.home }],
  rewards: [],
};

const TILE_TYPES: Record<string, TileTypeDefinition> = {
  plains: { id: 'plains', name: 'Plains', icon: '', color: '#7ec850', traversable: true },
  cliff: { id: 'cliff', name: 'Cliff', icon: '', color: '#555555', traversable: false },
};

const ZONE: ZoneDefinition = { id: ZONE_ID, displayName: 'Test Vale', encounterTable: [], levelRange: [1, 5] };

export interface RouteWorldOptions {
  gates?: Partial<Record<RoomKey, RoomEntryRequirements>>;
  walls?: RoomKey[];
}

function makeWorld(opts: RouteWorldOptions): WorldData {
  const room = (key: RoomKey, name: string, mapId = MAIN_MAP): WorldTileDefinition => ({
    id: ROOM[key],
    mapId,
    ...POS[key],
    type: opts.walls?.includes(key) ? 'cliff' : 'plains',
    zone: ZONE_ID,
    name,
    ...(opts.gates?.[key] ? { entryRequirements: opts.gates[key] } : {}),
  });
  return {
    startTile: POS.home,
    defaultMapId: MAIN_MAP,
    maps: [
      { id: MAIN_MAP, name: 'Main', startTile: POS.home },
      { id: ISLE_MAP, name: 'Isle', startTile: POS.isle },
    ],
    tiles: [
      room('home', 'Home'),
      room('lane', 'Lane'),
      room('bend', 'Bend'),
      room('camp', 'Camp'),
      room('ridge', 'Ridge'),
      room('summit', 'Summit'),
      room('isle', 'Isle', ISLE_MAP),
    ],
  };
}

function fakeContent(world: WorldData): ContentStore {
  const quests = { [SEAL_QUEST.id]: SEAL_QUEST };
  return {
    getStartTile: () => world.startTile,
    getWorld: () => world,
    getTileById: (id: string) => world.tiles.find(t => t.id === id),
    getTileType: (id: string) => TILE_TYPES[id],
    getAllTileTypes: () => TILE_TYPES,
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: () => null,
    getAllItems: () => ({}),
    getAllMonsters: () => ({}),
    getZone: () => ZONE,
    getAllZones: () => ({ [ZONE_ID]: ZONE }),
    getAllEncounters: () => ({}),
    getAllShops: () => ({}),
    getShop: () => undefined,
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpcQuestIds: () => [],
    getQuestRevision: () => 0,
    getQuestCatalog: () => quests,
    getNpc: () => undefined,
    getAllQuests: () => quests,
    getQuest: (id: string) => quests[id as keyof typeof quests],
    getDungeon: () => undefined,
    getAllDungeons: () => ({}),
    getHenchman: () => undefined,
    ...fakeSkillContent(),
  } as unknown as ContentStore;
}

function fakeAccounts(usernames: string[]): AccountStore {
  const accounts: Record<string, Account> = {};
  for (const u of usernames) accounts[u] = { username: u, email: `${u}@example.test`, deactivated: false } as unknown as Account;
  return {
    findByUsername: (u: string) => accounts[u] ?? null,
    getAllUsernames: () => usernames,
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    setDeactivated: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
}

function fakeStore(): GameStateStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    loadAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as GameStateStore;
}

export function fakeWs(): WebSocket {
  return { readyState: 1, send: vi.fn(), close: vi.fn(), on: vi.fn(), bufferedAmount: 0 } as unknown as WebSocket;
}

export interface RouteWorld {
  pm: PlayerManager;
  content: ContentStore;
  grids: WorldGrids;
  sessions: Record<string, PlayerSession>;
  partyOf: (username: string) => string;
  /** Move a player's whole party to a room, re-seating its members' fog as a relocation does. */
  placeParty: (username: string, room: RoomKey) => void;
  roomOf: (username: string) => string | undefined;
  befriend: (a: string, b: string) => void;
  levelTo: (username: string, level: number) => void;
  logOf: (username: string) => string[];
  /** A fresh manager over the same world, as after a restart. */
  restart: (usernames?: string[]) => PlayerManager;
}

/** Every named player is a Knight with a solo party at home. */
export async function setupRouteWorld(usernames: string[], opts: RouteWorldOptions = {}): Promise<RouteWorld> {
  const world = makeWorld(opts);
  const content = fakeContent(world);
  const grids = new WorldGrids(content);
  const pm = new PlayerManager(grids, content, new GuildStore(), fakeAccounts(usernames), fakeStore());
  const sessions: Record<string, PlayerSession> = {};
  for (const username of usernames) {
    const session = await pm.login(fakeWs(), username);
    session.setClass('Knight');
    pm.ensureParty(username);
    sessions[username] = session;
  }

  const partyOf = (username: string) => pm.getSessionByUsername(username)!.getPartyId()!;
  return {
    pm,
    content,
    grids,
    sessions,
    partyOf,
    placeParty: (username, room) => {
      const mapId = room === 'isle' ? ISLE_MAP : MAIN_MAP;
      const tile = grids.getOrThrow(mapId).getTile(offsetToCube(POS[room]))!;
      const partyId = partyOf(username);
      const moved = pm.partyBattles.getMapId(partyId) !== mapId;
      pm.partyBattles.relocateParty(partyId, tile, mapId);
      for (const member of pm.partyBattles.getMembers(partyId) ?? []) {
        const session = pm.getSessionByUsername(member)!;
        if (moved) session.switchMapGrid(tile);
        else session.forceUnlockTileArea(tile);
      }
    },
    roomOf: (username) => pm.partyBattles.getTile(partyOf(username))?.id,
    befriend: (a, b) => {
      pm.friends.sendRequest(a, b);
      pm.friends.acceptRequest(b, a);
    },
    levelTo: (username, level) => {
      const session = pm.getSessionByUsername(username)!;
      let xp = 0;
      for (let l = session.getLevel(); l < level; l++) xp += xpForNextLevel(l);
      session.grantXp(xp);
    },
    logOf: (username) => pm.getSessionByUsername(username)!.getState([]).combatLog.map(e => e.text),
    restart: (names = usernames) => new PlayerManager(grids, content, new GuildStore(), fakeAccounts(names), fakeStore()),
  };
}

export function tileAt(grids: WorldGrids, room: RoomKey) {
  const mapId = room === 'isle' ? ISLE_MAP : MAIN_MAP;
  return grids.getOrThrow(mapId).getTile(offsetToCube(POS[room]))!;
}
