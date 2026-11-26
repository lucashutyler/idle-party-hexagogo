import { vi } from 'vitest';
import { offsetToCube, xpForNextLevel } from '@idle-party-rpg/shared';
import type {
  DungeonDefinition,
  HenchmanDefinition,
  HexTile,
  MonsterDefinition,
  NpcDefinition,
  QuestDefinition,
  RoomEntryRequirements,
  TileTypeDefinition,
  UnlockSystem,
  WorldData,
  WorldTileDefinition,
  ZoneDefinition,
} from '@idle-party-rpg/shared';
import WebSocket from 'ws';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { WorldGrids } from '../src/game/WorldGrids.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';
import type { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';
import { fakeSkillContent } from './testGrids.js';

/**
 * Three invented maps. The dell is cut in two by a cliff, its halves joined by a door pair (west → east and back);
 * the east half and the burrow are joined by another pair; the burrow has a one-way drop into the pit.
 *
 *   dell:   w0 w1 w2 | x3 | e0 e1 e2        (nook sits below w1)
 *   burrow: b0 b1 b2
 *   pit:    p0 p1
 */
export const DELL = 'dell';
export const BURROW = 'burrow';
export const PIT = 'pit';

export const ROOM = {
  w0: 'r-w0', w1: 'r-w1', w2: 'r-w2', nook: 'r-nook', x3: 'r-x3',
  e0: 'r-e0', e1: 'r-e1', e2: 'r-e2',
  b0: 'r-b0', b1: 'r-b1', b2: 'r-b2',
  p0: 'r-p0', p1: 'r-p1',
} as const;
export type RoomKey = keyof typeof ROOM;

const PLACE: Record<RoomKey, { mapId: string; col: number; row: number }> = {
  w0: { mapId: DELL, col: 0, row: 0 },
  w1: { mapId: DELL, col: 1, row: 0 },
  w2: { mapId: DELL, col: 2, row: 0 },
  nook: { mapId: DELL, col: 1, row: 1 },
  x3: { mapId: DELL, col: 3, row: 0 },
  e0: { mapId: DELL, col: 4, row: 0 },
  e1: { mapId: DELL, col: 5, row: 0 },
  e2: { mapId: DELL, col: 6, row: 0 },
  b0: { mapId: BURROW, col: 0, row: 0 },
  b1: { mapId: BURROW, col: 1, row: 0 },
  b2: { mapId: BURROW, col: 2, row: 0 },
  p0: { mapId: PIT, col: 0, row: 0 },
  p1: { mapId: PIT, col: 1, row: 0 },
};

export const HIRE: HenchmanDefinition = {
  id: 'h_test_shield', name: 'Brin', className: 'Knight', level: 1, maxHp: 40, baseDamage: 3, skillIds: [], emoji: 'B',
};

export const VISIT_QUEST: QuestDefinition = {
  id: 'q_test_peek',
  name: 'Peek Below',
  description: 'A test quest.',
  scope: 'solo',
  objectives: [{ kind: 'visit', tileId: ROOM.b0 }],
  rewards: [],
};

export const DUNGEON: DungeonDefinition = {
  id: 'd_test_hole',
  name: 'Test Hole',
  floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [] }],
};

/** Fights that last until something ends them. */
export const STURDY: MonsterDefinition = {
  id: 'goblin', name: 'Sturdy Dummy', hp: 1_000_000, damage: 1, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0,
} as MonsterDefinition;
/** Fights the party loses at once. */
export const DEADLY: MonsterDefinition = {
  id: 'goblin', name: 'Deadly Dummy', hp: 1_000_000, damage: 1_000_000, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0,
} as MonsterDefinition;

const TILE_TYPES: Record<string, TileTypeDefinition> = {
  plains: { id: 'plains', name: 'Plains', icon: '', color: '#7ec850', traversable: true },
  cliff: { id: 'cliff', name: 'Cliff', icon: '', color: '#555555', traversable: false },
};

const ZONE: ZoneDefinition = { id: 'test_dale', displayName: 'Test Dale', encounterTable: [], levelRange: [1, 5] };

export interface TravelOptions {
  /** On the west → east door. */
  doorGate?: RoomEntryRequirements;
  /** On the east → west door. */
  backDoorGate?: RoomEntryRequirements;
  /** Where the test dungeon's entrance stands; w0 when unset. */
  dungeonAt?: RoomKey;
  /** Adds a second, shorter door w1 → e1 with this gate. */
  shortcutGate?: RoomEntryRequirements;
  /** More doors, each one way, after the usual ones. */
  extraDoors?: Partial<Record<RoomKey, RoomKey[]>>;
  gates?: Partial<Record<RoomKey, RoomEntryRequirements>>;
  walls?: RoomKey[];
  /** Without one every fight is won at once, so the party walks on after every fight. */
  monster?: MonsterDefinition;
  /** Besides the visit quest. */
  quests?: QuestDefinition[];
  /** Each NPC stands in the rooms given. */
  npcs?: { npc: NpcDefinition; rooms: RoomKey[] }[];
}

