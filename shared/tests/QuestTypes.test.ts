import { describe, it, expect } from 'vitest';
import {
  acceptableQuestIds,
  canAcceptQuest,
  nextWeeklyReopening,
  SOLO_QUEST_IN_PARTY_REASON,
  WEEKLY_COOLDOWN_MS,
  type QuestAcceptContext,
  type QuestDefinition,
} from '../src/systems/QuestTypes';

function quest(id: string, extra: Partial<QuestDefinition> = {}): QuestDefinition {
  return { id, name: id, description: '', scope: 'party_shared', objectives: [], rewards: [], ...extra };
}

function ctx(extra: Partial<QuestAcceptContext> = {}): QuestAcceptContext {
  return {
    playerLevel: 5,
    activeQuestIds: new Set(),
    completedQuestIds: new Set(),
    weeklyCompletions: {},
    now: new Date('2026-10-09T12:00:00Z'),
    ...extra,
  };
}

describe('canAcceptQuest', () => {
  it('accepts a quest with no gates', () => {
    expect(canAcceptQuest(quest('q'), ctx())).toBeNull();
  });

  it('refuses an active, under-levelled, prerequisite-locked or completed quest', () => {
    expect(canAcceptQuest(quest('q'), ctx({ activeQuestIds: new Set(['q']) }))).toBe('Already accepted.');
    expect(canAcceptQuest(quest('q', { requiredLevel: 6 }), ctx())).toBe('Requires level 6.');
    expect(canAcceptQuest(quest('q', { prerequisiteQuestIds: ['p'] }), ctx())).toBe('Prerequisite quest not completed.');
    expect(canAcceptQuest(quest('q'), ctx({ completedQuestIds: new Set(['q']) }))).toBe('Already completed.');
  });

  it('refuses a weekly quest for seven days after it was turned in', () => {
    const weekly = quest('w', { repeat: 'weekly' });
    expect(canAcceptQuest(weekly, ctx({ weeklyCompletions: { w: '2026-10-03T12:00:00Z' } }))).toBe('Available again next week.');
    expect(canAcceptQuest(weekly, ctx({ weeklyCompletions: { w: '2026-10-02T12:00:00Z' } }))).toBeNull();
  });

  it('refuses a solo quest only when the party has more than one player', () => {
    const solo = quest('s', { scope: 'solo' });
    expect(canAcceptQuest(solo, ctx({ partySize: 2 }))).toBe(SOLO_QUEST_IN_PARTY_REASON);
    expect(canAcceptQuest(solo, ctx({ partySize: 1 }))).toBeNull();
    expect(canAcceptQuest(solo, ctx())).toBeNull();
    expect(canAcceptQuest(quest('p'), ctx({ partySize: 3 }))).toBeNull();
  });

  it('reports every other gate before the solo-scope one', () => {
    const solo = quest('s', { scope: 'solo', requiredLevel: 9 });
    expect(canAcceptQuest(solo, ctx({ partySize: 2 }))).toBe('Requires level 9.');
  });
});

describe('acceptableQuestIds', () => {
  const quests: Record<string, QuestDefinition> = {
    open: quest('open'),
    locked: quest('locked', { prerequisiteQuestIds: ['open'] }),
    high: quest('high', { requiredLevel: 20 }),
    solo: quest('solo', { scope: 'solo' }),
  };

  it('keeps acceptable ids, skips unknown ones, and dedupes and sorts', () => {
    expect(acceptableQuestIds(['solo', 'open', 'missing', 'open', 'high', 'locked'], quests, ctx())).toEqual(['open', 'solo']);
  });

  it('unlocks a follow-up once its prerequisite is completed', () => {
    const result = acceptableQuestIds(Object.keys(quests), quests, ctx({ completedQuestIds: new Set(['open']) }));
    expect(result).toEqual(['locked', 'solo']);
  });
});

describe('nextWeeklyReopening', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');

  it('is the soonest cooldown still running', () => {
    const weekly = { a: '2026-10-05T12:00:00Z', b: '2026-10-08T12:00:00Z', done: '2026-09-01T00:00:00Z' };
    expect(nextWeeklyReopening(weekly, now)).toBe(Date.parse('2026-10-05T12:00:00Z') + WEEKLY_COOLDOWN_MS);
  });

  it('is Infinity when nothing is cooling down', () => {
    expect(nextWeeklyReopening({}, now)).toBe(Infinity);
    expect(nextWeeklyReopening({ old: '2026-09-01T00:00:00Z', bad: 'not a date' }, now)).toBe(Infinity);
  });

  it('matches when canAcceptQuest starts offering the quest again', () => {
    const weekly = { w: '2026-10-05T12:00:00Z' };
    const reopensAt = nextWeeklyReopening(weekly, now);
    const w = quest('w', { repeat: 'weekly' });
    expect(canAcceptQuest(w, ctx({ weeklyCompletions: weekly, now: new Date(reopensAt - 1) }))).not.toBeNull();
    expect(canAcceptQuest(w, ctx({ weeklyCompletions: weekly, now: new Date(reopensAt) }))).toBeNull();
  });
});
