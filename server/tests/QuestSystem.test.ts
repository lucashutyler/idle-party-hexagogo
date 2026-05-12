import { describe, it, expect, beforeEach } from 'vitest';
import { QuestSystem } from '../src/game/QuestSystem.js';
import type { QuestDefinition } from '@idle-party-rpg/shared';

const killGoblinsParty: QuestDefinition = {
  id: 'kill_goblins',
  name: 'Kill Goblins',
  description: 'Kill 3 goblins.',
  scope: 'party_shared',
  objectives: [{ kind: 'kill', monsterId: 'goblin', count: 3 }],
  rewards: [{ kind: 'xp', amount: 50 }],
};

const killWolfSolo: QuestDefinition = {
  id: 'kill_wolf',
  name: 'Slay the Wolf',
  description: 'Solo a wolf.',
  scope: 'solo',
  objectives: [{ kind: 'kill', monsterId: 'wolf', count: 1 }],
  rewards: [{ kind: 'gold', amount: 25 }],
};

const collectPelts: QuestDefinition = {
  id: 'collect_pelts',
  name: 'Pelt Collector',
  description: 'Bring 5 pelts.',
  scope: 'party_shared',
  objectives: [{ kind: 'collect', itemId: 'mangy_pelt', count: 5 }],
  rewards: [{ kind: 'gold', amount: 100 }],
};

const visitWell: QuestDefinition = {
  id: 'visit_well',
  name: 'Find the Well',
  description: 'Travel to the Old Well.',
  scope: 'party_shared',
  objectives: [{ kind: 'visit', tileId: 'tile-well-id' }],
  rewards: [{ kind: 'xp', amount: 20 }],
};

const advancedQuest: QuestDefinition = {
  id: 'advanced',
  name: 'Advanced',
  description: 'Requires kill_goblins.',
  scope: 'party_shared',
  objectives: [{ kind: 'kill', monsterId: 'wolf', count: 1 }],
  rewards: [{ kind: 'xp', amount: 100 }],
  prerequisiteQuestIds: ['kill_goblins'],
  requiredLevel: 5,
};

const weeklyQuest: QuestDefinition = {
  id: 'weekly',
  name: 'Weekly',
  description: 'Once per week.',
  scope: 'party_shared',
  objectives: [{ kind: 'visit', tileId: 'tile-anywhere' }],
  rewards: [{ kind: 'xp', amount: 200 }],
  repeat: 'weekly',
};

const allQuests: Record<string, QuestDefinition> = {
  kill_goblins: killGoblinsParty,
  kill_wolf: killWolfSolo,
  collect_pelts: collectPelts,
  visit_well: visitWell,
  advanced: advancedQuest,
  weekly: weeklyQuest,
};

