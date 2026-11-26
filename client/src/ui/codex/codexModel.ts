import type {
  CodexKind,
  CodexMonster,
  CodexRef,
  CodexShop,
  CodexTable,
  ItemDefinition,
  RecipeDefinition,
  ServerCodexMessage,
  ServerStateMessage,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import { codexRefKey, codexTableKey, cubeDistance, offsetToCube, questTitle } from '@idle-party-rpg/shared';
import type { WorldCache } from '../../network/WorldCache';
import { RARITY_ORDER } from '../ItemIcon';

export type CodexWorld = Pick<WorldCache,
  'getTileByGuid' | 'getTileOn' | 'routeIndex' | 'getMaps' | 'getDungeon' | 'getShop' | 'getNpc' | 'getRoomLevels'
  | 'getSkillContent' | 'contentGeneration'>;

export interface CodexItemEntry {
  def: ItemDefinition;
  /** Has been in the player's bags, or is there now. */
  found: boolean;
}

export interface CodexRoomFights {
  /** Each known fight as the met monsters in it. */
  fights: string[][];
  /** Met monsters the room can spawn that no fight line names. */
  others: string[];
}

export interface CodexIndex {
  monsters: ReadonlyMap<string, CodexMonster>;
  items: ReadonlyMap<string, CodexItemEntry>;
  shops: ReadonlyMap<string, CodexShop>;
  /** Found walkable rooms, in the order they were found. */
  rooms: ReadonlyMap<string, WorldTileDefinition>;
  roomsOfMonster: ReadonlyMap<string, readonly string[]>;
  fightsOfRoom(roomId: string): CodexRoomFights;
  droppedBy: ReadonlyMap<string, readonly { monsterId: string; seen: number }[]>;
  soldAt: ReadonlyMap<string, readonly { shopId: string; price: number }[]>;
  roomsOfShop: ReadonlyMap<string, readonly string[]>;
  recipesMaking: ReadonlyMap<string, readonly RecipeDefinition[]>;
  recipesUsing: ReadonlyMap<string, readonly RecipeDefinition[]>;
  dungeonsOfMonster: ReadonlyMap<string, readonly string[]>;
  dungeonsRewarding: ReadonlyMap<string, readonly string[]>;
  entrancesOfDungeon: ReadonlyMap<string, readonly string[]>;
  recent: readonly CodexRef[];
}

export type CodexSort = 'newest' | 'name' | 'level' | 'rarity';
export type CodexListSort = Exclude<CodexKind, 'room'>;

export const CODEX_SORTS: Readonly<Record<CodexListSort, readonly CodexSort[]>> = {
  monster: ['newest', 'name', 'level'],
  item: ['newest', 'name', 'rarity'],
  shop: ['newest', 'name'],
};

export const CODEX_SORT_LABELS: Readonly<Record<CodexSort, string>> = {
  newest: 'Newest',
  name: 'Name',
  level: 'Level',
  rarity: 'Rarity',
};

export type CodexTravelBlock = 'dungeon' | 'not_leader' | null;

export interface CodexQuestLine {
  title: string;
  kind: 'reward' | 'needed';
  active: boolean;
}

export interface CodexZoneGroup {
  zoneId: string;
  zoneName: string;
  rooms: WorldTileDefinition[];
}

export interface CodexMapGroup {
  mapId: string;
  mapName: string;
  count: number;
  zones: CodexZoneGroup[];
}

const NO_FIGHTS: CodexRoomFights = { fights: [], others: [] };

function push<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

/** Items in the bags or worn right now. */
export function ownedItemIds(state: Pick<ServerStateMessage, 'character'> | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const [id, count] of Object.entries(state?.character?.inventory ?? {})) {
    if (count > 0) ids.add(id);
  }
  for (const id of Object.values(state?.character?.equipment ?? {})) {
    if (id) ids.add(id);
  }
  return ids;
}

export function roomName(tile: Pick<WorldTileDefinition, 'name'>): string {
  return tile.name || 'Unnamed Room';
}

