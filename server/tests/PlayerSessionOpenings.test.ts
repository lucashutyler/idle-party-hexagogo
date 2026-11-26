import { describe, it, expect } from 'vitest';
import { xpForNextLevel } from '@idle-party-rpg/shared';
import type { QuestDefinition, RoomEntryRequirements, WorldTileDefinition } from '@idle-party-rpg/shared';
import { journal, recapContent, recapSession, room, setLevel } from './recapFixture.js';
import type { RecapContent } from './recapFixture.js';

function quest(id: string, name: string, rewards: QuestDefinition['rewards'] = []): QuestDefinition {
  return { id, name, description: '', scope: 'party_shared', objectives: [{ kind: 'visit', tileId: 'start' }], rewards };
}

const QUESTS: Record<string, QuestDefinition> = {
  bridge: quest('bridge', 'Mend the Bridge'),
  key: quest('key', 'Find the Cellar Key'),
  scholar: quest('scholar', 'Ask the Scholar', [{ kind: 'xp', amount: xpForNextLevel(1) + xpForNextLevel(2) }]),
};

const ELDER = { id: 'elder', name: 'Elder', emoji: '🧓', greeting: 'Hello', questIds: Object.keys(QUESTS) };

function gated(reqs: RoomEntryRequirements): Partial<WorldTileDefinition> {
  return { entryRequirements: reqs };
}

/** start (0,0) and east (1,0) are found at spawn; the far group (4..6, 0) is not. */
function world(overrides: Record<string, Partial<WorldTileDefinition>> = {}, extra: Partial<RecapContent> = {}) {
  const tiles = [
    room('start', 0, 0, { name: 'Old Mill', npcId: 'elder' }),
    room('east', 1, 0, { name: 'East Field' }),
    room('farWest', 4, 0, { name: 'Far West' }),
    room('far', 5, 0, { name: 'Far Field' }),
    room('farEast', 6, 0, { name: 'Far East' }),
    room('sewer', 0, 0, { mapId: 'sewers', name: 'Sewer Mouth', zone: 'drains' }),
  ].map(t => ({ ...t, ...overrides[t.id] }));
  const content = recapContent({
    tiles,
    quests: QUESTS,
    npcs: { elder: ELDER },
    maps: [
      { id: 'overworld', name: 'Overworld', startTile: { col: 0, row: 0 } },
      { id: 'sewers', name: 'Sewers', startTile: { col: 0, row: 0 } },
    ],
    ...extra,
  });
  return recapSession(content);
}

function turnIn(session: ReturnType<typeof world>['session'], questId: string): void {
  session.quests.accept(QUESTS[questId], { playerLevel: session.getLevel(), partySize: 1, currentTileId: 'start' });
  expect(session.handleTurnInQuest(questId)).toEqual({ success: true });
}

function openedLines(session: ReturnType<typeof world>['session']) {
  return session.toSaveData().combatLog.filter(l => l.type === 'opened');
}

describe('Now open', () => {
  it('logs one line, naming the room, when the gating quest is turned in', () => {
    const { session } = world({ east: gated({ requiredQuestIds: ['bridge'] }) });
    turnIn(session, 'bridge');
    expect(openedLines(session)).toEqual([expect.objectContaining({ text: 'Now open: East Field', roomId: 'east' })]);
    const log = journal(session);
    expect(log.indexOf('Now open: East Field')).toBe(log.indexOf('Completed quest: Mend the Bridge') + 1);
  });

  it('names a door by its room and the map it leads to, or the room behind it on the same map', () => {
    const { session } = world({
      start: {
        transitions: [
          { mapId: 'sewers', tileId: 'sewer', entryRequirements: { requiredQuestIds: ['key'] } },
          { mapId: 'overworld', tileId: 'east', entryRequirements: { requiredQuestIds: ['key'] } },
        ],
      },
    });
    turnIn(session, 'key');
    expect(journal(session, 'opened')).toEqual(['Now open: Old Mill → Sewers', 'Now open: Old Mill → East Field']);
  });

  it('logs when a level-up reaches a room\'s minimum level, and not before', () => {
    const { session } = world({ east: gated({ minLevel: 3 }) });
    session.grantXp(xpForNextLevel(1));
    expect(session.getLevel()).toBe(2);
    expect(journal(session, 'opened')).toEqual([]);
    session.grantXp(xpForNextLevel(2));
    expect(journal(session, 'opened')).toEqual(['Now open: East Field']);
    session.grantXp(xpForNextLevel(3));
    expect(journal(session, 'opened')).toHaveLength(1);
  });

  it('says nothing about a room the player has not found yet', () => {
    const { session } = world({ far: gated({ requiredQuestIds: ['bridge'] }) });
    turnIn(session, 'bridge');
    expect(journal(session, 'opened')).toEqual([]);
  });

  it('stays quiet on a quest-and-level gate until both are met', () => {
    const { session } = world({ east: gated({ requiredQuestIds: ['bridge'], minLevel: 3 }) });
    turnIn(session, 'bridge');
    expect(journal(session, 'opened')).toEqual([]);
    session.grantXp(xpForNextLevel(1) + xpForNextLevel(2));
    expect(journal(session, 'opened')).toEqual(['Now open: East Field']);
  });

  it('announces a gate opened by both the quest and the level it pays once', () => {
    const { session } = world({ east: gated({ requiredQuestIds: ['scholar'], minLevel: 3 }) });
    turnIn(session, 'scholar');
    expect(session.getLevel()).toBe(3);
    expect(journal(session, 'opened')).toEqual(['Now open: East Field']);
  });

  it('leaves out a gate the player still fails on gear', () => {
    const { session } = world({ east: gated({ requiredQuestIds: ['bridge'], requiredItemId: 'lantern' }) });
    turnIn(session, 'bridge');
    expect(journal(session, 'opened')).toEqual([]);
  });

  it('collapses more than three openings into one line', () => {
    const gate = gated({ requiredQuestIds: ['bridge'] });
    const { session, hex } = world({ east: gate, farWest: gate, far: gate, farEast: gate });
    session.forceUnlockTileArea(hex('far'));
    turnIn(session, 'bridge');
    expect(openedLines(session)).toEqual([expect.objectContaining({ text: 'Now open: East Field, Far West and 2 more' })]);
    expect(openedLines(session)[0].roomId).toBeUndefined();
  });

  it('records an away moment for each line', () => {
    const { session } = world({ east: gated({ minLevel: 2 }) });
    session.beginAway();
    session.grantRewardXp(xpForNextLevel(1));
    expect(session.getAwayLedger()!.moments.filter(m => m.kind === 'opened').map(m => m.text)).toEqual(['Now open: East Field']);
  });

  it('ignores a level gate the player already met', () => {
    const { session } = world({ east: gated({ minLevel: 2 }) });
    setLevel(session, 4);
    session.grantXp(xpForNextLevel(4));
    expect(journal(session, 'opened')).toEqual([]);
  });

  it('opens a gate from the room\'s tile type', () => {
    const { session } = world({ east: { type: 'crypt' } }, {
      tileTypes: {
        plains: { id: 'plains', name: 'Plains', icon: '', color: '#000', traversable: true },
        crypt: { id: 'crypt', name: 'Crypt', icon: '', color: '#000', traversable: true, entryRequirements: { requiredQuestIds: ['bridge'] } },
      },
    });
    turnIn(session, 'bridge');
    expect(journal(session, 'opened')).toEqual(['Now open: East Field']);
  });
});