function makeWorld(opts: TravelOptions): WorldData {
  const links: Partial<Record<RoomKey, WorldTileDefinition['transitions']>> = {
    w1: opts.shortcutGate ? [{ mapId: DELL, tileId: ROOM.e1, entryRequirements: opts.shortcutGate }] : undefined,
    w2: [{ mapId: DELL, tileId: ROOM.e0, ...(opts.doorGate ? { entryRequirements: opts.doorGate } : {}) }],
    e0: [{ mapId: DELL, tileId: ROOM.w2, ...(opts.backDoorGate ? { entryRequirements: opts.backDoorGate } : {}) }],
    e2: [{ mapId: BURROW, tileId: ROOM.b0 }],
    b0: [{ mapId: DELL, tileId: ROOM.e2 }],
    b1: [{ mapId: PIT, tileId: ROOM.p0 }],
  };
  for (const [from, rooms] of Object.entries(opts.extraDoors ?? {}) as [RoomKey, RoomKey[]][]) {
    links[from] = [...(links[from] ?? []), ...rooms.map(to => ({ mapId: PLACE[to].mapId, tileId: ROOM[to] }))];
  }
  const tiles = (Object.keys(ROOM) as RoomKey[]).map((key): WorldTileDefinition => ({
    id: ROOM[key],
    ...PLACE[key],
    type: key === 'x3' || opts.walls?.includes(key) ? 'cliff' : 'plains',
    zone: ZONE.id,
    name: `Room ${key}`,
    ...(key === (opts.dungeonAt ?? 'w0') ? { dungeonId: DUNGEON.id } : {}),
    ...(links[key] ? { transitions: links[key] } : {}),
    ...(opts.gates?.[key] ? { entryRequirements: opts.gates[key] } : {}),
    ...npcIn(opts, key),
  }));
  return {
    startTile: { col: 0, row: 0 },
    defaultMapId: DELL,
    maps: [
      { id: DELL, name: 'Dell', startTile: { col: 0, row: 0 } },
      { id: BURROW, name: 'Burrow', startTile: { col: 0, row: 0 } },
      { id: PIT, name: 'Pit', startTile: { col: 0, row: 0 } },
    ],
    tiles,
  };
}

function npcIn(opts: TravelOptions, key: RoomKey): { npcId?: string } {
  const placed = opts.npcs?.find(entry => entry.rooms.includes(key));
  return placed ? { npcId: placed.npc.id } : {};
}

interface FakeContent {
  content: ContentStore;
  /** A content change, as a save makes it: the epoch moves before anything is rebuilt. */
  bump: () => void;
}

function fakeContent(world: WorldData, opts: TravelOptions): FakeContent {
  const monster = opts.monster;
  const quests: Record<string, QuestDefinition> = Object.fromEntries([VISIT_QUEST, ...(opts.quests ?? [])].map(q => [q.id, q]));
  const npcs: Record<string, NpcDefinition> = Object.fromEntries((opts.npcs ?? []).map(({ npc }) => [npc.id, npc]));
  const epoch = { value: 1 };
  const content = {
    get contentEpoch() { return epoch.value; },
    getStartTile: () => world.startTile,
    getWorld: () => world,
    getTileById: (id: string) => world.tiles.find(t => t.id === id),
    getTileType: (id: string) => TILE_TYPES[id],
    getAllTileTypes: () => TILE_TYPES,
    getMonster: () => monster,
    getItem: () => null,
    getAllItems: () => ({}),
    getAllMonsters: () => (monster ? { goblin: monster } : {}),
    getZone: () => ZONE,
    getAllZones: () => ({ [ZONE.id]: ZONE }),
    getAllEncounters: () => ({}),
    getAllShops: () => ({}),
    getShop: () => undefined,
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => npcs,
    getNpcQuestIds: () => [...new Set(Object.values(npcs).flatMap(npc => npc.questIds ?? []))],
    getQuestRevision: () => 0,
    getQuestCatalog: () => quests,
    getNpc: (id: string) => npcs[id],
    getAllQuests: () => quests,
    getQuest: (id: string) => quests[id],
    getDungeon: (id: string) => (id === DUNGEON.id ? DUNGEON : undefined),
    getAllDungeons: () => ({ [DUNGEON.id]: DUNGEON }),
    getHenchman: (id: string) => (id === HIRE.id ? HIRE : undefined),
    ...fakeSkillContent(),
  } as unknown as ContentStore;
  return { content, bump: () => { epoch.value++; } };
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

function fakeStore(saves: Record<string, PlayerSaveData> = {}): GameStateStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(async (username: string) => saves[username] ?? null),
    loadAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as GameStateStore;
}

function fakeWs(): WebSocket {
  return { readyState: 1, send: vi.fn(), close: vi.fn(), on: vi.fn(), bufferedAmount: 0 } as unknown as WebSocket;
}

