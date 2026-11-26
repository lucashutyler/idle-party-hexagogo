import { describe, expect, it } from 'vitest';
import type { CompletedQuestEntry, MainStoryStep, NpcDefinition, QuestGuide, QuestProgressEntry, QuestStatus } from '@idle-party-rpg/shared';
import {
  giverLocations,
  nextStoryStep,
  questOfferedHere,
  sortActiveQuests,
  splitMainQuests,
  stepGiverLocations,
  summarizeCompletedQuests,
  turnInLocations,
  weeklyAvailableAgainAt,
  type NpcRoom,
} from '../src/ui/QuestLogModel';

function entry(questId: string, status: QuestStatus, acceptedAt: string): QuestProgressEntry {
  return { questId, status, progress: [], acceptedAt };
}

function done(questId: string, completedAt: string): CompletedQuestEntry {
  return { questId, completedAt };
}

function npc(id: string, questIds: string[]): NpcDefinition {
  return { id, name: `NPC ${id}`, emoji: '🧙', greeting: 'Hello', questIds };
}

describe('sortActiveQuests', () => {
  it('puts ready quests first, then in progress, then accepted', () => {
    const sorted = sortActiveQuests([
      entry('a', 'accepted', '2026-01-01T00:00:00.000Z'),
      entry('p', 'in_progress', '2026-01-02T00:00:00.000Z'),
      entry('r', 'ready', '2026-01-03T00:00:00.000Z'),
    ]);
    expect(sorted.map(e => e.questId)).toEqual(['r', 'p', 'a']);
  });

  it('orders ties by acceptedAt, oldest first, and keeps input order on equal times', () => {
    const sorted = sortActiveQuests([
      entry('late', 'ready', '2026-01-05T00:00:00.000Z'),
      entry('early', 'ready', '2026-01-01T00:00:00.000Z'),
      entry('same1', 'accepted', '2026-01-02T00:00:00.000Z'),
      entry('same2', 'accepted', '2026-01-02T00:00:00.000Z'),
    ]);
    expect(sorted.map(e => e.questId)).toEqual(['early', 'late', 'same1', 'same2']);
  });

  it('does not mutate its input', () => {
    const input = [entry('a', 'accepted', '2026-01-01T00:00:00.000Z'), entry('r', 'ready', '2026-01-01T00:00:00.000Z')];
    sortActiveQuests(input);
    expect(input.map(e => e.questId)).toEqual(['a', 'r']);
  });
});

describe('summarizeCompletedQuests', () => {
  it('folds repeated weekly completions into one row with a count and the latest time', () => {
    const rows = summarizeCompletedQuests([
      done('weekly', '2026-01-01T00:00:00.000Z'),
      done('once', '2026-01-05T00:00:00.000Z'),
      done('weekly', '2026-01-09T00:00:00.000Z'),
      done('weekly', '2026-01-16T00:00:00.000Z'),
    ]);
    expect(rows).toEqual([
      { questId: 'weekly', lastCompletedAt: '2026-01-16T00:00:00.000Z', timesCompleted: 3 },
      { questId: 'once', lastCompletedAt: '2026-01-05T00:00:00.000Z', timesCompleted: 1 },
    ]);
  });

  it('returns nothing for an empty history', () => {
    expect(summarizeCompletedQuests([])).toEqual([]);
  });
});

describe('weeklyAvailableAgainAt', () => {
  it('returns the end of the 7-day cooldown while it is running', () => {
    const at = weeklyAvailableAgainAt('2026-01-10T00:00:00.000Z', new Date('2026-01-12T00:00:00.000Z'));
    expect(at?.toISOString()).toBe('2026-01-17T00:00:00.000Z');
  });

  it('returns null once the cooldown has passed', () => {
    expect(weeklyAvailableAgainAt('2026-01-10T00:00:00.000Z', new Date('2026-01-17T00:00:00.000Z'))).toBeNull();
  });
});

describe('turnInLocations', () => {
  const rooms: Record<string, NpcRoom[]> = {
    mara: [
      { id: 'room-explored', mapId: 'overworld', name: 'Town Square', zoneName: 'Hatchetmill' },
      { id: 'room-hidden', mapId: 'overworld', name: 'Secret Grove', zoneName: 'Deepwood' },
    ],
    hermit: [{ id: 'room-far', mapId: 'overworld', name: 'Hermit Hut', zoneName: 'Far Peaks' }],
    ghost: [],
  };
  const roomsWithNpc = (id: string) => rooms[id] ?? [];

  it('lists explored rooms only and still names NPCs whose rooms are all unexplored', () => {
    const locations = turnInLocations(
      'q1',
      [npc('mara', ['q1']), npc('hermit', ['q1']), npc('other', ['q2'])],
      roomsWithNpc,
      new Set(['room-explored']),
    );
    expect(locations).toEqual([
      { npcName: 'NPC mara', npcEmoji: '🧙', roomId: 'room-explored', mapId: 'overworld', roomName: 'Town Square', zoneName: 'Hatchetmill' },
      { npcName: 'NPC hermit', npcEmoji: '🧙' },
    ]);
  });

  it('skips NPCs that stand in no room at all', () => {
    expect(turnInLocations('q1', [npc('ghost', ['q1'])], roomsWithNpc, new Set())).toEqual([]);
  });

  it('ignores NPCs without a quest list', () => {
    const plain: NpcDefinition = { id: 'mara', name: 'Mara', emoji: '🧙', greeting: 'Hi' };
    expect(turnInLocations('q1', [plain], roomsWithNpc, new Set(['room-explored']))).toEqual([]);
  });
});

