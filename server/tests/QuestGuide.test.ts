import { describe, it, expect } from 'vitest';
import type { NpcDefinition, QuestDefinition } from '@idle-party-rpg/shared';
import {
  MAIN_STORY_UPCOMING_STEPS,
  buildQuestGivers,
  buildQuestGuide,
  mainStorySteps,
  questGivers,
  type MainStoryInput,
} from '../src/game/QuestGuide.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function quest(id: string, over: Partial<QuestDefinition> = {}): QuestDefinition {
  return { id, name: id, description: '', scope: 'party_shared', objectives: [], rewards: [], ...over };
}

function main(id: string, over: Partial<QuestDefinition> = {}): QuestDefinition {
  return quest(id, { name: `Progress: ${id}`, ...over });
}

function catalogOf(...quests: QuestDefinition[]): Record<string, QuestDefinition> {
  return Object.fromEntries(quests.map(q => [q.id, q]));
}

/** Each quest is offered by its own NPC on the home map unless `givers` says otherwise. */
function input(catalog: Record<string, QuestDefinition>, over: Partial<MainStoryInput> = {}): MainStoryInput {
  const givers = new Map(Object.keys(catalog).map(id => [id, { npcIds: [`npc-${id}`], mapIds: new Set(['map-home']) }]));
  return {
    catalog,
    completedIds: new Set(),
    activeIds: new Set(),
    level: 1,
    weeklyCompletions: {},
    now: NOW,
    givers,
    currentMapId: 'map-home',
    ...over,
  };
}

const ids = (steps: { questId: string }[]) => steps.map(s => s.questId);

describe('mainStorySteps', () => {
  it('gives one available step for a linear chain', () => {
    const catalog = catalogOf(
      main('m1'),
      main('m2', { prerequisiteQuestIds: ['m1'] }),
      main('m3', { prerequisiteQuestIds: ['m2'] }),
    );
    expect(mainStorySteps(input(catalog))).toEqual([
      { questId: 'm1', name: 'Progress: m1', status: 'available', giverNpcIds: ['npc-m1'] },
    ]);
    expect(ids(mainStorySteps(input(catalog, { completedIds: new Set(['m1']) })))).toEqual(['m2']);
  });

  it('lists an active main quest as active, ahead of what comes after it', () => {
    const catalog = catalogOf(main('m1'), main('m2', { prerequisiteQuestIds: ['m1'] }), main('other'));
    const steps = mainStorySteps(input(catalog, { activeIds: new Set(['m1']) }));
    expect(steps.map(s => [s.questId, s.status])).toEqual([['m1', 'active'], ['other', 'available']]);
  });

  it('surfaces a side quest the main story waits on, naming the main quest it leads to', () => {
    const catalog = catalogOf(
      quest('side-a'),
      quest('side-b', { prerequisiteQuestIds: ['side-a'] }),
      main('m1', { prerequisiteQuestIds: ['side-b'] }),
    );
    expect(mainStorySteps(input(catalog))).toEqual([
      { questId: 'side-a', name: 'side-a', status: 'available', leadsTo: 'Progress: m1', giverNpcIds: ['npc-side-a'] },
    ]);
  });

  it('names the nearest main quest a side quest unblocks', () => {
    const catalog = catalogOf(
      quest('side'),
      main('near', { prerequisiteQuestIds: ['side'] }),
      main('far', { prerequisiteQuestIds: ['near'] }),
    );
    expect(mainStorySteps(input(catalog))[0].leadsTo).toBe('Progress: near');
  });

  it('marks a level-locked opener needs_level with its level', () => {
    const catalog = catalogOf(main('opener', { requiredLevel: 12 }));
    expect(mainStorySteps(input(catalog, { level: 5 }))).toEqual([
      { questId: 'opener', name: 'Progress: opener', status: 'needs_level', requiredLevel: 12, giverNpcIds: ['npc-opener'] },
    ]);
    expect(mainStorySteps(input(catalog, { level: 12 }))[0].status).toBe('available');
  });

  it('leaves out completed, weekly and side quests nothing main waits on', () => {
    const catalog = catalogOf(
      main('done'),
      main('weekly', { repeat: 'weekly' }),
      quest('side'),
      main('next', { prerequisiteQuestIds: ['done'] }),
    );
    expect(ids(mainStorySteps(input(catalog, { completedIds: new Set(['done']) })))).toEqual(['next']);
  });

  it('drops a step whose prerequisite is open or whose weekly cooldown runs', () => {
    const catalog = catalogOf(
      quest('weekly-side', { repeat: 'weekly' }),
      main('m1', { prerequisiteQuestIds: ['weekly-side'] }),
    );
    const cooling = { 'weekly-side': new Date(NOW.getTime() - DAY_MS).toISOString() };
    expect(mainStorySteps(input(catalog, { weeklyCompletions: cooling }))).toEqual([]);
  });

  it('skips a step nobody offers from a room unless it is already active', () => {
    const catalog = catalogOf(main('orphan'));
    const givers = new Map();
    expect(mainStorySteps(input(catalog, { givers }))).toEqual([]);
    expect(mainStorySteps(input(catalog, { givers, activeIds: new Set(['orphan']) }))).toEqual([
      { questId: 'orphan', name: 'Progress: orphan', status: 'active' },
    ]);
  });

  it('puts a step whose giver is on the current map first, then lower level, then id', () => {
    const catalog = catalogOf(main('a-away'), main('b-here-high', { requiredLevel: 3 }), main('c-here-low'), main('d-here-low'));
    const givers = new Map([
      ['a-away', { npcIds: ['npc-a'], mapIds: new Set(['map-far']) }],
      ['b-here-high', { npcIds: ['npc-b'], mapIds: new Set(['map-home']) }],
      ['c-here-low', { npcIds: ['npc-c'], mapIds: new Set(['map-home', 'map-far']) }],
      ['d-here-low', { npcIds: ['npc-d'], mapIds: new Set(['map-home']) }],
    ]);
    expect(ids(mainStorySteps(input(catalog, { givers, level: 5 })))).toEqual(['c-here-low', 'd-here-low', 'b-here-high']);
    expect(ids(mainStorySteps(input(catalog, { givers, level: 5, currentMapId: 'map-far' })))).toEqual(['a-away', 'c-here-low', 'd-here-low']);
  });

  it('keeps every active step and only the first three of the rest', () => {
    const catalog = catalogOf(
      main('act-1'), main('act-2'), main('act-3'), main('act-4'),
      main('open-1'), main('open-2'), main('open-3'), main('open-4'), main('open-5'),
    );
    const steps = mainStorySteps(input(catalog, { activeIds: new Set(['act-1', 'act-2', 'act-3', 'act-4']) }));
    expect(MAIN_STORY_UPCOMING_STEPS).toBe(3);
    expect(ids(steps)).toEqual(['act-1', 'act-2', 'act-3', 'act-4', 'open-1', 'open-2', 'open-3']);
  });

  it('ranks active before available before level-locked', () => {
    const catalog = catalogOf(main('locked', { requiredLevel: 50 }), main('open'), main('busy'));
    expect(mainStorySteps(input(catalog, { activeIds: new Set(['busy']) })).map(s => s.status)).toEqual(['active', 'available', 'needs_level']);
  });

  it('ends on a prerequisite cycle', () => {
    const catalog = catalogOf(
      quest('loop-a', { prerequisiteQuestIds: ['loop-b'] }),
      quest('loop-b', { prerequisiteQuestIds: ['loop-a'] }),
      main('m1', { prerequisiteQuestIds: ['loop-a'] }),
      main('m2', { prerequisiteQuestIds: ['m3'] }),
      main('m3', { prerequisiteQuestIds: ['m2'] }),
    );
    expect(mainStorySteps(input(catalog))).toEqual([]);
  });

  it('ignores a prerequisite missing from the catalog', () => {
    const catalog = catalogOf(main('m1', { prerequisiteQuestIds: ['gone'] }));
    expect(mainStorySteps(input(catalog))).toEqual([]);
  });
});

