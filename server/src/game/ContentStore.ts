import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { MonsterDefinition, ItemDefinition, ZoneDefinition, WorldData, WorldTileDefinition, WorldMapMeta, EncounterDefinition, EncounterTableEntry, TileTypeDefinition } from '@idle-party-rpg/shared';
import type { SetDefinition } from '@idle-party-rpg/shared';
import type { ShopDefinition } from '@idle-party-rpg/shared';
import type { RecipeDefinition } from '@idle-party-rpg/shared';
import type { NpcDefinition } from '@idle-party-rpg/shared';
import type { QuestDefinition } from '@idle-party-rpg/shared';
import type { DungeonDefinition } from '@idle-party-rpg/shared';
import { SEED_MONSTERS, SEED_ITEMS, SEED_ZONES, SEED_ENCOUNTERS, SEED_TILE_TYPES, SEED_RECIPES, SEED_NPCS, SEED_DUNGEONS, TILE_CONFIGS, migrateLegacySet, findSetConflicts, DEFAULT_MAP_ID, migrateWorldData } from '@idle-party-rpg/shared';
import { TileType } from '@idle-party-rpg/shared';

const DATA_DIR = path.resolve('data');
const MONSTERS_FILE = path.join(DATA_DIR, 'monsters.json');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const ZONES_FILE = path.join(DATA_DIR, 'zones.json');
const WORLD_FILE = path.join(DATA_DIR, 'world.json');
const ENCOUNTERS_FILE = path.join(DATA_DIR, 'encounters.json');
const SETS_FILE = path.join(DATA_DIR, 'sets.json');
const SHOPS_FILE = path.join(DATA_DIR, 'shops.json');
const TILE_TYPES_FILE = path.join(DATA_DIR, 'tile-types.json');
const RECIPES_FILE = path.join(DATA_DIR, 'recipes.json');
const NPCS_FILE = path.join(DATA_DIR, 'npcs.json');
const QUESTS_FILE = path.join(DATA_DIR, 'quests.json');
const DUNGEONS_FILE = path.join(DATA_DIR, 'dungeons.json');

/**
 * Loads and manages game content from JSON files in data/.
 * Follows the GuildStore pattern: in-memory data + JSON file persistence.
 * If data files don't exist, seeds with defaults and saves.
 */
export class ContentStore {
  private monsters = new Map<string, MonsterDefinition>();
  private items = new Map<string, ItemDefinition>();
  private zones = new Map<string, ZoneDefinition>();
  private encounters = new Map<string, EncounterDefinition>();
  private sets = new Map<string, SetDefinition>();
  private shops = new Map<string, ShopDefinition>();
  private tileTypes = new Map<string, TileTypeDefinition>();
  private recipes = new Map<string, RecipeDefinition>();
  private npcs = new Map<string, NpcDefinition>();
  private quests = new Map<string, QuestDefinition>();
  private dungeons = new Map<string, DungeonDefinition>();
  private world: WorldData = {
    startTile: { col: 0, row: 0 },
    maps: [{ id: DEFAULT_MAP_ID, name: 'Overworld', startTile: { col: 0, row: 0 } }],
    defaultMapId: DEFAULT_MAP_ID,
    tiles: [],
  };

