import type { MonsterDefinition } from './MonsterTypes.js';
import type { ItemDefinition } from './ItemTypes.js';
import type { ZoneDefinition } from './ZoneTypes.js';
import type { TileConfig } from '../hex/HexTile.js';

/**
 * Central mutable registry for all game content.
 *
 * Initialized from hardcoded defaults in each system file.
 * The server can replace content at runtime via setXxx() methods
 * (called by ContentStore after loading from JSON files or admin API).
 *
 * Each content type stores a reference to the original mutable Record
 * exported from its system file, so existing imports (e.g. `MONSTERS[id]`)
 * continue to work — the registry mutates those objects in-place.
 */
class ContentRegistry {
  private monstersRef: Record<string, MonsterDefinition> | null = null;
  private itemsRef: Record<string, ItemDefinition> | null = null;
  private zonesRef: Record<string, ZoneDefinition> | null = null;
  private tileTypesRef: Record<string, TileConfig> | null = null;

  /** Called once by each system file to register its mutable record. */
  registerMonsters(ref: Record<string, MonsterDefinition>): void {
    this.monstersRef = ref;
  }

  registerItems(ref: Record<string, ItemDefinition>): void {
    this.itemsRef = ref;
  }

  registerZones(ref: Record<string, ZoneDefinition>): void {
    this.zonesRef = ref;
  }

  registerTileTypes(ref: Record<string, TileConfig>): void {
    this.tileTypesRef = ref;
  }

  // --- Getters ---

  getMonster(id: string): MonsterDefinition | undefined {
    return this.monstersRef?.[id];
  }

  getAllMonsters(): Record<string, MonsterDefinition> {
    return this.monstersRef ?? {};
  }

  getItem(id: string): ItemDefinition | undefined {
    return this.itemsRef?.[id];
  }

  getAllItems(): Record<string, ItemDefinition> {
    return this.itemsRef ?? {};
  }

  getZone(id: string): ZoneDefinition | undefined {
    return this.zonesRef?.[id];
  }

  getAllZones(): Record<string, ZoneDefinition> {
    return this.zonesRef ?? {};
  }

  getTileType(id: string): TileConfig | undefined {
    return this.tileTypesRef?.[id];
  }

  getAllTileTypes(): Record<string, TileConfig> {
    return this.tileTypesRef ?? {};
  }

  // --- Setters (replace all content in-place) ---

  setMonsters(data: Record<string, MonsterDefinition>): void {
    if (!this.monstersRef) return;
    for (const key of Object.keys(this.monstersRef)) {
      delete this.monstersRef[key];
    }
    Object.assign(this.monstersRef, data);
  }

  setItems(data: Record<string, ItemDefinition>): void {
    if (!this.itemsRef) return;
    for (const key of Object.keys(this.itemsRef)) {
      delete this.itemsRef[key];
    }
    Object.assign(this.itemsRef, data);
  }

  setZones(data: Record<string, ZoneDefinition>): void {
    if (!this.zonesRef) return;
    for (const key of Object.keys(this.zonesRef)) {
      delete this.zonesRef[key];
    }
    Object.assign(this.zonesRef, data);
  }

  setTileTypes(data: Record<string, TileConfig>): void {
    if (!this.tileTypesRef) return;
    for (const key of Object.keys(this.tileTypesRef)) {
      delete this.tileTypesRef[key];
    }
    Object.assign(this.tileTypesRef, data);
  }
}

/** Singleton content registry instance. */
export const contentRegistry = new ContentRegistry();
