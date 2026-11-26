import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlayerManager } from '../src/game/PlayerManager.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';
import { WorldGrids } from '../src/game/WorldGrids.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import { offsetToCube } from '@idle-party-rpg/shared';
import type { NpcDefinition, QuestDefinition, WorldData, ZoneDefinition } from '@idle-party-rpg/shared';
import WebSocket from 'ws';
import { fakeSkillContent } from './testGrids.js';

const OVERWORLD_HUB = 'overworld-hub';
const SEWER_HUB = 'sewer-hub';
const SEWER_TUNNEL = 'sewer-tunnel';
const MYSTERY_ROOM = 'mystery-room';
const NOW = new Date('2026-10-09T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const SMITH: NpcDefinition = {
  id: 'npc_smith', name: 'Blacksmith', emoji: '🔨', greeting: 'Need steel?',
  questIds: ['q_open', 'q_followup', 'q_high', 'q_weekly', 'q_solo', 'q_missing'],
};
const FENCE: NpcDefinition = {
  id: 'npc_fence', name: 'Fence', emoji: '🕶️', greeting: 'Keep it quiet.',
  questIds: ['q_far', 'q_open', 'q_visit'],
};
const HERMIT: NpcDefinition = { id: 'npc_hermit', name: 'Hermit', emoji: '🧙', greeting: '...' };

function quest(id: string, over: Partial<QuestDefinition> = {}): QuestDefinition {
  return { id, name: id, description: '', scope: 'party_shared', objectives: [], rewards: [], ...over };
}

const QUESTS: Record<string, QuestDefinition> = {
  q_open: quest('q_open'),
  q_followup: quest('q_followup', { prerequisiteQuestIds: ['q_open'] }),
  q_high: quest('q_high', { requiredLevel: 10 }),
  q_weekly: quest('q_weekly', { repeat: 'weekly' }),
  q_solo: quest('q_solo', { scope: 'solo' }),
  q_far: quest('q_far'),
  q_visit: quest('q_visit', {
    objectives: [{ kind: 'visit', tileId: SEWER_TUNNEL }, { kind: 'visit', tileId: MYSTERY_ROOM }],
  }),
};

const ZONES: Record<string, ZoneDefinition> = {
  town: { id: 'town', displayName: 'Hatchetmill', encounterTable: [], levelRange: [1, 1] },
  sewer: { id: 'sewer', displayName: 'The Undercity', encounterTable: [], levelRange: [1, 1] },
};

function makeWorld(): WorldData {
  return {
    startTile: { col: 0, row: 0 },
    defaultMapId: 'overworld',
    maps: [
      { id: 'overworld', name: 'Overworld', startTile: { col: 0, row: 0 } },
      { id: 'sewers', name: 'Sewers', startTile: { col: 0, row: 0 } },
    ],
    tiles: [
      {
        id: OVERWORLD_HUB, mapId: 'overworld', col: 0, row: 0, type: 'town', zone: 'town',
        name: 'Town Square', npcId: SMITH.id, transitions: [{ mapId: 'sewers', tileId: SEWER_HUB }],
      },
      { id: 'overworld-road', mapId: 'overworld', col: 1, row: 0, type: 'plains', zone: 'town', name: 'Road' },
      { id: MYSTERY_ROOM, mapId: 'overworld', col: 2, row: 0, type: 'plains', zone: 'uncharted', name: 'Odd Clearing' },
      { id: SEWER_HUB, mapId: 'sewers', col: 0, row: 0, type: 'plains', zone: 'sewer', name: 'Sewer Junction', npcId: FENCE.id },
      { id: SEWER_TUNNEL, mapId: 'sewers', col: 1, row: 0, type: 'plains', zone: 'sewer', name: 'Sewer Tunnel', npcId: HERMIT.id },
    ],
  };
}

interface QuestContentEditor {
  replaceNpc(npc: NpcDefinition): void;
}

