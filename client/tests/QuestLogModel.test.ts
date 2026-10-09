import { describe, expect, it } from 'vitest';
import type { CompletedQuestEntry, NpcDefinition, QuestProgressEntry, QuestStatus } from '@idle-party-rpg/shared';
import {
  giverLocations,
  sortActiveQuests,
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
      { id: 'room-explored', name: 'Town Square', zoneName: 'Hatchetmill' },
      { id: 'room-hidden', name: 'Secret Grove', zoneName: 'Deepwood' },
    ],
    hermit: [{ id: 'room-far', name: 'Hermit Hut', zoneName: 'Far Peaks' }],
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
      { npcName: 'NPC mara', npcEmoji: '🧙', roomName: 'Town Square', zoneName: 'Hatchetmill' },
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
      { id: 'room-square', name: 'Town Square', zoneName: 'Hatchetmill' },
      { id: 'room-dock', name: 'Old Dock', zoneName: 'Hatchetmill' },
    ],
    hermit: [{ id: 'room-far', name: 'Hermit Hut', zoneName: 'Far Peaks' }],
    smith: [{ id: 'room-forge', name: 'Forge', zoneName: 'Hatchetmill' }],
  };
  const roomsWithNpc = (id: string) => rooms[id] ?? [];
  const npcs = [npc('mara', ['q1', 'q2']), npc('hermit', ['q3']), npc('smith', ['q4'])];

  it('lists every explored room of each npc offering an available quest', () => {
    const locations = giverLocations(['q2', 'q3'], npcs, roomsWithNpc, new Set(['room-square', 'room-dock', 'room-forge']));
    expect(locations).toEqual([
      { npcName: 'NPC mara', npcEmoji: '🧙', roomName: 'Town Square', zoneName: 'Hatchetmill' },
      { npcName: 'NPC mara', npcEmoji: '🧙', roomName: 'Old Dock', zoneName: 'Hatchetmill' },
    ]);
  });

  it('never names an npc standing only in unexplored rooms', () => {
    expect(giverLocations(['q3'], npcs, roomsWithNpc, new Set(['room-square']))).toEqual([]);
  });

  it('is empty when nothing is available', () => {
    expect(giverLocations([], npcs, roomsWithNpc, new Set(['room-square', 'room-forge']))).toEqual([]);
  });
});
