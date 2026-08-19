import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { WorldGrids } from '../src/game/WorldGrids.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';
import type {
  ItemDefinition,
  QuestDefinition,
  RoomEntryFailure,
  TileTypeDefinition,
  WorldData,
  ZoneDefinition,
} from '@idle-party-rpg/shared';
import { xpForNextLevel } from '@idle-party-rpg/shared';
import WebSocket from 'ws';
import { fakeSkillContent } from './testGrids.js';

/**
 * One overworld map shaped so every gate can be probed in isolation:
 *
 *   - an eastward corridor  start → road-1 → vault → road-2 → ember
 *     (`vault` is item-gated the legacy way, `ember` the new way), and
 *   - four spokes hanging off the start room, each carrying one gate.
 *
 * Each spoke sits one step from `start`, so a move onto it queues a one-room
 * path — which keeps "destination is gated" cases apart from "a room mid-path
 * is gated" ones. The corridor is the only route east, so its path is fixed.
 */
const MAP_ID = 'overworld';
const ZONE_ID = 'briar_hollow';

const START_ID = 'room-start';
const ROAD_1_ID = 'room-road-1';
const VAULT_ID = 'room-vault';
const ROAD_2_ID = 'room-road-2';
const EMBER_ID = 'room-ember';
const SHRINE_ID = 'room-shrine';
const CLIFF_ID = 'room-cliff';
const LAVA_ID = 'room-lava';
const CALDERA_ID = 'room-caldera';

const POS: Record<string, { col: number; row: number }> = {
  [START_ID]: { col: 2, row: 2 },
  [ROAD_1_ID]: { col: 3, row: 2 },
  [VAULT_ID]: { col: 4, row: 2 },
  [ROAD_2_ID]: { col: 5, row: 2 },
  [EMBER_ID]: { col: 6, row: 2 },
  [SHRINE_ID]: { col: 2, row: 1 },
  [CLIFF_ID]: { col: 1, row: 2 },
  [LAVA_ID]: { col: 1, row: 1 },
  [CALDERA_ID]: { col: 2, row: 3 },
};

const LANTERN_QUEST: QuestDefinition = {
  id: 'q_lantern',
  name: 'Light the Lantern',
  description: 'Kindle the shrine lantern.',
  scope: 'party_shared',
  objectives: [{ kind: 'visit', tileId: START_ID }],
  rewards: [],
};
const QUESTS: Record<string, QuestDefinition> = { [LANTERN_QUEST.id]: LANTERN_QUEST };

const ITEMS: Record<string, ItemDefinition> = {
  silver_key: { id: 'silver_key', name: 'Silver Key', rarity: 'common', equipSlot: 'relic' },
  ember_charm: { id: 'ember_charm', name: 'Ember Charm', rarity: 'common', equipSlot: 'necklace' },
  lava_boots: { id: 'lava_boots', name: 'Lava Boots', rarity: 'common', equipSlot: 'foot' },
  ruby_boots: { id: 'ruby_boots', name: 'Ruby Boots', rarity: 'common', equipSlot: 'foot' },
};

/** The lava_field type gates every room of its type; plains gates nothing. */
const TILE_TYPES: Record<string, TileTypeDefinition> = {
  plains: { id: 'plains', name: 'Plains', icon: '', color: '#7ec850', traversable: true },
  lava_field: {
    id: 'lava_field',
    name: 'Lava Field',
    icon: '🔥',
    color: '#d44000',
    traversable: true,
    entryRequirements: { requiredItemId: 'lava_boots', minLevel: 3 },
  },
};

const ZONE: ZoneDefinition = { id: ZONE_ID, displayName: 'Briar Hollow', encounterTable: [], levelRange: [1, 5] };

