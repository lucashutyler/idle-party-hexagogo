import { describe, expect, it } from 'vitest';
import { QUEST_CHAIN_DEPTH_CAP, nextQuestStep } from '../src/systems/QuestChain.js';
import type { QuestChainProgress } from '../src/systems/QuestChain.js';
import type { QuestDefinition } from '../src/systems/QuestTypes.js';

function quest(id: string, prerequisiteQuestIds: string[] = [], requiredLevel?: number): QuestDefinition {
  return {
    id,
    name: `Quest ${id}`,
    description: '',
    scope: 'solo',
    objectives: [],
    rewards: [],
    ...(prerequisiteQuestIds.length ? { prerequisiteQuestIds } : {}),
    ...(requiredLevel !== undefined ? { requiredLevel } : {}),
  };
}

function catalog(...quests: QuestDefinition[]): Record<string, QuestDefinition> {
  return Object.fromEntries(quests.map(q => [q.id, q]));
}

function progress(completed: string[] = [], active: string[] = [], level = 5): QuestChainProgress {
  return { completed: new Set(completed), active: new Set(active), level };
}

const everyoneOffers = () => true;

describe('nextQuestStep', () => {
  it('picks the first unfinished quest of a straight chain, counting what is left', () => {
    const quests = catalog(quest('a'), quest('b', ['a']), quest('c', ['b']));
    expect(nextQuestStep('c', quests, progress(), everyoneOffers)).toEqual({
      questId: 'a', questName: 'Quest a', state: 'available', remaining: 3,
    });
    expect(nextQuestStep('c', quests, progress(['a']), everyoneOffers)).toMatchObject({ questId: 'b', remaining: 2 });
    expect(nextQuestStep('c', quests, progress(['a', 'b']), everyoneOffers)).toMatchObject({ questId: 'c', remaining: 1 });
  });

  it('returns null once the target is done, or when it is unknown', () => {
    const quests = catalog(quest('a'));
    expect(nextQuestStep('a', quests, progress(['a']), everyoneOffers)).toBeNull();
    expect(nextQuestStep('nope', quests, progress(), everyoneOffers)).toBeNull();
  });

  it('on a branch prefers the lower level, then the branch listed first', () => {
    const quests = catalog(quest('left', [], 4), quest('right', [], 2), quest('gate', ['left', 'right']));
    expect(nextQuestStep('gate', quests, progress(), everyoneOffers)).toMatchObject({ questId: 'right', requiredLevel: 2, remaining: 3 });

    const even = catalog(quest('left'), quest('right'), quest('gate', ['left', 'right']));
    expect(nextQuestStep('gate', even, progress(), everyoneOffers)?.questId).toBe('left');
  });

  it('prefers a quest already under way', () => {
    const quests = catalog(quest('left'), quest('right'), quest('gate', ['left', 'right']));
    expect(nextQuestStep('gate', quests, progress([], ['right']), everyoneOffers)).toMatchObject({ questId: 'right', state: 'active' });
  });

  it('says when the next quest waits on the player\'s level', () => {
    const quests = catalog(quest('a', [], 9), quest('gate', ['a']));
    expect(nextQuestStep('gate', quests, progress([], [], 5), everyoneOffers)).toMatchObject({ questId: 'a', state: 'needs_level', requiredLevel: 9 });
    expect(nextQuestStep('gate', quests, progress([], [], 9), everyoneOffers)).toMatchObject({ questId: 'a', state: 'available' });
  });

  it('says a quest no NPC offers is unavailable, after any that can be taken', () => {
    const quests = catalog(quest('hidden'), quest('shown', [], 8), quest('gate', ['hidden', 'shown']));
    const offered = (id: string) => id !== 'hidden';
    expect(nextQuestStep('gate', quests, progress(), offered)).toMatchObject({ questId: 'shown', state: 'needs_level' });
    expect(nextQuestStep('hidden', quests, progress(), offered)).toMatchObject({ questId: 'hidden', state: 'unavailable', remaining: 1 });
  });

  it('ends on a prerequisite cycle, and on a prerequisite that no longer exists', () => {
    const cycle = catalog(quest('a', ['b']), quest('b', ['a']));
    expect(nextQuestStep('a', cycle, progress(), everyoneOffers)).toEqual({ questId: 'a', questName: 'Quest a', state: 'unavailable', remaining: 2 });

    const missing = catalog(quest('a', ['deleted']));
    expect(nextQuestStep('a', missing, progress(), everyoneOffers)).toMatchObject({ questId: 'a', state: 'unavailable', remaining: 1 });
  });

  it('counts a quest reached two ways once', () => {
    const quests = catalog(quest('root'), quest('left', ['root']), quest('right', ['root']), quest('gate', ['left', 'right']));
    expect(nextQuestStep('gate', quests, progress(), everyoneOffers)).toMatchObject({ questId: 'root', remaining: 4 });
  });

  it('stops following a chain deeper than the cap', () => {
    const chain: QuestDefinition[] = [quest('q0')];
    for (let i = 1; i <= QUEST_CHAIN_DEPTH_CAP + 50; i++) chain.push(quest(`q${i}`, [`q${i - 1}`]));
    const top = `q${QUEST_CHAIN_DEPTH_CAP + 50}`;
    const step = nextQuestStep(top, catalog(...chain), progress(), everyoneOffers);
    expect(step?.remaining).toBe(QUEST_CHAIN_DEPTH_CAP + 1);
    expect(step?.state).toBe('unavailable');
  });
});
