import { DEFAULT_MAP_ID, SEED_SKILLS, SEED_SKILL_SLOT_SCHEDULES, TILE_CONFIGS, buildRouteIndex, getSlotSchedule, isTileTraversable } from '@idle-party-rpg/shared';
import type { WorldTileDefinition, WorldMapMeta, TileTypeDefinition, NpcDefinition, DungeonDefinition, ShopSummary, SkillDefinition, SkillSlot, SkillContent, ClassName, TileType, RouteIndex } from '@idle-party-rpg/shared';
import type { LevelBand } from '../ui/roomLevels';

export interface MapRoomsFound {
  name: string;
  found: number;
  total: number;
}

/** Without the server's catalog there is no telling whether this world has Attack skills, so none are shown. */
const FALLBACK_SKILLS = Object.fromEntries(Object.entries(SEED_SKILLS).filter(([, skill]) => skill.type !== 'attack'));

/**
 * Client-side cache for world data.
 * Loaded once from GET /api/world on login.
 *
 * A world holds multiple maps; `currentMapId` is the map being drawn: the party's, or one the
 * player is viewing (ThreeWorldMap sets it). Tiles are indexed by `mapId:col:row` so rooms at
 * the same (col,row) on different maps don't collide. Fog of war is determined by
 * state.unlocked (sent with every state push).
 */
export class WorldCache {
  /** Keyed by "mapId:col:row". */
  private tiles = new Map<string, WorldTileDefinition>();
  /** Global GUID → tile, for cross-map lookups (e.g. transition targets). */
  private tilesByGuid = new Map<string, WorldTileDefinition>();
  private tileTypeDefs = new Map<string, TileTypeDefinition>();
  private npcs = new Map<string, NpcDefinition>();
  private dungeons = new Map<string, DungeonDefinition>();
  private shops = new Map<string, ShopSummary>();
  private roomsByNpc = new Map<string, WorldTileDefinition[]>();
  private startTile: { col: number; row: number } = { col: 0, row: 0 };
  private zoneLevels: Record<string, LevelBand> = {};
  private maps: WorldMapMeta[] = [];
  private currentMapId: string = DEFAULT_MAP_ID;

  /** Skill catalog + per-class slot schedules. Defaults to the built-in seed
   *  catalog so skill UIs never crash before /api/skills loads (or if it fails). */
  private skillContent: SkillContent = { skills: FALLBACK_SKILLS, slotSchedules: SEED_SKILL_SLOT_SCHEDULES };
  private serverSkillCatalog = false;

  /** Bumped on every successful loadWorld — screens include this in their
   *  re-render keys so content deploys refresh cached skill/world renders. */
  private contentGen = 0;

  /** Offset-format keys ("col,row") for unlocked tiles on the current map. */
  private unlockedOffsetKeys = new Set<string>();

  /** Zone IDs that have at least one unlocked tile on the current map. */
  private unlockedZones = new Set<string>();

  /** Previous unlock count — used to detect changes (-1 forces a recompute). */
  private lastUnlockedCount = -1;

  private routeIndexCache: { gen: number; index: RouteIndex } | null = null;

