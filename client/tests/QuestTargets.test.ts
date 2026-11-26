import { describe, expect, it } from 'vitest';
import type { MainStoryStep, QuestDefinition, QuestGuide, QuestProgressEntry, QuestStatus } from '@idle-party-rpg/shared';
import { mainBeaconRooms, pendingVisitTargets, questMarkerKey } from '../src/ui/QuestTargets';
import type { VisitTarget } from '../src/ui/QuestTargets';

function quest(id: string, tileIds: string[], name = `Quest ${id}`): QuestDefinition {
  return {
    id,
    name,
    description: '',
    scope: 'solo',
    objectives: [{ kind: 'kill', monsterId: 'm', count: 2 }, ...tileIds.map(tileId => ({ kind: 'visit' as const, tileId }))],
    rewards: [],
  };
}

function entry(questId: string, status: QuestStatus, progress: number[]): QuestProgressEntry {
  return { questId, status, progress, acceptedAt: '' };
}

const marks = (ready: string[], available: string[], main: string[] = []) =>
  ({ ready: new Set(ready), available: new Set(available), main: new Set(main) });
const side = (...names: string[]): VisitTarget => ({ names, mainNames: [] });
const step = (questId: string, over: Partial<MainStoryStep> = {}): MainStoryStep =>
  ({ questId, name: `Progress: Step ${questId}`, status: 'available', ...over });
const guide = (steps: MainStoryStep[]): QuestGuide => ({ steps, mainQuestIds: [] });

describe('pendingVisitTargets', () => {
  it('maps each room still to visit to the quests sending the party there', () => {
    const targets = pendingVisitTargets(
      [entry('q1', 'in_progress', [0, 0, 0]), entry('q2', 'accepted', [0, 0])],
      { q1: quest('q1', ['mill', 'well']), q2: quest('q2', ['mill']) },
    );
    expect([...targets]).toEqual([['mill', side('Quest q1', 'Quest q2')], ['well', side('Quest q1')]]);
  });

  it('skips visits already made and quests ready to turn in', () => {
    const targets = pendingVisitTargets(
      [entry('q1', 'in_progress', [0, 1, 0]), entry('q2', 'ready', [2, 0])],
      { q1: quest('q1', ['mill', 'well']), q2: quest('q2', ['tower']) },
    );
    expect([...targets.keys()]).toEqual(['well']);
  });

  it('skips quests whose definition is unknown and lists a quest once per room', () => {
    const targets = pendingVisitTargets(
      [entry('gone', 'accepted', [0, 0]), entry('q1', 'accepted', [0, 0, 0])],
      { q1: quest('q1', ['mill', 'mill']) },
    );
    expect([...targets]).toEqual([['mill', side('Quest q1')]]);
  });

  it('marks the quests of the main story, by name or because the guide leads through them, and drops the prefix', () => {
    const targets = pendingVisitTargets(
      [entry('m1', 'accepted', [0, 0]), entry('lead', 'accepted', [0, 0]), entry('q1', 'accepted', [0, 0])],
      { m1: quest('m1', ['mill'], 'Progress: The Mill'), lead: quest('lead', ['well'], 'Fetch a Rope'), q1: quest('q1', ['mill']) },
      new Set(['lead']),
    );
    expect(targets.get('mill')).toEqual({ names: ['The Mill', 'Quest q1'], mainNames: ['The Mill'] });
    expect(targets.get('well')).toEqual({ names: ['Fetch a Rope'], mainNames: ['Fetch a Rope'] });
  });

  it('is empty without active quests', () => {
    expect(pendingVisitTargets().size).toBe(0);
  });
});

describe('mainBeaconRooms', () => {
  const rooms: Record<string, { id: string }[]> = { orla: [{ id: 'camp' }, { id: 'harbour' }], bram: [{ id: 'cave' }] };
  const roomsWithNpc = (npcId: string) => rooms[npcId] ?? [];

  it('holds the main visit targets and the rooms where a step the player can take now is given', () => {
    const targets = new Map<string, VisitTarget>([
      ['mill', { names: ['The Mill', 'Quest q1'], mainNames: ['The Mill'] }],
      ['well', side('Quest q2')],
    ]);
    const beacons = mainBeaconRooms(targets, guide([
      step('next', { giverNpcIds: ['orla'] }),
      step('later', { status: 'needs_level', giverNpcIds: ['bram'] }),
      step('now', { status: 'active', giverNpcIds: ['bram'] }),
    ]), roomsWithNpc);
    expect([...beacons]).toEqual([['mill', ['The Mill']], ['camp', ['Step next']], ['harbour', ['Step next']]]);
  });

  it('is empty without a main story to follow', () => {
    expect(mainBeaconRooms(new Map([['well', side('Quest q2')]]), undefined, roomsWithNpc).size).toBe(0);
  });
});

describe('questMarkerKey', () => {
  it('ignores ordering', () => {
    const a = questMarkerKey(marks(['r2', 'r1'], ['a2', 'a1']), new Map([['t2', side('B')], ['t1', side('A')]]));
    const b = questMarkerKey(marks(['r1', 'r2'], ['a1', 'a2']), new Map([['t1', side('A')], ['t2', side('B')]]));
    expect(a).toBe(b);
  });

  it('changes when a pip, a destination or a gold marker changes', () => {
    const base = questMarkerKey(marks(['r'], ['a']), new Map([['t', side('A')]]));
    expect(questMarkerKey(marks([], ['r', 'a']), new Map([['t', side('A')]]))).not.toBe(base);
    expect(questMarkerKey(marks(['r'], []), new Map([['t', side('A')]]))).not.toBe(base);
    expect(questMarkerKey(marks(['r'], ['a'], ['a']), new Map([['t', side('A')]]))).not.toBe(base);
    expect(questMarkerKey(marks(['r'], ['a']), new Map())).not.toBe(base);
    expect(questMarkerKey(marks(['r'], ['a']), new Map([['t', side('Renamed')]]))).not.toBe(base);
    expect(questMarkerKey(marks(['r'], ['a']), new Map([['t', { names: ['A'], mainNames: ['A'] }]]))).not.toBe(base);
    expect(questMarkerKey(marks(['r'], ['a']), new Map([['t', side('A')]]), new Map([['camp', ['Step']]]))).not.toBe(base);
  });
});
