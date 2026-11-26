import { describe, expect, it } from 'vitest';
import type {
  GamePartyMember,
  PlayerListEntry,
  RoomEntryRequirements,
  ServerStateMessage,
  TileTypeDefinition,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import {
  UNKNOWN_QUEST_LOCK_TEXT,
  lockPreviewKey,
  previewRoomLock,
  previewTravelLock,
  roomLockLines,
  roomRequirements,
} from '../src/ui/RoomEntryCheck';

interface StateParts {
  level?: number;
  equipment?: Record<string, string | null>;
  completed?: string[];
  members?: Partial<GamePartyMember>[] | null;
  allPlayers?: PlayerListEntry[];
  questNames?: Record<string, string>;
  itemNames?: Record<string, string>;
  noCharacter?: boolean;
}

function makeState(parts: StateParts = {}): ServerStateMessage {
  return {
    username: 'alice',
    character: parts.noCharacter ? null : { level: parts.level ?? 5, equipment: parts.equipment ?? {}, inventory: {} },
    completedQuests: (parts.completed ?? []).map(questId => ({ questId, completedAt: '' })),
    questDefinitions: Object.fromEntries(Object.entries(parts.questNames ?? {}).map(([id, name]) => [id, { id, name }])),
    itemDefinitions: Object.fromEntries(Object.entries(parts.itemNames ?? {}).map(([id, name]) => [id, { id, name }])),
    social: {
      party: parts.members === null ? null : { id: 'p1', members: (parts.members ?? [{ username: 'alice' }]) },
      allPlayers: parts.allPlayers ?? [],
    },
  } as unknown as ServerStateMessage;
}

const kinds = (failures: ReturnType<typeof previewRoomLock>) => failures?.map(f => [f.kind, f.missingPlayers]) ?? null;

describe('previewRoomLock', () => {
  it('lets the server judge when there is nothing to check', () => {
    expect(previewRoomLock(undefined, makeState())).toBeNull();
    expect(previewRoomLock({}, makeState())).toBeNull();
    expect(previewRoomLock({ minLevel: 50 }, null)).toBeNull();
    expect(previewRoomLock({ minLevel: 50 }, makeState({ noCharacter: true }))).toBeNull();
  });

  it("lists every way the viewer falls short: item, level, then each quest", () => {
    const reqs: RoomEntryRequirements = { requiredItemId: 'lantern', minLevel: 8, requiredQuestIds: ['q1', 'q2', 'q3'] };
    const state = makeState({ level: 3, completed: ['q2'] });
    expect(kinds(previewRoomLock(reqs, state))).toEqual([
      ['item', ['alice']], ['level', ['alice']], ['quest', ['alice']], ['quest', ['alice']],
    ]);
    expect(previewRoomLock(reqs, state)!.map(f => f.questId).filter(Boolean)).toEqual(['q1', 'q3']);
  });

  it('opens once the viewer meets every requirement, wearing the item', () => {
    const reqs: RoomEntryRequirements = { requiredItemId: 'lantern', minLevel: 8, requiredQuestIds: ['q1'] };
    const carried = makeState({ level: 8, completed: ['q1'] });
    expect(kinds(previewRoomLock(reqs, carried))).toEqual([['item', ['alice']]]);
    const worn = makeState({ level: 8, completed: ['q1'], equipment: { trinket: 'lantern' } });
    expect(previewRoomLock(reqs, worn)).toBeNull();
  });

  it('blocks on another member under the level, from their own field or the player list', () => {
    const own = makeState({ level: 9, members: [{ username: 'alice' }, { username: 'bob', level: 4 }] });
    expect(kinds(previewRoomLock({ minLevel: 6 }, own))).toEqual([['level', ['bob']]]);
    const listed = makeState({
      level: 9,
      members: [{ username: 'alice' }, { username: 'bob' }],
      allPlayers: [{ username: 'bob', level: 4 }],
    });
    expect(kinds(previewRoomLock({ minLevel: 6 }, listed))).toEqual([['level', ['bob']]]);
  });

  it("assumes another member has the item and the quests, since the client can't see them", () => {
    const reqs: RoomEntryRequirements = { requiredItemId: 'lantern', requiredQuestIds: ['q1'] };
    const state = makeState({
      equipment: { trinket: 'lantern' },
      completed: ['q1'],
      members: [{ username: 'alice' }, { username: 'bob', level: 1 }],
    });
    expect(previewRoomLock(reqs, state)).toBeNull();
  });

  it("lets the server judge a level gate when a member's level is unknown", () => {
    const state = makeState({ level: 1, members: [{ username: 'alice' }, { username: 'bob' }] });
    expect(previewRoomLock({ minLevel: 50 }, state)).toBeNull();
    expect(kinds(previewRoomLock({ requiredQuestIds: ['q1'] }, state))).toEqual([['quest', ['alice']]]);
  });

  it('treats a viewer without party info as a solo party', () => {
    expect(kinds(previewRoomLock({ minLevel: 6 }, makeState({ level: 2, members: null })))).toEqual([['level', ['alice']]]);
  });

  it('reads the quest history once for a whole map of gated rooms, and again after a turn-in', () => {
    let reads = 0;
    const done = new Proxy({ questId: 'q-done', completedAt: '' }, {
      get(target, key, receiver) {
        if (key === 'questId') reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const state = { ...makeState(), completedQuests: [done] } as ServerStateMessage;
    for (let i = 0; i < 40; i++) previewRoomLock({ requiredQuestIds: [`q-${i}`, 'q-done'] }, state);
    expect(reads).toBe(1);

    const later = { ...state, completedQuests: [done, { questId: 'q-7', completedAt: '' }] } as ServerStateMessage;
    expect(previewRoomLock({ requiredQuestIds: ['q-7', 'q-done'] }, later)).toBeNull();
    expect(kinds(previewRoomLock({ requiredQuestIds: ['q-7'] }, state))).toEqual([['quest', ['alice']]]);
  });
});

describe('previewTravelLock', () => {
  const plains: TileTypeDefinition = { id: 'plains', name: 'Plains', icon: '', color: '#00ff00', traversable: true };
  const gated: TileTypeDefinition = { ...plains, id: 'gated', entryRequirements: { minLevel: 20 } };
  const types: Record<string, TileTypeDefinition> = { plains, gated };
  const cache = { getTileTypeDef: (id: string) => types[id] };
  const dest = (over: Partial<WorldTileDefinition> = {}): WorldTileDefinition =>
    ({ id: 'cellar', mapId: 'under', col: 0, row: 0, type: 'plains', zone: 'z', name: 'Cellar', ...over });

  it("checks the exit's own gate first", () => {
    const failures = previewTravelLock({ mapId: 'under', tileId: 'cellar', entryRequirements: { requiredQuestIds: ['q1'] } }, dest({ entryRequirements: { minLevel: 9 } }), cache, makeState());
    expect(kinds(failures)).toEqual([['quest', ['alice']]]);
  });

  it("then the room behind it, tile type included", () => {
    const link = { mapId: 'under', tileId: 'cellar' };
    expect(kinds(previewTravelLock(link, dest({ entryRequirements: { minLevel: 9 } }), cache, makeState()))).toEqual([['level', ['alice']]]);
    expect(previewTravelLock(link, dest({ type: 'gated' }), cache, makeState())![0].minLevel).toBe(20);
    expect(previewTravelLock(link, dest(), cache, makeState())).toBeNull();
    expect(previewTravelLock(link, undefined, cache, makeState())).toBeNull();
  });

  it('folds the legacy item gate into the room behind the exit', () => {
    const failures = previewTravelLock({ mapId: 'under', tileId: 'cellar' }, dest({ requiredItemId: 'lantern' }), cache, makeState());
    expect(failures![0].itemId).toBe('lantern');
  });
});

describe('roomRequirements', () => {
  it("merges the room's gate over its type's", () => {
    const cache = { getTileTypeDef: () => ({ id: 't', name: 'T', icon: '', color: '#000000', traversable: true, entryRequirements: { minLevel: 4, requiredItemId: 'boots' } }) };
    const def = { id: 'r', mapId: 'm', col: 0, row: 0, type: 't', zone: 'z', name: 'R', entryRequirements: { minLevel: 9 } };
    expect(roomRequirements(def, cache)).toEqual({ minLevel: 9, requiredItemId: 'boots' });
  });
});

describe('roomLockLines', () => {
  it("says what the viewer needs and who else in the party is short", () => {
    const state = makeState({
      level: 1,
      members: [{ username: 'alice' }, { username: 'bob', level: 2 }, { username: 'cat', level: 3 }, { username: 'dan', level: 9 }],
    });
    expect(roomLockLines(previewRoomLock({ minLevel: 6 }, state)!, state)).toEqual([
      "Needs level 6 (you're level 1)",
      'bob and cat need level 6',
    ]);
    const others = makeState({ level: 7, members: [{ username: 'alice' }, { username: 'bob', level: 2 }] });
    expect(roomLockLines(previewRoomLock({ minLevel: 6 }, others)!, others)).toEqual(['bob needs level 6']);
  });

  it('names a quest the player knows, and keeps any other quest a mystery, once', () => {
    const state = makeState({ questNames: { q1: 'The Lost Kite' } });
    const failures = previewRoomLock({ requiredQuestIds: ['q1', 'q2', 'q3'] }, state)!;
    expect(roomLockLines(failures, state)).toEqual(['Complete the quest "The Lost Kite"', UNKNOWN_QUEST_LOCK_TEXT]);
  });

  it('names an item the player has seen, and says it must be worn', () => {
    const known = makeState({ itemNames: { lantern: 'Glowing Lantern' } });
    expect(roomLockLines(previewRoomLock({ requiredItemId: 'lantern' }, known)!, known)).toEqual(['Needs Glowing Lantern equipped']);
    const unknown = makeState();
    expect(roomLockLines(previewRoomLock({ requiredItemId: 'lantern' }, unknown)!, unknown)).toEqual(['Needs a special item equipped']);
  });
});

describe('lockPreviewKey', () => {
  const base: StateParts = { level: 5, completed: ['q1'], equipment: { head: 'cap', hands: null }, members: [{ username: 'alice' }, { username: 'bob', level: 3 }] };

  it('stays put while nothing a lock depends on changes', () => {
    expect(lockPreviewKey(makeState(base))).toBe(lockPreviewKey(makeState({ ...base, questNames: { q9: 'Other' } })));
    expect(lockPreviewKey(makeState({ ...base, equipment: { hands: null, head: 'cap' } }))).toBe(lockPreviewKey(makeState(base)));
  });

  it('moves with level, quests, gear and party levels', () => {
    const key = lockPreviewKey(makeState(base));
    expect(lockPreviewKey(makeState({ ...base, level: 6 }))).not.toBe(key);
    expect(lockPreviewKey(makeState({ ...base, completed: ['q1', 'q2'] }))).not.toBe(key);
    expect(lockPreviewKey(makeState({ ...base, equipment: { head: 'helm' } }))).not.toBe(key);
    expect(lockPreviewKey(makeState({ ...base, members: [{ username: 'alice' }, { username: 'bob', level: 4 }] }))).not.toBe(key);
    expect(lockPreviewKey(makeState({ ...base, members: [{ username: 'alice' }] }))).not.toBe(key);
  });

  it('is empty without a character', () => {
    expect(lockPreviewKey(null)).toBe('');
    expect(lockPreviewKey(makeState({ noCharacter: true }))).toBe('');
  });
});