function makeWorld(): WorldData {
  return {
    startTile: POS[START_ID],
    defaultMapId: MAP_ID,
    maps: [{ id: MAP_ID, name: 'Overworld', startTile: POS[START_ID] }],
    tiles: [
      { id: START_ID, mapId: MAP_ID, ...POS[START_ID], type: 'plains', zone: ZONE_ID, name: 'Crossroads' },
      { id: ROAD_1_ID, mapId: MAP_ID, ...POS[ROAD_1_ID], type: 'plains', zone: ZONE_ID, name: 'East Road' },
      // Legacy scalar gate — no entryRequirements object anywhere on this room.
      { id: VAULT_ID, mapId: MAP_ID, ...POS[VAULT_ID], type: 'plains', zone: ZONE_ID, name: 'Vault Door', requiredItemId: 'silver_key' },
      { id: ROAD_2_ID, mapId: MAP_ID, ...POS[ROAD_2_ID], type: 'plains', zone: ZONE_ID, name: 'Far Road' },
      { id: EMBER_ID, mapId: MAP_ID, ...POS[EMBER_ID], type: 'plains', zone: ZONE_ID, name: 'Ember Gate', entryRequirements: { requiredItemId: 'ember_charm' } },
      { id: SHRINE_ID, mapId: MAP_ID, ...POS[SHRINE_ID], type: 'plains', zone: ZONE_ID, name: 'Sealed Shrine', entryRequirements: { requiredQuestIds: [LANTERN_QUEST.id] } },
      { id: CLIFF_ID, mapId: MAP_ID, ...POS[CLIFF_ID], type: 'plains', zone: ZONE_ID, name: 'Cliff Path', entryRequirements: { minLevel: 5 } },
      // Ungated room of a gated type — inherits the type's gate wholesale.
      { id: LAVA_ID, mapId: MAP_ID, ...POS[LAVA_ID], type: 'lava_field', zone: ZONE_ID, name: 'Lava Flow' },
      // Same type, but overrides the item requirement while inheriting minLevel.
      { id: CALDERA_ID, mapId: MAP_ID, ...POS[CALDERA_ID], type: 'lava_field', zone: ZONE_ID, name: 'Caldera Rim', entryRequirements: { requiredItemId: 'ruby_boots' } },
    ],
  };
}

function createFakeContentStore(world: WorldData): ContentStore {
  return {
    getStartTile: () => world.startTile,
    getWorld: () => world,
    getTileById: (id: string) => world.tiles.find(t => t.id === id),
    getTileType: (id: string) => TILE_TYPES[id],
    getAllTileTypes: () => TILE_TYPES,
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: (id: string) => ITEMS[id] ?? null,
    getAllItems: () => ITEMS,
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
    getNpc: () => undefined,
    getAllQuests: () => QUESTS,
    getQuest: (id: string) => QUESTS[id],
    getDungeon: () => undefined,
    getAllDungeons: () => ({}),
    ...fakeSkillContent(),
  } as unknown as ContentStore;
}

function createFakeAccountStore(usernames: string[]): AccountStore {
  const accounts: Record<string, Account> = {};
  for (const u of usernames) accounts[u] = { username: u, email: `${u}@x.com`, deactivated: false } as unknown as Account;
  return {
    findByUsername: (u: string) => accounts[u] ?? null,
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
  } as unknown as GameStateStore;
}

