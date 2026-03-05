import fs from 'fs/promises';
import path from 'path';
import {
  contentRegistry,
  type MonsterDefinition,
  type ItemDefinition,
  type ZoneDefinition,
  type TileConfig,
  type MapDefinition,
} from '@idle-party-rpg/shared';

/**
 * Reads/writes game content JSON files in data/content/.
 * On load(), pushes data into the shared ContentRegistry.
 * Falls back to hardcoded defaults if no files exist.
 */
export class ContentStore {
  private baseDir: string;
  private maps: Map<string, MapDefinition> = new Map();

  constructor(baseDir: string = 'data/content') {
    this.baseDir = baseDir;
  }

  async load(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });

    await this.loadMonsters();
    await this.loadItems();
    await this.loadZones();
    await this.loadTileTypes();
    await this.loadMaps();
  }

  // --- Monsters ---

  private async loadMonsters(): Promise<void> {
    const data = await this.readJson<Record<string, MonsterDefinition>>('monsters.json');
    if (data) {
      contentRegistry.setMonsters(data);
      console.log(`[ContentStore] Loaded ${Object.keys(data).length} monster(s)`);
    }
  }

  async saveMonsters(data: Record<string, MonsterDefinition>): Promise<void> {
    await this.writeJson('monsters.json', data);
    contentRegistry.setMonsters(data);
  }

  // --- Items ---

  private async loadItems(): Promise<void> {
    const data = await this.readJson<Record<string, ItemDefinition>>('items.json');
    if (data) {
      contentRegistry.setItems(data);
      console.log(`[ContentStore] Loaded ${Object.keys(data).length} item(s)`);
    }
  }

  async saveItems(data: Record<string, ItemDefinition>): Promise<void> {
    await this.writeJson('items.json', data);
    contentRegistry.setItems(data);
  }

  // --- Zones ---

  private async loadZones(): Promise<void> {
    const data = await this.readJson<Record<string, ZoneDefinition>>('zones.json');
    if (data) {
      contentRegistry.setZones(data);
      console.log(`[ContentStore] Loaded ${Object.keys(data).length} zone(s)`);
    }
  }

  async saveZones(data: Record<string, ZoneDefinition>): Promise<void> {
    await this.writeJson('zones.json', data);
    contentRegistry.setZones(data);
  }

  // --- Tile Types ---

  private async loadTileTypes(): Promise<void> {
    const data = await this.readJson<Record<string, TileConfig>>('tile-types.json');
    if (data) {
      contentRegistry.setTileTypes(data);
      console.log(`[ContentStore] Loaded ${Object.keys(data).length} tile type(s)`);
    }
  }

  async saveTileTypes(data: Record<string, TileConfig>): Promise<void> {
    await this.writeJson('tile-types.json', data);
    contentRegistry.setTileTypes(data);
  }

  // --- Maps ---

  private async loadMaps(): Promise<void> {
    const data = await this.readJson<Record<string, MapDefinition>>('maps.json');
    if (data) {
      this.maps.clear();
      for (const [id, mapDef] of Object.entries(data)) {
        this.maps.set(id, mapDef);
      }
      console.log(`[ContentStore] Loaded ${this.maps.size} map(s)`);
    }
  }

  getMap(id: string): MapDefinition | undefined {
    return this.maps.get(id);
  }

  getAllMaps(): MapDefinition[] {
    return Array.from(this.maps.values());
  }

  async saveMap(mapDef: MapDefinition): Promise<void> {
    this.maps.set(mapDef.id, mapDef);
    await this.persistMaps();
  }

  async deleteMap(id: string): Promise<boolean> {
    const deleted = this.maps.delete(id);
    if (deleted) {
      await this.persistMaps();
    }
    return deleted;
  }

  private async persistMaps(): Promise<void> {
    const data: Record<string, MapDefinition> = {};
    for (const [id, mapDef] of this.maps) {
      data[id] = mapDef;
    }
    await this.writeJson('maps.json', data);
  }

  // --- Helpers ---

  private async readJson<T>(filename: string): Promise<T | null> {
    const filePath = path.join(this.baseDir, filename);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return null; // File doesn't exist or is invalid — use defaults
    }
  }

  private async writeJson(filename: string, data: unknown): Promise<void> {
    const filePath = path.join(this.baseDir, filename);
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