function createFakeContentStore(
  world: WorldData,
  quests: Record<string, QuestDefinition> = QUESTS,
  npcList: NpcDefinition[] = [SMITH, FENCE, HERMIT],
): ContentStore & QuestContentEditor {
  const npcs: Record<string, NpcDefinition> = Object.fromEntries(npcList.map(npc => [npc.id, npc]));
  let questRevision = 0;
  return {
    replaceNpc: (npc: NpcDefinition) => { npcs[npc.id] = npc; questRevision++; },
    getStartTile: () => world.startTile,
    getWorld: () => world,
    getTileType: () => undefined,
    getAllTileTypes: () => ({}),
    getTileById: (id: string) => world.tiles.find(t => t.id === id),
    getMonster: () => ({ id: 'goblin', name: 'Goblin', hp: 10, damage: 2, drops: [], damageType: 'physical' }),
    getItem: (id: string) => (id ? { id, name: id, value: 1 } : null),
    getAllMonsters: () => ({}),
    getAllItems: () => ({}),
    getZone: (id: string) => ZONES[id],
    getAllZones: () => ZONES,
    getAllEncounters: () => ({}),
    getAllShops: () => ({}),
    getShop: () => undefined,
    getHenchman: () => undefined,
    getAllHenchmen: () => ({}),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => npcs,
    getNpcQuestIds: () => [...new Set(Object.values(npcs).flatMap(n => n.questIds ?? []))],
    getQuestRevision: () => questRevision,
    getQuestCatalog() { return this.getAllQuests(); },
    getNpc: (id: string) => npcs[id],
    getAllQuests: () => quests,
    getQuest: (id: string) => quests[id],
    getDungeon: () => undefined,
    getAllDungeons: () => ({}),
    ...fakeSkillContent(),
  } as unknown as ContentStore & QuestContentEditor;
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

async function setup(quests?: Record<string, QuestDefinition>, npcs?: NpcDefinition[]) {
  const world = makeWorld();
  const content = createFakeContentStore(world, quests, npcs);
  const grids = new WorldGrids(content);
  const pm = new PlayerManager(grids, content, new GuildStore(), createFakeAccountStore(['alice', 'bob']), createFakeStore());
  const session = await pm.login(createFakeWs(), 'alice');
  session.setClass('Knight');
  pm.ensureParty('alice');
  return { pm, session, grids, content, partyId: session.getPartyId()! };
}

describe('Quest availability in the state push', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('lists quests any NPC offers, on any map, that the player can accept now', async () => {
    const { session } = await setup();

    expect(session.getState([]).availableQuestIds).toEqual(['q_far', 'q_open', 'q_solo', 'q_visit', 'q_weekly']);
  });

  it('excludes active, completed-once, under-level and prerequisite-missing quests', async () => {
    const { session } = await setup();
    session.quests.loadFromSaveData({
      active: [{ questId: 'q_far', status: 'accepted', progress: [], acceptedAt: NOW.toISOString() }],
      completed: [{ questId: 'q_visit', completedAt: NOW.toISOString() }],
      weeklyCompletions: {},
    });

    const available = session.getState([]).availableQuestIds;

    expect(available).not.toContain('q_far');
    expect(available).not.toContain('q_visit');
    expect(available).not.toContain('q_high');
    expect(available).not.toContain('q_followup');
  });

  it('hides a weekly quest during its cooldown and offers it again after a week', async () => {
    const { session } = await setup();
    const save = (daysAgo: number) => {
      const completedAt = new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
      session.quests.loadFromSaveData({
        active: [],
        completed: [{ questId: 'q_weekly', completedAt }],
        weeklyCompletions: { q_weekly: completedAt },
      });
    };

    save(2);
    expect(session.getState([]).availableQuestIds).not.toContain('q_weekly');

    save(8);
    expect(session.getState([]).availableQuestIds).toContain('q_weekly');
  });

  it('reuses the answer across pushes while nothing it depends on changes', async () => {
    const { session } = await setup();
    const first = session.getState([]).availableQuestIds;
    expect(session.getState([]).availableQuestIds).toBe(first);
  });

  it('recomputes once the player levels up', async () => {
    const { session } = await setup();
    expect(session.getState([]).availableQuestIds).not.toContain('q_high');
    session.grantXp(10_000_000);
    expect(session.getState([]).availableQuestIds).toContain('q_high');
  });

  it('recomputes when a weekly cooldown runs out, with nothing else changing', async () => {
    const { session } = await setup();
    const completedAt = new Date(NOW.getTime() - 2 * DAY_MS).toISOString();
    session.quests.loadFromSaveData({ active: [], completed: [{ questId: 'q_weekly', completedAt }], weeklyCompletions: { q_weekly: completedAt } });
    expect(session.getState([]).availableQuestIds).not.toContain('q_weekly');

    vi.setSystemTime(NOW.getTime() + 5 * DAY_MS - 1);
    expect(session.getState([]).availableQuestIds).not.toContain('q_weekly');
    vi.setSystemTime(NOW.getTime() + 5 * DAY_MS);
    expect(session.getState([]).availableQuestIds).toContain('q_weekly');
  });

  it('recomputes when the clock steps back before a cooldown that had ended', async () => {
    const { session } = await setup();
    const completedAt = new Date(NOW.getTime() - 7 * DAY_MS).toISOString();
    session.quests.loadFromSaveData({ active: [], completed: [{ questId: 'q_weekly', completedAt }], weeklyCompletions: { q_weekly: completedAt } });
    expect(session.getState([]).availableQuestIds).toContain('q_weekly');

    vi.setSystemTime(NOW.getTime() - 500);
    expect(session.getState([]).availableQuestIds).not.toContain('q_weekly');
  });

  it('recomputes when quest content changes', async () => {
    const { session, content } = await setup();
    expect(session.getState([]).availableQuestIds).toContain('q_far');
    content.replaceNpc({ ...FENCE, questIds: [] });
    expect(session.getState([]).availableQuestIds).not.toContain('q_far');
  });

  it('offers a follow-up once its prerequisite is turned in', async () => {
    const { session } = await setup();
    expect(session.getState([]).availableQuestIds).not.toContain('q_followup');

    expect(session.handleAcceptQuest('q_open', 1).success).toBe(true);
    expect(session.handleTurnInQuest('q_open').success).toBe(true);

    const available = session.getState([]).availableQuestIds;
    expect(available).toContain('q_followup');
    expect(available).not.toContain('q_open');
  });

  it('keeps a solo quest available while the player is in a multi-player party', async () => {
    const { pm } = await setup();
    const bob = await pm.login(createFakeWs(), 'bob');
    bob.setClass('Bard');
    pm.ensureParty('bob');
    const getPartyId = (u: string) => pm.getSessionByUsername(u)?.getPartyId() ?? null;
    const aliceParty = getPartyId('alice')!;
    const bobOldParty = getPartyId('bob');
    expect(pm.parties.inviteToParty('alice', 'bob', getPartyId, (a, b) => pm.invitePolicy(a, b))).toBe(true);
    const joined = pm.parties.acceptInvite('bob', aliceParty, getPartyId, (u, id) => pm.getSessionByUsername(u)?.setPartyId(id), (u, id) => pm.joinPolicy(u, id));
    expect(typeof joined).not.toBe('string');
    pm.handlePartyJoin('bob', aliceParty, bobOldParty);

    expect(pm.getPartySize('bob')).toBe(2);
    expect(bob.getState([]).availableQuestIds).toContain('q_solo');
  });

  it('sends no available quests before a class is chosen', async () => {
    const { pm } = await setup();
    const bob = await pm.login(createFakeWs(), 'bob');

    expect(bob.getState([]).availableQuestIds).toEqual([]);
  });

  it('names the NPC whose quests the current room offers', async () => {
    const { pm, session, grids, partyId } = await setup();
    expect(session.getState([]).questGiverNpcId).toBe(SMITH.id);

    pm.partyBattles.enterTransition(partyId, SEWER_HUB);
    expect(session.getState([]).questGiverNpcId).toBe(FENCE.id);

    pm.partyBattles.relocateParty(partyId, grids.get('overworld')!.getTile(offsetToCube({ col: 1, row: 0 }))!, 'overworld');
    expect(session.getState([]).questGiverNpcId).toBeUndefined();
  });

  it('resolves visit targets to a room name and zone name, without coordinates', async () => {
    const { pm, session, partyId } = await setup();
    pm.partyBattles.enterTransition(partyId, SEWER_HUB);

    const tiles = session.getState([]).questResolutions!.tiles;

    expect(tiles[SEWER_TUNNEL]).toEqual({ name: 'Sewer Tunnel', zoneName: 'The Undercity' });
    expect(tiles[MYSTERY_ROOM]).toEqual({ name: 'Odd Clearing', zoneName: 'uncharted' });
  });

  it('refuses a quest the current room does not offer, in room terms', async () => {
    const { session } = await setup();

    expect(session.handleAcceptQuest('q_far', 1)).toEqual({ success: false, error: "That quest isn't offered in this room." });
  });
});

