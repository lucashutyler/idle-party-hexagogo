import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { MonsterDefinition, ItemDefinition, ZoneDefinition, WorldData, WorldTileDefinition, EncounterDefinition, EncounterTableEntry } from '@idle-party-rpg/shared';
import { SEED_MONSTERS, SEED_ITEMS, SEED_ZONES, SEED_ENCOUNTERS, TILE_CONFIGS } from '@idle-party-rpg/shared';
import { TileType } from '@idle-party-rpg/shared';

const DATA_DIR = path.resolve('data');
const MONSTERS_FILE = path.join(DATA_DIR, 'monsters.json');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const ZONES_FILE = path.join(DATA_DIR, 'zones.json');
const WORLD_FILE = path.join(DATA_DIR, 'world.json');
const ENCOUNTERS_FILE = path.join(DATA_DIR, 'encounters.json');

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
  private world: WorldData = { startTile: { col: 0, row: 0 }, tiles: [] };

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
    const idx = this.world.tiles.findIndex(t => t.col === tile.col && t.row === tile.row);
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

  async deleteTile(col: number, row: number): Promise<{ success: boolean; error?: string }> {
    const { startTile } = this.world;
    if (startTile.col === col && startTile.row === row) {
      return { success: false, error: 'Cannot delete the start tile. Assign a different start tile first.' };
    }

    const idx = this.world.tiles.findIndex(t => t.col === col && t.row === row);
    if (idx < 0) {
      return { success: false, error: 'Tile not found.' };
    }

    this.world.tiles.splice(idx, 1);
    await this.save();
    return { success: true };
  }

  async setStartTile(col: number, row: number): Promise<{ success: boolean; error?: string }> {
    const tile = this.world.tiles.find(t => t.col === col && t.row === row);
    if (!tile) {
      return { success: false, error: 'Tile not found.' };
    }
    const config = TILE_CONFIGS[tile.type];
    if (!config || !config.traversable) {
      return { success: false, error: 'Start tile must be traversable.' };
    }
    this.world.startTile = { col, row };
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

  // --- Snapshot ---

  /** Export current live state as a ContentSnapshot. */
  toSnapshot(): { monsters: MonsterDefinition[]; items: ItemDefinition[]; zones: ZoneDefinition[]; encounters: EncounterDefinition[]; world: WorldData } {
    return {
      monsters: Array.from(this.monsters.values()),
      items: Array.from(this.items.values()),
      zones: Array.from(this.zones.values()),
      encounters: Array.from(this.encounters.values()),
      world: JSON.parse(JSON.stringify(this.world)),
    };
  }

  /** Bulk-replace all content from a snapshot (used for deploy). */
  async replaceAll(snapshot: { monsters: MonsterDefinition[]; items: ItemDefinition[]; zones: ZoneDefinition[]; encounters?: EncounterDefinition[]; world: WorldData }): Promise<void> {
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

    this.world = snapshot.world;

    // Safety net: ensure every tile has a GUID
    for (const tile of this.world.tiles) {
      if (!tile.id) {
        tile.id = crypto.randomUUID();
      }
    }

    // Migrate old-format encounter tables if needed
    this.migrateEncounterTables();

    await this.save();
    console.log(`[ContentStore] Replaced all content: ${this.monsters.size} monsters, ${this.items.size} items, ${this.zones.size} zones, ${this.encounters.size} encounters, ${this.world.tiles.length} tiles`);
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

      // Try loading encounters file (may not exist on older installations)
      try {
        const encountersRaw = await fs.readFile(ENCOUNTERS_FILE, 'utf-8');
        const encountersArr: EncounterDefinition[] = JSON.parse(encountersRaw);
        for (const e of encountersArr) this.encounters.set(e.id, e);
      } catch {
        // encounters.json doesn't exist yet — will be created after migration
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

      // Migrate old-format encounter tables (monsterId → encounterId)
      const encountersMigrated = this.migrateEncounterTables();

      if (migrated > 0 || encountersMigrated) {
        await this.save();
      }

      console.log(`[ContentStore] Loaded ${this.monsters.size} monsters, ${this.items.size} items, ${this.zones.size} zones, ${this.encounters.size} encounters, ${this.world.tiles.length} tiles`);
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
      tiles: [
        // Hatchetmill
        { id: crypto.randomUUID(), col: 2, row: 2, type: TileType.Plains, zone: 'hatchetmill', name: 'Town Square' },
        { id: crypto.randomUUID(), col: 1, row: 2, type: TileType.Town, zone: 'hatchetmill', name: 'Blacksmith' },
        { id: crypto.randomUUID(), col: 3, row: 2, type: TileType.Town, zone: 'hatchetmill', name: 'General Store' },
        { id: crypto.randomUUID(), col: 2, row: 1, type: TileType.Town, zone: 'hatchetmill', name: "Healer's Hut" },
        { id: crypto.randomUUID(), col: 1, row: 1, type: TileType.Plains, zone: 'hatchetmill', name: 'Dirt Road' },
        { id: crypto.randomUUID(), col: 3, row: 1, type: TileType.Plains, zone: 'hatchetmill', name: 'Village Green' },
        { id: crypto.randomUUID(), col: 2, row: 3, type: TileType.Plains, zone: 'hatchetmill', name: 'Old Well' },

        // Darkwood
        { id: crypto.randomUUID(), col: 4, row: 2, type: TileType.Plains, zone: 'darkwood', name: 'Woodland Edge' },
        { id: crypto.randomUUID(), col: 5, row: 2, type: TileType.Forest, zone: 'darkwood', name: 'Forest Path' },
        { id: crypto.randomUUID(), col: 5, row: 1, type: TileType.Forest, zone: 'darkwood', name: 'Thick Trees' },
        { id: crypto.randomUUID(), col: 4, row: 1, type: TileType.Forest, zone: 'darkwood', name: 'Mossy Clearing' },
        { id: crypto.randomUUID(), col: 4, row: 3, type: TileType.Plains, zone: 'darkwood', name: 'Overgrown Trail' },

        // Crystal Caves
        { id: crypto.randomUUID(), col: 5, row: 3, type: TileType.Dungeon, zone: 'crystal_caves', name: 'Cave Entrance' },
        { id: crypto.randomUUID(), col: 6, row: 3, type: TileType.Dungeon, zone: 'crystal_caves', name: 'Glittering Tunnel' },
        { id: crypto.randomUUID(), col: 6, row: 2, type: TileType.Dungeon, zone: 'crystal_caves', name: 'Crystal Chamber' },
      ],
    };

    console.log(`[ContentStore] Seeded ${this.monsters.size} monsters, ${this.items.size} items, ${this.zones.size} zones, ${this.encounters.size} encounters, ${this.world.tiles.length} tiles`);
  }
}