/** Everything the Codex shows, joined from the reply, the state and the world. Copies; never mutates its inputs. */
export function buildCodexIndex(codex: ServerCodexMessage | null, state: ServerStateMessage | null, world: CodexWorld): CodexIndex {
  const monsters = new Map<string, CodexMonster>();
  const items = new Map<string, CodexItemEntry>();
  const shops = new Map<string, CodexShop>();
  const rooms = new Map<string, WorldTileDefinition>();
  const roomsOfMonster = new Map<string, string[]>();
  const droppedBy = new Map<string, { monsterId: string; seen: number }[]>();
  const soldAt = new Map<string, { shopId: string; price: number }[]>();
  const roomsOfShop = new Map<string, string[]>();
  const recipesMaking = new Map<string, RecipeDefinition[]>();
  const recipesUsing = new Map<string, RecipeDefinition[]>();
  const dungeonsOfMonster = new Map<string, string[]>();
  const dungeonsRewarding = new Map<string, string[]>();
  const entrancesOfDungeon = new Map<string, string[]>();
  const tableOfRoom = new Map<string, CodexTable>();

  for (const monster of codex?.monsters ?? []) {
    monsters.set(monster.id, monster);
    for (const drop of monster.drops) push(droppedBy, drop.itemId, { monsterId: monster.id, seen: drop.seen });
  }
  for (const list of droppedBy.values()) list.sort((a, b) => b.seen - a.seen);

  for (const item of codex?.items ?? []) items.set(item.def.id, { def: item.def, found: item.found });

  for (const shop of codex?.shops ?? []) {
    shops.set(shop.id, shop);
    for (const stock of shop.stock) push(soldAt, stock.itemId, { shopId: shop.id, price: stock.price });
  }
  for (const list of soldAt.values()) list.sort((a, b) => a.price - b.price);

  const catalog = state?.craftingCatalog;
  for (const recipe of catalog?.recipes ?? []) {
    push(recipesMaking, recipe.result.itemId, recipe);
    for (const id of new Set(recipe.ingredients.map(i => i.itemId))) push(recipesUsing, id, recipe);
    for (const id of [recipe.result.itemId, ...recipe.ingredients.map(i => i.itemId)]) {
      const def = catalog?.itemDefs[id];
      if (def && !items.has(id)) items.set(id, { def, found: false });
    }
  }
  for (const id of ownedItemIds(state)) {
    const def = items.get(id)?.def ?? state?.itemDefinitions?.[id];
    if (def) items.set(id, { def, found: true });
  }

  const tables = new Map((codex?.tables ?? []).map(table => [table.key, table]));
  const routes = world.routeIndex();
  for (const id of state?.unlocked ?? []) {
    if (rooms.has(id)) continue;
    const tile = world.getTileByGuid(id);
    if (!tile || routes.areaOf(id) === undefined) continue;
    rooms.set(id, tile);
    const table = tables.get(codexTableKey(tile));
    if (table) {
      tableOfRoom.set(id, table);
      for (const monsterId of table.monsters) if (monsters.has(monsterId)) push(roomsOfMonster, monsterId, id);
    }
    if (tile.shopId && shops.has(tile.shopId)) push(roomsOfShop, tile.shopId, id);
    if (tile.dungeonId) push(entrancesOfDungeon, tile.dungeonId, id);
  }

  for (const dungeon of codex?.dungeons ?? []) {
    for (const monsterId of dungeon.monsters) if (monsters.has(monsterId)) push(dungeonsOfMonster, monsterId, dungeon.id);
    const def = world.getDungeon(dungeon.id);
    if (!def) continue;
    const rewards = [...def.floors.flatMap(floor => floor.rewards ?? []), ...(def.firstClearRewards ?? [])];
    for (const itemId of new Set(rewards.map(r => r.itemId))) push(dungeonsRewarding, itemId, dungeon.id);
  }

  const fightsOfRoom = (roomId: string): CodexRoomFights => {
    const table = tableOfRoom.get(roomId);
    if (!table) return NO_FIGHTS;
    const seen = new Set<string>();
    const fights: string[][] = [];
    for (const index of table.fights) {
      const line = (codex?.fights[index] ?? []).filter(id => monsters.has(id));
      const key = line.join('\n');
      if (line.length === 0 || seen.has(key)) continue;
      seen.add(key);
      fights.push(line);
    }
    const named = new Set(fights.flat());
    return { fights, others: table.monsters.filter(id => monsters.has(id) && !named.has(id)) };
  };

  const index: CodexIndex = {
    monsters,
    items,
    shops,
    rooms,
    roomsOfMonster,
    fightsOfRoom,
    droppedBy,
    soldAt,
    roomsOfShop,
    recipesMaking,
    recipesUsing,
    dungeonsOfMonster,
    dungeonsRewarding,
    entrancesOfDungeon,
    recent: [],
  };
  return { ...index, recent: (codex?.recent ?? []).filter(ref => hasCodexEntry(index, ref)) };
}