const STORY: Record<string, QuestDefinition> = {
  p_first: quest('p_first', { name: 'Progress: First Steps' }),
  p_second: quest('p_second', { name: 'Progress: Second Steps', prerequisiteQuestIds: ['p_first'] }),
  p_high: quest('p_high', { name: 'Progress: Uphill', requiredLevel: 10 }),
  p_below: quest('p_below', { name: 'Progress: Down Below', objectives: [{ kind: 'visit', tileId: SEWER_HUB }] }),
};
const STORY_SMITH: NpcDefinition = { ...SMITH, questIds: ['p_first', 'p_second', 'p_high'] };
const STORY_FENCE: NpcDefinition = { ...FENCE, questIds: ['p_below'] };

function storySetup() {
  return setup(STORY, [STORY_SMITH, STORY_FENCE, HERMIT]);
}

const stepsOf = (session: PlayerSession) =>
  (session.getState([]).questGuide?.steps ?? []).map(s => `${s.questId}:${s.status}`);

describe('Main-story guide in the state push', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('lists the next steps, givers on this map first, and the main quests the player can take', async () => {
    const { session } = await storySetup();
    const guide = session.getState([]).questGuide!;

    expect(guide.steps).toEqual([
      { questId: 'p_first', name: 'Progress: First Steps', status: 'available', giverNpcIds: [SMITH.id] },
      { questId: 'p_below', name: 'Progress: Down Below', status: 'available', giverNpcIds: [FENCE.id] },
      { questId: 'p_high', name: 'Progress: Uphill', status: 'needs_level', requiredLevel: 10, giverNpcIds: [SMITH.id] },
    ]);
    expect(guide.mainQuestIds).toEqual(['p_below', 'p_first']);
  });

  it('reuses the guide across pushes while nothing it depends on changes', async () => {
    const { session } = await storySetup();
    const first = session.getState([]).questGuide;
    expect(session.getState([]).questGuide).toBe(first);
  });

  it('recomputes after an accept and a turn-in', async () => {
    const { session } = await storySetup();
    expect(session.handleAcceptQuest('p_first', 1).success).toBe(true);
    expect(stepsOf(session)).toEqual(['p_first:active', 'p_below:available', 'p_high:needs_level']);

    expect(session.handleTurnInQuest('p_first').success).toBe(true);
    expect(stepsOf(session)).toEqual(['p_second:available', 'p_below:available', 'p_high:needs_level']);
  });

  it('recomputes after a level-up', async () => {
    const { session } = await storySetup();
    session.grantXp(10_000_000);
    expect(stepsOf(session)).toEqual(['p_first:available', 'p_high:available', 'p_below:available']);
  });

  it('recomputes after a map change', async () => {
    const { pm, session, partyId } = await storySetup();
    pm.partyBattles.enterTransition(partyId, SEWER_HUB);
    expect(stepsOf(session)).toEqual(['p_below:available', 'p_first:available', 'p_high:needs_level']);
  });

  it('is absent before a class is chosen and empty when no quest is main', async () => {
    const { pm, session } = await setup();
    const bob = await pm.login(createFakeWs(), 'bob');
    expect(bob.getState([]).questGuide).toBeUndefined();
    expect(session.getState([]).questGuide).toEqual({ steps: [], mainQuestIds: [] });
  });
});

describe('Accepting a quest in the room it sends you to', () => {
  it('counts the visit at once, so the quest can be turned in straight away', async () => {
    const { pm, session, partyId } = await storySetup();
    pm.partyBattles.enterTransition(partyId, SEWER_HUB);

    expect(session.handleAcceptQuest('p_below', 1).success).toBe(true);
    const state = session.getState([]);
    expect(state.activeQuests).toEqual([expect.objectContaining({ questId: 'p_below', status: 'ready', progress: [1] })]);

    expect(session.handleTurnInQuest('p_below').success).toBe(true);
    expect(session.getState([]).completedQuests?.map(c => c.questId)).toEqual(['p_below']);
  });

  it('leaves the visit to do when the quest is taken elsewhere', async () => {
    const below: NpcDefinition = { ...STORY_SMITH, questIds: ['p_below'] };
    const { session } = await setup(STORY, [below, STORY_FENCE, HERMIT]);

    expect(session.handleAcceptQuest('p_below', 1).success).toBe(true);
    expect(session.getState([]).activeQuests).toEqual([expect.objectContaining({ questId: 'p_below', status: 'accepted', progress: [0] })]);
  });
});