  /** Load initial world data + NPC + dungeon + skill catalogs from the server. */
  async loadWorld(): Promise<void> {
    const [worldRes, npcsRes, dungeonsRes, skillsRes] = await Promise.all([
      fetch('/api/world', { credentials: 'include' }),
      fetch('/api/npcs', { credentials: 'include' }),
      fetch('/api/dungeons', { credentials: 'include' }),
      fetch('/api/skills', { credentials: 'include' }),
    ]);
    if (!worldRes.ok) throw new Error(`Failed to load world: ${worldRes.status}`);

    const data = await worldRes.json() as {
      startTile: { col: number; row: number };
      defaultMapId?: string;
      maps?: WorldMapMeta[];
      tiles: WorldTileDefinition[];
      tileTypes?: Record<string, TileTypeDefinition>;
      shops?: Record<string, ShopSummary>;
      zoneLevels?: Record<string, LevelBand>;
    };

    this.startTile = data.startTile;
    this.zoneLevels = data.zoneLevels ?? {};
    this.maps = data.maps ?? [{ id: DEFAULT_MAP_ID, name: 'Overworld', startTile: data.startTile }];
    if (!this.maps.some(m => m.id === this.currentMapId)) {
      this.currentMapId = data.defaultMapId ?? this.maps[0]?.id ?? DEFAULT_MAP_ID;
    }
    this.tiles.clear();
    this.tilesByGuid.clear();
    this.roomsByNpc.clear();
    for (const tile of data.tiles) {
      this.tiles.set(`${tile.mapId}:${tile.col},${tile.row}`, tile);
      this.tilesByGuid.set(tile.id, tile);
      if (tile.npcId) {
        const rooms = this.roomsByNpc.get(tile.npcId);
        if (rooms) rooms.push(tile);
        else this.roomsByNpc.set(tile.npcId, [tile]);
      }
    }
    this.lastUnlockedCount = -1; // force fog recompute against the (possibly new) tile set

    this.tileTypeDefs.clear();
    if (data.tileTypes) {
      for (const def of Object.values(data.tileTypes)) {
        this.tileTypeDefs.set(def.id, def);
      }
    }

    this.shops.clear();
    for (const shop of Object.values(data.shops ?? {})) {
      this.shops.set(shop.id, shop);
    }

    this.npcs.clear();
    if (npcsRes.ok) {
      const npcData = await npcsRes.json() as { npcs: Record<string, NpcDefinition> };
      for (const def of Object.values(npcData.npcs ?? {})) {
        this.npcs.set(def.id, def);
      }
    }

    this.dungeons.clear();
    if (dungeonsRes.ok) {
      const dungeonData = await dungeonsRes.json() as { dungeons: Record<string, DungeonDefinition> };
      for (const def of Object.values(dungeonData.dungeons ?? {})) {
        this.dungeons.set(def.id, def);
      }
    } else {
      console.warn(`[WorldCache] Failed to load dungeons: ${dungeonsRes.status} — dungeon entrances will show no Enter button`);
    }

    // Skills — tolerate failure gracefully (keep whatever catalog we already
    // have; that's the seed catalog on first load) so skill UIs never crash.
    if (skillsRes.ok) {
      try {
        const skillData = await skillsRes.json() as {
          skills: Record<string, SkillDefinition>;
          slotSchedules: Record<string, SkillSlot[]>;
        };
        this.skillContent = {
          skills: skillData.skills ?? FALLBACK_SKILLS,
          slotSchedules: skillData.slotSchedules ?? SEED_SKILL_SLOT_SCHEDULES,
        };
        this.serverSkillCatalog = !!skillData.skills;
      } catch (err) {
        console.warn('[WorldCache] Failed to parse skills response — using built-in skill catalog', err);
      }
    } else {
      console.warn(`[WorldCache] Failed to load skills: ${skillsRes.status} — using built-in skill catalog`);
    }

    this.contentGen++;
  }

  /**
   * Update the unlocked tile set from state.unlocked (tile GUIDs).
   * Returns true if the set changed (caller should re-render).
   */
  updateUnlocked(tileIds: string[]): boolean {
    if (tileIds.length === this.lastUnlockedCount) return false;
    this.lastUnlockedCount = tileIds.length;

    this.unlockedOffsetKeys.clear();
    this.unlockedZones.clear();

    // Unlock GUIDs span every map the player has visited; only the current
    // map's unlocks affect what the renderer shows.
    for (const id of tileIds) {
      const tile = this.tilesByGuid.get(id);
      if (!tile || tile.mapId !== this.currentMapId) continue;
      this.unlockedOffsetKeys.add(`${tile.col},${tile.row}`);
      this.unlockedZones.add(tile.zone);
    }

    return true;
  }

  /**
   * Switch the rendered map. Returns true if it changed (caller should rebuild
   * the grid + recompute fog). Forces the next updateUnlocked to recompute even
   * if the unlock count is unchanged.
   */
  setCurrentMap(mapId: string): boolean {
    if (mapId === this.currentMapId) return false;
    this.currentMapId = mapId;
    this.lastUnlockedCount = -1;
    return true;
  }

  getCurrentMapId(): string {
    return this.currentMapId;
  }

  /** Metadata for every map in the world. */
  getMaps(): WorldMapMeta[] {
    return this.maps;
  }

  /** Look up any tile by its stable GUID, across all maps. */
  getTileByGuid(id: string): WorldTileDefinition | undefined {
    return this.tilesByGuid.get(id);
  }

  /** The authored monster levels a room's fights roll from: its own table's, else its zone's. Undefined when unknown. */
  getRoomLevels(def: Pick<WorldTileDefinition, 'levels' | 'zone' | 'encounterTable'>): LevelBand | undefined {
    if (def.levels) return def.levels;
    if (def.encounterTable?.length) return undefined;
    return Object.prototype.hasOwnProperty.call(this.zoneLevels, def.zone) ? this.zoneLevels[def.zone] : undefined;
  }

  /** Check if a tile is unlocked (player can move to it). */
  isUnlocked(col: number, row: number): boolean {
    return this.unlockedOffsetKeys.has(`${col},${row}`);
  }

  /** Check if a zone has been unlocked (at least one tile in it is unlocked). */
  isZoneUnlocked(zone: string): boolean {
    return this.unlockedZones.has(zone);
  }