export function hasCodexEntry(index: CodexIndex, ref: CodexRef): boolean {
  switch (ref.kind) {
    case 'monster': return index.monsters.has(ref.id);
    case 'item': return index.items.has(ref.id);
    case 'shop': return index.shops.has(ref.id);
    case 'room': return index.rooms.has(ref.id);
  }
}

/** Kills from the state's recent mastery entries, which are fresher than the reply's. */
export function monsterKills(monster: CodexMonster, state: Pick<ServerStateMessage, 'character'> | null | undefined): number {
  const recent = state?.character?.mastery?.recent.find(entry => entry.monsterId === monster.id);
  return recent?.kills ?? monster.kills;
}

/** Name matches by kind, each sorted by name. Rooms also match their zone's name. */
export function searchCodex(index: CodexIndex, query: string, kind?: CodexKind): Record<CodexKind, CodexRef[]> {
  const found: Record<CodexKind, CodexRef[]> = { monster: [], item: [], room: [], shop: [] };
  const q = query.trim().toLowerCase();
  if (!q) return found;
  const hit = (...names: (string | undefined)[]) => names.some(name => !!name && name.toLowerCase().includes(q));
  const want = (k: CodexKind) => !kind || kind === k;
  if (want('monster')) {
    found.monster = [...index.monsters.values()].filter(m => hit(m.name)).sort(byName).map(m => ({ kind: 'monster', id: m.id }));
  }
  if (want('item')) {
    found.item = [...index.items.values()].filter(i => hit(i.def.name)).map(i => i.def).sort(byName).map(def => ({ kind: 'item', id: def.id }));
  }
  if (want('room')) {
    found.room = [...index.rooms.values()].filter(t => hit(roomName(t), t.zoneName))
      .sort((a, b) => roomName(a).localeCompare(roomName(b))).map(t => ({ kind: 'room', id: t.id }));
  }
  if (want('shop')) {
    found.shop = [...index.shops.values()].filter(s => hit(s.name)).sort(byName).map(s => ({ kind: 'shop', id: s.id }));
  }
  return found;
}

export function sortMonsters(list: readonly CodexMonster[], sort: CodexSort): CodexMonster[] {
  const out = [...list];
  if (sort === 'newest') return out.reverse();
  if (sort === 'level') return out.sort((a, b) => (a.level ?? Infinity) - (b.level ?? Infinity) || byName(a, b));
  return out.sort(byName);
}

/** Newest puts what has been held first, newest first, then what has only been seen. */
export function sortItems(list: readonly CodexItemEntry[], sort: CodexSort): CodexItemEntry[] {
  if (sort === 'newest') return [...list.filter(i => i.found).reverse(), ...list.filter(i => !i.found)];
  const out = [...list];
  if (sort === 'rarity') {
    return out.sort((a, b) => (RARITY_ORDER[a.def.rarity] ?? 99) - (RARITY_ORDER[b.def.rarity] ?? 99) || byName(a.def, b.def));
  }
  return out.sort((a, b) => byName(a.def, b.def));
}

export function sortShops(list: readonly CodexShop[], sort: CodexSort): CodexShop[] {
  const out = [...list];
  return sort === 'newest' ? out.reverse() : out.sort(byName);
}