  async load(): Promise<void> {
    const exists = await this.tryLoadAll();
    if (!exists) {
      console.log('[ContentStore] No data files found — seeding defaults');
      this.seedDefaults();
      await this.save();
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(MONSTERS_FILE, JSON.stringify(Array.from(this.monsters.values()), null, 2));
    await fs.writeFile(ITEMS_FILE, JSON.stringify(Array.from(this.items.values()), null, 2));
    await fs.writeFile(ZONES_FILE, JSON.stringify(Array.from(this.zones.values()), null, 2));
    await fs.writeFile(WORLD_FILE, JSON.stringify(this.world, null, 2));
    await fs.writeFile(ENCOUNTERS_FILE, JSON.stringify(Array.from(this.encounters.values()), null, 2));
    await fs.writeFile(SETS_FILE, JSON.stringify(Array.from(this.sets.values()), null, 2));
    await fs.writeFile(SHOPS_FILE, JSON.stringify(Array.from(this.shops.values()), null, 2));
    await fs.writeFile(TILE_TYPES_FILE, JSON.stringify(Array.from(this.tileTypes.values()), null, 2));
    await fs.writeFile(RECIPES_FILE, JSON.stringify(Array.from(this.recipes.values()), null, 2));
    await fs.writeFile(NPCS_FILE, JSON.stringify(Array.from(this.npcs.values()), null, 2));
    await fs.writeFile(QUESTS_FILE, JSON.stringify(Array.from(this.quests.values()), null, 2));
    await fs.writeFile(DUNGEONS_FILE, JSON.stringify(Array.from(this.dungeons.values()), null, 2));
  }

  // --- Accessors ---

  getMonster(id: string): MonsterDefinition | undefined {
    return this.monsters.get(id);
  }

  getAllMonsters(): Record<string, MonsterDefinition> {
    const result: Record<string, MonsterDefinition> = {};
    for (const [id, def] of this.monsters) result[id] = def;
    return result;
  }

  getItem(id: string): ItemDefinition | undefined {
    return this.items.get(id);
  }

  getAllItems(): Record<string, ItemDefinition> {
    const result: Record<string, ItemDefinition> = {};
    for (const [id, def] of this.items) result[id] = def;
    return result;
  }

  getZone(id: string): ZoneDefinition | undefined {
    return this.zones.get(id);
  }

  getAllZones(): Record<string, ZoneDefinition> {
    const result: Record<string, ZoneDefinition> = {};
    for (const [id, def] of this.zones) result[id] = def;
    return result;
  }

  getEncounter(id: string): EncounterDefinition | undefined {
    return this.encounters.get(id);
  }

  getAllEncounters(): Record<string, EncounterDefinition> {
    const result: Record<string, EncounterDefinition> = {};
    for (const [id, def] of this.encounters) result[id] = def;
    return result;
  }

  getSet(id: string): SetDefinition | undefined {
    return this.sets.get(id);
  }

  getAllSets(): Record<string, SetDefinition> {
    const result: Record<string, SetDefinition> = {};
    for (const [id, def] of this.sets) result[id] = def;
    return result;
  }

  getShop(id: string): ShopDefinition | undefined {
    return this.shops.get(id);
  }

  getAllShops(): Record<string, ShopDefinition> {
    const result: Record<string, ShopDefinition> = {};
    for (const [id, def] of this.shops) result[id] = def;
    return result;
  }

  getTileType(id: string): TileTypeDefinition | undefined {
    return this.tileTypes.get(id);
  }

  getAllTileTypes(): Record<string, TileTypeDefinition> {
    const result: Record<string, TileTypeDefinition> = {};
    for (const [id, def] of this.tileTypes) result[id] = def;
    return result;
  }

  getRecipe(id: string): RecipeDefinition | undefined {
    return this.recipes.get(id);
  }

  getAllRecipes(): Record<string, RecipeDefinition> {
    const result: Record<string, RecipeDefinition> = {};
    for (const [id, def] of this.recipes) result[id] = def;
    return result;
  }

  getNpc(id: string): NpcDefinition | undefined {
    return this.npcs.get(id);
  }

  getAllNpcs(): Record<string, NpcDefinition> {
    const result: Record<string, NpcDefinition> = {};
    for (const [id, def] of this.npcs) result[id] = def;
    return result;
  }

  getQuest(id: string): QuestDefinition | undefined {
    return this.quests.get(id);
  }

  getAllQuests(): Record<string, QuestDefinition> {
    const result: Record<string, QuestDefinition> = {};
    for (const [id, def] of this.quests) result[id] = def;
    return result;
  }

  getDungeon(id: string): DungeonDefinition | undefined {
    return this.dungeons.get(id);
  }

  getAllDungeons(): Record<string, DungeonDefinition> {
    const result: Record<string, DungeonDefinition> = {};
    for (const [id, def] of this.dungeons) result[id] = def;
    return result;
  }

  getWorld(): WorldData {
    return this.world;
  }

  getStartTile(): { col: number; row: number } {
    return this.world.startTile;
  }

  getTileById(id: string): WorldTileDefinition | undefined {
    return this.world.tiles.find(t => t.id === id);
  }

  // --- Tile CRUD ---

  async addOrUpdateTile(tile: WorldTileDefinition): Promise<void> {
    // Tiles are unique per (mapId, col, row) — two maps may share a (col, row).
    const idx = this.world.tiles.findIndex(t => t.mapId === tile.mapId && t.col === tile.col && t.row === tile.row);
    if (idx >= 0) {
      // Preserve existing GUID on update
      tile.id = this.world.tiles[idx].id;
      this.world.tiles[idx] = tile;
    } else {
      // New tile — generate a GUID
      tile.id = crypto.randomUUID();
      this.world.tiles.push(tile);
    }
    await this.save();
  }

  async deleteTile(mapId: string, col: number, row: number): Promise<{ success: boolean; error?: string }> {
    if (mapId === this.world.defaultMapId && this.world.startTile.col === col && this.world.startTile.row === row) {
      return { success: false, error: 'Cannot delete the start tile. Assign a different start tile first.' };
    }

    const idx = this.world.tiles.findIndex(t => t.mapId === mapId && t.col === col && t.row === row);
    if (idx < 0) {
      return { success: false, error: 'Tile not found.' };
    }

    // Block deletion if another room's transition links to this one (dangling link).
    const victim = this.world.tiles[idx];
    const inbound = this.world.tiles.find(t => t.transitionsTo?.tileId === victim.id);
    if (inbound) {
      return { success: false, error: `A transition in "${inbound.name}" links to this room. Remove it first.` };
    }

    this.world.tiles.splice(idx, 1);
    await this.save();
    return { success: true };
  }

  /** Set the global spawn tile (a room on the default map). */
  async setStartTile(col: number, row: number): Promise<{ success: boolean; error?: string }> {
    return this.setMapStartTile(this.world.defaultMapId, col, row);
  }

  /** Set a specific map's start (centering/fallback) tile; also the global spawn for the default map. */
  async setMapStartTile(mapId: string, col: number, row: number): Promise<{ success: boolean; error?: string }> {
    const meta = this.world.maps.find(m => m.id === mapId);
    if (!meta) {
      return { success: false, error: 'Map not found.' };
    }
    const tile = this.world.tiles.find(t => t.mapId === mapId && t.col === col && t.row === row);
    if (!tile) {
      return { success: false, error: 'Tile not found.' };
    }
    const tileTypeDef = this.tileTypes.get(tile.type);
    const isTraversable = tileTypeDef ? tileTypeDef.traversable : (TILE_CONFIGS[tile.type as TileType]?.traversable ?? false);
    if (!isTraversable) {
      return { success: false, error: 'Start tile must be traversable.' };
    }
    meta.startTile = { col, row };
    if (mapId === this.world.defaultMapId) {
      this.world.startTile = { col, row };
    }
    await this.save();
    return { success: true };
  }

  // --- Map CRUD ---

  getMaps(): WorldMapMeta[] {
    return this.world.maps;
  }

  /** Create or rename a map. New maps start with no tiles; the admin adds rooms tagged with `id`. */
  async addOrUpdateMap(map: WorldMapMeta): Promise<{ success: boolean; error?: string }> {
    if (!map.id) {
      return { success: false, error: 'Map id is required.' };
    }
    const idx = this.world.maps.findIndex(m => m.id === map.id);
    if (idx >= 0) {
      this.world.maps[idx] = map;
    } else {
      this.world.maps.push(map);
    }
    await this.save();
    return { success: true };
  }

  async deleteMap(mapId: string): Promise<{ success: boolean; error?: string }> {
    if (mapId === this.world.defaultMapId) {
      return { success: false, error: 'Cannot delete the default map.' };
    }
    if (this.world.tiles.some(t => t.mapId === mapId)) {
      return { success: false, error: "Delete or move this map's rooms first." };
    }
    const inbound = this.world.tiles.find(t => t.transitionsTo?.mapId === mapId);
    if (inbound) {
      return { success: false, error: `A transition in "${inbound.name}" still leads to this map. Remove it first.` };
    }
    const idx = this.world.maps.findIndex(m => m.id === mapId);
    if (idx < 0) {
      return { success: false, error: 'Map not found.' };
    }
    this.world.maps.splice(idx, 1);
    await this.save();
    return { success: true };
  }

  // --- Monster CRUD ---

  async addOrUpdateMonster(monster: MonsterDefinition): Promise<void> {
    this.monsters.set(monster.id, monster);
    await this.save();
  }

  async deleteMonster(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.monsters.has(id)) {
      return { success: false, error: 'Monster not found.' };
    }
    this.monsters.delete(id);
    await this.save();
    return { success: true };
  }

