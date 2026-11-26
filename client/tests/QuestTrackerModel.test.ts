import { describe, expect, it } from 'vitest';
import type {
  MainStoryStep,
  NpcDefinition,
  QuestDefinition,
  QuestGuide,
  QuestProgressEntry,
  ServerStateMessage,
  WorldMapMeta,
} from '@idle-party-rpg/shared';
import { objectiveShortText, trackerLine, type TrackerLookups } from '../src/ui/QuestTrackerModel';
import type { NpcRoom } from '../src/ui/QuestLogModel';

const MAPS: WorldMapMeta[] = [
  { id: 'overworld', name: 'Overworld', startTile: { col: 0, row: 0 } },
  { id: 'cellar', name: 'Cellar', startTile: { col: 0, row: 0 } },
];

function quest(id: string, over: Partial<QuestDefinition> = {}): QuestDefinition {
  return {
    id,
    name: `Progress: Title ${id}`,
    description: '',
    scope: 'party_shared',
    objectives: [{ kind: 'kill', monsterId: 'm-rat', count: 15 }],
    rewards: [],
    ...over,
  };
}

function active(questId: string, status: QuestProgressEntry['status'], progress: number[]): QuestProgressEntry {
  return { questId, status, progress, acceptedAt: '2026-01-01T00:00:00.000Z' };
}

const step = (questId: string, over: Partial<MainStoryStep> = {}): MainStoryStep =>
  ({ questId, name: `Progress: Title ${questId}`, status: 'available', ...over });

function lookups(npcs: NpcDefinition[], rooms: Record<string, NpcRoom[]>, tiles: Record<string, NpcRoom> = {}): TrackerLookups {
  return {
    getAllNpcs: () => npcs,
    getNpc: (id) => npcs.find(n => n.id === id),
    getRoomsWithNpc: (id) => rooms[id] ?? [],
    getTileByGuid: (id) => tiles[id],
    getMaps: () => MAPS,
  };
}

type Parts = Partial<Pick<ServerStateMessage,
  'activeQuests' | 'questDefinitions' | 'questGuide' | 'offeredQuestIds' | 'availableQuestIds' | 'questGiverNpcId' | 'currentMapId' | 'unlocked'>>;

function state(parts: Parts): ServerStateMessage {
  return {
    currentMapId: 'overworld',
    unlocked: [],
    questResolutions: {
      monsters: { 'm-rat': 'Rat' },
      items: { 'i-pelt': 'Pelt' },
      tiles: { 'r-mill': { name: 'Mill', zoneName: 'Vale' }, 'r-deep': { name: 'Deep Hall', zoneName: 'Under' } },
    },
    ...parts,
  } as unknown as ServerStateMessage;
}

const guide = (steps: MainStoryStep[], mainQuestIds: string[]): QuestGuide => ({ steps, mainQuestIds });

const ORLA: NpcDefinition = { id: 'orla', name: 'Orla', emoji: '🧭', greeting: '', questIds: ['m1', 'm2', 'm-next'] };
const BRAM: NpcDefinition = { id: 'bram', name: 'Bram', emoji: '🪓', greeting: '', questIds: ['m1', 'm-far'] };
const TESS: NpcDefinition = { id: 'tess', name: 'Tess', emoji: '🧺', greeting: '', questIds: ['side'] };
const ROOMS: Record<string, NpcRoom[]> = {
  orla: [{ id: 'r-camp', mapId: 'overworld', name: 'Camp', zoneName: 'Vale' }],
  bram: [{ id: 'r-cave', mapId: 'cellar', name: 'Cave', zoneName: 'Under' }],
  tess: [{ id: 'r-stall', mapId: 'overworld', name: 'Stall', zoneName: 'Vale' }],
};
const TILES: Record<string, NpcRoom> = {
  'r-mill': { id: 'r-mill', mapId: 'overworld', name: 'Mill', zoneName: 'Vale' },
  'r-deep': { id: 'r-deep', mapId: 'cellar', name: 'Deep Hall', zoneName: 'Under' },
};
const LOOKUPS = lookups([ORLA, BRAM, TESS], ROOMS, TILES);

