import { describe, expect, it } from 'vitest';
import type { QuestDefinition, QuestProgressEntry, QuestStatus } from '@idle-party-rpg/shared';
import { pendingVisitTargets, questMarkerKey } from '../src/ui/QuestTargets';

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

const marks = (ready: string[], available: string[]) => ({ ready: new Set(ready), available: new Set(available) });

describe('pendingVisitTargets', () => {
  it('maps each room still to visit to the quests sending the party there', () => {
    const targets = pendingVisitTargets(
      [entry('q1', 'in_progress', [0, 0, 0]), entry('q2', 'accepted', [0, 0])],
      { q1: quest('q1', ['mill', 'well']), q2: quest('q2', ['mill']) },
    );
    expect([...targets]).toEqual([['mill', ['Quest q1', 'Quest q2']], ['well', ['Quest q1']]]);
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
    expect([...targets]).toEqual([['mill', ['Quest q1']]]);
  });

  it('is empty without active quests', () => {
    expect(pendingVisitTargets().size).toBe(0);
  });
});

describe('questMarkerKey', () => {
  it('ignores ordering', () => {
    const a = questMarkerKey(marks(['r2', 'r1'], ['a2', 'a1']), new Map([['t2', ['B']], ['t1', ['A']]]));
    const b = questMarkerKey(marks(['r1', 'r2'], ['a1', 'a2']), new Map([['t1', ['A']], ['t2', ['B']]]));
    expect(a).toBe(b);
  });

  it('changes when a pip or a destination changes', () => {
    const base = questMarkerKey(marks(['r'], ['a']), new Map([['t', ['A']]]));
    expect(questMarkerKey(marks([], ['r', 'a']), new Map([['t', ['A']]]))).not.toBe(base);
    expect(questMarkerKey(marks(['r'], []), new Map([['t', ['A']]]))).not.toBe(base);
    expect(questMarkerKey(marks(['r'], ['a']), new Map())).not.toBe(base);
    expect(questMarkerKey(marks(['r'], ['a']), new Map([['t', ['Renamed']]]))).not.toBe(base);
  });
});
