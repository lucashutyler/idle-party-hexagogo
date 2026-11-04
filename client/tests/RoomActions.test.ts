import { describe, expect, it } from 'vitest';
import type {
  DungeonDefinition,
  NpcDefinition,
  ServerStateMessage,
  ShopSummary,
  WorldMapMeta,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import {
  HIRE_DETAIL,
  QUEST_AVAILABLE_DETAIL,
  QUEST_READY_DETAIL,
  ROOM_ICONS,
  actionLabel,
  getRoomActions,
  questMarks,
  questPipClass,
} from '../src/ui/RoomActions';
import type { QuestMarks, RoomActionLookups } from '../src/ui/RoomActions';

const NPCS: Record<string, NpcDefinition> = {
  mira: { id: 'mira', name: 'Mira', emoji: '🧙', greeting: 'Hi', questIds: ['q1', 'q2'] },
};
const SHOPS: Record<string, ShopSummary> = {
  store: { id: 'store', name: 'General Store', sellsItems: true, hiresHenchmen: false },
  guild: { id: 'guild', name: 'Mercenary Guild', sellsItems: false, hiresHenchmen: true },
  both: { id: 'both', name: 'Outfitters', sellsItems: true, hiresHenchmen: true },
};
const DUNGEONS: Record<string, DungeonDefinition> = {
  caves: { id: 'caves', name: 'Crystal Caves', floors: [] },
};
const TILES: Record<string, WorldTileDefinition> = {
  gate: { id: 'gate', mapId: 'forest', col: 1, row: 1, type: 'plains', zone: 'wood', name: 'Darkwood Gate' },
  nameless: { id: 'nameless', mapId: 'sewers', col: 2, row: 2, type: 'plains', zone: 'sewer', name: '' },
};
const MAPS: WorldMapMeta[] = [
  { id: 'forest', name: 'Darkwood', startTile: { col: 0, row: 0 } },
  { id: 'sewers', name: 'The Sewers', startTile: { col: 0, row: 0 } },
];

function marks(ready: string[] = [], available: string[] = []): QuestMarks {
  return { ready: new Set(ready), available: new Set(available) };
}

const lookups: RoomActionLookups = {
  getNpc: id => NPCS[id],
  getShop: id => SHOPS[id],
  getDungeon: id => DUNGEONS[id],
  getTileByGuid: id => TILES[id],
  getMaps: () => MAPS,
};

describe('getRoomActions', () => {
  it('returns nothing for an empty room', () => {
    expect(getRoomActions({}, lookups)).toEqual([]);
  });

  it('orders actions npc, shop, dungeon, then one per exit', () => {
    const actions = getRoomActions({
      transitions: [{ mapId: 'forest', tileId: 'gate' }, { mapId: 'sewers', tileId: 'nameless' }],
      dungeonId: 'caves',
      shopId: 'store',
      npcId: 'mira',
    }, lookups);
    expect(actions.map(a => a.kind)).toEqual(['npc', 'shop', 'dungeon', 'travel', 'travel']);
    expect(actions.map(a => a.targetId)).toEqual(['mira', 'store', 'caves', 'gate', 'nameless']);
  });

  it('skips npc, shop and dungeon ids that no longer resolve', () => {
    const actions = getRoomActions({ npcId: 'ghost', shopId: 'gone', dungeonId: 'collapsed' }, lookups);
    expect(actions).toEqual([]);
  });

  it('uses the npc portrait emoji and name', () => {
    const [npc] = getRoomActions({ npcId: 'mira' }, lookups);
    expect(npc).toEqual({ kind: 'npc', icon: '🧙', name: 'Mira', targetId: 'mira' });
  });

  it('flags an npc whose quest is ready to turn in', () => {
    const [npc] = getRoomActions({ npcId: 'mira' }, lookups, marks(['q2']));
    expect(npc.detail).toBe(QUEST_READY_DETAIL);
    expect(npc.questReady).toBe(true);
    expect(questPipClass(npc)).toBe('quest-ready-pip');
  });

  it('flags an npc with a quest the player can take now', () => {
    const [npc] = getRoomActions({ npcId: 'mira' }, lookups, marks([], ['q1']));
    expect(npc.detail).toBe(QUEST_AVAILABLE_DETAIL);
    expect(npc.questAvailable).toBe(true);
    expect(npc.questReady).toBeUndefined();
    expect(questPipClass(npc)).toBe('quest-available-pip');
  });

  it('shows a ready turn-in over a new quest at the same npc', () => {
    const [npc] = getRoomActions({ npcId: 'mira' }, lookups, marks(['q2'], ['q1']));
    expect(npc.detail).toBe(QUEST_READY_DETAIL);
    expect(npc.questReady).toBe(true);
    expect(npc.questAvailable).toBeUndefined();
    expect(questPipClass(npc)).toBe('quest-ready-pip');
  });

  it('ignores ready and available quests the npc does not offer', () => {
    const [npc] = getRoomActions({ npcId: 'mira' }, lookups, marks(['other'], ['elsewhere']));
    expect(npc.detail).toBeUndefined();
    expect(npc.questReady).toBeUndefined();
    expect(npc.questAvailable).toBeUndefined();
    expect(questPipClass(npc)).toBe('');
  });

  it('marks a shop that sells items with a coin', () => {
    const [shop] = getRoomActions({ shopId: 'store' }, lookups);
    expect(shop).toEqual({ kind: 'shop', icon: ROOM_ICONS.shop, name: 'General Store', targetId: 'store' });
  });

  it('marks a hire-only shop with a handshake', () => {
    const [shop] = getRoomActions({ shopId: 'guild' }, lookups);
    expect(shop.icon).toBe(ROOM_ICONS.hire);
    expect(shop.detail).toBeUndefined();
  });

  it('notes henchmen for hire on a shop that also sells items', () => {
    const [shop] = getRoomActions({ shopId: 'both' }, lookups);
    expect(shop.icon).toBe(ROOM_ICONS.shop);
    expect(shop.detail).toBe(HIRE_DETAIL);
  });

  it('names a dungeon with the key glyph', () => {
    const [dungeon] = getRoomActions({ dungeonId: 'caves' }, lookups);
    expect(dungeon).toEqual({ kind: 'dungeon', icon: ROOM_ICONS.dungeon, name: 'Crystal Caves', targetId: 'caves' });
  });

  it('names an exit after its destination room, then its map, then a generic passage', () => {
    const actions = getRoomActions({
      transitions: [
        { mapId: 'forest', tileId: 'gate' },
        { mapId: 'sewers', tileId: 'nameless' },
        { mapId: 'nowhere', tileId: 'missing' },
      ],
    }, lookups);
    expect(actions.map(a => a.name)).toEqual(['Darkwood Gate', 'The Sewers', 'a passage']);
    expect(actions.every(a => a.icon === ROOM_ICONS.travel)).toBe(true);
  });
});

describe('actionLabel', () => {
  it('phrases each kind as something to do', () => {
    const actions = getRoomActions({
      npcId: 'mira',
      shopId: 'store',
      dungeonId: 'caves',
      transitions: [{ mapId: 'forest', tileId: 'gate' }],
    }, lookups);
    expect(actions.map(actionLabel)).toEqual([
      'Talk to Mira',
      'General Store',
      'Enter Crystal Caves',
      'Travel to Darkwood Gate',
    ]);
  });
});

describe('questMarks', () => {
  it('collects quests ready to turn in and quests available to accept', () => {
    const state = {
      activeQuests: [
        { questId: 'a', status: 'ready', progress: [], acceptedAt: '' },
        { questId: 'b', status: 'in_progress', progress: [], acceptedAt: '' },
        { questId: 'c', status: 'ready', progress: [], acceptedAt: '' },
      ],
      availableQuestIds: ['d', 'e'],
    } as unknown as ServerStateMessage;
    const { ready, available } = questMarks(state);
    expect([...ready].sort()).toEqual(['a', 'c']);
    expect([...available]).toEqual(['d', 'e']);
  });

  it('is empty without a state or quest fields', () => {
    expect(questMarks().ready.size).toBe(0);
    expect(questMarks(null).available.size).toBe(0);
    expect(questMarks({} as ServerStateMessage).available.size).toBe(0);
  });
});

describe('questPipClass', () => {
  it('marks only npcs with quest news', () => {
    expect(questPipClass({ kind: 'shop', icon: '🪙', name: 'Store', targetId: 's' })).toBe('');
  });
});