  /** Get all tiles on the current map. */
  getTiles(): WorldTileDefinition[] {
    const result: WorldTileDefinition[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.mapId === this.currentMapId) result.push(tile);
    }
    return result;
  }

  /** Get a specific tile on the current map by offset coordinates. */
  getTile(col: number, row: number): WorldTileDefinition | undefined {
    return this.tiles.get(`${this.currentMapId}:${col},${row}`);
  }

  /**
   * Get a tile on an explicitly named map. Prefer this over `getTile` outside the map renderer:
   * `currentMapId` is the drawn map, which can be a viewed one or lag the party's real map.
   */
  getTileOn(mapId: string, col: number, row: number): WorldTileDefinition | undefined {
    return this.tiles.get(`${mapId}:${col},${row}`);
  }

  /**
   * Walkable rooms found and in all, per map in world order, for every map with any.
   * A locked room the fog has lifted from counts as found; unknown ids are skipped.
   */
  roomsFoundByMap(unlockedIds: readonly string[]): Map<string, MapRoomsFound> {
    const byMap = new Map<string, MapRoomsFound>();
    for (const map of this.maps) byMap.set(map.id, { name: map.name || map.id, found: 0, total: 0 });
    for (const tile of this.tiles.values()) {
      if (!this.isWalkableRoom(tile)) continue;
      let entry = byMap.get(tile.mapId);
      if (!entry) {
        entry = { name: tile.mapId, found: 0, total: 0 };
        byMap.set(tile.mapId, entry);
      }
      entry.total++;
    }
    for (const id of new Set(unlockedIds)) {
      const tile = this.tilesByGuid.get(id);
      if (tile && this.isWalkableRoom(tile)) byMap.get(tile.mapId)!.found++;
    }
    for (const [mapId, entry] of byMap) {
      if (entry.total === 0) byMap.delete(mapId);
    }
    return byMap;
  }

  /** Maps the player can look at: those with at least one found walkable room. */
  viewableMapIds(unlockedIds: readonly string[]): Set<string> {
    const ids = new Set<string>();
    for (const [mapId, entry] of this.roomsFoundByMap(unlockedIds)) {
      if (entry.found > 0) ids.add(mapId);
    }
    return ids;
  }

  /** Walkable areas and doors across every map, built once per world load. */
  routeIndex(): RouteIndex {
    if (this.routeIndexCache?.gen === this.contentGen) return this.routeIndexCache.index;
    const index = buildRouteIndex([...this.tiles.values()].map(tile => ({
      id: tile.id,
      mapId: tile.mapId,
      col: tile.col,
      row: tile.row,
      traversable: isTileTraversable(tile.type, this.tileTypeDefs.get(tile.type)),
      transitions: tile.transitions,
    })));
    this.routeIndexCache = { gen: this.contentGen, index };
    return index;
  }

  /** Get the start tile position. */
  getStartTile(): { col: number; row: number } {
    return this.startTile;
  }

  /** Get a tile type definition by ID. */
  getTileTypeDef(typeId: string): TileTypeDefinition | undefined {
    return this.tileTypeDefs.get(typeId);
  }

  /** Get all tile type definitions. */
  getAllTileTypeDefs(): Map<string, TileTypeDefinition> {
    return this.tileTypeDefs;
  }

  /** Get an NPC definition by ID. */
  getNpc(id: string): NpcDefinition | undefined {
    return this.npcs.get(id);
  }

  /** Every NPC in the catalog. */
  getAllNpcs(): NpcDefinition[] {
    return [...this.npcs.values()];
  }

  /** Rooms (on any map) where an NPC stands. */
  getRoomsWithNpc(npcId: string): WorldTileDefinition[] {
    return this.roomsByNpc.get(npcId) ?? [];
  }

  /** Get a dungeon definition by ID. */
  getDungeon(id: string): DungeonDefinition | undefined {
    return this.dungeons.get(id);
  }

  /** Name and offer kinds of a shop; the stock itself only arrives for the current room. */
  getShop(id: string): ShopSummary | undefined {
    return this.shops.get(id);
  }

  /** Get a skill definition by ID (cross-class catalog). */
  getSkill(id: string): SkillDefinition | undefined {
    return this.skillContent.skills[id];
  }

  /** Get every skill definition in the catalog. */
  getAllSkills(): SkillDefinition[] {
    return Object.values(this.skillContent.skills);
  }

  /** Get the skill slot schedule for a class (falls back to the seed schedule). */
  getSlotSchedule(className: string): SkillSlot[] {
    return getSlotSchedule(className as ClassName, this.skillContent);
  }

  /** Skill catalog + slot schedules in the shape the shared helpers expect. */
  hasServerSkillCatalog(): boolean {
    return this.serverSkillCatalog;
  }

  getSkillContent(): SkillContent {
    return this.skillContent;
  }

  /** Monotonic counter bumped on each successful loadWorld — include in
   *  re-render keys so content deploys invalidate cached renders. */
  get contentGeneration(): number {
    return this.contentGen;
  }

  /** Check if world data has been loaded. */
  get isLoaded(): boolean {
    return this.tiles.size > 0;
  }

  private isWalkableRoom(tile: WorldTileDefinition): boolean {
    if (tile.type === 'void') return false;
    const def = this.tileTypeDefs.get(tile.type);
    return def ? def.traversable : TILE_CONFIGS[tile.type as TileType]?.traversable ?? true;
  }
}
