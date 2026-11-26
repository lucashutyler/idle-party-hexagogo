import { HexGrid, HexTile, offsetToCube, DEFAULT_MAP_ID } from '@idle-party-rpg/shared';
import type {
  EncounterDefinition,
  ItemDefinition,
  MonsterDefinition,
  NpcDefinition,
  QuestDefinition,
  RecipeDefinition,
  TileTypeDefinition,
  WorldMapMeta,
  WorldTileDefinition,
  ZoneDefinition,
} from '@idle-party-rpg/shared';
import type { ContentStore } from '../src/game/ContentStore.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import { wrapGrids, fakeSkillContent } from './testGrids.js';

/** Invented content for journal, recap and lock-opening tests. */
export interface RecapContent {
  tiles: WorldTileDefinition[];
  maps?: WorldMapMeta[];
  tileTypes?: Record<string, TileTypeDefinition>;
  quests?: Record<string, QuestDefinition>;
  npcs?: Record<string, NpcDefinition>;
  items?: Record<string, ItemDefinition>;
  recipes?: Record<string, RecipeDefinition>;
  monsters?: Record<string, MonsterDefinition>;
  encounters?: Record<string, EncounterDefinition>;
  zones?: Record<string, ZoneDefinition>;
}

export type MutableContent = ContentStore & { contentEpoch: number };

export function room(id: string, col: number, row: number, extra: Partial<WorldTileDefinition> = {}): WorldTileDefinition {
  return { id, mapId: DEFAULT_MAP_ID, col, row, type: 'plains', zone: 'meadow', name: id, ...extra };
}

export function recapContent(spec: RecapContent): MutableContent {
  const tileTypes = spec.tileTypes ?? { plains: { id: 'plains', name: 'Plains', icon: '', color: '#7ec850', traversable: true } };
  const quests = spec.quests ?? {};
  const items = spec.items ?? {};
  const zones = spec.zones ?? { meadow: { id: 'meadow', displayName: 'Meadow', encounterTable: [], levelRange: [1, 1] } };
  const maps = spec.maps ?? [{ id: DEFAULT_MAP_ID, name: 'Overworld', startTile: { col: 0, row: 0 } }];
  const content = {
    contentEpoch: 1,
    getStartTile: () => ({ col: 0, row: 0 }),
    getWorld: () => ({ tiles: spec.tiles, startTile: { col: 0, row: 0 }, defaultMapId: DEFAULT_MAP_ID, maps }),
    getAllTileTypes: () => tileTypes,
    getTileById: (id: string) => spec.tiles.find(t => t.id === id),
    getZone: (id: string) => zones[id],
    getAllZones: () => zones,
    getMonster: (id: string) => spec.monsters?.[id],
    getAllMonsters: () => spec.monsters ?? {},
    getAllEncounters: () => spec.encounters ?? {},
    getItem: (id: string) => items[id],
    getAllItems: () => items,
    getAllSets: () => ({}),
    getAllRecipes: () => spec.recipes ?? {},
    getRecipe: (id: string) => spec.recipes?.[id],
    getAllShops: () => ({}),
    getShop: () => undefined,
    getNpc: (id: string) => spec.npcs?.[id],
    getAllNpcs: () => spec.npcs ?? {},
    getQuest: (id: string) => quests[id],
    getAllQuests: () => quests,
    getQuestCatalog: () => quests,
    getQuestRevision: () => 0,
    getNpcQuestIds: () => Object.values(spec.npcs ?? {}).flatMap(npc => npc.questIds ?? []),
    getDungeon: () => undefined,
    getAllDungeons: () => ({}),
    ...fakeSkillContent(),
  };
  return content as unknown as MutableContent;
}

/** A Knight standing on the room at (0, 0); every room in `tiles` is on the grid. */
export function recapSession(content: MutableContent): { session: PlayerSession; hex: (id: string) => HexTile } {
  const grid = new HexGrid();
  const tileTypes = content.getAllTileTypes();
  for (const t of content.getWorld().tiles) {
    if (t.mapId !== DEFAULT_MAP_ID) continue;
    grid.addTile(new HexTile(offsetToCube({ col: t.col, row: t.row }), t.type, t.zone, t.id, t.requiredItemId, tileTypes[t.type], t.entryRequirements));
  }
  const session = new PlayerSession('alice', wrapGrids(grid), content);
  session.setClass('Knight');
  const hex = (id: string): HexTile => {
    const t = content.getTileById(id)!;
    return grid.getTile(offsetToCube({ col: t.col, row: t.row }))!;
  };
  session.getCurrentTile = () => hex(content.getWorld().tiles[0].id);
  return { session, hex };
}

export function journal(session: PlayerSession, type?: string): string[] {
  return session.toSaveData().combatLog.filter(l => !type || l.type === type).map(l => l.text);
}

export function setLevel(session: PlayerSession, level: number): void {
  (session as unknown as { character: { level: number; xp: number } }).character.level = level;
}