describe('giverLocations', () => {
  const rooms: Record<string, NpcRoom[]> = {
    mara: [
      { id: 'room-square', mapId: 'overworld', name: 'Town Square', zoneName: 'Hatchetmill' },
      { id: 'room-dock', mapId: 'cellar', name: 'Old Dock', zoneName: 'Hatchetmill' },
    ],
    hermit: [{ id: 'room-far', mapId: 'overworld', name: 'Hermit Hut', zoneName: 'Far Peaks' }],
    smith: [{ id: 'room-forge', mapId: 'overworld', name: 'Forge', zoneName: 'Hatchetmill' }],
  };
  const roomsWithNpc = (id: string) => rooms[id] ?? [];
  const npcs = [npc('mara', ['q1', 'q2']), npc('hermit', ['q3']), npc('smith', ['q4'])];

  it('lists every explored room of each npc offering an available quest', () => {
    const locations = giverLocations(['q2', 'q3'], npcs, roomsWithNpc, new Set(['room-square', 'room-dock', 'room-forge']));
    expect(locations).toEqual([
      { npcName: 'NPC mara', npcEmoji: '🧙', roomId: 'room-square', mapId: 'overworld', roomName: 'Town Square', zoneName: 'Hatchetmill', main: false },
      { npcName: 'NPC mara', npcEmoji: '🧙', roomId: 'room-dock', mapId: 'cellar', roomName: 'Old Dock', zoneName: 'Hatchetmill', main: false },
    ]);
  });

  it('never names an npc standing only in unexplored rooms', () => {
    expect(giverLocations(['q3'], npcs, roomsWithNpc, new Set(['room-square']))).toEqual([]);
  });

  it('is empty when nothing is available', () => {
    expect(giverLocations([], npcs, roomsWithNpc, new Set(['room-square', 'room-forge']))).toEqual([]);
  });
});

describe('giverLocations with a guide', () => {
  const rooms: Record<string, NpcRoom[]> = {
    side: [{ id: 'room-side', mapId: 'overworld', name: 'Side Room', zoneName: 'Vale' }],
    far: [{ id: 'room-far', mapId: 'cellar', name: 'Far Room', zoneName: 'Vale' }],
    story: [{ id: 'room-story', mapId: 'cellar', name: 'Story Room', zoneName: 'Vale' }],
    here: [{ id: 'room-here', mapId: 'overworld', name: 'Here Room', zoneName: 'Vale' }],
  };
  const roomsWithNpc = (id: string) => rooms[id] ?? [];
  const npcs = [npc('side', ['q-side']), npc('far', ['q-far']), npc('story', ['q-main', 'q-x']), npc('here', ['q-here'])];
  const explored = new Set(['room-side', 'room-far', 'room-story', 'room-here']);

  it('flags NPCs with a main quest the player can take and lists them first, then this map', () => {
    const locations = giverLocations(['q-side', 'q-far', 'q-main', 'q-here'], npcs, roomsWithNpc, explored, ['q-main'], 'overworld');
    expect(locations.map(loc => [loc.roomId, loc.main])).toEqual([
      ['room-story', true],
      ['room-side', false],
      ['room-here', false],
      ['room-far', false],
    ]);
  });

  it('only flags a main quest the player can take now', () => {
    const locations = giverLocations(['q-x'], npcs, roomsWithNpc, explored, ['q-main'], 'overworld');
    expect(locations).toEqual([expect.objectContaining({ roomId: 'room-story', main: false })]);
  });
});