/** Found rooms by map (world order), then zone and room by name. */
export function roomGroups(rooms: Iterable<WorldTileDefinition>, world: Pick<CodexWorld, 'getMaps'>): CodexMapGroup[] {
  const maps = world.getMaps();
  const groups = new Map<string, Map<string, CodexZoneGroup>>();
  for (const tile of rooms) {
    let zones = groups.get(tile.mapId);
    if (!zones) groups.set(tile.mapId, zones = new Map());
    let zone = zones.get(tile.zone);
    if (!zone) zones.set(tile.zone, zone = { zoneId: tile.zone, zoneName: tile.zoneName || tile.zone, rooms: [] });
    zone.rooms.push(tile);
  }
  const order = [...maps.map(m => m.id).filter(id => groups.has(id)), ...[...groups.keys()].filter(id => !maps.some(m => m.id === id))];
  return order.map(mapId => {
    const zones = [...groups.get(mapId)!.values()].sort((a, b) => a.zoneName.localeCompare(b.zoneName));
    for (const zone of zones) zone.rooms.sort((a, b) => roomName(a).localeCompare(roomName(b)));
    return {
      mapId,
      mapName: maps.find(m => m.id === mapId)?.name || mapId,
      count: zones.reduce((n, z) => n + z.rooms.length, 0),
      zones,
    };
  });
}

export function partyRoom(state: Pick<ServerStateMessage, 'currentMapId' | 'party'> | null | undefined, world: Pick<CodexWorld, 'getTileOn'>): WorldTileDefinition | undefined {
  if (!state?.party) return undefined;
  return world.getTileOn(state.currentMapId, state.party.col, state.party.row);
}

/** A cheap nearest-first order: the party's own area by distance, the rest of its map by distance, then other maps in world order. */
export function closestRooms(
  roomIds: readonly string[],
  state: Pick<ServerStateMessage, 'currentMapId' | 'party'> | null | undefined,
  world: Pick<CodexWorld, 'getTileByGuid' | 'getTileOn' | 'routeIndex' | 'getMaps'>,
): string[] {
  const here = partyRoom(state, world);
  const routes = world.routeIndex();
  const hereArea = here ? routes.areaOf(here.id) : undefined;
  const mapOrder = new Map(world.getMaps().map((m, i) => [m.id, i]));
  const ranked = roomIds.flatMap(id => {
    const tile = world.getTileByGuid(id);
    if (!tile) return [];
    const sameMap = !!here && tile.mapId === here.mapId;
    const tier = sameMap && hereArea !== undefined && routes.areaOf(id) === hereArea ? 0 : sameMap ? 1 : 2;
    const distance = sameMap ? cubeDistance(offsetToCube(tile), offsetToCube(here!)) : mapOrder.get(tile.mapId) ?? mapOrder.size;
    return [{ id, tier, distance, name: roomName(tile) }];
  });
  ranked.sort((a, b) => a.tier - b.tier || a.distance - b.distance || a.name.localeCompare(b.name));
  return ranked.map(r => r.id);
}

/** Why Go would be refused; the server checks again. */
export function travelBlock(state: Pick<ServerStateMessage, 'dungeon' | 'social' | 'username'> | null | undefined): CodexTravelBlock {
  if (state?.dungeon) return 'dungeon';
  const me = state?.social?.party?.members.find(m => m.username === state.username);
  if (me && me.role !== 'owner' && me.role !== 'leader') return 'not_leader';
  return null;
}

export function newRecentKeys(recent: readonly CodexRef[], seen: readonly string[]): Set<string> {
  const known = new Set(seen);
  return new Set(recent.map(codexRefKey).filter(key => !known.has(key)));
}

/** Quests the player has taken or finished that give the item, and active ones that collect it. */
export function itemQuestLines(
  itemId: string,
  state: Pick<ServerStateMessage, 'questDefinitions' | 'activeQuests' | 'completedQuests'> | null | undefined,
): CodexQuestLine[] {
  const defs = state?.questDefinitions ?? {};
  const lines: CodexQuestLine[] = [];
  const seen = new Set<string>();
  for (const entry of state?.activeQuests ?? []) {
    const def = defs[entry.questId];
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    if (def.rewards.some(r => r.kind === 'item' && r.itemId === itemId)) lines.push({ title: questTitle(def), kind: 'reward', active: true });
    if (def.objectives.some(o => o.kind === 'collect' && o.itemId === itemId)) lines.push({ title: questTitle(def), kind: 'needed', active: true });
  }
  for (const entry of state?.completedQuests ?? []) {
    const def = defs[entry.questId];
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    if (def.rewards.some(r => r.kind === 'item' && r.itemId === itemId)) lines.push({ title: questTitle(def), kind: 'reward', active: false });
  }
  return lines;
}