export interface TravelWorld {
  pm: PlayerManager;
  world: WorldData;
  content: ContentStore;
  grids: WorldGrids;
  bump: () => void;
  sessions: Record<string, PlayerSession>;
  sockets: Record<string, WebSocket>;
  partyOf: (username: string) => string;
  roomOf: (username: string) => string | undefined;
  tile: (room: RoomKey) => HexTile;
  /** Mark rooms found for a player, on any map. */
  reveal: (username: string, ...rooms: RoomKey[]) => void;
  /** Hire the test fighter for a player's party on the map it stands on. */
  hire: (username: string) => void;
  hires: (username: string) => number;
  placeParty: (username: string, room: RoomKey) => void;
  timerOf: (username: string) => ServerBattleTimer;
  befriend: (a: string, b: string) => void;
  join: (inviter: string, joiner: string) => void;
  levelTo: (username: string, level: number) => void;
  logOf: (username: string) => string[];
  /** Rooms the party stood in at each fight start from now on. */
  watchFights: (username: string) => string[];
  /** A fresh manager over the same world, as after a restart. */
  restart: (usernames?: string[], saves?: Record<string, PlayerSaveData>) => PlayerManager;
}

/** Every named player is a Knight with a solo party in w0. */
export async function setupTravel(usernames: string[], opts: TravelOptions = {}): Promise<TravelWorld> {
  const world = makeWorld(opts);
  const { content, bump } = fakeContent(world, opts);
  const grids = new WorldGrids(content);
  const pm = new PlayerManager(grids, content, new GuildStore(), fakeAccounts(usernames), fakeStore());
  const sessions: Record<string, PlayerSession> = {};
  const sockets: Record<string, WebSocket> = {};
  for (const username of usernames) {
    sockets[username] = fakeWs();
    const session = await pm.login(sockets[username], username);
    session.setClass('Knight');
    pm.ensureParty(username);
    sessions[username] = session;
  }

  const partyOf = (username: string) => pm.getSessionByUsername(username)!.getPartyId()!;
  const tile = (room: RoomKey) => grids.getOrThrow(PLACE[room].mapId).getTile(offsetToCube(PLACE[room]))!;
  const entryOf = (username: string) =>
    (pm.partyBattles as unknown as { entries: Map<string, { battleTimer: ServerBattleTimer }> }).entries.get(partyOf(username))!;
  return {
    pm,
    world,
    content,
    grids,
    bump,
    sessions,
    sockets,
    partyOf,
    roomOf: (username) => pm.partyBattles.getTile(partyOf(username))?.id,
    tile,
    reveal: (username, ...rooms) => {
      const unlocks = (pm.getSessionByUsername(username) as unknown as { unlockSystem: UnlockSystem }).unlockSystem;
      for (const room of rooms) unlocks.forceUnlock(tile(room));
    },
    hire: (username) => {
      const hired = pm.hireHenchman(username, HIRE.id, pm.partyBattles.getMapId(partyOf(username))!);
      if (typeof hired === 'string') throw new Error(hired);
    },
    hires: (username) => pm.parties.getHenchmen(partyOf(username)).length,
    placeParty: (username, room) => {
      const partyId = partyOf(username);
      const mapId = PLACE[room].mapId;
      const moved = pm.partyBattles.getMapId(partyId) !== mapId;
      pm.partyBattles.relocateParty(partyId, tile(room), mapId);
      for (const member of pm.partyBattles.getMembers(partyId) ?? []) {
        const session = pm.getSessionByUsername(member)!;
        if (moved) session.switchMapGrid(tile(room));
        else session.forceUnlockTileArea(tile(room));
      }
    },
    timerOf: (username) => entryOf(username).battleTimer,
    befriend: (a, b) => {
      pm.friends.sendRequest(a, b);
      pm.friends.acceptRequest(b, a);
    },
    join: (inviter, joiner) => {
      const refused = pm.inviteToParty(inviter, joiner) ?? pm.acceptPartyInvite(joiner, partyOf(inviter));
      if (refused) throw new Error(refused);
    },
    levelTo: (username, level) => {
      const session = pm.getSessionByUsername(username)!;
      let xp = 0;
      for (let l = session.getLevel(); l < level; l++) xp += xpForNextLevel(l);
      session.grantXp(xp);
    },
    logOf: (username) => pm.getSessionByUsername(username)!.getState([]).combatLog.map(e => e.text),
    watchFights: (username) => {
      const rooms: string[] = [];
      const session = pm.getSessionByUsername(username)!;
      const original = session.incrementBattleCount.bind(session);
      vi.spyOn(session, 'incrementBattleCount').mockImplementation(() => {
        rooms.push(pm.partyBattles.getTile(partyOf(username))!.id);
        original();
      });
      return rooms;
    },
    restart: (names = usernames, saves = {}) => new PlayerManager(grids, content, new GuildStore(), fakeAccounts(names), fakeStore(saves)),
  };
}
