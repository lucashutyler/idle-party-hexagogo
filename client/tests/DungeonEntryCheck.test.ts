import { describe, expect, it } from 'vitest';
import type {
  ClientCharacterState,
  DungeonDefinition,
  DungeonEntryRequirements,
  GamePartyMember,
  HiredHenchman,
  ItemDefinition,
  PlayerListEntry,
  ServerStateMessage,
} from '@idle-party-rpg/shared';
import { dungeonItemName, previewDungeonEntry } from '../src/ui/DungeonEntryCheck';

function dungeon(entryRequirements?: DungeonEntryRequirements): DungeonDefinition {
  return {
    id: 'd-crypt',
    name: 'Crypt',
    floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [] }],
    entryRequirements,
  };
}

interface StateParts {
  character?: Partial<ClientCharacterState> | null;
  members?: Partial<GamePartyMember>[] | null;
  allPlayers?: PlayerListEntry[];
  henchmen?: Partial<HiredHenchman>[];
  itemDefinitions?: Record<string, Partial<ItemDefinition>>;
}

function makeState(parts: StateParts = {}): ServerStateMessage {
  const character = parts.character === null
    ? null
    : { className: 'Knight', level: 10, inventory: {}, equipment: {}, ...parts.character };
  const party = parts.members === null
    ? null
    : {
      id: 'p1',
      members: (parts.members ?? [{ username: 'alice' }]).map(m => ({ role: 'member', gridPosition: 0, ...m })),
      henchmen: parts.henchmen ?? [],
    };
  return {
    username: 'alice',
    character,
    social: { party, allPlayers: parts.allPlayers ?? [] },
    itemDefinitions: parts.itemDefinitions ?? {},
  } as unknown as ServerStateMessage;
}

describe('previewDungeonEntry', () => {
  it('allows an unrestricted dungeon', () => {
    expect(previewDungeonEntry(dungeon(), makeState())).toBeNull();
  });

  it("gives the server's sentence for an under-level member resolved from the member's own fields", () => {
    const state = makeState({
      members: [{ username: 'alice' }, { username: 'bob', level: 3, className: 'Mage' }],
      allPlayers: [{ username: 'bob', level: 9, className: 'Mage' }],
    });
    expect(previewDungeonEntry(dungeon({ minLevel: 5 }), state)).toBe('bob must be at least level 5 to enter.');
  });

  it('falls back to allPlayers for a member without resolved fields', () => {
    const state = makeState({
      members: [{ username: 'alice' }, { username: 'bob' }],
      allPlayers: [{ username: 'bob', level: 3, className: 'Mage' }],
    });
    expect(previewDungeonEntry(dungeon({ minLevel: 5 }), state)).toBe('bob must be at least level 5 to enter.');
  });

  it("uses the viewer's own character for their level and class", () => {
    const state = makeState({
      character: { level: 2, className: 'Priest' },
      members: [{ username: 'alice', level: 30, className: 'Knight' }],
    });
    expect(previewDungeonEntry(dungeon({ minLevel: 5 }), state)).toBe('alice must be at least level 5 to enter.');
    expect(previewDungeonEntry(dungeon({ requiredClasses: ['Knight'] }), state)).toBe("alice's class cannot enter this dungeon.");
  });

  it('reports the level cap', () => {
    expect(previewDungeonEntry(dungeon({ maxLevel: 5 }), makeState())).toBe('alice is above the level cap (5) for this dungeon.');
  });

  it('requires an unequipped copy when the item is consumed', () => {
    const req: DungeonEntryRequirements = { requiredItemId: 'sigil', consumeRequiredItem: true };
    const items = { sigil: { id: 'sigil', name: 'Bone Sigil' } };
    const equippedOnly = makeState({ character: { equipment: { trinket: 'sigil' } }, itemDefinitions: items });
    expect(previewDungeonEntry(dungeon(req), equippedOnly)).toBe('alice needs Bone Sigil to enter.');
    const carried = makeState({ character: { inventory: { sigil: 1 } }, itemDefinitions: items });
    expect(previewDungeonEntry(dungeon(req), carried)).toBeNull();
  });

  it('accepts an equipped copy when the item is not consumed', () => {
    const state = makeState({ character: { equipment: { trinket: 'sigil' } } });
    expect(previewDungeonEntry(dungeon({ requiredItemId: 'sigil' }), state)).toBeNull();
  });

  it("names an item the viewer has never owned 'a key item'", () => {
    expect(previewDungeonEntry(dungeon({ requiredItemId: 'sigil' }), makeState())).toBe('alice needs a key item to enter.');
  });

  it("never blocks on another member's item", () => {
    const state = makeState({
      character: { inventory: { sigil: 1 } },
      members: [{ username: 'alice' }, { username: 'bob', level: 10, className: 'Mage' }],
    });
    expect(previewDungeonEntry(dungeon({ requiredItemId: 'sigil', consumeRequiredItem: true }), state)).toBeNull();
  });

  it('returns null when a member cannot be resolved', () => {
    const unknown = makeState({ members: [{ username: 'alice' }, { username: 'bob' }] });
    expect(previewDungeonEntry(dungeon({ minLevel: 50 }), unknown)).toBeNull();
    const levelOnly = makeState({ members: [{ username: 'alice' }, { username: 'bob', level: 1 }] });
    expect(previewDungeonEntry(dungeon({ minLevel: 50 }), levelOnly)).toBeNull();
    const noCharacter = makeState({ character: null });
    expect(previewDungeonEntry(dungeon({ minLevel: 50 }), noCharacter)).toBeNull();
  });

  it('never blocks on henchmen', () => {
    const state = makeState({ henchmen: [{ instanceId: 'h1', henchmanId: 'squire', level: 1 }] });
    expect(previewDungeonEntry(dungeon({ minLevel: 5, maxPartySize: 1 }), state)).toBeNull();
  });

  it('counts only players toward party size', () => {
    const state = makeState({ henchmen: [{ instanceId: 'h1', henchmanId: 'squire' }, { instanceId: 'h2', henchmanId: 'archer' }] });
    expect(previewDungeonEntry(dungeon({ minPartySize: 2 }), state)).toBe('Need at least 2 party members to enter.');
  });

  it('treats a viewer without party info as a solo party', () => {
    const state = makeState({ members: null });
    expect(previewDungeonEntry(dungeon({ minPartySize: 2 }), state)).toBe('Need at least 2 party members to enter.');
    expect(previewDungeonEntry(dungeon({ minLevel: 20 }), state)).toBe('alice must be at least level 20 to enter.');
  });

  it('reports a dungeon with no floors', () => {
    const empty = { ...dungeon(), floors: [] };
    expect(previewDungeonEntry(empty, makeState())).toBe('This dungeon is not ready yet.');
  });
});

describe('dungeonItemName', () => {
  it('names the required item, falls back for unknown ones, and is undefined without one', () => {
    const state = makeState({ itemDefinitions: { sigil: { id: 'sigil', name: 'Bone Sigil' } } });
    expect(dungeonItemName(dungeon({ requiredItemId: 'sigil' }), state)).toBe('Bone Sigil');
    expect(dungeonItemName(dungeon({ requiredItemId: 'other' }), state)).toBe('a key item');
    expect(dungeonItemName(dungeon({ requiredItemId: 'sigil' }), null)).toBe('a key item');
    expect(dungeonItemName(dungeon({ minLevel: 2 }), state)).toBeUndefined();
  });
});