function createFakeWs(): WebSocket {
  return { readyState: 1, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as WebSocket;
}

/** Spin up a manager with every named player as a Knight standing on the start room. */
async function setup(usernames: string[] = ['alice']): Promise<{
  pm: PlayerManager;
  sessions: Record<string, PlayerSession>;
  session: PlayerSession;
  partyId: string;
  world: WorldData;
  content: ContentStore;
  grids: WorldGrids;
}> {
  const world = makeWorld();
  const content = createFakeContentStore(world);
  const grids = new WorldGrids(content);
  const pm = new PlayerManager(grids, content, new GuildStore(), createFakeAccountStore(usernames), createFakeStore());

  const sessions: Record<string, PlayerSession> = {};
  for (const username of usernames) {
    const session = await pm.login(createFakeWs(), username);
    session.setClass('Knight');
    pm.ensureParty(username);
    sessions[username] = session;
  }

  const leader = sessions[usernames[0]];
  return { pm, sessions, session: leader, partyId: leader.getPartyId()!, world, content, grids };
}

/** Merge `joiner` into `leader`'s party the way the invite/accept flow does. */
function joinParty(pm: PlayerManager, leader: string, joiner: string): void {
  const getPartyId = (u: string) => pm.getSessionByUsername(u)?.getPartyId() ?? null;
  const setPartyId = (u: string, id: string | null) => { pm.getSessionByUsername(u)?.setPartyId(id); };
  const sameTile = (a: string, b: string) => pm.areSameTile(a, b);

  const partyId = getPartyId(leader)!;
  const oldPartyId = getPartyId(joiner);
  const invited = pm.parties.inviteToParty(leader, joiner, getPartyId, sameTile);
  if (invited !== true) throw new Error(invited);
  const accepted = pm.parties.acceptInvite(joiner, partyId, getPartyId, setPartyId, sameTile);
  if (typeof accepted === 'string') throw new Error(accepted);
  pm.handlePartyJoin(joiner, partyId, oldPartyId);
}

/** Order the party to walk to a room by ID. */
function moveTo(pm: PlayerManager, partyId: string, roomId: string): { success: true } | { success: false; blocked?: RoomEntryFailure } {
  const at = POS[roomId];
  return pm.partyBattles.handleMove(partyId, at.col, at.row);
}

/** Assert a move was refused by an entry gate and hand back the failure. */
function expectBlocked(result: { success: true } | { success: false; blocked?: RoomEntryFailure }): RoomEntryFailure {
  expect(result.success).toBe(false);
  if (result.success || !result.blocked) throw new Error('Expected the move to be blocked by an entry gate.');
  return result.blocked;
}

function equip(session: PlayerSession, itemId: string): void {
  session.addToInventory(itemId, 1);
  if (!session.handleEquipItem(itemId)) throw new Error(`Failed to equip ${itemId}`);
}

/** Grant exactly enough XP to sit on `target` with no leftover progress. */
function levelTo(session: PlayerSession, target: number): void {
  let xp = 0;
  for (let level = session.getLevel(); level < target; level++) xp += xpForNextLevel(level);
  session.grantXp(xp);
}

function pathIds(pm: PlayerManager, partyId: string): string[] {
  return pm.partyBattles.getPath(partyId).map(t => t.id);
}

function logTexts(session: PlayerSession): string[] {
  return session.getState([]).combatLog.map(e => e.text);
}

describe('Movement gating (PartyBattleManager via PlayerManager)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // ── Legacy item gate ────────────────────────────────────────

  it('still blocks a room gated only by the legacy requiredItemId field', async () => {
    const { pm, partyId } = await setup();

    const blocked = expectBlocked(moveTo(pm, partyId, VAULT_ID));
    expect(blocked.kind).toBe('item');
    expect(blocked.itemId).toBe('silver_key');
    expect(blocked.itemName).toBe('Silver Key'); // resolved through ContentStore, not the raw ID
    expect(blocked.missingPlayers).toEqual(['alice']);
    expect(blocked.reason).toContain('Silver Key');
  });

  it('allows the legacy-gated room once the item is equipped', async () => {
    const { pm, session, partyId } = await setup();
    equip(session, 'silver_key');

    expect(moveTo(pm, partyId, VAULT_ID)).toEqual({ success: true });
    expect(pathIds(pm, partyId)).toEqual([ROAD_1_ID, VAULT_ID]);
  });

  // ── Quest gate ──────────────────────────────────────────────

  it('blocks a quest-gated room until the quest has been turned in', async () => {
    const { pm, session, partyId } = await setup();

    const blocked = expectBlocked(moveTo(pm, partyId, SHRINE_ID));
    expect(blocked.kind).toBe('quest');
    expect(blocked.questId).toBe(LANTERN_QUEST.id);
    expect(blocked.questName).toBe('Light the Lantern');
    expect(blocked.missingPlayers).toEqual(['alice']);

    // Accepting is not enough — only a completed (turned-in) quest opens the room.
    session.quests.accept(LANTERN_QUEST, { playerLevel: session.getLevel(), partySize: 1 });
    expect(moveTo(pm, partyId, SHRINE_ID).success).toBe(false);

    session.quests.applyVisit(START_ID, QUESTS);
    session.quests.turnIn(LANTERN_QUEST.id, QUESTS, () => true, () => 0);
    expect(session.quests.getCompletedQuestIds().has(LANTERN_QUEST.id)).toBe(true);
    expect(moveTo(pm, partyId, SHRINE_ID)).toEqual({ success: true });
  });

  // ── Level gate ──────────────────────────────────────────────

  it('blocks a level-gated room below the minimum and opens it at exactly the minimum', async () => {
    const { pm, session, partyId } = await setup();
    expect(session.getLevel()).toBe(1);

    const blocked = expectBlocked(moveTo(pm, partyId, CLIFF_ID));
    expect(blocked.kind).toBe('level');
    expect(blocked.minLevel).toBe(5);
    expect(blocked.missingPlayers).toEqual(['alice']);
    expect(blocked.reason).toContain('Level 5');

    levelTo(session, 5);
    expect(session.getLevel()).toBe(5); // exactly the boundary, not past it
    expect(moveTo(pm, partyId, CLIFF_ID)).toEqual({ success: true });
  });

  // ── Multi-member parties ────────────────────────────────────

  it('names only the members who fail the gate', async () => {
    const { pm, sessions, partyId } = await setup(['alice', 'bob']);
    joinParty(pm, 'alice', 'bob');
    equip(sessions.alice, 'silver_key');

    const blocked = expectBlocked(moveTo(pm, partyId, VAULT_ID));
    expect(blocked.missingPlayers).toEqual(['bob']);
  });

  it('names every member when the whole party fails the gate', async () => {
    const { pm, partyId } = await setup(['alice', 'bob']);
    joinParty(pm, 'alice', 'bob');

    const blocked = expectBlocked(moveTo(pm, partyId, VAULT_ID));
    expect(blocked.missingPlayers).toEqual(['alice', 'bob']);
  });

  // ── Tile-type gates ─────────────────────────────────────────

  it('applies the tile type default gate to an otherwise ungated room', async () => {
    const { pm, partyId } = await setup();

    const blocked = expectBlocked(moveTo(pm, partyId, LAVA_ID));
    expect(blocked.kind).toBe('item');
    expect(blocked.itemId).toBe('lava_boots');
    expect(blocked.itemName).toBe('Lava Boots');
  });

  it('lets a room override the tile type gate field by field', async () => {
    const { pm, session, partyId } = await setup();

    // The room's own item wins over the type's item.
    const itemFailure = expectBlocked(moveTo(pm, partyId, CALDERA_ID));
    expect(itemFailure.kind).toBe('item');
    expect(itemFailure.itemId).toBe('ruby_boots');

    // ...but the type's minLevel is still inherited, because the room never set one.
    equip(session, 'ruby_boots');
    const levelFailure = expectBlocked(moveTo(pm, partyId, CALDERA_ID));
    expect(levelFailure.kind).toBe('level');
    expect(levelFailure.minLevel).toBe(3);

    levelTo(session, 3);
    expect(moveTo(pm, partyId, CALDERA_ID)).toEqual({ success: true });
  });

  // ── Whole-path validation ───────────────────────────────────

  it('blocks the whole move when a room in the middle of the path is gated', async () => {
    const { pm, partyId } = await setup();

    // road-2 is ungated, but the only route to it runs through the gated vault.
    const blocked = expectBlocked(moveTo(pm, partyId, ROAD_2_ID));
    expect(blocked.itemId).toBe('silver_key');
    expect(pathIds(pm, partyId)).toEqual([]);
    expect(pm.partyBattles.getTile(partyId)!.id).toBe(START_ID);
  });

  it('keeps the previously queued path when a move is refused', async () => {
    const { pm, partyId } = await setup();

    expect(moveTo(pm, partyId, ROAD_1_ID)).toEqual({ success: true });
    expect(pathIds(pm, partyId)).toEqual([ROAD_1_ID]);

    // The refused destination must not strand the party with an empty queue.
    expectBlocked(moveTo(pm, partyId, ROAD_2_ID));
    expect(pathIds(pm, partyId)).toEqual([ROAD_1_ID]);
  });

  // ── Gates are checked when the move is requested ────────────

  /**
   * The path is validated up front, so a party can only be *inside* a room it
   * fails once the world changes underneath it — which the relocation sweep
   * handles (see "relocates a party out of a room that became gated"). While
   * merely walking, winning a battle never re-opens the question.
   */
  it('does not re-check the gate every battle cycle once the path is approved', async () => {
    const { pm, sessions, partyId } = await setup();
    equip(sessions.alice, 'silver_key');
    expect(moveTo(pm, partyId, ROAD_2_ID)).toEqual({ success: true });

    // Several full battle → victory → move cycles.
    vi.advanceTimersByTime(20000);

    // The approved path ran to completion straight through the gated room.
    expect(pm.partyBattles.getTile(partyId)!.id).toBe(ROAD_2_ID);
    expect(pathIds(pm, partyId)).toEqual([]);
  });

  // ── Recovery when the world changes underneath a party ──────

  it('relocates a party out of a room that became gated, and says why', async () => {
    const { pm, session, partyId, world, content, grids } = await setup();

    // Walk to an ungated room and settle there.
    expect(moveTo(pm, partyId, ROAD_1_ID)).toEqual({ success: true });
    vi.advanceTimersByTime(20000);
    expect(pm.partyBattles.getTile(partyId)!.id).toBe(ROAD_1_ID);

    // Content changes: the room the party is standing in is now gated.
    world.tiles.find(t => t.id === ROAD_1_ID)!.entryRequirements = { minLevel: 25 };
    grids.rebuild();
    pm.partyBattles.refreshAllPartyTiles(grids);
    const relocated = pm.relocateDisplacedParties(grids, content);

    expect(relocated).toBe(1);
    expect(pm.partyBattles.getTile(partyId)!.id).toBe(START_ID);
    const moved = logTexts(session).filter(t => t.includes('starting room'));
    expect(moved.length).toBeGreaterThan(0);
    expect(moved[moved.length - 1]).toContain('Level 25');
  });

  it('leaves a party alone when the room it is standing in is still allowed', async () => {
    const { pm, partyId, world, content, grids } = await setup();

    expect(moveTo(pm, partyId, ROAD_1_ID)).toEqual({ success: true });
    vi.advanceTimersByTime(20000);

    // A gate the party already satisfies must not uproot them.
    world.tiles.find(t => t.id === ROAD_1_ID)!.entryRequirements = { minLevel: 1 };
    grids.rebuild();
    pm.partyBattles.refreshAllPartyTiles(grids);

    expect(pm.relocateDisplacedParties(grids, content)).toBe(0);
    expect(pm.partyBattles.getTile(partyId)!.id).toBe(ROAD_1_ID);
  });

  // ── Equipment locking ───────────────────────────────────────

  it('locks items required by the queued path, including entryRequirements-authored ones', async () => {
    const { pm, session, partyId } = await setup();
    equip(session, 'silver_key');
    equip(session, 'ember_charm');

    expect(moveTo(pm, partyId, EMBER_ID)).toEqual({ success: true });

    const locked = session.getLockedItemIds();
    expect(locked).toContain('ember_charm'); // authored via entryRequirements.requiredItemId
    expect(locked).toContain('silver_key');  // authored via the legacy scalar field
    // A locked item cannot be taken off while the party still needs it.
    expect(session.handleUnequipItem('necklace')).toEqual({ success: false, lockedByTile: true });
  });
});