describe('splitMainQuests', () => {
  const guide = (over: Partial<QuestGuide> = {}): QuestGuide => ({ steps: [], mainQuestIds: [], ...over });
  const step = (questId: string, status: MainStoryStep['status'] = 'active'): MainStoryStep => ({ questId, name: questId, status });

  it('puts main quests in guide step order and keeps the rest sorted as before', () => {
    const entries = [
      entry('side-ready', 'ready', '2026-01-03T00:00:00.000Z'),
      entry('main-b', 'ready', '2026-01-01T00:00:00.000Z'),
      entry('side-old', 'accepted', '2026-01-01T00:00:00.000Z'),
      entry('main-a', 'accepted', '2026-01-02T00:00:00.000Z'),
      entry('leads', 'in_progress', '2026-01-02T00:00:00.000Z'),
    ];
    const split = splitMainQuests(entries, guide({
      steps: [step('main-a'), step('leads'), step('main-b'), step('main-next', 'available')],
      mainQuestIds: ['main-a', 'main-b'],
    }));
    expect(split.main.map(e => e.questId)).toEqual(['main-a', 'leads', 'main-b']);
    expect(split.other.map(e => e.questId)).toEqual(['side-ready', 'side-old']);
  });

  it('orders main quests the guide has no step for by status, after the ones it does', () => {
    const entries = [
      entry('main-weekly', 'accepted', '2026-01-01T00:00:00.000Z'),
      entry('main-ready', 'ready', '2026-01-05T00:00:00.000Z'),
      entry('main-step', 'accepted', '2026-01-09T00:00:00.000Z'),
    ];
    const split = splitMainQuests(entries, guide({ steps: [step('main-step')], mainQuestIds: ['main-weekly', 'main-ready', 'main-step'] }));
    expect(split.main.map(e => e.questId)).toEqual(['main-step', 'main-ready', 'main-weekly']);
  });

  it('treats everything as other without a guide', () => {
    const entries = [entry('a', 'accepted', '2026-01-01T00:00:00.000Z'), entry('r', 'ready', '2026-01-02T00:00:00.000Z')];
    expect(splitMainQuests(entries, undefined)).toEqual({ main: [], other: [entries[1], entries[0]] });
  });
});

describe('stepGiverLocations', () => {
  const rooms: Record<string, NpcRoom[]> = {
    giver: [
      { id: 'room-dark-here', mapId: 'overworld', name: 'Dark Here', zoneName: 'Vale' },
      { id: 'room-lit-away', mapId: 'cellar', name: 'Lit Away', zoneName: 'Deep' },
      { id: 'room-lit-here', mapId: 'overworld', name: 'Lit Here', zoneName: 'Vale' },
    ],
    other: [{ id: 'room-other', mapId: 'overworld', name: 'Other', zoneName: 'Vale' }],
  };
  const roomsWithNpc = (id: string) => rooms[id] ?? [];
  const npcs = [npc('other', ['q1']), npc('giver', ['q1'])];

  it("lists the step givers' rooms, unexplored too: explored first, then this map", () => {
    const locations = stepGiverLocations({ giverNpcIds: ['giver'] }, npcs, roomsWithNpc, new Set(['room-lit-away', 'room-lit-here']), 'overworld');
    expect(locations.map(loc => loc.roomId)).toEqual(['room-lit-here', 'room-lit-away', 'room-dark-here']);
    expect(locations[0]).toEqual({ npcName: 'NPC giver', npcEmoji: '🧙', roomId: 'room-lit-here', mapId: 'overworld', roomName: 'Lit Here', zoneName: 'Vale' });
  });

  it('is empty for a step without givers', () => {
    expect(stepGiverLocations({}, npcs, roomsWithNpc, new Set(), 'overworld')).toEqual([]);
  });
});

describe('nextStoryStep', () => {
  const rooms: Record<string, NpcRoom[]> = {
    away: [{ id: 'room-away', mapId: 'cellar', name: 'Away', zoneName: 'Deep' }],
    home: [{ id: 'room-home', mapId: 'overworld', name: 'Home', zoneName: 'Vale' }],
  };
  const roomsWithNpc = (id: string) => rooms[id] ?? [];
  const steps: MainStoryStep[] = [
    { questId: 'busy', name: 'busy', status: 'active', giverNpcIds: ['home'] },
    { questId: 'away-open', name: 'away-open', status: 'available', giverNpcIds: ['away'] },
    { questId: 'home-locked', name: 'home-locked', status: 'needs_level', requiredLevel: 9, giverNpcIds: ['home'] },
  ];

  it('prefers an upcoming step whose giver is on this map', () => {
    expect(nextStoryStep({ steps, mainQuestIds: [] }, roomsWithNpc, 'overworld')?.questId).toBe('home-locked');
  });

  it('falls back to the first upcoming step anywhere, and never an active one', () => {
    expect(nextStoryStep({ steps, mainQuestIds: [] }, roomsWithNpc, 'attic')?.questId).toBe('away-open');
    expect(nextStoryStep({ steps: [steps[0]], mainQuestIds: [] }, roomsWithNpc, 'overworld')).toBeUndefined();
    expect(nextStoryStep(undefined, roomsWithNpc, 'overworld')).toBeUndefined();
  });
});

describe('questOfferedHere', () => {
  it('is true only when the NPC here offers a quest the player can take', () => {
    expect(questOfferedHere({ offeredQuestIds: ['a', 'b'], availableQuestIds: ['b', 'c'] })).toBe(true);
    expect(questOfferedHere({ offeredQuestIds: ['a'], availableQuestIds: ['c'] })).toBe(false);
    expect(questOfferedHere({})).toBe(false);
    expect(questOfferedHere(null)).toBe(false);
  });
});
