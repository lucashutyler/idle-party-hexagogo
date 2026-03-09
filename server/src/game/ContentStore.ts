import fs from 'fs/promises';
import path from 'path';
import type { MonsterDefinition, ItemDefinition, ZoneDefinition, WorldData } from '@idle-party-rpg/shared';
import { SEED_MONSTERS, SEED_ITEMS, SEED_ZONES } from '@idle-party-rpg/shared';
import { TileType } from '@idle-party-rpg/shared';

const DATA_DIR = path.resolve('data');
const MONSTERS_FILE = path.join(DATA_DIR, 'monsters.json');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const ZONES_FILE = path.join(DATA_DIR, 'zones.json');
const WORLD_FILE = path.join(DATA_DIR, 'world.json');

/**
 * Loads and manages game content from JSON files in data/.
 * Follows the GuildStore pattern: in-memory data + JSON file persistence.
 * If data files don't exist, seeds with defaults and saves.
 */
export class ContentStore {
  private monsters = new Map<string, MonsterDefinition>();
  private items = new Map<string, ItemDefinition>();
  private zones = new Map<string, ZoneDefinition>();
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

  getWorld(): WorldData {
    return this.world;
  }

  getStartTile(): { col: number; row: number } {
    return this.world.startTile;
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

      console.log(`[ContentStore] Loaded ${this.monsters.size} monsters, ${this.items.size} items, ${this.zones.size} zones, ${this.world.tiles.length} tiles`);
      return true;
    } catch {
      return false;
    }
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
        { col: 2, row: 2, type: TileType.Plains, zone: 'hatchetmill', name: 'Town Square' },
        { col: 1, row: 2, type: TileType.Town, zone: 'hatchetmill', name: 'Blacksmith' },
        { col: 3, row: 2, type: TileType.Town, zone: 'hatchetmill', name: 'General Store' },
        { col: 2, row: 1, type: TileType.Town, zone: 'hatchetmill', name: "Healer's Hut" },
        { col: 1, row: 1, type: TileType.Plains, zone: 'hatchetmill', name: 'Dirt Road' },
        { col: 3, row: 1, type: TileType.Plains, zone: 'hatchetmill', name: 'Village Green' },
        { col: 2, row: 3, type: TileType.Plains, zone: 'hatchetmill', name: 'Old Well' },

        // Darkwood
        { col: 4, row: 2, type: TileType.Plains, zone: 'darkwood', name: 'Woodland Edge' },
        { col: 5, row: 2, type: TileType.Forest, zone: 'darkwood', name: 'Forest Path' },
        { col: 5, row: 1, type: TileType.Forest, zone: 'darkwood', name: 'Thick Trees' },
        { col: 4, row: 1, type: TileType.Forest, zone: 'darkwood', name: 'Mossy Clearing' },
        { col: 4, row: 3, type: TileType.Plains, zone: 'darkwood', name: 'Overgrown Trail' },

        // Crystal Caves
        { col: 5, row: 3, type: TileType.Dungeon, zone: 'crystal_caves', name: 'Cave Entrance' },
        { col: 6, row: 3, type: TileType.Dungeon, zone: 'crystal_caves', name: 'Glittering Tunnel' },
        { col: 6, row: 2, type: TileType.Dungeon, zone: 'crystal_caves', name: 'Crystal Chamber' },
      ],
    };

    console.log(`[ContentStore] Seeded ${this.monsters.size} monsters, ${this.items.size} items, ${this.zones.size} zones, ${this.world.tiles.length} tiles`);
  }
}