describe('buildQuestGuide', () => {
  it('lists the main quests among active and available ids, sorted', () => {
    const catalog = catalogOf(main('m-b'), main('m-a'), quest('side'), main('m-later'));
    const guide = buildQuestGuide(input(catalog, { activeIds: new Set(['m-b', 'side']) }), ['m-a', 'side', 'unknown']);
    expect(guide.mainQuestIds).toEqual(['m-a', 'm-b']);
    expect(ids(guide.steps)).toEqual(['m-b', 'm-a', 'm-later']);
  });

  it('is empty when no quest name carries the prefix', () => {
    const catalog = catalogOf(quest('a'), quest('b', { prerequisiteQuestIds: ['a'] }));
    expect(buildQuestGuide(input(catalog), ['a'])).toEqual({ steps: [], mainQuestIds: [] });
  });
});

describe('quest givers', () => {
  const npcs: NpcDefinition[] = [
    { id: 'npc-z', name: 'Z', emoji: '🙂', greeting: '', questIds: ['q1', 'q1'] },
    { id: 'npc-a', name: 'A', emoji: '🙂', greeting: '', questIds: ['q1', 'q2'] },
    { id: 'npc-nowhere', name: 'N', emoji: '🙂', greeting: '', questIds: ['q3'] },
  ];
  const tiles = [
    { npcId: 'npc-z', mapId: 'map-1' },
    { npcId: 'npc-a', mapId: 'map-2' },
    { npcId: 'npc-a', mapId: 'map-1' },
    { mapId: 'map-1' },
  ];

  it('maps each quest to the NPCs offering it from a room and the maps they stand on', () => {
    const givers = buildQuestGivers(npcs, tiles);
    expect(givers.get('q1')).toEqual({ npcIds: ['npc-a', 'npc-z'], mapIds: new Set(['map-1', 'map-2']) });
    expect(givers.get('q2')).toEqual({ npcIds: ['npc-a'], mapIds: new Set(['map-2', 'map-1']) });
    expect(givers.has('q3')).toBe(false);
  });

  it('is rebuilt only when content changes', () => {
    const content = {
      contentEpoch: 1,
      revision: 1,
      getQuestRevision() { return this.revision; },
      getAllNpcs: () => Object.fromEntries(npcs.map(n => [n.id, n])),
      getWorld: () => ({ tiles }),
    };
    const first = questGivers(content as never);
    expect(questGivers(content as never)).toBe(first);
    content.contentEpoch = 2;
    const second = questGivers(content as never);
    expect(second).not.toBe(first);
    content.revision = 2;
    expect(questGivers(content as never)).not.toBe(second);
  });
});