  // --- Item CRUD ---

  async addOrUpdateItem(item: ItemDefinition): Promise<void> {
    this.items.set(item.id, item);
    await this.save();
  }

  async deleteItem(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.items.has(id)) {
      return { success: false, error: 'Item not found.' };
    }
    // Check if any monster references this item in its drops
    for (const monster of this.monsters.values()) {
      if (monster.drops?.some(d => d.itemId === id)) {
        return { success: false, error: `Cannot delete: item is referenced in ${monster.name}'s drop table.` };
      }
    }
    this.items.delete(id);
    await this.save();
    return { success: true };
  }

  // --- Zone CRUD ---

  async addOrUpdateZone(zone: ZoneDefinition): Promise<void> {
    this.zones.set(zone.id, zone);
    await this.save();
  }

  /**
   * Bulk-merge generated content (used by the dev seed). Adds the given
   * zones + tiles to the in-memory maps and persists once at the end —
   * much cheaper than 1000 individual `addOrUpdateTile` calls. Skips
   * any tile whose (col,row) already has a tile so a partial re-seed
   * doesn't clobber existing content.
   */
  async mergeSeedContent(zones: ZoneDefinition[], tiles: WorldTileDefinition[]): Promise<void> {
    for (const z of zones) this.zones.set(z.id, z);
    const occupied = new Set(this.world.tiles.map(t => `${t.col},${t.row}`));
    for (const t of tiles) {
      const key = `${t.col},${t.row}`;
      if (occupied.has(key)) continue;
      this.world.tiles.push(t);
      occupied.add(key);
    }
    await this.save();
  }

  async deleteZone(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.zones.has(id)) {
      return { success: false, error: 'Zone not found.' };
    }
    // Check if any world tile references this zone
    const referencingTile = this.world.tiles.find(t => t.zone === id);
    if (referencingTile) {
      return { success: false, error: `Cannot delete: zone is used by tile "${referencingTile.name}" at (${referencingTile.col}, ${referencingTile.row}).` };
    }
    this.zones.delete(id);
    await this.save();
    return { success: true };
  }

  // --- Encounter CRUD ---

  async addOrUpdateEncounter(encounter: EncounterDefinition): Promise<void> {
    this.encounters.set(encounter.id, encounter);
    await this.save();
  }

  async deleteEncounter(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.encounters.has(id)) {
      return { success: false, error: 'Encounter not found.' };
    }
    // Check if any zone or tile references this encounter
    for (const zone of this.zones.values()) {
      if (zone.encounterTable.some(e => e.encounterId === id)) {
        return { success: false, error: `Cannot delete: encounter is referenced by zone "${zone.displayName}".` };
      }
    }
    for (const tile of this.world.tiles) {
      if (tile.encounterTable?.some(e => e.encounterId === id)) {
        return { success: false, error: `Cannot delete: encounter is referenced by tile "${tile.name}" at (${tile.col}, ${tile.row}).` };
      }
    }
    this.encounters.delete(id);
    await this.save();
    return { success: true };
  }

  // --- Set CRUD ---

  /**
   * Add or update a set. Returns { success, error } — fails if the set conflicts with
   * existing sets (same item in two sets that share a class).
   */
  async addOrUpdateSet(set: SetDefinition): Promise<{ success: boolean; error?: string }> {
    const migrated = migrateLegacySet(set);
    const existing = Array.from(this.sets.values()).map(s => migrateLegacySet(s));
    const errors = findSetConflicts(migrated, existing);
    if (errors.length > 0) {
      return { success: false, error: errors.join(' ') };
    }
    this.sets.set(migrated.id, migrated);
    await this.save();
    return { success: true };
  }

  async deleteSet(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.sets.has(id)) {
      return { success: false, error: 'Set not found.' };
    }
    this.sets.delete(id);
    await this.save();
    return { success: true };
  }

  // --- Shop CRUD ---

  async addOrUpdateShop(shop: ShopDefinition): Promise<void> {
    this.shops.set(shop.id, shop);
    await this.save();
  }

  async deleteShop(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.shops.has(id)) {
      return { success: false, error: 'Shop not found.' };
    }
    // Check if any world tile references this shop
    const referencingTile = this.world.tiles.find(t => t.shopId === id);
    if (referencingTile) {
      return { success: false, error: `Cannot delete: shop is used by room "${referencingTile.name}" at (${referencingTile.col}, ${referencingTile.row}).` };
    }
    this.shops.delete(id);
    await this.save();
    return { success: true };
  }

  // --- NPC CRUD ---

  async addOrUpdateNpc(npc: NpcDefinition): Promise<void> {
    this.npcs.set(npc.id, npc);
    await this.save();
  }

  async deleteNpc(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.npcs.has(id)) {
      return { success: false, error: 'NPC not found.' };
    }
    const referencingTile = this.world.tiles.find(t => t.npcId === id);
    if (referencingTile) {
      return { success: false, error: `Cannot delete: NPC is placed in room "${referencingTile.name}" at (${referencingTile.col}, ${referencingTile.row}).` };
    }
    this.npcs.delete(id);
    await this.save();
    return { success: true };
  }

  // --- Quest CRUD ---

  async addOrUpdateQuest(quest: QuestDefinition): Promise<void> {
    this.quests.set(quest.id, quest);
    await this.save();
  }

  async deleteQuest(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.quests.has(id)) {
      return { success: false, error: 'Quest not found.' };
    }
    // Block delete if any NPC offers this quest
    for (const npc of this.npcs.values()) {
      if (npc.questIds?.includes(id)) {
        return { success: false, error: `Cannot delete: quest is offered by NPC "${npc.name}".` };
      }
    }
    // Block delete if any other quest depends on this one
    for (const q of this.quests.values()) {
      if (q.prerequisiteQuestIds?.includes(id)) {
        return { success: false, error: `Cannot delete: quest is a prerequisite of "${q.name}".` };
      }
    }
    this.quests.delete(id);
    await this.save();
    return { success: true };
  }

  // --- Tile Type CRUD ---

  async addOrUpdateTileType(def: TileTypeDefinition): Promise<void> {
    this.tileTypes.set(def.id, def);
    await this.save();
  }

  // --- Recipe CRUD ---

  async addOrUpdateRecipe(recipe: RecipeDefinition): Promise<void> {
    this.recipes.set(recipe.id, recipe);
    await this.save();
  }

  async deleteRecipe(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.recipes.has(id)) {
      return { success: false, error: 'Recipe not found.' };
    }
    this.recipes.delete(id);
    await this.save();
    return { success: true };
  }

  async deleteTileType(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.tileTypes.has(id)) {
      return { success: false, error: 'Tile type not found.' };
    }
    // Check if any world tile uses this type
    const referencingTile = this.world.tiles.find(t => t.type === id);
    if (referencingTile) {
      return { success: false, error: `Cannot delete: tile type is used by room "${referencingTile.name}" at (${referencingTile.col}, ${referencingTile.row}).` };
    }
    this.tileTypes.delete(id);
    await this.save();
    return { success: true };
  }

  // --- Dungeon CRUD ---

  async addOrUpdateDungeon(dungeon: DungeonDefinition): Promise<void> {
    this.dungeons.set(dungeon.id, dungeon);
    await this.save();
  }

  async deleteDungeon(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.dungeons.has(id)) {
      return { success: false, error: 'Dungeon not found.' };
    }
    this.dungeons.delete(id);
    await this.save();
    return { success: true };
  }

  // --- Snapshot ---

  /** Export current live state as a ContentSnapshot. */
  toSnapshot(): { monsters: MonsterDefinition[]; items: ItemDefinition[]; zones: ZoneDefinition[]; encounters: EncounterDefinition[]; sets: SetDefinition[]; shops: ShopDefinition[]; tileTypes: TileTypeDefinition[]; recipes: RecipeDefinition[]; npcs: NpcDefinition[]; quests: QuestDefinition[]; dungeons: DungeonDefinition[]; world: WorldData } {
    return {
      monsters: Array.from(this.monsters.values()),
      items: Array.from(this.items.values()),
      zones: Array.from(this.zones.values()),
      encounters: Array.from(this.encounters.values()),
      sets: Array.from(this.sets.values()),
      shops: Array.from(this.shops.values()),
      tileTypes: Array.from(this.tileTypes.values()),
      recipes: Array.from(this.recipes.values()),
      npcs: Array.from(this.npcs.values()),
      quests: Array.from(this.quests.values()),
      dungeons: Array.from(this.dungeons.values()),
      world: JSON.parse(JSON.stringify(this.world)),
    };
  }

  /** Bulk-replace all content from a snapshot (used for deploy). */
  async replaceAll(snapshot: { monsters: MonsterDefinition[]; items: ItemDefinition[]; zones: ZoneDefinition[]; encounters?: EncounterDefinition[]; sets?: SetDefinition[]; shops?: ShopDefinition[]; tileTypes?: TileTypeDefinition[]; recipes?: RecipeDefinition[]; npcs?: NpcDefinition[]; quests?: QuestDefinition[]; dungeons?: DungeonDefinition[]; world: WorldData }): Promise<void> {
    this.monsters.clear();
    for (const m of snapshot.monsters) this.monsters.set(m.id, m);

    this.items.clear();
    for (const i of snapshot.items) this.items.set(i.id, i);

    this.zones.clear();
    for (const z of snapshot.zones) this.zones.set(z.id, z);

    this.encounters.clear();
    if (snapshot.encounters) {
      for (const e of snapshot.encounters) this.encounters.set(e.id, e);
    }

    this.sets.clear();
    if (snapshot.sets) {
      for (const s of snapshot.sets) this.sets.set(s.id, migrateLegacySet(s));
    }

    this.shops.clear();
    if (snapshot.shops) {
      for (const s of snapshot.shops) this.shops.set(s.id, s);
    }

    if (snapshot.tileTypes && snapshot.tileTypes.length > 0) {
      this.tileTypes.clear();
      for (const t of snapshot.tileTypes) this.tileTypes.set(t.id, t);
    }
    // Old snapshots predate tile types — keep existing tile types intact

    if (snapshot.recipes) {
      this.recipes.clear();
      for (const r of snapshot.recipes) this.recipes.set(r.id, r);
    }
    // Old snapshots predate recipes — keep existing intact

    this.npcs.clear();
    if (snapshot.npcs) {
      for (const n of snapshot.npcs) this.npcs.set(n.id, n);
    }

    this.quests.clear();
    if (snapshot.quests) {
      for (const q of snapshot.quests) this.quests.set(q.id, q);
    }

    this.dungeons.clear();
    if (snapshot.dungeons) {
      for (const d of snapshot.dungeons) this.dungeons.set(d.id, d);
    }

    this.world = snapshot.world;
    // Normalize legacy snapshots (no mapId / maps) into the multi-map shape.
    migrateWorldData(this.world);

    // Safety net: ensure every tile has a GUID
    for (const tile of this.world.tiles) {
      if (!tile.id) {
        tile.id = crypto.randomUUID();
      }
    }

    // Migrate old-format encounter tables if needed
    this.migrateEncounterTables();

    // Migrate items if needed
    this.migrateItems();

    await this.save();
    console.log(`[ContentStore] Replaced all content: ${this.monsters.size} monsters, ${this.items.size} items, ${this.zones.size} zones, ${this.encounters.size} encounters, ${this.sets.size} sets, ${this.shops.size} shops, ${this.dungeons.size} dungeons, ${this.world.tiles.length} tiles`);
  }

  // --- Private ---

  private async tryLoadAll(): Promise<boolean> {
    try {
      const [monstersRaw, itemsRaw, zonesRaw, worldRaw] = await Promise.all([
        fs.readFile(MONSTERS_FILE, 'utf-8'),
        fs.readFile(ITEMS_FILE, 'utf-8'),
        fs.readFile(ZONES_FILE, 'utf-8'),
        fs.readFile(WORLD_FILE, 'utf-8'),
      ]);

      const monstersArr: MonsterDefinition[] = JSON.parse(monstersRaw);
      for (const m of monstersArr) this.monsters.set(m.id, m);

      const itemsArr: ItemDefinition[] = JSON.parse(itemsRaw);
      for (const i of itemsArr) this.items.set(i.id, i);

      const zonesArr: ZoneDefinition[] = JSON.parse(zonesRaw);
      for (const z of zonesArr) this.zones.set(z.id, z);

      this.world = JSON.parse(worldRaw);

      // Try loading optional files (may not exist on older installations)
      try {
        const encountersRaw = await fs.readFile(ENCOUNTERS_FILE, 'utf-8');
        const encountersArr: EncounterDefinition[] = JSON.parse(encountersRaw);
        for (const e of encountersArr) this.encounters.set(e.id, e);
      } catch {
        // encounters.json doesn't exist yet — will be created after migration
      }

      try {
        const setsRaw = await fs.readFile(SETS_FILE, 'utf-8');
        const setsArr: SetDefinition[] = JSON.parse(setsRaw);
        for (const s of setsArr) this.sets.set(s.id, migrateLegacySet(s));
      } catch {
        // sets.json doesn't exist yet
      }

      try {
        const shopsRaw = await fs.readFile(SHOPS_FILE, 'utf-8');
        const shopsArr: ShopDefinition[] = JSON.parse(shopsRaw);
        for (const s of shopsArr) this.shops.set(s.id, s);
      } catch {
        // shops.json doesn't exist yet
      }

      let tileTypesSeeded = false;
      try {
        const tileTypesRaw = await fs.readFile(TILE_TYPES_FILE, 'utf-8');
        const tileTypesArr: TileTypeDefinition[] = JSON.parse(tileTypesRaw);
        for (const t of tileTypesArr) this.tileTypes.set(t.id, t);
      } catch {
        // tile-types.json doesn't exist yet — seed from defaults
        for (const t of SEED_TILE_TYPES) this.tileTypes.set(t.id, t);
        tileTypesSeeded = true;
      }

      let recipesSeeded = false;
      try {
        const recipesRaw = await fs.readFile(RECIPES_FILE, 'utf-8');
        const recipesArr: RecipeDefinition[] = JSON.parse(recipesRaw);
        for (const r of recipesArr) this.recipes.set(r.id, r);
      } catch {
        // recipes.json doesn't exist yet — seed from defaults
        for (const r of Object.values(SEED_RECIPES)) this.recipes.set(r.id, r);
        recipesSeeded = true;
      }

      try {
        const npcsRaw = await fs.readFile(NPCS_FILE, 'utf-8');
        const npcsArr: NpcDefinition[] = JSON.parse(npcsRaw);
        for (const n of npcsArr) this.npcs.set(n.id, n);
      } catch {
        // npcs.json doesn't exist yet — start empty (intentionally not seeded
        // on existing installs; dev-only seed lives in seedDefaults())
      }

      try {
        const questsRaw = await fs.readFile(QUESTS_FILE, 'utf-8');
        const questsArr: QuestDefinition[] = JSON.parse(questsRaw);
        for (const q of questsArr) this.quests.set(q.id, q);
      } catch {
        // quests.json doesn't exist yet — start empty
      }

      try {
        const dungeonsRaw = await fs.readFile(DUNGEONS_FILE, 'utf-8');
        const dungeonsArr: DungeonDefinition[] = JSON.parse(dungeonsRaw);
        for (const d of dungeonsArr) this.dungeons.set(d.id, d);
      } catch {
        // dungeons.json doesn't exist yet
      }

      // Migrate: assign GUIDs to any tiles missing an id
      let migrated = 0;
      for (const tile of this.world.tiles) {
        if (!tile.id) {
          tile.id = crypto.randomUUID();
          migrated++;
        }
      }
      if (migrated > 0) {
        console.log(`[ContentStore] Assigned GUIDs to ${migrated} tiles (migration)`);
      }

      // Normalize legacy single-map worlds into the multi-map shape (mapId / maps / defaultMapId)
      const worldMigrated = migrateWorldData(this.world);

      // Migrate old-format encounter tables (monsterId → encounterId)
      const encountersMigrated = this.migrateEncounterTables();

      // Migrate items: twoHanded → twohanded slot, remove dodge, classRestriction→array, add value
      const itemsMigrated = this.migrateItems();

      if (migrated > 0 || worldMigrated || encountersMigrated || itemsMigrated || tileTypesSeeded || recipesSeeded) {
        await this.save();
      }

      console.log(`[ContentStore] Loaded ${this.monsters.size} monsters, ${this.items.size} items, ${this.zones.size} zones, ${this.encounters.size} encounters, ${this.dungeons.size} dungeons, ${this.world.tiles.length} tiles`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Migrate old-format encounter tables ({ monsterId, weight, minCount, maxCount })
   * to new format ({ encounterId, weight }), auto-creating encounter definitions.
   * Returns true if any migration occurred.
   */
  private migrateEncounterTables(): boolean {
    let migrated = false;

    // Helper: detect old-format entry (has monsterId field)
    const isOldFormat = (entry: Record<string, unknown>): boolean => {
      return 'monsterId' in entry && !('encounterId' in entry);
    };

    // Helper: get or create an encounter definition for an old-format entry
    const getOrCreateEncounter = (entry: { monsterId: string; weight: number; minCount: number; maxCount: number }): string => {
      const encId = `auto_${entry.monsterId}`;
      if (!this.encounters.has(encId)) {
        const monsterDef = this.monsters.get(entry.monsterId);
        const name = monsterDef ? `${monsterDef.name}s` : entry.monsterId;
        this.encounters.set(encId, {
          id: encId,
          name,
          type: 'random',
          monsterPool: [{ monsterId: entry.monsterId, min: entry.minCount, max: entry.maxCount }],
          roomMax: 9,
        });
      }
      return encId;
    };

    // Migrate zone encounter tables
    for (const zone of this.zones.values()) {
      if (zone.encounterTable.length > 0 && isOldFormat(zone.encounterTable[0] as unknown as Record<string, unknown>)) {
        const oldTable = zone.encounterTable as unknown as { monsterId: string; weight: number; minCount: number; maxCount: number }[];
        const newTable: EncounterTableEntry[] = oldTable.map(entry => ({
          encounterId: getOrCreateEncounter(entry),
          weight: entry.weight,
        }));
        zone.encounterTable = newTable;
        migrated = true;
      }
    }

    // Migrate tile encounter tables
    for (const tile of this.world.tiles) {
      if (tile.encounterTable && tile.encounterTable.length > 0 && isOldFormat(tile.encounterTable[0] as unknown as Record<string, unknown>)) {
        const oldTable = tile.encounterTable as unknown as { monsterId: string; weight: number; minCount: number; maxCount: number }[];
        const newTable: EncounterTableEntry[] = oldTable.map(entry => ({
          encounterId: getOrCreateEncounter(entry),
          weight: entry.weight,
        }));
        tile.encounterTable = newTable;
        migrated = true;
      }
    }

    if (migrated) {
      console.log(`[ContentStore] Migrated encounter tables to new format, created ${this.encounters.size} encounter definitions`);
    }

    return migrated;
  }

  /**
   * Migrate items from old format:
   * - twoHanded: true + equipSlot: 'mainhand' → equipSlot: 'twohanded'
   * - twoHanded on non-weapon items → remove property
   * - dodgeChance → remove
   * - classRestriction string → string[]
   * - missing value → set to 1
   */
  private migrateItems(): boolean {
    let migrated = false;

    for (const item of this.items.values()) {
      const raw = item as unknown as Record<string, unknown>;

      // twoHanded migration
      if (raw['twoHanded']) {
        if (item.equipSlot === 'mainhand') {
          item.equipSlot = 'twohanded';
        }
        delete raw['twoHanded'];
        migrated = true;
      }

      // dodgeChance removal
      if (raw['dodgeChance'] != null) {
        delete raw['dodgeChance'];
        migrated = true;
      }

      // classRestriction string → string[]
      if (typeof item.classRestriction === 'string') {
        (item as { classRestriction: string[] }).classRestriction = [item.classRestriction as unknown as string];
        migrated = true;
      }

      // Add default value
      if (item.value == null) {
        item.value = 1;
        migrated = true;
      }
    }

    if (migrated) {
      console.log('[ContentStore] Migrated items to new format');
    }

    return migrated;
  }

  private seedDefaults(): void {
    // Monsters
    for (const m of Object.values(SEED_MONSTERS)) {
      this.monsters.set(m.id, m);
    }

    // Items
    for (const i of Object.values(SEED_ITEMS)) {
      this.items.set(i.id, i);
    }

    // Zones
    for (const z of Object.values(SEED_ZONES)) {
      this.zones.set(z.id, z);
    }

    // Encounters
    for (const e of Object.values(SEED_ENCOUNTERS)) {
      this.encounters.set(e.id, e);
    }

    // Tile Types
    for (const t of SEED_TILE_TYPES) {
      this.tileTypes.set(t.id, t);
    }

    // Recipes
    for (const r of Object.values(SEED_RECIPES)) {
      this.recipes.set(r.id, r);
    }

    // NPCs — dev only. Production deploys boot with no NPCs; admins create them.
    if (process.env.NODE_ENV !== 'production') {
      for (const n of Object.values(SEED_NPCS)) {
        this.npcs.set(n.id, n);
      }
    }

    // Dungeons
    for (const d of Object.values(SEED_DUNGEONS)) {
      this.dungeons.set(d.id, d);
    }

    // World — Hatchetmill (village), Darkwood (forest), Crystal Caves (dungeon)
    //
    // Layout (offset coords, flat-top hexagons):
    //
    //   Hatchetmill (center):
    //     (2,2) = Town Square (start tile, plains)
    //     (1,2) = Blacksmith (town)
    //     (3,2) = General Store (town)
    //     (2,1) = Healer's Hut (town)
    //     (1,1) = Dirt Road (plains)
    //     (3,1) = Village Green (plains)
    //     (2,3) = Old Well (plains)
    //
    //   Darkwood (east of Hatchetmill):
    //     (4,2) = Woodland Edge (plains)
    //     (5,2) = Forest Path (forest)
    //     (5,1) = Thick Trees (forest)
    //     (4,1) = Mossy Clearing (forest)
    //     (4,3) = Overgrown Trail (plains)
    //
    //   Crystal Caves (south of Darkwood):
    //     (5,3) = Cave Entrance (dungeon)
    //     (6,3) = Glittering Tunnel (dungeon)
    //     (6,2) = Crystal Chamber (dungeon)

    this.world = {
      startTile: { col: 2, row: 2 },
      maps: [{ id: DEFAULT_MAP_ID, name: 'Overworld', startTile: { col: 2, row: 2 } }],
      defaultMapId: DEFAULT_MAP_ID,
      tiles: [
        // Hatchetmill
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 2, row: 2, type: TileType.Plains, zone: 'hatchetmill', name: 'Town Square' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 1, row: 2, type: TileType.Town, zone: 'hatchetmill', name: 'Blacksmith' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 3, row: 2, type: TileType.Town, zone: 'hatchetmill', name: 'General Store' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 2, row: 1, type: TileType.Town, zone: 'hatchetmill', name: "Healer's Hut" },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 1, row: 1, type: TileType.Plains, zone: 'hatchetmill', name: 'Dirt Road' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 3, row: 1, type: TileType.Plains, zone: 'hatchetmill', name: 'Village Green' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 2, row: 3, type: TileType.Plains, zone: 'hatchetmill', name: 'Old Well' },

        // Darkwood
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 4, row: 2, type: TileType.Plains, zone: 'darkwood', name: 'Woodland Edge' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 5, row: 2, type: TileType.Forest, zone: 'darkwood', name: 'Forest Path' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 5, row: 1, type: TileType.Forest, zone: 'darkwood', name: 'Thick Trees' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 4, row: 1, type: TileType.Forest, zone: 'darkwood', name: 'Mossy Clearing' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 4, row: 3, type: TileType.Plains, zone: 'darkwood', name: 'Overgrown Trail' },

        // Crystal Caves
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 5, row: 3, type: TileType.Dungeon, zone: 'crystal_caves', name: 'Cave Entrance', dungeonId: 'crystal_caves_trial' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 6, row: 3, type: TileType.Dungeon, zone: 'crystal_caves', name: 'Glittering Tunnel' },
        { id: crypto.randomUUID(), mapId: DEFAULT_MAP_ID, col: 6, row: 2, type: TileType.Dungeon, zone: 'crystal_caves', name: 'Crystal Chamber' },
      ],
    };

    console.log(`[ContentStore] Seeded ${this.monsters.size} monsters, ${this.items.size} items, ${this.zones.size} zones, ${this.encounters.size} encounters, ${this.dungeons.size} dungeons, ${this.world.tiles.length} tiles`);
  }
}