describe('QuestSystem', () => {
  let qs: QuestSystem;

  beforeEach(() => {
    qs = new QuestSystem('alice');
  });

  describe('accept', () => {
    it('accepts a quest with no requirements', () => {
      expect(qs.accept(killGoblinsParty, { playerLevel: 1, partySize: 1 })).toBeNull();
      expect(qs.hasAccepted('kill_goblins')).toBe(true);
      const entry = qs.getProgress('kill_goblins')!;
      expect(entry.status).toBe('accepted');
      expect(entry.progress).toEqual([0]);
    });

    it('rejects duplicate accept', () => {
      qs.accept(killGoblinsParty, { playerLevel: 1, partySize: 1 });
      expect(qs.accept(killGoblinsParty, { playerLevel: 1, partySize: 1 })).toMatch(/already/i);
    });

    it('blocks solo quest while in a multi-person party', () => {
      expect(qs.accept(killWolfSolo, { playerLevel: 1, partySize: 3 })).toMatch(/solo/i);
      expect(qs.hasAccepted('kill_wolf')).toBe(false);
    });

    it('allows solo quest in a solo party', () => {
      expect(qs.accept(killWolfSolo, { playerLevel: 1, partySize: 1 })).toBeNull();
    });

    it('blocks accept under required level', () => {
      expect(qs.accept(advancedQuest, { playerLevel: 1, partySize: 1 })).toMatch(/level/i);
    });

    it('blocks accept with missing prerequisite', () => {
      expect(qs.accept(advancedQuest, { playerLevel: 10, partySize: 1 })).toMatch(/prerequisite/i);
    });

    it('allows accept when prerequisite completed', () => {
      qs.accept(killGoblinsParty, { playerLevel: 10, partySize: 1 });
      qs.applyKill('goblin', allQuests);
      qs.applyKill('goblin', allQuests);
      qs.applyKill('goblin', allQuests);
      qs.turnIn('kill_goblins', allQuests, () => true, () => 0);
      expect(qs.accept(advancedQuest, { playerLevel: 10, partySize: 1 })).toBeNull();
    });
  });

  describe('progress transitions (kill)', () => {
    beforeEach(() => qs.accept(killGoblinsParty, { playerLevel: 1, partySize: 1 }));

    it('accepted → in_progress on first kill', () => {
      qs.applyKill('goblin', allQuests);
      expect(qs.getProgress('kill_goblins')!.status).toBe('in_progress');
      expect(qs.getProgress('kill_goblins')!.progress).toEqual([1]);
    });

    it('in_progress → ready when all objectives hit target', () => {
      qs.applyKill('goblin', allQuests);
      qs.applyKill('goblin', allQuests);
      qs.applyKill('goblin', allQuests);
      expect(qs.getProgress('kill_goblins')!.status).toBe('ready');
    });

    it('does not over-count past target', () => {
      for (let i = 0; i < 10; i++) qs.applyKill('goblin', allQuests);
      expect(qs.getProgress('kill_goblins')!.progress).toEqual([3]);
    });

    it('ignores non-matching monsters', () => {
      qs.applyKill('wolf', allQuests);
      expect(qs.getProgress('kill_goblins')!.status).toBe('accepted');
      expect(qs.getProgress('kill_goblins')!.progress).toEqual([0]);
    });
  });

  describe('progress transitions (visit)', () => {
    beforeEach(() => qs.accept(visitWell, { playerLevel: 1, partySize: 1 }));

    it('marks visit as ready immediately on matching tile', () => {
      qs.applyVisit('tile-well-id', allQuests);
      expect(qs.getProgress('visit_well')!.status).toBe('ready');
      expect(qs.getProgress('visit_well')!.progress).toEqual([1]);
    });

    it('ignores wrong tile id', () => {
      qs.applyVisit('tile-other', allQuests);
      expect(qs.getProgress('visit_well')!.status).toBe('accepted');
    });
  });

  describe('progress transitions (collect)', () => {
    beforeEach(() => qs.accept(collectPelts, { playerLevel: 1, partySize: 1 }));

    it('recompute reflects current ownership; status updates accordingly', () => {
      qs.recomputeCollect(allQuests, () => 2);
      expect(qs.getProgress('collect_pelts')!.progress).toEqual([2]);
      expect(qs.getProgress('collect_pelts')!.status).toBe('in_progress');

      qs.recomputeCollect(allQuests, () => 5);
      expect(qs.getProgress('collect_pelts')!.status).toBe('ready');

      // Drop below threshold — back to in_progress
      qs.recomputeCollect(allQuests, () => 3);
      expect(qs.getProgress('collect_pelts')!.status).toBe('in_progress');
    });

    it('caps progress at target', () => {
      qs.recomputeCollect(allQuests, () => 99);
      expect(qs.getProgress('collect_pelts')!.progress).toEqual([5]);
    });
  });

  describe('turnIn', () => {
    it('rejects when objectives incomplete', () => {
      qs.accept(killGoblinsParty, { playerLevel: 1, partySize: 1 });
      const result = qs.turnIn('kill_goblins', allQuests, () => true, () => 0);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/incomplete/i);
    });

    it('grants rewards on success', () => {
      qs.accept(killGoblinsParty, { playerLevel: 1, partySize: 1 });
      qs.applyKill('goblin', allQuests);
      qs.applyKill('goblin', allQuests);
      qs.applyKill('goblin', allQuests);
      const result = qs.turnIn('kill_goblins', allQuests, () => true, () => 0);
      expect(result.success).toBe(true);
      expect(result.rewards).toEqual([{ kind: 'xp', amount: 50 }]);
      expect(qs.hasAccepted('kill_goblins')).toBe(false);
      expect(qs.getCompletedQuestIds().has('kill_goblins')).toBe(true);
    });

    it('consumes collect items on turn-in', () => {
      qs.accept(collectPelts, { playerLevel: 1, partySize: 1 });
      let inv = 5;
      const consume = (_id: string, count: number) => { inv -= count; return true; };
      const getInv = () => inv;

      qs.recomputeCollect(allQuests, getInv);
      const result = qs.turnIn('collect_pelts', allQuests, consume, getInv);
      expect(result.success).toBe(true);
      expect(inv).toBe(0);
    });

    it('blocks repeat once-quests after completion', () => {
      qs.accept(killGoblinsParty, { playerLevel: 1, partySize: 1 });
      for (let i = 0; i < 3; i++) qs.applyKill('goblin', allQuests);
      qs.turnIn('kill_goblins', allQuests, () => true, () => 0);
      expect(qs.accept(killGoblinsParty, { playerLevel: 1, partySize: 1 })).toMatch(/already completed/i);
    });

    it('blocks weekly within 7 days, then allows again', () => {
      // First completion
      qs.accept(weeklyQuest, { playerLevel: 1, partySize: 1 });
      qs.applyVisit('tile-anywhere', allQuests);
      qs.turnIn('weekly', allQuests, () => true, () => 0);

      // Re-accept blocked
      expect(qs.accept(weeklyQuest, { playerLevel: 1, partySize: 1 })).toMatch(/next week/i);

      // Manually rewind weekly completion timestamp by > 7 days
      const data = qs.toSaveData();
      data.weeklyCompletions.weekly = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      qs.loadFromSaveData(data);

      expect(qs.accept(weeklyQuest, { playerLevel: 1, partySize: 1 })).toBeNull();
    });
  });

  describe('persistence', () => {
    it('roundtrips active + completed + weeklyCompletions', () => {
      qs.accept(killGoblinsParty, { playerLevel: 1, partySize: 1 });
      qs.applyKill('goblin', allQuests);

      const data = qs.toSaveData();
      const restored = new QuestSystem('alice');
      restored.loadFromSaveData(data);

      const entry = restored.getProgress('kill_goblins')!;
      expect(entry.progress).toEqual([1]);
      expect(entry.status).toBe('in_progress');
    });
  });

  describe('events', () => {
    it('fires accepted, progress, ready, turned_in', () => {
      const events: string[] = [];
      const local = new QuestSystem('bob', (e) => events.push(e.type));

      local.accept(killGoblinsParty, { playerLevel: 1, partySize: 1 });
      local.applyKill('goblin', allQuests);
      local.applyKill('goblin', allQuests);
      local.applyKill('goblin', allQuests);
      local.turnIn('kill_goblins', allQuests, () => true, () => 0);

      expect(events).toContain('accepted');
      expect(events).toContain('progress');
      expect(events).toContain('ready');
      expect(events).toContain('turned_in');
    });
  });
});