describe('trackerLine', () => {
  it('is null without a state or anything to say', () => {
    expect(trackerLine(null, LOOKUPS)).toBeNull();
    expect(trackerLine(state({}), LOOKUPS)).toBeNull();
  });

  it('puts a ready main quest first, handed to the NPC here when they take it', () => {
    const s = state({
      activeQuests: [active('m2', 'in_progress', [3]), active('m1', 'ready', [15])],
      questDefinitions: { m1: quest('m1'), m2: quest('m2') },
      questGuide: guide([step('m2', { status: 'active' }), step('m1', { status: 'active' })], ['m1', 'm2']),
      questGiverNpcId: 'orla',
    });
    expect(trackerLine(s, LOOKUPS)).toEqual({ kind: 'main', title: 'Title m1', detail: 'Turn in to Orla', action: { type: 'npc', npcId: 'orla' } });
  });

  it('sends a ready main quest to an explored turn-in room on this map, else to the log with the map', () => {
    const ready = {
      activeQuests: [active('m1', 'ready', [15])],
      questDefinitions: { m1: quest('m1') },
      questGuide: guide([step('m1', { status: 'active' })], ['m1']),
    };
    expect(trackerLine(state({ ...ready, unlocked: ['r-camp', 'r-cave'] }), LOOKUPS))
      .toEqual({ kind: 'main', title: 'Title m1', detail: 'Turn in to Orla', action: { type: 'room', roomId: 'r-camp' } });

    const onlyBram = lookups([BRAM], ROOMS, TILES);
    expect(trackerLine(state({ ...ready, unlocked: ['r-cave'] }), onlyBram))
      .toEqual({ kind: 'main', title: 'Title m1', detail: 'Turn in to Bram on the Cellar map', action: { type: 'log' } });
  });

  it('names the first unfinished objective of the first active main quest in guide order', () => {
    const s = state({
      activeQuests: [active('m2', 'in_progress', [9]), active('m1', 'in_progress', [15, 0])],
      questDefinitions: {
        m1: quest('m1', { objectives: [{ kind: 'kill', monsterId: 'm-rat', count: 15 }, { kind: 'collect', itemId: 'i-pelt', count: 1 }] }),
        m2: quest('m2'),
      },
      questGuide: guide([step('m1', { status: 'active' }), step('m2', { status: 'active' })], ['m1', 'm2']),
    });
    expect(trackerLine(s, LOOKUPS)).toEqual({ kind: 'main', title: 'Title m1', detail: 'Pelt 0/1', action: { type: 'log' } });
  });

  it('opens an explored visit room on this map, and names the map of one elsewhere', () => {
    const visit = (tileId: string, unlocked: string[] = ['r-mill', 'r-deep']) => state({
      activeQuests: [active('m1', 'accepted', [0])],
      questDefinitions: { m1: quest('m1', { objectives: [{ kind: 'visit', tileId }] }) },
      questGuide: guide([step('m1', { status: 'active' })], ['m1']),
      unlocked,
    });
    expect(trackerLine(visit('r-mill'), LOOKUPS)).toEqual({ kind: 'main', title: 'Title m1', detail: 'Visit Mill', action: { type: 'room', roomId: 'r-mill' } });
    expect(trackerLine(visit('r-deep'), LOOKUPS)).toEqual({ kind: 'main', title: 'Title m1', detail: 'Visit Deep Hall on the Cellar map', action: { type: 'log' } });
  });

  it('opens an explored visit room on another map the player can view, naming that map', () => {
    const visit = (unlocked: string[]) => state({
      activeQuests: [active('m1', 'accepted', [0])],
      questDefinitions: { m1: quest('m1', { objectives: [{ kind: 'visit', tileId: 'r-deep' }] }) },
      questGuide: guide([step('m1', { status: 'active' })], ['m1']),
      unlocked,
    });
    const viewing = { ...LOOKUPS, viewableMapIds: (ids: readonly string[]) => new Set(ids.includes('r-deep') ? ['overworld', 'cellar'] : ['overworld']) };
    expect(trackerLine(visit(['r-mill', 'r-deep']), viewing))
      .toEqual({ kind: 'main', title: 'Title m1', detail: 'Visit Deep Hall on the Cellar map', action: { type: 'room', roomId: 'r-deep' } });
    expect(trackerLine(visit(['r-mill']), viewing))
      .toEqual({ kind: 'main', title: 'Title m1', detail: 'Visit Deep Hall on the Cellar map', action: { type: 'log' } });
  });

  it('keeps an unexplored visit destination off the map, as the map itself does', () => {
    const s = state({
      activeQuests: [active('m1', 'accepted', [0])],
      questDefinitions: { m1: quest('m1', { objectives: [{ kind: 'visit', tileId: 'r-mill' }] }) },
      questGuide: guide([step('m1', { status: 'active' })], ['m1']),
      unlocked: [],
    });
    expect(trackerLine(s, LOOKUPS)).toEqual({ kind: 'main', title: 'Title m1', detail: 'Visit Mill', action: { type: 'log' } });
  });

  it('skips a main quest whose definition is missing', () => {
    const s = state({
      activeQuests: [active('gone', 'ready', [1]), active('m2', 'in_progress', [9])],
      questDefinitions: { m2: quest('m2') },
      questGuide: guide([step('gone', { status: 'active' }), step('m2', { status: 'active' })], ['gone', 'm2']),
    });
    expect(trackerLine(s, LOOKUPS)).toEqual({ kind: 'main', title: 'Title m2', detail: 'Rat 9/15', action: { type: 'log' } });
  });

  it('points an available step at its giver: here, then a room on this map, then the log', () => {
    const next = { questGuide: guide([step('m-next', { giverNpcIds: ['orla'] })], ['m-next']) };
    expect(trackerLine(state({ ...next, questGiverNpcId: 'orla' }), LOOKUPS))
      .toEqual({ kind: 'main', title: 'Title m-next', detail: 'Talk to Orla', action: { type: 'npc', npcId: 'orla' } });
    expect(trackerLine(state(next), LOOKUPS))
      .toEqual({ kind: 'main', title: 'Title m-next', detail: 'Talk to Orla', action: { type: 'room', roomId: 'r-camp' } });

    const far = { questGuide: guide([step('m-far', { giverNpcIds: ['bram'] })], []) };
    expect(trackerLine(state(far), LOOKUPS))
      .toEqual({ kind: 'main', title: 'Title m-far', detail: 'Talk to Bram on the Cellar map', action: { type: 'log' } });
  });

  it('asks for a level when the next step is level-locked', () => {
    const s = state({ questGuide: guide([step('m-next', { status: 'needs_level', requiredLevel: 8, giverNpcIds: ['orla'] })], []) });
    expect(trackerLine(s, LOOKUPS)).toEqual({ kind: 'main', title: 'Title m-next', detail: 'Reach level 8', action: { type: 'log' } });
  });

  it('prefers the active quest over the next step, and the next step over a quest offered here', () => {
    const base = {
      offeredQuestIds: ['side'],
      availableQuestIds: ['side', 'm-next'],
      questGiverNpcId: 'tess',
      questDefinitions: { m1: quest('m1') },
    };
    const both = state({ ...base, activeQuests: [active('m1', 'in_progress', [2])], questGuide: guide([step('m1', { status: 'active' }), step('m-next', { giverNpcIds: ['orla'] })], ['m1', 'm-next']) });
    expect(trackerLine(both, LOOKUPS)?.detail).toBe('Rat 2/15');
    const next = state({ ...base, questGuide: guide([step('m-next', { giverNpcIds: ['orla'] })], ['m-next']) });
    expect(trackerLine(next, LOOKUPS)?.detail).toBe('Talk to Orla');
  });

  it('with no main step, says when someone here has work, even for a fresh character', () => {
    const fresh = state({ offeredQuestIds: ['side'], availableQuestIds: ['side'], questGiverNpcId: 'tess', questGuide: guide([], []) });
    expect(trackerLine(fresh, LOOKUPS)).toEqual({ kind: 'here', title: 'Tess has work for you', detail: '', action: { type: 'npc', npcId: 'tess' } });

    const nothingNew = state({ offeredQuestIds: ['side'], availableQuestIds: [], questGiverNpcId: 'tess' });
    expect(trackerLine(nothingNew, LOOKUPS)).toBeNull();
  });

  it('works for an older server that sends no guide', () => {
    const s = state({
      activeQuests: [active('m1', 'ready', [15])],
      questDefinitions: { m1: quest('m1') },
      offeredQuestIds: ['side'],
      availableQuestIds: ['side'],
      questGiverNpcId: 'tess',
    });
    expect(trackerLine(s, LOOKUPS)?.kind).toBe('here');
  });
});

describe('objectiveShortText', () => {
  const s = state({});

  it('keeps kills, items and visits short', () => {
    expect(objectiveShortText({ kind: 'kill', monsterId: 'm-rat', count: 15 }, 9, s)).toBe('Rat 9/15');
    expect(objectiveShortText({ kind: 'kill', monsterId: 'm-rat', count: 15 }, 99, s)).toBe('Rat 15/15');
    expect(objectiveShortText({ kind: 'collect', itemId: 'i-pelt', count: 1 }, 0, s)).toBe('Pelt 0/1');
    expect(objectiveShortText({ kind: 'visit', tileId: 'r-mill' }, 0, s)).toBe('Visit Mill');
  });

  it('never shows an id', () => {
    expect(objectiveShortText({ kind: 'kill', monsterId: 'm-unknown', count: 2 }, 1, s)).toBe('Monster 1/2');
    expect(objectiveShortText({ kind: 'collect', itemId: 'i-unknown', count: 2 }, 1, s)).toBe('Item 1/2');
    expect(objectiveShortText({ kind: 'visit', tileId: 'r-unknown' }, 0, s)).toBe('Visit a room');
  });
});
